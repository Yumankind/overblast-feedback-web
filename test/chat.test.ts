/**
 * With the site's chat on the page (feedback-chat-integration §2.1, §5a): one button in the corner,
 * the chat's device borrowed for signing (and the library's own when it cannot be), the library's
 * sheet handed to the chat through `announce`, the error prompt through the chat's `nudge`, and the
 * key's categories (§2 of the feedback contract).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { $, page } from './dom.ts';
import 'fake-indexeddb/auto';
import { init } from '../src/index.ts';
import { CHAT_READY_EVENT, type FeedbackCapabilities, type FeedbackOpener } from '../src/chat.ts';
import { isApple } from '../src/triggers.ts';
import type { FeedbackBody, FeedbackInstance, InitOptions } from '../src/types.ts';
import { Clock } from './clock.ts';
import { b64url, json, makeDoor } from './door.ts';

window.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
const w = window as unknown as Record<string, unknown>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shadow = () => document.querySelector('overblast-feedback')?.shadowRoot ?? null;
const inSheet = <T extends Element>(sel: string) => shadow()!.querySelector<T>(sel);
const fab = () => inSheet<HTMLButtonElement>('.fab');
const sheetOpen = () => !!inSheet<HTMLElement>('.backdrop') && !inSheet<HTMLElement>('.backdrop')!.hidden;
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as FeedbackBody;

/** A chat with a device of its own, a key that signs, and a record of what it was told. */
async function fakeChat(opts: { device?: boolean; signThrows?: boolean; nudge?: 'shown' | 'declined' | 'none'; outcome?: 'tapped' | 'dismissed' | 'expired' | null } = {}) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const announced: Array<{ caps: FeedbackCapabilities; open: FeedbackOpener | undefined }> = [];
  const signed: string[] = [];
  const nudges: unknown[] = [];
  const feedback: Record<string, unknown> = {
    device: () => (opts.device === false ? null : { appId: 'iaa_app1', deviceId: 'iad_dev1' }),
    sign: async (canonical: string) => {
      if (opts.signThrows) throw Object.assign(new Error('forgotten'), { name: 'FeedbackSignError', code: 'forgotten' });
      signed.push(canonical);
      return b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(canonical)));
    },
    announce: (caps: FeedbackCapabilities, open?: FeedbackOpener) => announced.push({ caps, open }),
  };
  if (opts.nudge !== 'none') {
    feedback.nudge = async (o: unknown) => {
      nudges.push(o);
      const shown = opts.nudge !== 'declined';
      return opts.outcome === null || !shown ? { shown } : { shown, outcome: opts.outcome ?? 'tapped' };
    };
  }
  return { api: { feedback }, pair, announced, signed, nudges };
}

/** The door, with embed devices: it verifies the five-line canonical string against the chat's key. */
function chatDoor(config: Record<string, unknown>, chatKey?: CryptoKey) {
  const own = makeDoor({ config });
  const embedReports: Array<{ headers: Record<string, string>; body: FeedbackBody; ok: boolean }> = [];
  const f = (async (url: string, i: RequestInit) => {
    const h = { ...(i.headers as Record<string, string>) };
    if (!url.endsWith('/config') && h['X-Overblast-Feedback-App']) {
      const bytes = i.body as Uint8Array;
      const hash = b64url(createHash('sha256').update(bytes).digest());
      const canonical = `overblast-feedback-v1\n${h['X-Overblast-Feedback-Device']}\n${h['X-Overblast-Feedback-Time']}\n${h['X-Overblast-Feedback-Nonce']}\n${hash}`;
      const ok = !!chatKey && (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, chatKey, Buffer.from(h['X-Overblast-Feedback-Signature']!, 'base64url'), new TextEncoder().encode(canonical)));
      embedReports.push({ headers: h, body: decode(bytes), ok });
      if (!ok) return json(401, { code: 'device_signature_invalid', error: 'No.' });
      return json(201, { id: 'fbr_chat', taskId: 't', conversationId: 'webchat_ia-iaa_app1-iad_dev1', reference: 'R-1042' });
    }
    return own.fetch(url, i);
  }) as unknown as typeof fetch;
  return { f, own, embedReports };
}

let fb: FeedbackInstance | null = null;
afterEach(() => {
  fb?.destroy();
  fb = null;
  delete w.InfiniteAgent;
  localStorage.clear();
});

const OPEN = { verification: 'off', screenshots: true, categories: ['bug', 'idea', 'question', 'other'], errorPrompt: { enabled: false, on: ['exception'], minHoursBetween: 24 } };

// ── One button ────────────────────────────────────────────────────────────────────────────────

