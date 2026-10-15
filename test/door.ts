/**
 * A stand-in for the worker's feedback door and its device doors (contract §8.2, §8.3), honest
 * enough to check the library's work: it checks the proof of work with Node's own SHA-256, imports
 * the registered public key, and verifies each report's signature over the exact bytes received.
 * Any answer can be overridden per call, in order, to walk the error paths.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface DoorCall {
  url: string;
  kind: 'challenge' | 'register' | 'report';
  headers: Record<string, string>;
  bytes: Uint8Array;
  json: Record<string, unknown>;
}

type Answer = Response | Promise<Response> | (() => Response | Promise<Response>);

export interface DoorOptions {
  difficulty?: number;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');
}

export function makeDoor(opts: DoorOptions = {}) {
  const calls: DoorCall[] = [];
  const challenges = new Map<string, { salt: string; difficulty: number; used: boolean }>();
  const devices = new Map<string, CryptoKey>();
  const overrides: Record<DoorCall['kind'], Answer[]> = { challenge: [], register: [], report: [] };
  let n = 0;
  const verified: Array<{ deviceId: string; ok: boolean }> = [];

  const answer = async (a: Answer): Promise<Response> => (typeof a === 'function' ? a() : a);

  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const headers = { ...(init.headers as Record<string, string>) };
    const raw = init.body;
    const bytes = raw instanceof Uint8Array ? raw : typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = bytes.length ? (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    const kind: DoorCall['kind'] = url.endsWith('/devices/challenge') ? 'challenge' : url.endsWith('/devices') ? 'register' : 'report';
    calls.push({ url, kind, headers, bytes, json: parsed });
    const override = overrides[kind].shift();
    if (override !== undefined) return answer(override);

    if (kind === 'challenge') {
      const id = `ch_${++n}`;
      const salt = randomBytes(16).toString('base64url');
      const difficulty = opts.difficulty ?? 8;
      challenges.set(id, { salt, difficulty, used: false });
      return json(200, { challenge: { id, salt, difficulty, expiresAt: Date.now() + 300_000, nonce: randomBytes(32).toString('base64url') } });
    }
    if (kind === 'register') {
      const ch = challenges.get(String(parsed.challengeId));
      if (!ch || ch.used) return json(403, { code: 'challenge_invalid', error: 'The challenge is not valid.' });
      ch.used = true;
      if (parsed.method !== 'pow' || typeof parsed.powNonce !== 'string') return json(400, { code: 'invalid_field', field: 'method', error: 'x' });
      const digest = createHash('sha256').update(`${ch.salt}:${parsed.powNonce}`).digest();
      if (leadingZeroBits(digest) < ch.difficulty) return json(403, { code: 'pow_invalid', error: 'The proof of work is not valid.' });
      const spki = Buffer.from(String(parsed.publicKey), 'base64url');
      const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const deviceId = `fbd_${++n}`;
      devices.set(deviceId, key);
      return json(201, { deviceId, level: 'registered', reason: null });
    }
    // The report.
    const deviceId = headers['X-Overblast-Feedback-Device'];
    if (deviceId) {
      const key = devices.get(deviceId);
      if (!key) return json(401, { code: 'unknown_device', error: 'This device is not known.' });
      const hash = b64url(createHash('sha256').update(bytes).digest());
      const canonical = `overblast-feedback-v1\n${deviceId}\n${headers['X-Overblast-Feedback-Time']}\n${hash}`;
      const sig = Buffer.from(headers['X-Overblast-Feedback-Signature'] ?? '', 'base64url');
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(canonical));
      verified.push({ deviceId, ok });
      if (!ok) return json(401, { code: 'device_signature_invalid', error: 'The signature is not valid.' });
    }
    return json(201, { id: `fbr_${++n}`, taskId: `todo_${n}`, conversationId: null });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    devices,
    verified,
    /** Answer the next call of this kind with `a` instead. */
    next(kind: DoorCall['kind'], ...a: Answer[]) {
      overrides[kind].push(...a);
    },
    count: (kind: DoorCall['kind']) => calls.filter((c) => c.kind === kind).length,
    reports: () => calls.filter((c) => c.kind === 'report'),
  };
}
