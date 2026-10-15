/**
 * The key's settings (contract §2.1): read, kept with the ETag, re-read at most every five minutes,
 * used as kept when offline, the defaults before any answer; and what they switch in the library:
 * device registration, the screenshot option.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { page } from './dom.ts';
import 'fake-indexeddb/auto';
import { CONFIG_MAX_AGE_MS, ConfigClient, DEFAULT_CONFIG, configUrl, parseConfig } from '../src/config.ts';
import { DEVICE_HEADER } from '../src/device.ts';
import { init } from '../src/index.ts';
import type { FeedbackInstance } from '../src/types.ts';
import { json, makeDoor } from './door.ts';

window.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shadow = () => document.querySelector('overblast-feedback')?.shadowRoot ?? null;
const inSheet = <T extends Element>(sel: string) => shadow()!.querySelector<T>(sel);
const ENDPOINT = 'https://brain.deployd.network/v1/feedback';

let fb: FeedbackInstance | null = null;
afterEach(() => {
  fb?.destroy();
  fb = null;
  localStorage.clear();
});

function configDoor(answers: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const f = (async (url: string, i: RequestInit) => {
    calls.push({ url, headers: { ...(i.headers as Record<string, string>) } });
    const a = answers.shift();
    if (!a) throw new TypeError('Failed to fetch');
    return typeof a === 'function' ? a() : a;
  }) as unknown as typeof fetch;
  return { f, calls };
}

test('parse: defensive, defaults for anything missing; the url', () => {
  assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig({ verification: 'nonsense', errorPrompt: { enabled: 'yes', on: ['exception', 'bogus'], minHoursBetween: -1 }, screenshots: 0 }), {
    verification: 'off',
    errorPrompt: { enabled: false, on: ['exception'], minHoursBetween: 24 },
    screenshots: true,
  });
  assert.deepEqual(parseConfig({ verification: 'require', errorPrompt: { enabled: true, on: ['network'], minHoursBetween: 2 }, screenshots: false }), {
    verification: 'require',
    errorPrompt: { enabled: true, on: ['network'], minHoursBetween: 2 },
    screenshots: false,
  });
  assert.equal(configUrl(ENDPOINT), `${ENDPOINT}/config`);
  assert.equal(configUrl(`${ENDPOINT}/`), `${ENDPOINT}/config`);
});

test('kept with its ETag; If-None-Match next time; 304 keeps it; offline uses it; at most every five minutes', async () => {
  let now = 1_000_000;
  const answer = { verification: 'flag', errorPrompt: { enabled: true, on: ['exception'], minHoursBetween: 12 }, screenshots: false };
  const { f, calls } = configDoor([json(200, answer, { ETag: '"v1"' }), new Response(null, { status: 304 })]);
  const a = new ConfigClient({ endpoint: ENDPOINT, key: 'obfk_c', fetch: () => f, now: () => now });
  assert.equal(a.known, false);
  assert.deepEqual(a.current, DEFAULT_CONFIG, 'the defaults before any answer');
  let changed = 0;
  a.onChange(() => changed++);
  await a.maybeRefresh();
  assert.equal(calls[0]!.url, `${ENDPOINT}/config`);
  assert.equal(calls[0]!.headers['X-Overblast-Feedback-Key'], 'obfk_c');
  assert.equal(a.current.verification, 'flag');
  assert.equal(a.current.screenshots, false);
  assert.equal(changed, 1);

  now += CONFIG_MAX_AGE_MS - 1;
  await a.maybeRefresh();
  assert.equal(calls.length, 1, 'not again within five minutes');
  now += 1;
  await a.maybeRefresh();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.headers['If-None-Match'], '"v1"');
  assert.equal(a.current.verification, 'flag', '304: the kept answer stands');

  // A new page load, offline: the kept answer, at once and after the failed read.
  const offline = new ConfigClient({ endpoint: ENDPOINT, key: 'obfk_c', fetch: () => configDoor([]).f, now: () => now });
  assert.equal(offline.known, true);
  assert.equal(offline.current.errorPrompt.minHoursBetween, 12);
  await offline.refresh();
  assert.equal(offline.current.verification, 'flag');
  // Another key on the same site has its own answer.
  assert.equal(new ConfigClient({ endpoint: ENDPOINT, key: 'obfk_other', fetch: () => f }).known, false);
});

test('storage that throws: the answer holds for the page', async () => {
  const realSet = Storage.prototype.setItem;
  const realGet = Storage.prototype.getItem;
  Storage.prototype.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  Storage.prototype.getItem = () => {
    throw new Error('SecurityError');
  };
  try {
    const { f } = configDoor([json(200, { verification: 'require' })]);
    const c = new ConfigClient({ endpoint: ENDPOINT, key: 'obfk_x', fetch: () => f });
    await c.refresh();
    assert.equal(c.current.verification, 'require');
  } finally {
    Storage.prototype.setItem = realSet;
    Storage.prototype.getItem = realGet;
  }
});

test('verification off (the default): the sheet never registers a device', async () => {
  page('<main></main>');
  const door = makeDoor({ config: { verification: 'off' } });
  fb = init({ key: 'obfk_off', fetch: door.fetch });
  await wait(300);
  inSheet<HTMLButtonElement>('.fab')!.click();
  await wait(500);
  await fb.report({ message: 'unsigned' });
  assert.deepEqual(door.calls.map((c) => c.kind), ['config', 'report']);
  assert.equal(door.reports()[0]!.headers[DEVICE_HEADER], undefined);
});

test('before any answer: no device, even when the key turns out to want one', async () => {
  page('<main></main>');
  const door = makeDoor({ config: { verification: 'flag' } });
  fb = init({ key: 'obfk_early_report', fetch: door.fetch });
  await fb.report({ message: 'straight away' });
  assert.equal(door.reports()[0]!.headers[DEVICE_HEADER], undefined);
  assert.equal(door.count('challenge'), 0);
});

test('a stale answer and a door that says device_required: register and send once more', async () => {
  page('<main></main>');
  const door = makeDoor({ config: { verification: 'off' } });
  fb = init({ key: 'obfk_stale', fetch: door.fetch });
  await wait(300);
  door.next('report', json(403, { code: 'device_required', error: 'Registered devices only.' }));
  await fb.report({ message: 'needs a device' });
  const reports = door.reports();
  assert.equal(reports.length, 2, 'refused unsigned, then sent signed (the registration took under 3 s)');
  assert.equal(reports[0]!.headers[DEVICE_HEADER], undefined);
  assert.ok(reports.at(-1)!.headers[DEVICE_HEADER]);
  // And with `device: false` the refusal stands.
  fb.destroy();
  const door2 = makeDoor({ config: { verification: 'off' } });
  fb = init({ key: 'obfk_stale2', fetch: door2.fetch, device: false });
  await wait(300);
  door2.next('report', json(403, { code: 'device_required', error: 'Registered devices only.' }));
  await assert.rejects(fb.report({ message: 'x' }), /Registered devices only/);
});

test('screenshots off for the key: the sheet does not offer one, and report() takes none', async () => {
  page('<main></main>');
  const door = makeDoor({ config: { verification: 'off', screenshots: false } });
  fb = init({ key: 'obfk_noshots', fetch: door.fetch });
  inSheet<HTMLButtonElement>('.fab')!.click();
  assert.equal(inSheet<HTMLElement>('[data-part="shot-row"]')!.hidden, false, 'offered before the answer (the default)');
  fb.close();
  await wait(300);
  inSheet<HTMLButtonElement>('.fab')!.click();
  assert.equal(inSheet<HTMLElement>('[data-part="shot-row"]')!.hidden, true);
  fb.close();
  await fb.report({ message: 'x', screenshot: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }) });
  const body = JSON.parse(new TextDecoder().decode(door.reports()[0]!.bytes)) as { screenshot?: unknown };
  assert.equal(body.screenshot, undefined);
});

test('never during server rendering', async () => {
  // This file has a DOM; the SSR file asserts no request at all. Here: a page that never opens the
  // sheet still reads the settings once, in idle time, and not before.
  page('<main></main>');
  const door = makeDoor();
  fb = init({ key: 'obfk_idle', fetch: door.fetch });
  assert.equal(door.calls.length, 0, 'not during init itself');
  await wait(300);
  assert.deepEqual(door.calls.map((c) => c.kind), ['config']);
});