test('without the chat: the button as before, in its corner', () => {
  page('<main></main>');
  fb = init({ key: 'obfk_c', fetch: makeDoor({ config: OPEN }).fetch });
  assert.ok(fab() && !fab()!.hidden);
  assert.ok(fab()!.classList.contains('bottom-right'));
  fb.destroy();
  fb = init({ key: 'obfk_c', fetch: makeDoor({ config: OPEN }).fetch, trigger: { button: { position: 'top-left' } } });
  assert.ok(fab()!.classList.contains('top-left') && !fab()!.hidden);
});

test('the chat on the page at init: no button; the shortcut and report() still work', async () => {
  page('<main><input id="q"></main>');
  w.InfiniteAgent = {};
  const door = makeDoor({ config: OPEN });
  fb = init({ key: 'obfk_c', fetch: door.fetch });
  assert.equal(fab()!.hidden, true);
  const apple = isApple();
  $('#q').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyF', key: 'F', shiftKey: true, ...(apple ? { metaKey: true } : { ctrlKey: true }) }));
  assert.ok(sheetOpen());
  fb.close();
  await fb.report({ message: 'from code' });
  assert.equal(door.reports().length, 1);
});

test('the chat arriving later: the button goes on infinite:ready, or at idle without the event', async () => {
  page('<main></main>');
  fb = init({ key: 'obfk_c', fetch: makeDoor({ config: OPEN }).fetch });
  assert.equal(fab()!.hidden, false);
  w.InfiniteAgent = {};
  window.dispatchEvent(new CustomEvent(CHAT_READY_EVENT, { detail: { feedback: true } }));
  assert.equal(fab()!.hidden, true);

  fb.destroy();
  delete w.InfiniteAgent;
  fb = init({ key: 'obfk_c', fetch: makeDoor({ config: OPEN }).fetch });
  w.InfiniteAgent = {};
  assert.equal(fab()!.hidden, false);
  await wait(300); // the idle check
  assert.equal(fab()!.hidden, true);
});

test('button: true and false still force it, chat or not', () => {
  page('<main></main>');
  w.InfiniteAgent = {};
  fb = init({ key: 'obfk_c', fetch: makeDoor({ config: OPEN }).fetch, trigger: { button: true } });
  assert.equal(fab()!.hidden, false);
  fb.destroy();
  fb = init({ key: 'obfk_c', fetch: makeDoor({ config: OPEN }).fetch, trigger: { button: false } });
  assert.equal(fab(), null);
});

// ── The chat's device ─────────────────────────────────────────────────────────────────────────

test('a report signed with the chat\'s device: five headers, the five-line canonical string', async () => {
  page('<main></main>');
  const chat = await fakeChat();
  w.InfiniteAgent = chat.api;
  const d = chatDoor(OPEN, chat.pair.publicKey);
  fb = init({ key: 'obfk_c', fetch: d.f });
  const r = await fb.report({ message: 'in the conversation' });
  assert.equal(r.conversationId, 'webchat_ia-iaa_app1-iad_dev1');
  assert.equal(r.reference, 'R-1042');
  const sent = d.embedReports[0]!;
  assert.equal(sent.ok, true, 'the signature verifies with the chat\'s key');
  assert.equal(sent.headers['X-Overblast-Feedback-Device'], 'iad_dev1');
  assert.equal(sent.headers['X-Overblast-Feedback-App'], 'iaa_app1');
  assert.match(sent.headers['X-Overblast-Feedback-Nonce']!, /^[A-Za-z0-9_-]{16,64}$/);
  assert.match(sent.headers['X-Overblast-Feedback-Time']!, /^\d{13}$/);
  const lines = chat.signed[0]!.split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'overblast-feedback-v1');
  assert.equal(lines[3], sent.headers['X-Overblast-Feedback-Nonce']);
  assert.equal(d.own.count('challenge'), 0, 'no device of its own needed');
});

test('sign throws, device() is null, or the door refuses the chat\'s device: the library\'s own device', async () => {
  const flag = { ...OPEN, verification: 'flag' };
  for (const variant of ['throws', 'null', 'refused'] as const) {
    page('<main></main>');
    localStorage.clear();
    const chat = await fakeChat(variant === 'throws' ? { signThrows: true } : variant === 'null' ? { device: false } : {});
    w.InfiniteAgent = chat.api;
    // `refused`: the door does not know the chat's key (verifies against nothing).
    const d = chatDoor(flag, variant === 'refused' ? undefined : chat.pair.publicKey);
    fb = init({ key: `obfk_${variant}`, fetch: d.f });
    await wait(300); // the key's settings: flag
    await fb.report({ message: variant });
    const own = d.own.reports();
    assert.equal(own.length, 1, variant);
    assert.match(own[0]!.headers['X-Overblast-Feedback-Device'] ?? '', /^fbd_/, `${variant}: signed by the library's own device`);
    assert.equal(own[0]!.headers['X-Overblast-Feedback-App'], undefined);
    assert.equal(d.embedReports.length, variant === 'refused' ? 1 : 0);
    fb.destroy();
    fb = null;
  }
});

