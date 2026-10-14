import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { $, page, setRect } from './dom.ts';
import { init } from '../src/index.ts';
import { DRAFT_KEY } from '../src/draft.ts';
import { BODY_FIELDS } from '../src/payload.ts';
import { isApple } from '../src/triggers.ts';
import type { FeedbackBody, FeedbackInstance } from '../src/types.ts';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: FeedbackBody;
}

function door(status = 201, answer: unknown = { id: 'fbr_1', taskId: 'todo_1', conversationId: null }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as FeedbackBody });
    return new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const shadow = () => document.querySelector('overblast-feedback')?.shadowRoot ?? null;
const inSheet = <T extends Element>(sel: string) => shadow()!.querySelector<T>(sel);
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const isOpen = () => {
  const b = inSheet<HTMLElement>('.backdrop');
  return !!b && !b.hidden;
};
const status = () => inSheet<HTMLElement>('[data-part="status"]')!.textContent ?? '';

// The page's own fetch, before any wrapper: a stub, so the tests never reach the network.
window.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
// happy-dom decodes no images and draws on no canvas: a bitmap that decodes to something the
// finishing step then cannot paint, which is the "could not be blanked" path.
(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ width: 1000, height: 800, close() {} });

let fb: FeedbackInstance | null = null;
afterEach(() => {
  fb?.destroy();
  fb = null;
  try {
    localStorage.clear();
  } catch {
    /* fine */
  }
});

test('the button opens the sheet; Send files the report the contract describes', async () => {
  page('<main><h1>Cart</h1><button id="pay">Pay</button></main>');
  const { f, calls } = door();
  let sent: unknown = null;
  fb = init({ key: 'obfk_test', fetch: f, reporter: { accountRef: 'cus_8812', name: 'Ana' }, appVersion: '2.4.1', extra: { plan: 'pro' }, onSent: (r) => (sent = r) });
  console.warn('the total is wrong, token=abc123');
  await window.fetch('https://shop.example.com/api/cart?id=3').catch(() => undefined);

  const fab = inSheet<HTMLButtonElement>('.fab')!;
  assert.ok(fab, 'the floating button is there');
  assert.equal(fab.textContent?.trim(), 'Feedback');
  fab.click();
  assert.ok(isOpen());
  assert.equal(shadow()!.activeElement, inSheet('textarea'), 'focus goes to the message');
  assert.equal(inSheet<HTMLElement>('[data-part="email"]')!.hidden, false, 'no email from the integrator: the field is offered');
  assert.equal(inSheet<HTMLInputElement>('input[name="screenshot"]')!.checked, false, 'the screenshot is opt-in');
  assert.match(inSheet<HTMLElement>('[data-part="preview"]')!.textContent!, /your message, logs from this session/);

  // Empty message: refused on this side.
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(inSheet<HTMLElement>('[data-err="message"]')!.hidden, false);

  type(inSheet<HTMLTextAreaElement>('textarea')!, 'The total does not update when I remove an item');
  inSheet<HTMLInputElement>('input[value="question"]')!.click();
  type(inSheet<HTMLInputElement>('input[type="email"]')!, 'ana@example.com');
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();

  assert.equal(calls.length, 1);
  const { url, headers, body } = calls[0]!;
  assert.equal(url, 'https://brain.deployd.network/v1/feedback');
  assert.equal(headers['X-Overblast-Feedback-Key'], 'obfk_test');
  for (const k of Object.keys(body)) assert.ok((BODY_FIELDS as readonly string[]).includes(k), `unknown field ${k}`);
  assert.equal(body.v, 1);
  assert.equal(body.message, 'The total does not update when I remove an item');
  assert.equal(body.category, 'question');
  assert.deepEqual(body.reporter, { name: 'Ana', accountRef: 'cus_8812', email: 'ana@example.com' });
  assert.equal(body.context.platform, 'web');
  assert.equal(body.context.url, 'https://shop.example.com/cart?step=2&token=[redacted]');
  assert.equal(body.context.appVersion, '2.4.1');
  assert.deepEqual(body.context.extra, { plan: 'pro' });
  assert.deepEqual(body.context.sdk, { name: 'overblast-feedback-web', version: '0.1.0' });
  assert.match(body.context.deviceId!, /^[a-f0-9]{32}$/);
  assert.equal(localStorage.getItem('ob-feedback-device'), body.context.deviceId);
  assert.ok(body.logs!.some((l) => l.level === 'warn' && l.msg === 'the total is wrong, token=[redacted]'));
  assert.ok(body.network!.some((n) => n.url === 'https://shop.example.com/api/cart'));
  assert.ok(!body.network!.some((n) => n.url.includes('brain.deployd.network')), 'the report itself is not in the network log');
  assert.equal(body.screenshot, undefined);
  assert.equal(body.element, undefined);

  assert.match(status(), /Thank you/);
  assert.deepEqual(sent, { id: 'fbr_1', taskId: 'todo_1', conversationId: null });
  assert.equal(inSheet<HTMLTextAreaElement>('textarea')!.value, '', 'the form is cleared');
});

