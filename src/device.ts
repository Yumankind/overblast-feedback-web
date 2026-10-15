/**
 * The device a browser registers with the door (contract §8). On the web it is always `registered`
 * by the `pow` method: a non-extractable ECDSA P-256 key pair made with WebCrypto and kept in
 * IndexedDB, registered once by paying a proof of work, and used to sign every report afterwards.
 *
 * Nothing here may fail a report. A browser without IndexedDB or WebCrypto (a private window, an old
 * browser, a sandboxed frame), a registration the door refuses, a proof of work that takes too long:
 * each of them means the report goes unsigned, at level `none`, and is still sent.
 *
 * Nothing here runs until the first report is on its way (or the sheet has been opened), and nothing
 * here runs at all without a DOM, so server rendering never touches IndexedDB.
 */

import { solvePow, type WorkerFactory } from './pow.ts';
import type { DeviceLevel } from './types.ts';

export const DEVICE_HEADER = 'X-Overblast-Feedback-Device';
export const TIME_HEADER = 'X-Overblast-Feedback-Time';
export const SIGNATURE_HEADER = 'X-Overblast-Feedback-Signature';
export const SIGNING_PREFIX = 'overblast-feedback-v1';

export const IDB_NAME = 'overblast-feedback';
export const IDB_STORE = 'device';

/** How long Send waits for a registration still under way before it sends unsigned. */
export const SEND_WAIT_MS = 3_000;
/** How long the proof of work may take before the registration gives up. */
export const POW_TIMEOUT_MS = 20_000;
/** How long a resend after `unknown_device` or `device_required` waits for the new registration. */
export const RETRY_WAIT_MS = 30_000;
/** After a registration that failed, the next one is not started before this, unless asked. */
export const FAILURE_COOLDOWN_MS = 60_000;
/** An IndexedDB call that has not answered by now is treated as unavailable. */
const IDB_TIMEOUT_MS = 3_000;


/** What is kept per endpoint and key. */
export interface StoredDevice {
  keyPair: CryptoKeyPair;
  /** `fbd_…` once the door has registered the public key; null until then. */
  deviceId: string | null;
  level: 'registered' | 'attested' | null;
  createdAt: number;
}

/** The storage seam: IndexedDB in a browser, anything with the same three calls in a test. */
export interface DeviceStore {
  get(id: string): Promise<StoredDevice | null>;
  put(id: string, value: StoredDevice): Promise<void>;
  delete(id: string): Promise<void>;
}

/** A device ready to sign. */
export interface ReadyDevice {
  deviceId: string;
  privateKey: CryptoKey;
}

// ── Encoding ──────────────────────────────────────────────────────────────────────────────────

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The string a report signature covers (§8.3). */
export function canonicalString(deviceId: string, time: string | number, bodyHash: string): string {
  return `${SIGNING_PREFIX}\n${deviceId}\n${time}\n${bodyHash}`;
}

/** `…/v1/feedback` → `…/v1/feedback/devices`, keeping any query string out of the way. */
export function devicesUrl(endpoint: string, suffix = ''): string {
  const q = endpoint.indexOf('?');
  const base = (q >= 0 ? endpoint.slice(0, q) : endpoint).replace(/\/+$/, '');
  return `${base}/devices${suffix}`;
}