// ── announce and the opener ───────────────────────────────────────────────────────────────────

test('announce: the capabilities and an opener; the opener prefills the sheet and settles on send or close', async () => {
  page('<main></main>');
  const chat = await fakeChat();
  w.InfiniteAgent = chat.api;
  const d = chatDoor({ ...OPEN, categories: ['bug', 'question'] }, chat.pair.publicKey);
  fb = init({ key: 'obfk_c', fetch: d.f });
  await wait(300);
  const last = chat.announced.at(-1)!;
  assert.deepEqual({ ...last.caps, pointer: 'x' }, { available: true, source: 'library', picker: true, screenshot: true, shake: false, pointer: 'x', categories: ['bug', 'question'] });
  assert.equal(typeof last.open, 'function');

  const filed = last.open!({ message: 'The total is wrong', category: 'question', trigger: 'agent' });
  assert.ok(sheetOpen());
  assert.equal(inSheet<HTMLTextAreaElement>('textarea')!.value, 'The total is wrong');
  assert.equal(inSheet<HTMLInputElement>('input[value="question"]')!.checked, true);
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  assert.deepEqual(await filed, { filed: true, reportId: 'fbr_chat', reference: 'R-1042' });
  assert.equal(d.embedReports[0]!.body.context.trigger, 'agent');
  assert.equal(d.embedReports[0]!.body.category, 'question');

  fb.close();
  const cancelled = last.open!({ message: 'never mind', category: 'idea' });
  assert.equal(inSheet<HTMLInputElement>('input[value="bug"]')!.checked, true, 'a kind the key does not take: its first');
  fb.close();
  assert.deepEqual(await cancelled, { filed: false, reason: 'cancelled' });

  fb.destroy();
  assert.equal(chat.announced.at(-1)!.caps.available, false, 'withdrawn on destroy');
  fb = null;
});

// ── The error prompt through the chat ─────────────────────────────────────────────────────────

const PROMPT_ON = { ...OPEN, errorPrompt: { enabled: true, on: ['exception'], minHoursBetween: 24 } };

let nextStart = 1_760_440_000_000;
async function withClock(config: Record<string, unknown>, chatOpts: Parameters<typeof fakeChat>[0]) {
  page('<main></main>');
  const chat = await fakeChat(chatOpts);
  w.InfiniteAgent = chat.api;
  const clock = new Clock();
  // Each session an hour after the last, as page loads would be.
  clock.now = nextStart;
  nextStart += 3600 * 1000;
  const d = chatDoor(config, chat.pair.publicKey);
  const o: InitOptions & { _promptClock: unknown } = { key: 'obfk_n', fetch: d.f, _promptClock: { now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } };
  fb = init(o);
  await wait(300);
  return { chat, clock, d };
}
const uncaught = () => window.dispatchEvent(new ErrorEvent('error', { message: 'kaput', error: new Error('kaput') }));
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test('the chat shows it: nudge after the same gating, no pill, counted as shown; its tap opens the sheet as error_prompt', async () => {
  const { chat, clock, d } = await withClock(PROMPT_ON, { nudge: 'shown' });
  uncaught();
  clock.advance(9000);
  assert.equal(chat.nudges.length, 0, 'the 10 seconds still hold');
  clock.advance(1000);
  await flush();
  assert.deepEqual(chat.nudges, [{ text: 'Something may have gone wrong. Tell us?', reason: 'exception' }]);
  assert.equal(inSheet('.pill'), null, 'no pill of its own');
  assert.ok(JSON.parse(localStorage.getItem('ob-feedback-prompt')!).lastShown > 0, 'counted as shown');

  const filed = chat.announced.at(-1)!.open!({ trigger: 'error_prompt' });
  assert.equal(inSheet<HTMLInputElement>('input[value="bug"]')!.checked, true);
  const ta = inSheet<HTMLTextAreaElement>('textarea')!;
  ta.value = 'It broke';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await filed;
  const body = d.embedReports[0]!.body;
  assert.equal(body.context.trigger, 'error_prompt');
  const msgs = body.logs!.map((l) => l.msg);
  assert.ok(msgs.includes('error prompt shown') && msgs.includes('error prompt: reporting'));
});

test('the chat declines, or offers no nudge: nothing at all, and not counted', async () => {
  for (const nudge of ['declined', 'none'] as const) {
    const { chat, clock } = await withClock(PROMPT_ON, { nudge });
    clock.advance(10_000);
    uncaught();
    clock.advance(1);
    await flush();
    clock.advance(30_000);
    assert.equal(inSheet('.pill'), null, nudge);
    assert.equal(chat.nudges.length, nudge === 'declined' ? 1 : 0);
    assert.equal(localStorage.getItem('ob-feedback-prompt'), null, `${nudge}: not counted`);
    fb!.destroy();
    fb = null;
    delete w.InfiniteAgent;
  }
});

