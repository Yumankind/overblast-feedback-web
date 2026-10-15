import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { makePow, solveOnMainThread, solvePow, workerSource, type PowWorker } from '../src/pow.ts';
import { leadingZeroBits } from './door.ts';

const zeroBits = (salt: string, nonce: string) => leadingZeroBits(createHash('sha256').update(`${salt}:${nonce}`).digest());

test('the synchronous SHA-256 agrees with Node across block boundaries', () => {
  const pow = makePow();
  for (const len of [0, 1, 3, 31, 32, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 200, 1000]) {
    const bytes = new Uint8Array(randomBytes(len));
    assert.equal(Buffer.from(pow.sha256(bytes)).toString('hex'), createHash('sha256').update(bytes).digest('hex'), `length ${len}`);
  }
  assert.equal(Buffer.from(pow.sha256(new TextEncoder().encode('abc'))).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('search finds the first counter with enough leading zero bits, byte-aligned or not', () => {
  const pow = makePow();
  for (const difficulty of [0, 1, 4, 7, 8, 9, 12, 13, 16]) {
    const salt = randomBytes(16).toString('base64url');
    const n = pow.search(`${salt}:`, difficulty, 0, 5_000_000);
    assert.ok(n >= 0, `difficulty ${difficulty} solved`);
    assert.ok(zeroBits(salt, String(n)) >= difficulty, `difficulty ${difficulty}: ${n} qualifies`);
    if (difficulty <= 9) for (let k = 0; k < n; k++) assert.ok(zeroBits(salt, String(k)) < difficulty, `difficulty ${difficulty}: ${k} was skipped rightly`);
  }
  assert.equal(pow.search('x:', 0, 7, 10), 7);
  // A count that holds no answer says so.
  assert.equal(pow.search('salt:', 64, 0, 100), -1);
});

test('a prefix longer than one block, and switching prefixes between searches', () => {
  const pow = makePow();
  const long = 'a'.repeat(150);
  const n = pow.search(`${long}:`, 10, 0, 1_000_000);
  assert.ok(zeroBits(long, String(n)) >= 10);
  const m = pow.search('short:', 10, 0, 1_000_000);
  assert.ok(zeroBits('short', String(m)) >= 10);
  assert.equal(pow.search(`${long}:`, 10, 0, 1_000_000), n);
});

test('the main-thread solver yields to the page and gives up at the deadline', async () => {
  // A timer set while the solver runs fires long before the solver finishes: it is not one long task.
  let firedAt = 0;
  const start = Date.now();
  setTimeout(() => (firedAt = Date.now()), 20);
  const r = await solveOnMainThread('salt', 200, Date.now() + 300);
  const took = Date.now() - start;
  assert.equal(r, null);
  assert.ok(took >= 290 && took < 1000, `gave up after ${took} ms`);
  // Before the solver gave up: the page got its turn in the middle (the exact moment depends on
  // how busy the machine is, so only the order is asserted).
  assert.ok(firedAt > 0 && firedAt < start + took, `the page's timer ran at ${firedAt - start} ms of ${took}`);
  const salt = 'abc';
  const nonce = await solveOnMainThread(salt, 12, Date.now() + 5000);
  assert.ok(nonce !== null && zeroBits(salt, nonce) >= 12);
});

/** A worker made the way a browser would make one: the source evaluated against its own `self`. */
function evalWorker(source: string): PowWorker & { terminated: boolean } {
  const self: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (d: unknown) => void } = { onmessage: null, postMessage: () => {} };
  new Function('self', source)(self);
  const w: PowWorker & { terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage(data) {
      setTimeout(() => self.onmessage?.({ data }), 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  self.postMessage = (d) => w.onmessage?.({ data: d });
  return w;
}

test('the worker source is self-contained and solves', async () => {
  let made: (PowWorker & { terminated: boolean }) | null = null;
  const salt = randomBytes(12).toString('base64url');
  const nonce = await solvePow(salt, 13, {
    timeoutMs: 10_000,
    createWorker: (src) => {
      assert.ok(src.includes('self.onmessage'));
      made = evalWorker(src);
      return made;
    },
  });
  assert.ok(nonce !== null && zeroBits(salt, nonce) >= 13);
  assert.equal(made!.terminated, true);
  assert.ok(workerSource().startsWith('const makePow = function makePow()') || workerSource().startsWith('const makePow = function'));
});

test('a worker that fails to start hands the work to the main thread; no worker at all too', async () => {
  const failing: PowWorker = {
    onmessage: null,
    onerror: null,
    postMessage() {
      setTimeout(() => failing.onerror?.(new Error('blocked by CSP')), 0);
    },
    terminate() {},
  };
  const a = await solvePow('s1', 10, { timeoutMs: 5000, createWorker: () => failing });
  assert.ok(a !== null && zeroBits('s1', a) >= 10);
  const b = await solvePow('s2', 10, { timeoutMs: 5000, createWorker: () => null });
  assert.ok(b !== null && zeroBits('s2', b) >= 10);
  const c = await solvePow('s3', 10, {
    timeoutMs: 5000,
    createWorker: () => {
      throw new Error('no workers here');
    },
  });
  assert.ok(c !== null && zeroBits('s3', c) >= 10);
});

test('a worker that never answers is stopped at the deadline', async () => {
  let terminated = false;
  const silent: PowWorker = { onmessage: null, onerror: null, postMessage() {}, terminate: () => void (terminated = true) };
  const start = Date.now();
  assert.equal(await solvePow('s', 8, { timeoutMs: 150, createWorker: () => silent }), null);
  assert.ok(Date.now() - start < 1000);
  assert.equal(terminated, true);
});
