/**
 * The device through `init`, on a page with IndexedDB (fake-indexeddb): nothing is made at init, the
 * sheet registers in idle time once it opens, Send signs, and `device: false` keeps it all off.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { page } from './dom.ts';
import 'fake-indexeddb/auto';
import { init } from '../src/index.ts';
import { DEVICE_HEADER } from '../src/device.ts';
import type { FeedbackInstance } from '../src/types.ts';
import { makeDoor } from './door.ts';

window.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

const shadow = () => document.querySelector('overblast-feedback')?.shadowRoot ?? null;
const inSheet = <T extends Element>(sel: string) => shadow()!.querySelector<T>(sel);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(20);
  }
  throw new Error('timed out');
}

let fb: FeedbackInstance | null = null;
afterEach(() => {
  fb?.destroy();
  fb = null;
});

// The same door for the first two tests: it remembers the device the first one registered.
const shared = makeDoor();

test('nothing at init; the sheet registers in idle time; Send is signed', async () => {
  page('<main><button id="pay">Pay</button></main>');
  const door = shared;
  fb = init({ key: 'obfk_sheet', fetch: door.fetch });
  await wait(400);
  assert.deepEqual(door.calls.map((c) => c.kind), ['config'], 'the key\'s settings read in idle time; no key, no challenge');
  assert.equal(await fb.deviceLevel(), 'none');

  inSheet<HTMLButtonElement>('.fab')!.click();
  await until(async () => (await fb!.deviceLevel()) === 'registered');
  assert.deepEqual(door.calls.map((c) => c.kind), ['config', 'challenge', 'register']);

  const textarea = inSheet<HTMLTextAreaElement>('textarea')!;
  textarea.value = 'Signed from the sheet';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await until(() => door.reports().length === 1);
  const report = door.reports()[0]!;
  assert.match(report.headers[DEVICE_HEADER]!, /^fbd_/);
  await until(() => door.verified.length === 1);
  assert.equal(door.verified[0]!.ok, true);
  // The device doors are the library's own: not in the page's network log.
  const body = JSON.parse(new TextDecoder().decode(report.bytes)) as { network?: Array<{ url: string }> };
  assert.ok(!(body.network ?? []).some((n) => n.url.includes('/devices')));
});

test('a later instance on the same page load reuses the kept device', async () => {
  page('<main></main>');
  const door = shared;
  const before = door.calls.length;
  fb = init({ key: 'obfk_sheet', fetch: door.fetch });
  assert.equal(await fb.deviceLevel(), 'registered', 'kept in IndexedDB by the test before');
  await fb.report({ message: 'again' });
  const calls = door.calls.slice(before).filter((c) => c.kind !== 'config');
  assert.deepEqual(calls.map((c) => c.kind), ['report']);
  assert.equal(calls[0]!.headers[DEVICE_HEADER], door.reports()[0]!.headers[DEVICE_HEADER]);
  assert.equal(door.verified.at(-1)!.ok, true);
});

test('report() without the sheet registers on first use', async () => {
  page('<main></main>');
  const door = makeDoor();
  fb = init({ key: 'obfk_programmatic', fetch: door.fetch });
  await wait(400); // the key's settings, read in idle time, say `flag`
  await fb.report({ message: 'from code' });
  assert.deepEqual(door.calls.map((c) => c.kind), ['config', 'challenge', 'register', 'report']);
  assert.ok(door.reports()[0]!.headers[DEVICE_HEADER]);
});

test('device: false: never a device door, never a signature', async () => {
  page('<main></main>');
  const door = makeDoor();
  fb = init({ key: 'obfk_off', fetch: door.fetch, device: false });
  inSheet<HTMLButtonElement>('.fab')!.click();
  await wait(500);
  await fb.report({ message: 'unsigned' });
  assert.deepEqual(door.calls.filter((c) => c.kind !== 'config').map((c) => c.kind), ['report']);
  assert.equal(door.reports()[0]!.headers[DEVICE_HEADER], undefined);
  assert.equal(await fb.deviceLevel(), 'none');
});