function subtleCrypto(): SubtleCrypto | null {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    return c && c.subtle && typeof c.subtle.sign === 'function' ? c.subtle : null;
  } catch {
    return null;
  }
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** The IndexedDB store, or null where there is none. Every call can reject; callers catch. */
export function indexedDbStore(factory?: IDBFactory): DeviceStore | null {
  let idb: IDBFactory | undefined;
  try {
    idb = factory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  } catch {
    idb = undefined;
  }
  if (!idb) return null;
  const f = idb;
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!opening) {
      opening = withTimeout(
        new Promise<IDBDatabase>((resolve, reject) => {
          const req = f.open(IDB_NAME, 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
          req.onblocked = () => reject(new Error('indexedDB.open blocked'));
        }),
        IDB_TIMEOUT_MS,
        'indexedDB.open',
      );
      // A failed open is tried again next time rather than remembered.
      opening.catch(() => {
        opening = null;
      });
    }
    return opening;
  };
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | null, read: boolean): Promise<T> =>
    withTimeout(
      open().then(
        (db) =>
          new Promise<T>((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, mode);
            const req = fn(tx.objectStore(IDB_STORE));
            let result: unknown;
            if (req) req.onsuccess = () => (result = req.result);
            tx.oncomplete = () => resolve((read ? (result ?? null) : undefined) as T);
            tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
            tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
          }),
      ),
      IDB_TIMEOUT_MS,
      'indexedDB',
    );
  return {
    async get(id) {
      const v = await run<StoredDevice | null>('readonly', (s) => s.get(id), true);
      return v && typeof v === 'object' && v.keyPair && v.keyPair.privateKey ? v : null;
    },
    put: (id, value) => run<void>('readwrite', (s) => s.put(value, id), false),
    delete: (id) => run<void>('readwrite', (s) => s.delete(id), false),
  };
}

// ── The client ────────────────────────────────────────────────────────────────────────────────

export interface DeviceClientOptions {
  endpoint: string;
  key: string;
  /** Called each time, so the page's own (unwrapped) fetch is used. */
  fetch: () => typeof fetch;
  /** Default IndexedDB. `null` means there is no store, so every report is unsigned. */
  store?: DeviceStore | null | undefined;
  /** Default `globalThis.crypto.subtle`. */
  subtle?: SubtleCrypto | null | undefined;
  createWorker?: WorkerFactory | undefined;
  powTimeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

interface Challenge {
  id: string;
  salt: string;
  difficulty: number;
}

export type ReadyResult =
  | { device: ReadyDevice; state: 'ready' }
  | { device: null; state: 'late' | 'failed' | 'cooldown' | 'unavailable' };

/** How a registration attempt ended, besides with a device. */
type Outcome = { device: ReadyDevice } | { device: null; retryAt: number };

export class DeviceClient {
  private readonly opts: DeviceClientOptions;
  private readonly storeId: string;
  private store: DeviceStore | null | undefined;
  private subtle: SubtleCrypto | null | undefined;
  /** A device known good in this page, so a report does not read IndexedDB each time. */
  private cached: ReadyDevice | null = null;
  private inflight: Promise<Outcome> | null = null;
  private notBefore = 0;
  /** Bumped by `drop()`, so an attempt that was under way when the device was dropped is ignored. */
  private generation = 0;
  /** Set once IndexedDB or WebCrypto proved unusable here: this page sends unsigned. */
  private unavailable = false;

