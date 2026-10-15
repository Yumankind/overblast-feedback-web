import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom.ts';
import { Capture, formatValue, MAX_LOGS } from '../src/capture.ts';

/** A window with nothing but what Capture touches, so every original is ours to inspect. */
function fakeWindow() {
  const seen: unknown[][] = [];
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const con = {
    debug(...a: unknown[]) {
      seen.push(['debug', this, ...a]);
      return 'debug-result';
    },
    info(...a: unknown[]) {
      seen.push(['info', this, ...a]);
    },
    log(...a: unknown[]) {
      seen.push(['log', this, ...a]);
      return 'log-result';
    },
    warn(...a: unknown[]) {
      seen.push(['warn', this, ...a]);
    },
    error(...a: unknown[]) {
      seen.push(['error', this, ...a]);
      throw new Error('console.error itself threw');
    },
  };
  class FakeXhr extends EventTarget {
    status = 0;
    opened: unknown[] = [];
    sent: unknown[] = [];
    open(...a: unknown[]) {
      this.opened = a;
      return 'open-result';
    }
    send(...a: unknown[]) {
      this.sent = a;
      return 'send-result';
    }
    finish(status: number) {
      this.status = status;
      this.dispatchEvent(new Event('loadend'));
    }
  }
  const win = {
    console: con,
    fetch: async function (this: unknown, input: unknown, init?: RequestInit) {
      (win as { lastThis?: unknown }).lastThis = this;
      const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
      if (url.includes('fail')) throw new TypeError('Failed to fetch');
      if (url.includes('sync')) throw new Error('never reached');
      return new Response('ok', { status: url.includes('500') ? 500 : 200, headers: { 'x-method': init?.method ?? 'GET' } });
    },
    XMLHttpRequest: FakeXhr,
    addEventListener(type: string, fn: (e: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      listeners.get(type)?.delete(fn);
    },
    emit(type: string, e: Event) {
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
    listeners,
  };
  return { win, seen, con, FakeXhr };
}

function installed(opts: { console?: boolean; network?: boolean; step?: number } = {}) {
  const f = fakeWindow();
  let now = 1_000;
  const step = opts.step ?? 5;
  const cap = new Capture({ console: opts.console ?? true, network: opts.network ?? true, ignoreUrl: 'https://brain.deployd.network/v1/feedback', now: () => (now += step) });
  cap.install(f.win as unknown as Window & typeof globalThis);
  return { ...f, cap };
}

test('console: transparent (arguments, this, return value, throws) and recorded, redacted', () => {
  const { win, seen, cap } = installed();
  const original = fakeWindow().con.log;
  assert.notEqual(win.console.log, original);
  assert.equal(win.console.log('hello', { a: 1 }, 'Bearer abcdefghijklmnop'), 'log-result');
  assert.equal(seen[0]![1], win.console, '`this` is the console');
  assert.deepEqual(seen[0]!.slice(2), ['hello', { a: 1 }, 'Bearer abcdefghijklmnop'], 'the original got the original arguments');
  assert.throws(() => win.console.error('x'), /console.error itself threw/);
  const logs = cap.logs.list();
  assert.equal(logs.length, 2);
  assert.deepEqual({ ...logs[0], t: 0 }, { t: 0, level: 'info', msg: 'hello {"a":1} Bearer [redacted]', src: 'console' });
  assert.equal(logs[1]!.level, 'error');
  win.console.debug('d');
  win.console.warn('w');
  assert.deepEqual(cap.logs.list().map((l) => l.level), ['info', 'error', 'debug', 'warn']);
});

test('console: each line at most 4000 characters; the buffer holds far more than the excerpt', () => {
  // 25 ms a line: 40 a second, under the intake cap, so every line is kept.
  const { win, cap } = installed({ step: 25 });
  for (let i = 0; i < 700; i++) win.console.info(`line ${i}`);
  win.console.info('x'.repeat(10_000));
  const logs = cap.logs.list();
  assert.equal(logs.length, 701);
  assert.ok(logs.length > MAX_LOGS);
  assert.equal(logs[0]!.msg, 'line 0');
  assert.equal(logs.at(-1)!.msg.length, 4000);
});

test('console: uninstall restores the originals; a wrapper installed over ours keeps working', () => {
  const { win, cap } = installed();
  const ours = win.console.warn;
  const theirs = function (...a: unknown[]) {
    return ours.apply(win.console, a);
  };
  win.console.warn = theirs;
  const logBefore = win.console.log;
  cap.uninstall();
  assert.notEqual(win.console.log, logBefore, 'ours was on top: the original is back');
  assert.equal(win.console.warn, theirs, 'theirs was on top: left in place');
  win.console.warn('after');
  assert.equal(cap.logs.list().length, 0, 'ours is a pass-through now');
});

test('errors and unhandled rejections', () => {
  const { win, cap } = installed();
  const err = new Error('boom token=abc');
  const ev = Object.assign(new Event('error'), { message: 'boom', error: err, filename: 'https://a.example/app.js?v=3', lineno: 10, colno: 4 });
  Object.setPrototypeOf(ev, ErrorEvent.prototype);
  win.emit('error', ev);
  const rej = Object.assign(new Event('unhandledrejection'), { reason: new TypeError('nope') });
  win.emit('unhandledrejection', rej);
  const logs = cap.logs.list();
  assert.equal(logs[0]!.src, 'onerror');
  assert.ok(logs[0]!.msg.includes('boom token=[redacted]'), logs[0]!.msg);
  assert.ok(logs[0]!.msg.includes('(https://a.example/app.js:10:4)'), logs[0]!.msg);
  assert.equal(logs[1]!.src, 'unhandledrejection');
  assert.ok(logs[1]!.msg.startsWith('Unhandled rejection: TypeError: nope'));
  cap.uninstall();
  assert.equal(win.listeners.get('error')!.size, 0);
  assert.equal(win.listeners.get('unhandledrejection')!.size, 0);
});

test('fetch: same response, same rejection, same `this`; recorded without query', async () => {
  const { win, cap } = installed();
  const res = await win.fetch('https://api.example.com/cart?id=3#x', { method: 'post' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-method'), 'post', 'init passed through');
  assert.equal((win as { lastThis?: unknown }).lastThis, win, '`this` preserved');
  await win.fetch(new Request('https://api.example.com/500?x=1', { method: 'DELETE' }));
  await assert.rejects(win.fetch('https://api.example.com/fail?k=1'), TypeError);
  // The library's own endpoint is never recorded.
  await win.fetch('https://brain.deployd.network/v1/feedback');
  const net = cap.network.list();
  assert.deepEqual(
    net.map((n) => [n.method, n.url, n.status]),
    [
      ['POST', 'https://api.example.com/cart', 200],
      ['DELETE', 'https://api.example.com/500', 500],
      ['GET', 'https://api.example.com/fail', 0],
    ],
  );
  assert.ok(net.every((n) => n.ms >= 0 && Number.isInteger(n.ms)));
  cap.uninstall();
  assert.equal(typeof win.fetch, 'function');
  await win.fetch('https://api.example.com/after');
  assert.equal(cap.network.list().length, 3, 'nothing recorded after uninstall');
});

test('fetch: the original is kept for the library to send with', () => {
  const { win, cap } = installed();
  assert.ok(cap.originalFetch);
  assert.notEqual(cap.originalFetch, win.fetch);
});

test('XMLHttpRequest: transparent and recorded at loadend', () => {
  const { win, cap, FakeXhr } = installed();
  const xhr = new win.XMLHttpRequest() as InstanceType<typeof FakeXhr>;
  assert.equal(xhr.open('PUT', 'https://api.example.com/items/4?token=x', true), 'open-result');
  assert.deepEqual(xhr.opened, ['PUT', 'https://api.example.com/items/4?token=x', true]);
  assert.equal(xhr.send('{"a":1}'), 'send-result');
  assert.deepEqual(xhr.sent, ['{"a":1}']);
  xhr.finish(404);
  const failed = new win.XMLHttpRequest() as InstanceType<typeof FakeXhr>;
  failed.open('GET', '/x');
  failed.send();
  failed.finish(0);
  assert.deepEqual(
    cap.network.list().map((n) => [n.method, n.url, n.status]),
    [
      ['PUT', 'https://api.example.com/items/4', 404],
      ['GET', 'https://shop.example.com/x', 0],
    ],
  );
  const proto = FakeXhr.prototype as unknown as { open: unknown };
  const wrapped = proto.open;
  cap.uninstall();
  assert.notEqual(proto.open, wrapped, 'prototype restored');
});

test('nothing is wrapped when capture is off', () => {
  const { win, cap } = installed({ console: false, network: false });
  const f = fakeWindow();
  assert.equal(win.console.log.toString(), f.con.log.toString());
  assert.equal(win.fetch.toString(), f.win.fetch.toString());
  assert.ok(cap.originalFetch);
});

test('formatValue never throws', () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assert.equal(formatValue(circular), '{"a":1,"self":"[Circular]"}');
  assert.equal(formatValue(10n), '10');
  assert.equal(formatValue({ n: 10n, f() {} }), '{"n":"10n","f":"[Function]"}');
  const hostile = { toJSON() { throw new Error('no'); } };
  assert.equal(typeof formatValue(hostile), 'string');
  assert.equal(formatValue(undefined), 'undefined');
});
