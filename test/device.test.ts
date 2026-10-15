/**
 * The device (contract §8) against a stand-in door that checks the proof of work and verifies every
 * signature: registration, signing over the exact bytes, IndexedDB persistence (fake-indexeddb),
 * each error path's single resend, the 3 s cap on Send, and the unsigned fallbacks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import {
  DEVICE_HEADER,
  DeviceClient,
  IDB_NAME,
  IDB_STORE,
  SEND_WAIT_MS,
  SIGNATURE_HEADER,
  TIME_HEADER,
  base64url,
  canonicalString,
  devicesUrl,
  indexedDbStore,
  type DeviceStore,
  type StoredDevice,
} from '../src/device.ts';
import { FeedbackError } from '../src/payload.ts';
import { DEFAULT_ENDPOINT, encodeBody, sendReport } from '../src/transport.ts';
import type { FeedbackBody } from '../src/types.ts';
import { b64url, json, makeDoor } from './door.ts';

const KEY = 'obfk_test';
const body: FeedbackBody = { v: 1, message: 'The total is wrong — ünïcödé ✓', category: 'bug', context: { platform: 'web' } };

function memoryStore(): DeviceStore & { map: Map<string, StoredDevice> } {
  const map = new Map<string, StoredDevice>();
  return {
    map,
    get: async (id) => map.get(id) ?? null,
    put: async (id, v) => void map.set(id, v),
    delete: async (id) => void map.delete(id),
  };
}

function client(door: ReturnType<typeof makeDoor>, extra: Partial<ConstructorParameters<typeof DeviceClient>[0]> = {}) {
  return new DeviceClient({ endpoint: DEFAULT_ENDPOINT, key: KEY, fetch: () => door.fetch, store: memoryStore(), createWorker: () => null, ...extra });
}

const send = (door: ReturnType<typeof makeDoor>, device: DeviceClient | null, opts: { waitMs?: number; retryWaitMs?: number } = {}) =>
  sendReport(door.fetch, DEFAULT_ENDPOINT, KEY, body, { device, waitMs: opts.waitMs ?? 10_000, retryWaitMs: opts.retryWaitMs ?? 10_000 });

/** WebCrypto's own methods, with some replaced. */
function subtleWith(over: Partial<Record<'generateKey' | 'exportKey' | 'digest' | 'sign', (...a: unknown[]) => Promise<unknown>>>): SubtleCrypto {
  const s = crypto.subtle;
  return {
    generateKey: s.generateKey.bind(s),
    exportKey: s.exportKey.bind(s),
    digest: s.digest.bind(s),
    sign: s.sign.bind(s),
    ...over,
  } as unknown as SubtleCrypto;
}

const signed = (c: { headers: Record<string, string> }) => !!c.headers[DEVICE_HEADER];

// ── Pure parts ────────────────────────────────────────────────────────────────────────────────

test('the canonical string, base64url and the device door urls', () => {
  assert.equal(canonicalString('fbd_1', 1760440000123, 'abc'), 'overblast-feedback-v1\nfbd_1\n1760440000123\nabc');
  assert.equal(base64url(new Uint8Array([0xfb, 0xff, 0xfe])), '-__-');
  assert.equal(base64url(new Uint8Array([1])), 'AQ');
  const big = new Uint8Array(100_000).map((_, i) => i % 256);
  assert.equal(base64url(big), Buffer.from(big).toString('base64url'));
  assert.equal(devicesUrl('https://brain.deployd.network/v1/feedback'), 'https://brain.deployd.network/v1/feedback/devices');
  assert.equal(devicesUrl('https://brain.deployd.network/v1/feedback/', '/challenge'), 'https://brain.deployd.network/v1/feedback/devices/challenge');
  assert.equal(devicesUrl('http://localhost:8787/v1/feedback?x=1', '/challenge'), 'http://localhost:8787/v1/feedback/devices/challenge');
});