test('429: the door\'s sentence is shown, the draft is kept, and it comes back next time', async () => {
  page('<main>x</main>');
  const sentence = 'Too many reports from this device. Please try again in an hour.';
  const { f, calls } = door(429, { code: 'rate_limited', error: sentence, retryAfter: 3600 });
  fb = init({ key: 'obfk_test', fetch: f, reporter: { email: 'ana@example.com' } });
  fb.open();
  assert.equal(inSheet<HTMLElement>('[data-part="email"]')!.hidden, true, 'the integrator gave an email: no field');
  type(inSheet<HTMLTextAreaElement>('textarea')!, 'Checkout button does nothing');
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();
  assert.equal(calls.length, 1, 'one attempt, no retry loop');
  assert.ok(status().includes(sentence), status());
  assert.match(status(), /saved on this device/);
  assert.equal(inSheet<HTMLButtonElement>('[data-act="send"]')!.textContent, 'Try again');
  const draft = JSON.parse(localStorage.getItem(DRAFT_KEY)!) as { message: string; retryAt: number };
  assert.equal(draft.message, 'Checkout button does nothing');
  assert.ok(draft.retryAt > Date.now() + 3500_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 1, 'still one attempt');

  // A fresh page: the draft is restored into the sheet.
  fb.destroy();
  const ok = door();
  fb = init({ key: 'obfk_test', fetch: ok.f });
  fb.open();
  assert.equal(inSheet<HTMLTextAreaElement>('textarea')!.value, 'Checkout button does nothing');
  assert.match(status(), /restored/);
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();
  assert.equal(ok.calls.length, 1);
  assert.equal(localStorage.getItem(DRAFT_KEY), null, 'sent: the draft is gone');
});

test('a refusal that will not change (401) is shown and not kept', async () => {
  page('<main>x</main>');
  const { f } = door(401, { code: 'unknown_key', error: 'This feedback key was revoked.' });
  fb = init({ key: 'obfk_old', fetch: f });
  fb.open();
  type(inSheet<HTMLTextAreaElement>('textarea')!, 'x');
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();
  assert.equal(status(), 'This feedback key was revoked.');
  assert.equal(localStorage.getItem(DRAFT_KEY), null);
});

test('the shortcut toggles the sheet; Esc closes it; a page that handled the keys keeps them', () => {
  page('<main><input id="q"></main>');
  fb = init({ key: 'obfk_test', fetch: door().f });
  const apple = isApple();
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyF', key: 'F', shiftKey: true, ...(apple ? { metaKey: true } : { ctrlKey: true }), ...init });
    $('#q').dispatchEvent(e);
    return e;
  };
  const e = press({});
  assert.ok(isOpen());
  assert.equal(e.defaultPrevented, true);
  inSheet('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(isOpen(), false);

  const handled = (ev: Event) => ev.preventDefault();
  $('#q').addEventListener('keydown', handled);
  press({});
  assert.equal(isOpen(), false, 'the page handled the keys first');
  $('#q').removeEventListener('keydown', handled);
});

