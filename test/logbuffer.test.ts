/**
 * The log buffer and the excerpt (contract §3.5): the per-second intake cap and its marker, repeats,
 * redaction only on kept lines, the line and byte budgets with their eviction order, and how the
 * 500-entry excerpt is chosen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUFFER_MAX_BYTES, BUFFER_MAX_LINES, LogBuffer, RATE_LINES, RATE_URGENT, groupDigits } from '../src/logbuffer.ts';
import { Capture } from '../src/capture.ts';
import { EXCERPT_URGENT_WINDOW_MS, MAX_LOG_BYTES, excerpt, utf8Length } from '../src/payload.ts';
import type { LogEntry, LogLevel } from '../src/types.ts';

const T0 = 1_760_440_000_000;

test('a storm of 10,000 lines in one tick: a bounded number formatted, the rest counted, one marker', () => {
  let formatted = 0;
  const buf = new LogBuffer({ now: () => T0 });
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    buf.add('info', 'console', () => {
      formatted++;
      return `line ${i} token=secret${i}`;
    });
  }
  const took = performance.now() - start;
  assert.equal(formatted, RATE_LINES, 'only the kept lines were formatted (and so redacted)');
  assert.ok(took < 200, `the storm took ${took.toFixed(1)} ms`);
  const logs = buf.list();
  assert.equal(logs.length, RATE_LINES + 1);
  assert.ok(logs.slice(0, RATE_LINES).every((l) => l.msg.endsWith('token=[redacted]')));
  assert.deepEqual(logs.at(-1), { t: T0, level: 'warn', msg: '9,950 lines dropped in 1 s (too fast)', src: 'overblast' });
});

test('the same storm through the console wrapper never formats the dropped arguments', () => {
  let stringified = 0;
  const heavy = { toJSON: () => (stringified++, { big: 'x'.repeat(100) }) };
  const con = { info: () => undefined, error: () => undefined, warn: () => undefined, log: () => undefined, debug: () => undefined };
  const win = { console: con, addEventListener() {}, removeEventListener() {} } as unknown as Window & typeof globalThis;
  const cap = new Capture({ console: true, network: false, now: () => T0 });
  cap.install(win);
  for (let i = 0; i < 10_000; i++) (win.console as unknown as { error: (...a: unknown[]) => void }).error('boom', heavy);
  assert.equal(stringified, RATE_URGENT, 'the 200 kept were formatted (to compare them); the 9,800 dropped never were');
  const logs = cap.logs.list();
  assert.equal(logs[0]!.repeat, RATE_URGENT);
  assert.equal(logs.at(-1)!.msg, '9,800 lines dropped in 1 s (too fast)');
  cap.uninstall();
});

test('errors and warnings go in up to 200 a second, debug and info up to 50, sharing the count', () => {
  const buf = new LogBuffer({ now: () => T0 });
  for (let i = 0; i < 40; i++) buf.add('info', 'c', `i${i}`);
  for (let i = 0; i < 300; i++) buf.add('error', 'c', `e${i}`);
  for (let i = 0; i < 10; i++) buf.add('debug', 'c', `d${i}`);
  const logs = buf.list();
  assert.equal(logs.filter((l) => l.level === 'info').length, 40);
  assert.equal(logs.filter((l) => l.level === 'error').length, 160);
  assert.equal(logs.filter((l) => l.level === 'debug').length, 0);
  assert.equal(logs.at(-1)!.msg, '150 lines dropped in 1 s (too fast)');
});

test('the marker is written once the storm has passed, before the lines after it, spanning its seconds', () => {
  let now = T0;
  const buf = new LogBuffer({ now: () => now });
  for (let s = 0; s < 3; s++) {
    now = T0 + s * 1000;
    for (let i = 0; i < 100; i++) buf.add('info', 'c', `s${s} ${i}`);
  }
  now = T0 + 2500;
  buf.add('info', 'c', 'still inside the storm: dropped too');
  now = T0 + 5000;
  buf.add('info', 'c', 'after the storm');
  const logs = buf.list();
  const marker = logs.findIndex((l) => l.src === 'overblast');
  assert.equal(logs[marker]!.msg, '151 lines dropped in 3 s (too fast)');
  assert.equal(logs[marker + 1]!.msg, 'after the storm');
  assert.equal(logs.filter((l) => l.src === 'overblast').length, 1);
  assert.equal(groupDigits(1204), '1,204');
  assert.equal(groupDigits(1234567), '1,234,567');
});

test('repeats collapse into the line before, with a count and the time of the last one', () => {
  let now = T0;
  const buf = new LogBuffer({ now: () => (now += 300) });
  for (let i = 0; i < 5; i++) buf.add('error', 'console', 'Network down');
  buf.add('error', 'onerror', 'Network down');
  buf.add('warn', 'onerror', 'Network down');
  buf.add('warn', 'onerror', 'Network down');
  const logs = buf.list();
  assert.equal(logs.length, 3);
  assert.deepEqual(logs[0], { t: T0 + 300, level: 'error', msg: 'Network down', src: 'console', repeat: 5, last: T0 + 1500 });
  assert.equal(logs[1]!.repeat, undefined, 'another source is another line, and once has no count');
  assert.equal(logs[2]!.repeat, 2);
});

test('the line budget: oldest debug and info go first, errors and warnings outlive them', () => {
  let now = T0;
  const buf = new LogBuffer({ maxLines: 10, now: () => (now += 100) });
  buf.add('error', 'c', 'old error');
  buf.add('warn', 'c', 'old warning');
  for (let i = 0; i < 30; i++) buf.add(i % 2 ? 'debug' : 'info', 'c', `chatter ${i}`);
  const logs = buf.list();
  assert.equal(logs.length, 10);
  assert.deepEqual(logs.slice(0, 2).map((l) => l.msg), ['old error', 'old warning']);
  assert.deepEqual(logs.slice(2).map((l) => l.msg), Array.from({ length: 8 }, (_, i) => `chatter ${22 + i}`));
  // With nothing low left, the oldest error goes.
  for (let i = 0; i < 12; i++) buf.add('error', 'c', `new error ${i}`);
  assert.deepEqual(buf.list().map((l) => l.msg), Array.from({ length: 10 }, (_, i) => `new error ${2 + i}`));
});

test('the byte budget, and the defaults: 1 MB and 20,000 lines', () => {
  let now = T0;
  const buf = new LogBuffer({ maxBytes: 100 * 1024 * 1024, now: () => (now += 30) });
  assert.equal(BUFFER_MAX_LINES, 20_000);
  assert.equal(BUFFER_MAX_BYTES, 1024 * 1024);
  for (let i = 0; i < 25_000; i++) buf.add('info', 'c', `n${i}`);
  assert.equal(buf.length, 20_000);
  assert.equal(buf.list()[0]!.msg, 'n5000');
  const big = new LogBuffer({ now: () => (now += 30) });
  big.add('error', 'c', 'the one error');
  for (let i = 0; i < 2000; i++) big.add('info', 'c', `${i} ${'x'.repeat(3000)}`);
  assert.ok(big.byteSize <= BUFFER_MAX_BYTES, `${big.byteSize}`);
  const serialised = big.list().reduce((n, l) => n + utf8Length(JSON.stringify(l)) + 1, 0);
  assert.ok(serialised <= BUFFER_MAX_BYTES, `${serialised} bytes as NDJSON`);
  assert.equal(big.list()[0]!.msg, 'the one error');
});

test('paused: nothing enters; resumed: lines enter again', () => {
  const buf = new LogBuffer({ now: () => T0 });
  buf.paused = true;
  buf.add('error', 'c', 'while the sheet is open');
  assert.equal(buf.length, 0);
  buf.paused = false;
  buf.add('error', 'c', 'after');
  assert.deepEqual(buf.list().map((l) => l.msg), ['after']);
});

test('adopting the early recorder\'s lines: their timestamps kept, repeats collapsed, drops marked', () => {
  const buf = new LogBuffer({ now: () => T0 + 10_000 });
  buf.adopt(
    [
      { t: T0 + 1, level: 'error', msg: 'boom token=abc', src: 'console' },
      { t: T0 + 2, level: 'error', msg: 'boom token=abc', src: 'console' },
      { t: T0 + 3, level: 'error', msg: 'boom token=abc', src: 'console' },
      { t: T0 + 4, level: 'warn', msg: 'other', src: 'console' },
    ],
    12,
  );
  buf.add('info', 'console', 'after init');
  const logs = buf.list();
  assert.deepEqual(logs[0], { t: T0 + 1, level: 'error', msg: 'boom token=[redacted]', src: 'console', repeat: 3, last: T0 + 3 });
  assert.equal(logs[1]!.t, T0 + 4);
  assert.deepEqual(logs[2], { t: T0 + 4, level: 'warn', msg: '12 lines dropped in 1 s (too fast)', src: 'overblast' });
  assert.equal(logs[3]!.msg, 'after init');
});

// ── The excerpt ───────────────────────────────────────────────────────────────────────────────

function entry(t: number, level: LogLevel, msg: string): LogEntry {
  return { t, level, msg, src: 'console' };
}

test('excerpt: every error and warning of the two minutes before openedAt, then the newest others', () => {
  const openedAt = T0 + 600_000;
  const logs: LogEntry[] = [];
  logs.push(entry(openedAt - EXCERPT_URGENT_WINDOW_MS - 5_000, 'error', 'too old to be sure of'));
  for (let i = 0; i < 1000; i++) logs.push(entry(openedAt - 300_000 + i * 290, 'info', `info ${i}`));
  logs.splice(100, 0, entry(openedAt - 110_000, 'error', 'recent error'));
  logs.splice(400, 0, entry(openedAt - 60_000, 'warn', 'recent warning'));
  logs.push(entry(openedAt - 1, 'error', 'just before'));
  const ex = excerpt(logs, openedAt);
  assert.equal(ex.length, 500);
  const msgs = ex.map((l) => l.msg);
  for (const m of ['recent error', 'recent warning', 'just before']) assert.ok(msgs.includes(m), m);
  assert.ok(!msgs.includes('too old to be sure of'));
  // The rest are the newest info lines, and the order is the buffer's.
  assert.ok(msgs.includes('info 999') && !msgs.includes('info 400'));
  const times = ex.map((l) => l.t);
  assert.ok(logs.map((l) => l.msg).filter((m) => msgs.includes(m)).every((m, i) => m === msgs[i]));
  assert.ok(times.length === 500);
});

test('excerpt: more urgent lines than fit keeps the newest of them; 256 KB holds', () => {
  const openedAt = T0 + 1_000_000;
  const logs: LogEntry[] = [];
  for (let i = 0; i < 700; i++) logs.push(entry(openedAt - 100_000 + i * 100, 'error', `e${i}`));
  const ex = excerpt(logs, openedAt);
  assert.equal(ex.length, 500);
  assert.equal(ex[0]!.msg, 'e200');
  const big: LogEntry[] = Array.from({ length: 300 }, (_, i) => entry(openedAt - 50_000 + i, i % 3 ? 'info' : 'warn', `${i} ${'é'.repeat(1500)}`));
  const ex2 = excerpt(big, openedAt);
  assert.ok(utf8Length(JSON.stringify(ex2)) <= MAX_LOG_BYTES);
  assert.ok(ex2.filter((l) => l.level === 'warn').length > ex2.filter((l) => l.level === 'info').length, 'warnings first');
  // `repeat` and `last` travel with the entry.
  const r = excerpt([{ ...entry(openedAt - 10, 'error', 'x'), repeat: 3, last: openedAt - 5 }], openedAt);
  assert.deepEqual(r[0], { t: openedAt - 10, level: 'error', msg: 'x', src: 'console', repeat: 3, last: openedAt - 5 });
});