// ── Registration and signing ──────────────────────────────────────────────────────────────────

test('first report: a challenge, a proof of work, a registration, and a report signed over its exact bytes', async () => {
  const door = makeDoor({ difficulty: 10 });
  const device = client(door);
  assert.equal(await device.level(), 'none');
  const result = await send(door, device);
  assert.ok(result.id.startsWith('fbr_'));
  assert.deepEqual(door.calls.map((c) => c.kind), ['challenge', 'register', 'report']);

  const [challenge, register, report] = door.calls;
  assert.equal(challenge!.url, 'https://brain.deployd.network/v1/feedback/devices/challenge');
  assert.equal(challenge!.headers['X-Overblast-Feedback-Key'], KEY);
  assert.equal(register!.url, 'https://brain.deployd.network/v1/feedback/devices');
  assert.equal(register!.json.method, 'pow');
  assert.deepEqual(Object.keys(register!.json).sort(), ['challengeId', 'method', 'powNonce', 'publicKey']);
  // The public key is SPKI, P-256: 91 bytes.
  assert.equal(Buffer.from(String(register!.json.publicKey), 'base64url').length, 91);

  const h = report!.headers;
  assert.match(h[DEVICE_HEADER]!, /^fbd_/);
  assert.match(h[TIME_HEADER]!, /^\d{13}$/);
  assert.ok(Math.abs(Number(h[TIME_HEADER]) - Date.now()) < 5000);
  assert.equal(Buffer.from(h[SIGNATURE_HEADER]!, 'base64url').length, 64, 'raw P1363 signature');
  assert.deepEqual(door.verified, [{ deviceId: h[DEVICE_HEADER], ok: true }]);
  // The bytes sent are the body encoded once, and the signature covers exactly them.
  assert.deepEqual(report!.bytes, encodeBody(body));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(report!.bytes)), body);
  assert.equal(await device.level(), 'registered');

  // The second report reuses the device: no new challenge.
  await send(door, device);
  assert.equal(door.count('challenge'), 1);
  assert.equal(door.verified.length, 2);
  assert.ok(door.verified.every((v) => v.ok));
});

test('the signature verifies with the registered public key, independently of the door', async () => {
  const door = makeDoor();
  const store = memoryStore();
  const device = client(door, { store });
  await send(door, device);
  const kept = [...store.map.values()][0]!;
  assert.equal(kept.keyPair.privateKey.extractable, false, 'the private key never leaves WebCrypto');
  const report = door.reports()[0]!;
  const hash = b64url(createHash('sha256').update(report.bytes).digest());
  const canonical = canonicalString(report.headers[DEVICE_HEADER]!, report.headers[TIME_HEADER]!, hash);
  const sig = Buffer.from(report.headers[SIGNATURE_HEADER]!, 'base64url');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kept.keyPair.publicKey, sig, new TextEncoder().encode(canonical)));
  // A byte changed anywhere in the body breaks it.
  const tampered = new Uint8Array(report.bytes);
  tampered[5] = tampered[5]! ^ 1;
  const bad = canonicalString(report.headers[DEVICE_HEADER]!, report.headers[TIME_HEADER]!, b64url(createHash('sha256').update(tampered).digest()));
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kept.keyPair.publicKey, sig, new TextEncoder().encode(bad)), false);
});

// ── IndexedDB ─────────────────────────────────────────────────────────────────────────────────

