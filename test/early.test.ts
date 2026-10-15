/**
 * `@overblast/feedback/early`: what it records before the library loads, its cap and redaction, and
 * `init()` adopting it: entries kept with their timestamps, wrappers taken over without a second
 * layer, the buffer removed.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { page } from './dom.ts';
import { EARLY_KEY, EARLY_MAX, startEarly } from '../src/early.ts';
import { EARLY_KEY as CAPTURE_EARLY_KEY } from '../src/capture.ts';
import { init } from '../src/index.ts';
import type { EarlyBuffer, FeedbackBody, FeedbackInstance } from '../src/types.ts';

type AnyFn = (...a: unknown[]) => unknown;
const con = console as unknown as Record<string, AnyFn>;
const win = window as unknown as Record<string, unknown>;

// The page's own functions before anything wraps them, and what they saw.
const seen: Array<[string, unknown[]]> = [];
const trueWarn: AnyFn = (...a) => void seen.push(['warn', a]);
const trueError: AnyFn = (...a) => void seen.push(['error', a]);
const trueFetch = (async (input: unknown) => {
  const url = String(input);
  if (url.includes('/down')) throw new TypeError('Failed to fetch');
  return new Response('{}', { status: url.includes('/bad') ? 500 : 200 });
}) as unknown as AnyFn;

function freshPage(): void {
  con.warn = trueWarn;
  con.error = trueError;
  win.fetch = trueFetch;
  delete win[EARLY_KEY];
  seen.length = 0;
}

const early = () => win[EARLY_KEY] as EarlyBuffer | undefined;

let fb: FeedbackInstance | null = null;
afterEach(() => {
  fb?.destroy();
  fb = null;
  freshPage();
});

function door() {
  const bodies: FeedbackBody[] = [];
  const f = (async (_u: string, i: RequestInit) => {
    bodies.push(JSON.parse(new TextDecoder().decode(i.body as Uint8Array)) as FeedbackBody);
    return new Response(JSON.stringify({ id: 'fbr_1', taskId: 't', conversationId: null }), { status: 201 });
  }) as unknown as typeof fetch;
  return { f, bodies };
}

test('one key, spelled the same on both sides', () => {
  assert.equal(EARLY_KEY, CAPTURE_EARLY_KEY);
  assert.equal(EARLY_KEY, '__overblastFeedbackEarly');
});

test('records warnings, errors, uncaught errors, rejections and failed requests, redacted', async () => {
  freshPage();
  const buf = startEarly({ fetch: true })!;
  assert.equal(early(), buf);
  assert.equal(startEarly(), buf, 'a second start is the same buffer');
  console.warn('slow down', { token: 'abc123' });
  console.error('boom Bearer abcdefghijklmnop', new Error('kaput'));
  assert.equal(seen.length, 2, 'the page\'s own console still ran');
  window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught', filename: 'https://shop.example.com/app.js?v=3', lineno: 10, colno: 4, error: new Error('exploded password=hunter2') }));
  window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'nope sk-abcdefghijklmnopqrstuvwxyz' }));
  await (window.fetch as AnyFn)('https://api.example.com/ok?x=1');
  await (window.fetch as AnyFn)('https://api.example.com/bad?token=1', { method: 'post' });
  await assert.rejects((window.fetch as AnyFn)('https://api.example.com/down') as Promise<unknown>);

  const logs = buf.logs;
  assert.equal(logs.length, 4);
  assert.equal(logs[0]!.msg, 'slow down {"token":"[redacted]"}');
  assert.ok(logs[1]!.msg.startsWith('boom Bearer [redacted] Error: kaput'), logs[1]!.msg);
  assert.equal(logs[2]!.src, 'onerror');
  assert.ok(logs[2]!.msg.includes('exploded password=[redacted]'), logs[2]!.msg);
  assert.ok(logs[2]!.msg.endsWith('(https://shop.example.com/app.js:10:4)'), logs[2]!.msg);
  assert.equal(logs[3]!.msg, 'Unhandled rejection: nope [redacted]');
  assert.deepEqual(
    buf.network.map((n) => [n.method, n.url, n.status]),
    [
      ['post', 'https://api.example.com/bad', 500],
      ['GET', 'https://api.example.com/down', 0],
    ],
  );
  assert.ok(logs.every((l) => typeof l.t === 'number' && l.t > 0));
});

test('at most 200 lines kept (the newest), and a storm in one second counted rather than formatted', () => {
  freshPage();
  const buf = startEarly()!;
  const realNow = Date.now;
  let now = realNow();
  try {
    Date.now = () => (now += 10); // 100 a second: under the cap, so the ring is what holds them
    for (let i = 0; i < 250; i++) console.warn(`line ${i}`);
  } finally {
    Date.now = realNow;
  }
  assert.equal(buf.logs.length, EARLY_MAX);
  assert.equal(buf.logs[0]!.msg, 'line 50');
  assert.equal(buf.dropped, 0);

  freshPage();
  const storm = startEarly()!;
  let formatted = 0;
  const heavy = { toJSON: () => (formatted++, 'x') };
  const fixed = realNow();
  try {
    Date.now = () => fixed;
    for (let i = 0; i < 1000; i++) console.error('again', heavy);
  } finally {
    Date.now = realNow;
  }
  assert.equal(formatted, 200);
  assert.equal(storm.dropped, 800);
});

test('init adopts the buffer: entries with their own times first, the buffer gone, one layer of wrapping', async () => {
  freshPage();
  page('<main></main>');
  startEarly({ fetch: true });
  console.error('before init 1');
  console.error('before init 1');
  await (window.fetch as AnyFn)('https://api.example.com/bad');
  const earlyTimes = early()!.logs.map((l) => l.t);
  const earlyWrapper = con.error;
  const { f, bodies } = door();
  fb = init({ key: 'obfk_early', fetch: f, device: false });
  assert.equal(early(), undefined, 'the buffer is cleared');
  assert.ok(!(EARLY_KEY in window));
  assert.notEqual(con.error, earlyWrapper, 'the early wrapper is no longer installed');

  seen.length = 0;
  console.error('after init');
  assert.equal(seen.length, 1, 'the page\'s console.error ran once');
  await fb.report({ message: 'with early lines' });
  const body = bodies[0]!;
  const errors = body.logs!.filter((l) => l.level === 'error');
  assert.deepEqual(
    errors.map((l) => [l.msg, l.repeat]),
    [
      ['before init 1', 2],
      ['after init', undefined],
    ],
  );
  assert.equal(errors[0]!.t, earlyTimes[0]);
  assert.ok(body.network!.some((n) => n.url === 'https://api.example.com/bad' && n.status === 500 && n.method === 'GET'));
  assert.equal(body.logFile, undefined, 'every line is in the excerpt: no file to repeat it');

  fb.destroy();
  fb = null;
  assert.equal(con.error, trueError, 'nothing of the early recorder is left in the chain');
  assert.equal(con.warn, trueWarn);
  assert.equal(win.fetch, trueFetch);
});

test('a wrapper put over the early one stays; the early one turns into a pass-through', async () => {
  freshPage();
  page('<main></main>');
  startEarly();
  const earlyWarn = con.warn!;
  const theirs: AnyFn = function (this: unknown, ...a: unknown[]) {
    return earlyWarn.apply(this, a);
  };
  con.warn = theirs;
  const { f, bodies } = door();
  fb = init({ key: 'obfk_early', fetch: f, device: false });
  console.warn('once');
  assert.equal(seen.filter(([k]) => k === 'warn').length, 1);
  await fb.report({ message: 'x' });
  assert.equal(bodies[0]!.logs!.filter((l) => l.msg === 'once').length, 1, 'recorded once, not twice');
  fb.destroy();
  fb = null;
  assert.equal(con.warn, theirs, 'their wrapper was on top: left in place');
});

test('the early entry imports nothing from the library but the redaction', () => {
  const src = readFileSync(new URL('../src/early.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./redact.ts', './types.ts']);
  assert.ok(/^import type .* from '\.\/types\.ts';$/m.test(src), 'types only, erased at build');
});