test('the focus trap keeps Tab inside the sheet', () => {
  page('<main><button id="outside">x</button></main>');
  fb = init({ key: 'obfk_test', fetch: door().f });
  fb.open();
  const sheet = inSheet<HTMLElement>('.sheet')!;
  const send = inSheet<HTMLButtonElement>('[data-act="send"]')!;
  send.focus();
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  send.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(shadow()!.activeElement, inSheet('[data-act="close"]'));
  assert.equal(sheet.getAttribute('role'), 'dialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
});

test('point at the problem: the picker selects an element and the report carries its anchor', async () => {
  page('<main><section><p>Shoes</p><button class="rm" aria-label="Remove shoes">Remove</button></section></main>');
  setRect($('button.rm'), { left: 610, top: 336, width: 200, height: 40 });
  const { f, calls } = door();
  fb = init({ key: 'obfk_test', fetch: f });
  fb.open();
  type(inSheet<HTMLTextAreaElement>('textarea')!, 'Remove does nothing');
  inSheet<HTMLButtonElement>('[data-part="pick"] [data-act="pick"]')!.click();
  assert.equal(isOpen(), false, 'the sheet steps aside while picking');
  assert.ok(inSheet('.pick-bar'), 'the picker bar is shown');
  let pageSawClick = false;
  $('button.rm').addEventListener('click', () => (pageSawClick = true));
  $('button.rm').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 700, clientY: 350 }));
  await settle();
  assert.equal(pageSawClick, false, 'the page never saw the picking click');
  assert.equal(inSheet('.pick-bar'), null, 'the picker is gone');
  assert.ok(isOpen(), 'the sheet is back');
  assert.equal(inSheet<HTMLElement>('[data-part="selected"]')!.hidden, false);
  assert.match(inSheet<HTMLElement>('[data-part="preview"]')!.textContent!, /the selected element/);
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();
  const el = calls[0]!.body.element!;
  assert.equal(el.kind, 'dom');
  assert.equal(el.selector, 'main > section > button.rm');
  assert.equal(el.label, 'Remove shoes');
  assert.deepEqual(el.rect, { x: 0.61, y: 0.42, w: 0.2, h: 0.05 });
});

test('the picker cancels on Esc and lets the page have its clicks back', async () => {
  page('<main><button id="b">B</button></main>');
  fb = init({ key: 'obfk_test', fetch: door().f });
  const picked = fb.pick();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(await picked, null);
  let clicked = false;
  $('#b').addEventListener('click', () => (clicked = true));
  ($('#b') as HTMLButtonElement).click();
  assert.equal(clicked, true);
});

test('report(): programmatic, with an element, and the integrator\'s screenshot', async () => {
  page('<main><div id="total">€40</div></main>');
  const { f, calls } = door(201, { id: 'fbr_9', taskId: 'todo_9', conversationId: 'cmp:ana@example.com' });
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
  fb = init({ key: 'obfk_test', fetch: f, trigger: { button: false }, captureScreenshot: async () => png });
  assert.equal(inSheet('.fab'), null, 'no button when asked for none');
  const result = await fb.report({ message: 'Total wrong', category: 'bug', element: $('#total'), screenshot: true, reporter: { email: 'ana@example.com' }, extra: { cart: 3 } });
  assert.deepEqual(result, { id: 'fbr_9', taskId: 'todo_9', conversationId: 'cmp:ana@example.com' });
  const body = calls[0]!.body;
  assert.equal(body.element!.selector, '#total');
  assert.equal(body.screenshot!.contentType, 'image/png');
  assert.equal(body.screenshot!.base64, 'iVBORw==');
  assert.deepEqual(body.context.extra, { cart: '3' });
});

test('report(): a screenshot that cannot be blanked is not sent when something private is on screen', async () => {
  page('<main><input type="password" id="pw"><div data-overblast-private id="acct">PT50…</div></main>');
  setRect($('#pw'), { left: 10, top: 10, width: 200, height: 30 });
  const { f, calls } = door();
  const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  fb = init({ key: 'obfk_test', fetch: f, captureScreenshot: async () => png });
  await fb.report({ message: 'x', screenshot: true });
  assert.equal(calls[0]!.body.screenshot, undefined);
});

