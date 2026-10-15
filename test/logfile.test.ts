/**
 * `logFile` (contract §3.5): gzip NDJSON through `CompressionStream`, identity without it, cut from
 * the oldest end to fit with a first line that says so, and shrunk to leave the screenshot room.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { LOG_FILE_MAX, MAX_BODY_BYTES, attachLogFile, buildLogFile } from '../src/logfile.ts';
import { buildBody, utf8Length } from '../src/payload.ts';
import type { LogEntry, LogFileBody } from '../src/types.ts';

const T0 = 1_760_440_000_000;

function decode(file: LogFileBody): LogEntry[] {
  const bytes = Buffer.from(file.base64, 'base64');
  const text = (file.encoding === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8');
  assert.ok(text.endsWith('\n'));
  return text.trimEnd().split('\n').map((l) => JSON.parse(l) as LogEntry);
}

const lines = (n: number, size = 20): LogEntry[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * 1000, level: i % 10 ? 'info' : 'error', msg: `${i} ${randomBytes(size).toString('base64')}`, src: 'console' }));

test('gzip round trip: every entry, oldest first, with the count and the first and last times', async () => {
  const entries = lines(3000);
  entries[5] = { ...entries[5]!, repeat: 7, last: T0 + 5500 };
  const file = (await buildLogFile(entries))!;
  assert.equal(file.contentType, 'application/x-ndjson');
  assert.equal(file.encoding, 'gzip');
  assert.equal(Buffer.from(file.base64, 'base64')[0], 0x1f, 'gzip magic');
  assert.deepEqual(decode(file), entries);
  assert.equal(file.lines, 3000);
  assert.equal(file.from, T0);
  assert.equal(file.to, T0 + 2_999_000);
  assert.ok(LOG_FILE_MAX <= 4 * 1024 * 1024 && MAX_BODY_BYTES <= 8 * 1024 * 1024);
});

test('identity where CompressionStream is missing', async () => {
  const saved = globalThis.CompressionStream;
  try {
    (globalThis as { CompressionStream?: unknown }).CompressionStream = undefined;
    const file = (await buildLogFile(lines(10)))!;
    assert.equal(file.encoding, 'identity');
    assert.equal(decode(file).length, 10);
  } finally {
    globalThis.CompressionStream = saved;
  }
  assert.equal((await buildLogFile(lines(3), { compress: false }))!.encoding, 'identity');
});

test('too large: the oldest lines are cut, and the first line of the file says so', async () => {
  // Random text does not compress: 4,000 lines of ~280 bytes, into 64 KB of base64.
  const entries = lines(4000, 200);
  const max = 64 * 1024;
  const file = (await buildLogFile(entries, { maxBase64: max }))!;
  assert.ok(file.base64.length <= max, `${file.base64.length}`);
  const out = decode(file);
  const kept = out.length - 1;
  const cut = 4000 - kept;
  assert.ok(cut > 3000 && kept > 50, `${kept} kept`);
  assert.equal(out[0]!.level, 'warn');
  assert.equal(out[0]!.src, 'overblast');
  assert.match(out[0]!.msg, new RegExp(`^older lines cut to fit: ${cut.toLocaleString('en-US')} lines from \\d\\d:\\d\\d to \\d\\d:\\d\\d$`));
  assert.equal(out[0]!.t, entries[cut - 1]!.t);
  assert.deepEqual(out.slice(1), entries.slice(cut), 'the newest lines, untouched');
  assert.equal(file.lines, out.length);
  assert.equal(file.from, entries[cut - 1]!.t);
  assert.equal(file.to, entries.at(-1)!.t);
  assert.equal(await buildLogFile(entries, { maxBase64: 100 }), null, 'no room at all: no file');
  assert.equal(await buildLogFile([]), null);
});

test('with a 5 MB screenshot the log file shrinks to keep the body under 8 MB', async () => {
  const entries = lines(6000, 300);
  const screenshot = Buffer.alloc(5 * 1024 * 1024 - 16, 1).toString('base64');
  const body = buildBody({
    message: 'with everything',
    context: { platform: 'web' },
    screenshot: { contentType: 'image/jpeg', base64: screenshot, highlighted: false },
    logs: entries,
  });
  const alone = (await buildLogFile(entries, { compress: false }))!;
  await attachLogFile(body, entries, { compress: false });
  const size = utf8Length(JSON.stringify(body));
  assert.ok(body.logFile, 'a smaller file still went');
  assert.ok(body.logFile!.base64.length < alone.base64.length, 'shrunk');
  assert.ok(size <= MAX_BODY_BYTES, `${size} bytes`);
  assert.equal(body.screenshot!.base64.length, screenshot.length, 'the screenshot untouched');
  assert.match(decode(body.logFile!)[0]!.msg, /^older lines cut to fit/);

  // When the excerpt already holds every line, there is no file.
  const few = lines(20);
  const small = buildBody({ message: 'few', context: { platform: 'web' }, logs: few });
  await attachLogFile(small, few);
  assert.equal(small.logs!.length, 20);
  assert.equal(small.logFile, undefined);

  // With no room left at all, the body goes without the file.
  const full = buildBody({ message: 'x', context: { platform: 'web' } });
  await attachLogFile(full, entries, { maxBody: utf8Length(JSON.stringify(full)) + 100 });
  assert.equal(full.logFile, undefined);
});
