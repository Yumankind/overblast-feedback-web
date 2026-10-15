/**
 * The proof of work a browser pays to register a device (contract §8.2): a `powNonce` such that
 * `SHA-256("<salt>:<powNonce>")` starts with `difficulty` zero bits.
 *
 * WebCrypto's `digest` is asynchronous, and a promise per attempt costs more than the hash itself,
 * so the search runs on a small synchronous SHA-256 instead. It runs in a Web Worker built from a
 * Blob URL, so the page never janks; where a worker cannot be made (a CSP without `blob:`, an old
 * browser) it runs on the main thread in slices of a few milliseconds that yield between them. Either
 * way it gives up at a deadline, and the report is sent unsigned rather than late.
 *
 * `makePow` is written to be self-contained: the worker's source is its own `toString()`, so it may
 * not refer to anything outside its body (no imports, no module constants, no classes that a
 * compiler would lower with a helper).
 */

export interface Pow {
  /** SHA-256 of `bytes`, for the tests. */
  sha256(bytes: Uint8Array): Uint8Array;
  /** The first counter in `[start, start + count)` whose `"<prefix><counter>"` hash qualifies, or -1. */
  search(prefix: string, difficulty: number, start: number, count: number): number;
}

export function makePow(): Pow {
  // Int32Array, and every intermediate kept to int32 with `| 0`: a Uint32Array hands back values
  // past 2^31, which the engine may have to hold as doubles in the hot loop.
  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const W = new Int32Array(64);
  const H = new Int32Array(8);
  let buf = new Uint8Array(256);
  let cachedPrefix: string | null = null;
  let prefixLen = 0;

  /** Hash `buf[0, len)` into `H`. The padding is written into `buf` past `len`. */
  function hashBuf(len: number): void {
    const total = ((len + 9 + 63) >>> 6) << 6;
    if (buf.length < total) {
      const bigger = new Uint8Array(total * 2);
      bigger.set(buf.subarray(0, len));
      buf = bigger;
    }
    buf[len] = 0x80;
    for (let i = len + 1; i < total - 4; i++) buf[i] = 0;
    const bits = len * 8;
    buf[total - 4] = (bits >>> 24) & 0xff;
    buf[total - 3] = (bits >>> 16) & 0xff;
    buf[total - 2] = (bits >>> 8) & 0xff;
    buf[total - 1] = bits & 0xff;
    let h0 = 0x6a09e667 | 0, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372 | 0, h3 = 0xa54ff53a | 0;
    let h4 = 0x510e527f | 0, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab | 0, h7 = 0x5be0cd19 | 0;
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        W[i] = (buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!;
      }
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15]!;
        const b = W[i - 2]!;
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (((W[i - 16]! + s0) | 0) + ((W[i - 7]! + s1) | 0)) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (((((h + S1) | 0) + ch) | 0) + ((K[i]! + W[i]!) | 0)) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0;
      h1 = (h1 + b) | 0;
      h2 = (h2 + c) | 0;
      h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0;
      h5 = (h5 + f) | 0;
      h6 = (h6 + g) | 0;
      h7 = (h7 + h) | 0;
    }
    H[0] = h0;
    H[1] = h1;
    H[2] = h2;
    H[3] = h3;
    H[4] = h4;
    H[5] = h5;
    H[6] = h6;
    H[7] = h7;
  }

  function zeroBits(difficulty: number): boolean {
    let d = difficulty;
    let i = 0;
    while (d >= 32) {
      if (H[i] !== 0) return false;
      i++;
      d -= 32;
    }
    return d === 0 || H[i]! >>> (32 - d) === 0;
  }

  function setPrefix(prefix: string): void {
    if (prefix === cachedPrefix) return;
    const bytes = new TextEncoder().encode(prefix);
    if (buf.length < bytes.length + 96) buf = new Uint8Array((bytes.length + 96) * 2);
    buf.set(bytes);
    prefixLen = bytes.length;
    cachedPrefix = prefix;
  }

  return {
    sha256(bytes: Uint8Array): Uint8Array {
      cachedPrefix = null;
      if (buf.length < bytes.length + 72) buf = new Uint8Array(bytes.length + 72);
      buf.set(bytes);
      hashBuf(bytes.length);
      const out = new Uint8Array(32);
      for (let i = 0; i < 8; i++) {
        out[i * 4] = (H[i]! >>> 24) & 0xff;
        out[i * 4 + 1] = (H[i]! >>> 16) & 0xff;
        out[i * 4 + 2] = (H[i]! >>> 8) & 0xff;
        out[i * 4 + 3] = H[i]! & 0xff;
      }
      return out;
    },
    search(prefix: string, difficulty: number, start: number, count: number): number {
      setPrefix(prefix);
      const end = start + count;
      for (let n = start; n < end; n++) {
        const digits = String(n);
        let len = prefixLen;
        for (let i = 0; i < digits.length; i++) buf[len++] = digits.charCodeAt(i);
        hashBuf(len);
        if (zeroBits(difficulty)) return n;
      }
      return -1;
    },
  };
}