test('the screenshot box: opt-in, a thumbnail with a remove button, and it is sent only while ticked', async () => {
  page('<main>x</main>');
  const { f, calls } = door();
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
  let captures = 0;
  fb = init({ key: 'obfk_test', fetch: f, captureScreenshot: async () => (captures++, jpeg) });
  fb.open();
  assert.equal(captures, 0, 'nothing is captured until the box is ticked');
  const box = inSheet<HTMLInputElement>('input[name="screenshot"]')!;
  box.click();
  await settle();
  assert.equal(captures, 1);
  assert.equal(inSheet<HTMLElement>('[data-part="thumb"]')!.hidden, false, 'the person sees the image');
  assert.match(inSheet<HTMLImageElement>('[data-part="thumb-img"]')!.src, /^blob:/);
  assert.match(inSheet<HTMLElement>('[data-part="preview"]')!.textContent!, /a screenshot/);
  assert.ok(isOpen(), 'the sheet came back after the capture');

  inSheet<HTMLButtonElement>('[data-act="unshot"]')!.click();
  await settle();
  assert.equal(box.checked, false);
  assert.equal(inSheet<HTMLElement>('[data-part="thumb"]')!.hidden, true);
  type(inSheet<HTMLTextAreaElement>('textarea')!, 'no picture please');
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();
  assert.equal(calls[0]!.body.screenshot, undefined, 'removed: not sent');

  type(inSheet<HTMLTextAreaElement>('textarea')!, 'with a picture');
  box.click();
  await settle();
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();
  assert.deepEqual(calls[1]!.body.screenshot, { contentType: 'image/jpeg', base64: '/9j/4A==', highlighted: false });
});

test('a screenshot that cannot be taken says so and the report still goes', async () => {
  page('<main>x</main>');
  const { f, calls } = door();
  fb = init({ key: 'obfk_test', fetch: f, captureScreenshot: async () => { throw new Error('html2canvas failed'); } });
  fb.open();
  inSheet<HTMLInputElement>('input[name="screenshot"]')!.click();
  await settle();
  const note = inSheet<HTMLElement>('[data-part="shot-note"]')!;
  assert.equal(note.hidden, false);
  assert.match(note.textContent!, /could not be taken/);
  assert.equal(inSheet<HTMLInputElement>('input[name="screenshot"]')!.checked, false);
  type(inSheet<HTMLTextAreaElement>('textarea')!, 'x');
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.screenshot, undefined);
});

test('setReporter and a reporter function are read at send time', async () => {
  page('<main>x</main>');
  const { f, calls } = door();
  let user = { accountRef: 'u1' };
  fb = init({ key: 'obfk_test', fetch: f, reporter: () => user });
  user = { accountRef: 'u2' };
  await fb.report({ message: 'a' });
  fb.setReporter({ accountRef: 'u3', email: 'b@example.com' });
  await fb.report({ message: 'b' });
  assert.deepEqual(calls.map((c) => c.body.reporter), [{ accountRef: 'u2' }, { accountRef: 'u3', email: 'b@example.com' }]);
});

test('destroy removes the UI and every wrapper', () => {
  page('<main>x</main>');
  const log = console.log;
  const fetchBefore = window.fetch;
  const xhrOpen = XMLHttpRequest.prototype.open;
  const inst = init({ key: 'obfk_test', fetch: door().f });
  assert.notEqual(console.log, log);
  assert.notEqual(window.fetch, fetchBefore);
  assert.notEqual(XMLHttpRequest.prototype.open, xhrOpen);
  inst.destroy();
  assert.equal(console.log, log);
  assert.equal(window.fetch, fetchBefore);
  assert.equal(XMLHttpRequest.prototype.open, xhrOpen);
  assert.equal(document.querySelector('overblast-feedback'), null);
});

test('a second init replaces the first', () => {
  page('<main>x</main>');
  const log = console.log;
  init({ key: 'obfk_a', fetch: door().f });
  fb = init({ key: 'obfk_b', fetch: door().f });
  assert.equal(document.querySelectorAll('overblast-feedback').length, 1);
  fb.destroy();
  fb = null;
  assert.equal(console.log, log, 'both sets of wrappers are gone');
});

test('init without a key is refused by name', () => {
  assert.throws(() => init({ key: '' }), /needs `key`/);
});