test('IndexedDB keeps the key pair and the device id across page loads, one per endpoint and key', async () => {
  const idb = new IDBFactory();
  const door = makeDoor();
  const first = client(door, { store: indexedDbStore(idb) });
  await send(door, first);
  const deviceId = door.reports()[0]!.headers[DEVICE_HEADER];

  // A new page: a new client on the same database registers nothing and signs as the same device.
  const second = client(door, { store: indexedDbStore(idb) });
  assert.equal(await second.level(), 'registered');
  await send(door, second);
  assert.equal(door.count('challenge'), 1);
  assert.equal(door.reports()[1]!.headers[DEVICE_HEADER], deviceId);
  assert.ok(door.verified.every((v) => v.ok));

  // Another key on the same site is another device, kept beside the first.
  const other = new DeviceClient({ endpoint: DEFAULT_ENDPOINT, key: 'obfk_other', fetch: () => door.fetch, store: indexedDbStore(idb), createWorker: () => null });
  await sendReport(door.fetch, DEFAULT_ENDPOINT, 'obfk_other', body, { device: other });
  assert.equal(door.count('challenge'), 2);
  assert.notEqual(door.reports()[2]!.headers[DEVICE_HEADER], deviceId);

  // What is on disk: database `overblast-feedback`, store `device`, two records keyed by endpoint and key.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open(IDB_NAME);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const keys = await new Promise<IDBValidKey[]>((resolve) => {
    const r = db.transaction(IDB_STORE).objectStore(IDB_STORE).getAllKeys();
    r.onsuccess = () => resolve(r.result);
  });
  assert.deepEqual(keys.map(String).sort(), [`${DEFAULT_ENDPOINT} ${KEY}`, `${DEFAULT_ENDPOINT} obfk_other`].sort());
  db.close();
});

test('a key pair kept before a registration that failed is reused by the next one', async () => {
  const door = makeDoor();
  const store = memoryStore();
  door.next('register', json(500, { code: 'misconfigured', error: 'x' }));
  const a = client(door, { store });
  await send(door, a);
  assert.equal(signed(door.reports()[0]!), false);
  const pk1 = door.calls.find((c) => c.kind === 'register')!.json.publicKey;
  const b = client(door, { store });
  await send(door, b);
  const pk2 = door.calls.filter((c) => c.kind === 'register')[1]!.json.publicKey;
  assert.equal(pk1, pk2);
  assert.equal(signed(door.reports()[1]!), true);
});

// ── The error paths ───────────────────────────────────────────────────────────────────────────

for (const code of ['unknown_device', 'device_signature_invalid'] as const) {
  test(`401 ${code}: the device is dropped, a new one registered, and the report sent once more`, async () => {
    const door = makeDoor();
    const store = memoryStore();
    const device = client(door, { store });
    await send(door, device);
    const oldId = door.reports()[0]!.headers[DEVICE_HEADER];
    door.next('report', json(401, { code, error: 'No.' }));
    await send(door, device);
    const reports = door.reports();
    assert.equal(reports.length, 3);
    assert.equal(reports[1]!.headers[DEVICE_HEADER], oldId);
    assert.ok(signed(reports[2]!));
    assert.notEqual(reports[2]!.headers[DEVICE_HEADER], oldId, 'a new device');
    assert.deepEqual(reports[2]!.bytes, reports[1]!.bytes, 'the same bytes');
    assert.equal(door.count('challenge'), 2);
    assert.equal([...store.map.values()][0]!.deviceId, reports[2]!.headers[DEVICE_HEADER]);
  });
}

test('401 twice: one resend only, then the refusal', async () => {
  const door = makeDoor();
  const device = client(door);
  door.next('report', json(401, { code: 'unknown_device', error: 'Unknown device.' }), json(401, { code: 'unknown_device', error: 'Still unknown.' }));
  await assert.rejects(send(door, device), (e: unknown) => e instanceof FeedbackError && e.code === 'unknown_device' && e.message === 'Still unknown.');
  assert.equal(door.reports().length, 2);
});

test('401 and the new registration fails: the resend goes unsigned', async () => {
  const door = makeDoor();
  const device = client(door);
  await send(door, device);
  door.next('report', json(401, { code: 'unknown_device', error: 'x' }));
  door.next('challenge', json(429, { code: 'rate_limited', error: 'Slow.', retryAfter: 60 }));
  await send(door, device);
  const reports = door.reports();
  assert.equal(reports.length, 3);
  assert.equal(signed(reports[2]!), false);
});