  constructor(opts: DeviceClientOptions) {
    this.opts = opts;
    // The endpoint and the key together: two keys on one site, or one key against two endpoints
    // (staging and production), are two devices as far as the door is concerned.
    this.storeId = `${opts.endpoint} ${opts.key}`;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private getStore(): DeviceStore | null {
    if (this.store === undefined) {
      try {
        this.store = this.opts.store !== undefined ? this.opts.store : indexedDbStore();
      } catch {
        this.store = null;
      }
    }
    return this.store;
  }

  private getSubtle(): SubtleCrypto | null {
    if (this.subtle === undefined) this.subtle = this.opts.subtle !== undefined ? this.opts.subtle : subtleCrypto();
    return this.subtle;
  }

  /**
   * Start a registration if there is no device yet and none under way. Cheap to call often: the
   * sheet calls it in idle time each time it opens.
   */
  start(force = false): void {
    if (this.unavailable || this.cached || this.inflight) return;
    if (!force && this.now() < this.notBefore) return;
    const generation = this.generation;
    const attempt = this.register().catch((): Outcome => ({ device: null, retryAt: this.now() + FAILURE_COOLDOWN_MS }));
    this.inflight = attempt;
    void attempt.then((o) => {
      if (this.inflight === attempt) this.inflight = null;
      if (generation !== this.generation) return;
      if (o.device) this.cached = o.device;
      else this.notBefore = o.retryAt;
    });
  }

  /**
   * The device to sign with, waiting at most `waitMs` for a registration under way. With no device,
   * `state` says why: `late` (still registering), `failed` (this attempt ended without one),
   * `cooldown` (an earlier attempt failed a moment ago, so none was started), `unavailable` (no
   * IndexedDB or WebCrypto here). `force` starts one despite the cooldown.
   */
  async ready(waitMs: number, force = false): Promise<ReadyResult> {
    try {
      if (this.cached) return { device: this.cached, state: 'ready' };
      if (this.unavailable) return { device: null, state: 'unavailable' };
      this.start(force);
      const attempt = this.inflight;
      if (!attempt) return { device: null, state: this.unavailable ? 'unavailable' : 'cooldown' };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), waitMs);
      });
      const r = await Promise.race([attempt, late]);
      clearTimeout(timer);
      if (r === 'late') return { device: null, state: 'late' };
      if (r.device) return { device: r.device, state: 'ready' };
      return { device: null, state: this.unavailable ? 'unavailable' : 'failed' };
    } catch {
      return { device: null, state: 'failed' };
    }
  }

  /** The three headers over `body`, or `{}` when signing fails (the report then goes unsigned). */
  async sign(device: ReadyDevice, body: Uint8Array): Promise<Record<string, string>> {
    try {
      const subtle = this.getSubtle();
      if (!subtle) return {};
      const hash = base64url(await subtle.digest('SHA-256', body as BufferSource));
      const time = String(this.now());
      const data = new TextEncoder().encode(canonicalString(device.deviceId, time, hash));
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, data as BufferSource);
      return { [DEVICE_HEADER]: device.deviceId, [TIME_HEADER]: time, [SIGNATURE_HEADER]: base64url(sig) };
    } catch {
      return {};
    }
  }

  /** Forget the device (the door does not know it, or refuses its signatures): a new key next time. */
  async drop(): Promise<void> {
    this.generation++;
    this.cached = null;
    this.inflight = null;
    this.notBefore = 0;
    try {
      await this.getStore()?.delete(this.storeId);
    } catch {
      /* the next registration overwrites it */
    }
  }

  /** `registered` when a device is kept (or a registration under way finishes with one). */
  async level(): Promise<DeviceLevel> {
    try {
      if (this.cached) return 'registered';
      if (this.inflight) return (await this.inflight).device ? 'registered' : 'none';
      if (this.unavailable) return 'none';
      const store = this.getStore();
      if (!store) return 'none';
      const kept = await store.get(this.storeId);
      return kept?.deviceId ? 'registered' : 'none';
    } catch {
      return 'none';
    }
  }

  // ── Registration ──────────────────────────────────────────────────────────────────────────

  private async register(): Promise<Outcome> {
    const store = this.getStore();
    const subtle = this.getSubtle();
    if (!store || !subtle) {
      this.unavailable = true;
      return { device: null, retryAt: Infinity };
    }
    let kept: StoredDevice | null;
    try {
      kept = await store.get(this.storeId);
    } catch {
      this.unavailable = true;
      return { device: null, retryAt: Infinity };
    }
    if (kept?.deviceId) return { device: { deviceId: kept.deviceId, privateKey: kept.keyPair.privateKey } };

    if (!kept) {
      let keyPair: CryptoKeyPair;
      try {
        // Non-extractable: the private key never leaves WebCrypto, even to this library.
        keyPair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
        kept = { keyPair, deviceId: null, level: null, createdAt: this.now() };
        // Kept before registering, so a registration cut short reuses the same key next time. A
        // store that cannot keep it would make a new device on every page load: unsigned instead.
        await store.put(this.storeId, kept);
      } catch {
        this.unavailable = true;
        return { device: null, retryAt: Infinity };
      }
    }

    let publicKey: string;
    try {
      publicKey = base64url(await subtle.exportKey('spki', kept.keyPair.publicKey));
    } catch {
      // A stored key that cannot be read back: start over with a new one next time.
      await this.drop();
      return { device: null, retryAt: this.now() };
    }

    // One fresh challenge after `challenge_invalid` or `pow_invalid`, then unsigned (§8.2).
    for (let round = 0; round < 2; round++) {
      const challenge = await this.challenge();
      if ('retryAt' in challenge) return { device: null, retryAt: challenge.retryAt };
      const powNonce = await solvePow(challenge.salt, challenge.difficulty, {
        timeoutMs: this.opts.powTimeoutMs ?? POW_TIMEOUT_MS,
        createWorker: this.opts.createWorker,
      });
      if (powNonce === null) return { device: null, retryAt: this.now() + FAILURE_COOLDOWN_MS };
      const answer = await this.post(devicesUrl(this.opts.endpoint), { challengeId: challenge.id, method: 'pow', powNonce, publicKey });
      if (answer.status === 201 || (answer.ok && typeof answer.json.deviceId === 'string')) {
        const deviceId = answer.json.deviceId;
        if (typeof deviceId !== 'string' || !deviceId) return { device: null, retryAt: this.now() + FAILURE_COOLDOWN_MS };
        const level = answer.json.level === 'attested' ? 'attested' : 'registered';
        try {
          await store.put(this.storeId, { ...kept, deviceId, level });
        } catch {
          // Registered but not kept: good for this page, and the next page registers again.
        }
        return { device: { deviceId, privateKey: kept.keyPair.privateKey } };
      }
      if (answer.status === 403 && (answer.json.code === 'challenge_invalid' || answer.json.code === 'pow_invalid') && round === 0) continue;
      return { device: null, retryAt: this.retryAt(answer) };
    }
    return { device: null, retryAt: this.now() + FAILURE_COOLDOWN_MS };
  }

  private async challenge(): Promise<Challenge | { retryAt: number }> {
    const answer = await this.post(devicesUrl(this.opts.endpoint, '/challenge'), undefined);
    const c = answer.json.challenge as Partial<Challenge> | undefined;
    if (!answer.ok || !c || typeof c.id !== 'string' || typeof c.salt !== 'string' || typeof c.difficulty !== 'number') {
      return { retryAt: this.retryAt(answer) };
    }
    // A difficulty past what a page can pay in the time allowed is not attempted at all.
    if (!Number.isInteger(c.difficulty) || c.difficulty < 0 || c.difficulty > 40) return { retryAt: this.now() + FAILURE_COOLDOWN_MS };
    return { id: c.id, salt: c.salt, difficulty: c.difficulty };
  }

  private retryAt(answer: { status: number; json: Record<string, unknown>; retryAfter: number }): number {
    if (answer.status === 429 && answer.retryAfter > 0) return this.now() + answer.retryAfter * 1000;
    return this.now() + FAILURE_COOLDOWN_MS;
  }

  private async post(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; retryAfter: number }> {
    let response: Response;
    try {
      const headers: Record<string, string> = { 'X-Overblast-Feedback-Key': this.opts.key };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      response = await this.opts.fetch()(url, {
        method: 'POST',
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit',
        mode: 'cors',
      });
    } catch {
      return { ok: false, status: 0, json: {}, retryAfter: 0 };
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
    } catch {
      /* the status speaks */
    }
    const ra = typeof json.retryAfter === 'number' ? json.retryAfter : Number(response.headers.get('Retry-After'));
    return { ok: response.ok, status: response.status, json, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 0 };
  }
}