/** What a worker runs: `{ prefix, difficulty }` in, `{ nonce }` out once found. */
export function workerSource(): string {
  return (
    `const makePow = ${makePow.toString()};\n` +
    'const pow = makePow();\n' +
    'self.onmessage = function (e) {\n' +
    '  const d = e.data;\n' +
    '  for (let n = 0; ; n += 20000) {\n' +
    '    const r = pow.search(d.prefix, d.difficulty, n, 20000);\n' +
    '    if (r >= 0) { self.postMessage({ nonce: String(r) }); return; }\n' +
    '  }\n' +
    '};\n'
  );
}

/** The few methods of a `Worker` this file uses, so a test can stand one in. */
export interface PowWorker {
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  postMessage(data: unknown): void;
  terminate(): void;
}

export type WorkerFactory = (source: string) => PowWorker | null;

/** A worker from a Blob URL, or null when this browser or this page's CSP will not make one. */
export function blobWorker(source: string): PowWorker | null {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    return new Worker(url) as unknown as PowWorker;
  } catch {
    return null;
  } finally {
    // The worker has fetched its script by the time it runs; revoking later keeps Safari happy.
    if (url) {
      const u = url;
      setTimeout(() => URL.revokeObjectURL(u), 10_000);
    }
  }
}

/** Yield to the page: `scheduler.postTask` at background priority where it exists, else a timeout. */
function yieldToPage(): Promise<void> {
  const s = (globalThis as { scheduler?: { postTask?: (cb: () => void, o: { priority: string }) => Promise<void> } }).scheduler;
  if (s && typeof s.postTask === 'function') {
    try {
      return s.postTask(() => undefined, { priority: 'background' });
    } catch {
      /* fall through */
    }
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** On the main thread, in slices of about `sliceMs`, until found or `deadline`. */
export async function solveOnMainThread(salt: string, difficulty: number, deadline: number, sliceMs = 8): Promise<string | null> {
  const pow = makePow();
  const prefix = `${salt}:`;
  let n = 0;
  const step = 500;
  while (Date.now() < deadline) {
    const sliceEnd = Math.min(deadline, Date.now() + sliceMs);
    do {
      const r = pow.search(prefix, difficulty, n, step);
      if (r >= 0) return String(r);
      n += step;
    } while (Date.now() < sliceEnd);
    await yieldToPage();
  }
  return null;
}

export interface SolveOptions {
  /** Give up after this many milliseconds. */
  timeoutMs: number;
  /** Default `blobWorker`; return null to solve on the main thread. */
  createWorker?: WorkerFactory | undefined;
}

/** Solve the challenge, in a worker when one can be made; null when the deadline passed first. */
export function solvePow(salt: string, difficulty: number, opts: SolveOptions): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  let worker: PowWorker | null = null;
  try {
    worker = (opts.createWorker ?? blobWorker)(workerSource());
  } catch {
    worker = null;
  }
  if (!worker) return solveOnMainThread(salt, difficulty, deadline);
  const w = worker;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null | 'fallback') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        w.terminate();
      } catch {
        /* already gone */
      }
      // A worker that failed to start (a CSP that refuses `blob:` reports it as an error event)
      // hands the rest of the time to the main thread.
      if (v === 'fallback') void solveOnMainThread(salt, difficulty, deadline).then(resolve);
      else resolve(v);
    };
    const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    w.onmessage = (e) => {
      const nonce = (e.data as { nonce?: unknown } | null)?.nonce;
      finish(typeof nonce === 'string' ? nonce : 'fallback');
    };
    w.onerror = () => finish('fallback');
    try {
      w.postMessage({ prefix: `${salt}:`, difficulty });
    } catch {
      finish('fallback');
    }
  });
}