test('403 device_required while the registration is still running: it is awaited, and the report resent signed', async () => {
  const door = makeDoor();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  door.next('challenge', async () => {
    await gate;
    return json(200, { challenge: { id: 'missing', salt: 's', difficulty: 1, expiresAt: 0, nonce: 'n' } });
  });
  // That first challenge is not one the door issued: the registration retries once with a fresh one.
  door.next('report', () => {
    setTimeout(release, 10);
    return json(403, { code: 'device_required', error: 'This app only takes reports from registered devices.' });
  });
  const device = client(door);
  await send(door, device, { waitMs: 50 });
  const reports = door.reports();
  assert.equal(reports.length, 2);
  assert.equal(signed(reports[0]!), false);
  assert.equal(signed(reports[1]!), true);
  assert.equal(door.verified.at(-1)!.ok, true);
});

test('403 device_required after the registration failed: the door\'s sentence, no second report', async () => {
  const door = makeDoor();
  door.next('challenge', json(429, { code: 'rate_limited', error: 'Too many.' }));
  door.next('report', json(403, { code: 'device_required', error: 'This app only takes reports from registered devices.' }));
  await assert.rejects(
    send(door, client(door)),
    (e: unknown) => e instanceof FeedbackError && e.status === 403 && e.code === 'device_required' && e.message === 'This app only takes reports from registered devices.',
  );
  assert.equal(door.reports().length, 1);
  assert.equal(door.count('challenge'), 1);
});

test('403 device_required in a cooldown after an earlier failure: one forced registration, then signed', async () => {
  const door = makeDoor();
  const device = client(door);
  door.next('challenge', json(500, { code: 'misconfigured', error: 'x' }));
  await send(door, device);
  assert.equal(signed(door.reports()[0]!), false);
  door.next('report', json(403, { code: 'device_required', error: 'Registered devices only.' }));
  await send(door, device);
  const reports = door.reports();
  assert.equal(reports.length, 3);
  assert.equal(signed(reports[1]!), false, 'the cooldown held for the first try');
  assert.equal(signed(reports[2]!), true);
});

test('challenge_invalid then a fresh challenge that works', async () => {
  const door = makeDoor();
  door.next('register', json(403, { code: 'challenge_invalid', error: 'Expired.' }));
  await send(door, client(door));
  assert.equal(door.count('challenge'), 2);
  assert.equal(door.count('register'), 2);
  assert.equal(signed(door.reports()[0]!), true);
});

test('pow_invalid twice: one fresh challenge, then the report goes unsigned', async () => {
  const door = makeDoor();
  door.next('register', json(403, { code: 'pow_invalid', error: 'x' }), json(403, { code: 'pow_invalid', error: 'x' }));
  const device = client(door);
  await send(door, device);
  assert.equal(door.count('challenge'), 2);
  assert.equal(door.count('register'), 2);
  assert.equal(signed(door.reports()[0]!), false);
  assert.equal(await device.level(), 'none');
});

test('429 on the challenge or the registration: this report goes unsigned, and the next one does not hammer the door', async () => {
  const door = makeDoor();
  const device = client(door);
  door.next('challenge', json(429, { code: 'rate_limited', error: 'x' }, { 'Retry-After': '120' }));
  await send(door, device);
  assert.equal(signed(door.reports()[0]!), false);
  await send(door, device);
  assert.equal(door.count('challenge'), 1, 'no second challenge inside Retry-After');

  const door2 = makeDoor();
  door2.next('register', json(429, { code: 'rate_limited', error: 'x', retryAfter: 60 }));
  await send(door2, client(door2));
  assert.equal(door2.count('register'), 1);
  assert.equal(signed(door2.reports()[0]!), false);
});

test('a proof of work past the time allowed: unsigned', async () => {
  const door = makeDoor({ difficulty: 40 });
  const device = client(door, { powTimeoutMs: 200 });
  await send(door, device);
  assert.equal(door.count('register'), 0);
  assert.equal(signed(door.reports()[0]!), false);
});