test('the nudge\'s outcome: dismissed counts toward the quiet days, expired (or none given) does not', async () => {
  const shownOnce = async (outcome: 'dismissed' | 'expired' | null) => {
    const { chat, clock } = await withClock({ ...PROMPT_ON, errorPrompt: { enabled: true, on: ['exception'], minHoursBetween: 0 } }, { nudge: 'shown', outcome });
    clock.advance(10_000);
    uncaught();
    clock.advance(1);
    await flush();
    const n = chat.nudges.length;
    await fb!.report({ message: 'what the log says' });
    fb!.destroy();
    fb = null;
    delete w.InfiniteAgent;
    return n;
  };
  const memory = () => JSON.parse(localStorage.getItem('ob-feedback-prompt') ?? '{}') as { dismissals?: number; quietUntil?: number };

  assert.equal(await shownOnce('expired'), 1);
  assert.equal(memory().dismissals, undefined, 'expired is not a close');
  assert.equal(await shownOnce(null), 1);
  assert.equal(memory().dismissals, undefined, 'no outcome reads as expired');
  assert.equal(await shownOnce('dismissed'), 1);
  assert.equal(memory().dismissals, 1);
  assert.equal(await shownOnce('dismissed'), 1);
  assert.ok(memory().quietUntil! > nextStart, 'two closes: seven quiet days');
  assert.equal(await shownOnce('dismissed'), 0, 'quiet now: the chat is not even asked');
});

test('the nudge\'s outcome in the log', async () => {
  for (const [outcome, line] of [
    ['dismissed', 'error prompt dismissed'],
    ['expired', 'error prompt went by itself'],
  ] as const) {
    localStorage.clear();
    const { clock, d } = await withClock(PROMPT_ON, { nudge: 'shown', outcome });
    clock.advance(10_000);
    uncaught();
    clock.advance(1);
    await flush();
    await fb!.report({ message: 'x' });
    const msgs = d.embedReports.at(-1)!.body.logs!.map((l) => l.msg);
    assert.ok(msgs.includes('error prompt shown') && msgs.includes(line), `${outcome}: ${line}`);
    fb!.destroy();
    fb = null;
    delete w.InfiniteAgent;
  }
});

// ── The key's categories ──────────────────────────────────────────────────────────────────────

test('one category: no choice, "Report a problem"; another kind refused as the door would', async () => {
  page('<main></main>');
  const door = makeDoor({ config: { ...OPEN, categories: ['bug'] } });
  fb = init({ key: 'obfk_bugs', fetch: door.fetch, labels: {} });
  await wait(300);
  fb.open();
  assert.equal(inSheet<HTMLElement>('fieldset')!.hidden, true);
  assert.equal(inSheet<HTMLElement>('#ob-title')!.textContent, 'Report a problem');
  fb.close();
  await assert.rejects(fb.report({ message: 'an idea', category: 'idea' }), (e: unknown) => {
    const err = e as { status: number; code: string; message: string };
    return err.status === 403 && err.code === 'category_not_accepted' && err.message === 'This app only takes problem reports.';
  });
  assert.equal(door.reports().length, 0, 'nothing sent');
  await fb.report({ message: 'no category given' });
  assert.equal(decode(door.reports()[0]!.bytes).category, 'bug');
  // The title can be the integrator's own.
  fb.destroy();
  fb = init({ key: 'obfk_bugs', fetch: door.fetch, labels: { titleSingle: 'Something broken?' } });
  fb.open();
  assert.equal(inSheet<HTMLElement>('#ob-title')!.textContent, 'Something broken?');
});

test('several categories: only those, the first by default', async () => {
  page('<main></main>');
  const door = makeDoor({ config: { ...OPEN, categories: ['question', 'bug'] } });
  fb = init({ key: 'obfk_two', fetch: door.fetch });
  await wait(300);
  fb.open();
  const visible = Array.from(shadow()!.querySelectorAll<HTMLInputElement>('input[name="ob-category"]'))
    .filter((r) => !(r.closest('label') as HTMLElement).hidden)
    .map((r) => r.value);
  assert.deepEqual(visible.sort(), ['bug', 'question']);
  assert.equal(inSheet<HTMLInputElement>('input[value="question"]')!.checked, true);
  assert.equal(inSheet<HTMLElement>('#ob-title')!.textContent, 'Send feedback');
  fb.close();
  await fb.report({ message: 'x' });
  assert.equal(decode(door.reports()[0]!.bytes).category, 'question');
});