// ── The 3 s cap ───────────────────────────────────────────────────────────────────────────────

test('Send waits at most 3 s for a registration under way, then sends unsigned; the registration finishes for the next one', async () => {
  assert.equal(SEND_WAIT_MS, 3000);
  const door = makeDoor();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  door.next('challenge', async () => {
    await gate;
    return json(200, { challenge: { id: 'late', salt: 's', difficulty: 1, expiresAt: 0, nonce: 'n' } });
  });
  const device = client(door);
  const start = Date.now();
  await sendReport(door.fetch, DEFAULT_ENDPOINT, KEY, body, { device });
  const took = Date.now() - start;
  assert.ok(took >= 2950 && took < 3800, `waited ${took} ms`);
  assert.equal(signed(door.reports()[0]!), false);
  release();
  // The late challenge is unknown to the door, so the registration takes its one fresh challenge.
  assert.equal(await device.level(), 'registered');
  await sendReport(door.fetch, DEFAULT_ENDPOINT, KEY, body, { device });
  assert.equal(signed(door.reports()[1]!), true);
});

// ── Unsigned fallbacks ────────────────────────────────────────────────────────────────────────

test('no IndexedDB, or WebCrypto that throws, or a store that throws: the report is sent unsigned', async () => {
  const cases: Array<[string, Partial<ConstructorParameters<typeof DeviceClient>[0]>]> = [
    ['no store', { store: null }],
    ['no WebCrypto', { subtle: null }],
    [
      'generateKey throws',
      {
        subtle: subtleWith({
          generateKey: async () => {
            throw new DOMException('not supported', 'NotSupportedError');
          },
        }),
      },
    ],
    [
      'the store throws',
      {
        store: {
          get: async () => {
            throw new Error('InvalidStateError');
          },
          put: async () => {},
          delete: async () => {},
        },
      },
    ],
    [
      'the store cannot keep the key',
      {
        store: {
          get: async () => null,
          put: async () => {
            throw new Error('QuotaExceededError');
          },
          delete: async () => {},
        },
      },
    ],
  ];
  for (const [name, extra] of cases) {
    const door = makeDoor();
    const device = client(door, extra);
    const r = await send(door, device);
    assert.ok(r.id, name);
    assert.equal(door.reports().length, 1, name);
    assert.equal(signed(door.reports()[0]!), false, name);
    assert.equal(door.count('challenge'), 0, `${name}: no device door`);
    assert.equal(await device.level(), 'none', name);
  }
});

test('signing that throws: unsigned, and the report still goes', async () => {
  const door = makeDoor();
  const device = client(door);
  await send(door, device);
  const broken = client(door, {
    store: (device as unknown as { store: DeviceStore }).store,
    subtle: subtleWith({
      sign: async () => {
        throw new Error('boom');
      },
    }),
  });
  await send(door, broken);
  assert.equal(signed(door.reports()[1]!), false);
});

test('indexedDbStore without IndexedDB is null, and the real one survives a factory that throws', async () => {
  assert.equal(indexedDbStore(), null);
  const throwing = {
    open() {
      throw new Error('SecurityError');
    },
  } as unknown as IDBFactory;
  const store = indexedDbStore(throwing)!;
  await assert.rejects(store.get('x'));
  const door = makeDoor();
  await send(door, client(door, { store }));
  assert.equal(signed(door.reports()[0]!), false);
});

test('no device: exactly the 0.1 request, no device door', async () => {
  const door = makeDoor();
  await sendReport(door.fetch, DEFAULT_ENDPOINT, KEY, body);
  assert.deepEqual(door.calls.map((c) => c.kind), ['report']);
  assert.deepEqual(Object.keys(door.calls[0]!.headers).sort(), ['Content-Type', 'X-Overblast-Feedback-Key']);
});
