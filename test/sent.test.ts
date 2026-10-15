/**
 * The sent state, on a fake clock: how long it stays (2 s for the thank-you, 4 s for the known-issue
 * sentence), the pause while the pointer is over the sheet or the person has moved to Done, every way
 * to close it (Done, the ✕, Esc, a click outside), and where focus goes.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { page } from './dom.ts';
import { init } from '../src/index.ts';
import { SENT_HOLD_MS, SENT_KNOWN_HOLD_MS } from '../src/ui.ts';
import type { FeedbackInstance, InitOptions } from '../src/types.ts';
import { Clock } from './clock.ts';

window.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
const shadow = () => document.querySelector('overblast-feedback')!.shadowRoot!;
const q = <T extends Element>(sel: string) => shadow().querySelector<T>(sel)!;
const isOpen = () => !q<HTMLElement>('.backdrop').hidden;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

let fb: FeedbackInstance | null = null;
afterEach(() => {
  fb?.destroy();
  fb = null;
});

/** Open, type, send; the door answers 201, with `known` when asked. Returns the fake clock. */
async function sent(known = false): Promise<Clock> {
  page('<main><button id="b">b</button></main>');
  const clock = new Clock();
  clock.now = 1_760_440_000_000;
  const f = (async (u: string) =>
    u.endsWith('/config')
      ? new Response('{}', { status: 200 })
      : new Response(JSON.stringify({ id: 'fbr_1', taskId: 't', conversationId: null, ...(known ? { known: true } : {}) }), { status: 201 })) as unknown as typeof fetch;
  const o: InitOptions & { _promptClock: unknown } = {
    key: 'obfk_sent',
    fetch: f,
    reporter: { email: 'a@b.co' },
    _promptClock: { now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  };
  fb = init(o);
  fb.open();
  const ta = q<HTMLTextAreaElement>('textarea');
  ta.value = 'The total is wrong';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  q<HTMLButtonElement>('[data-act="send"]').click();
  await settle();
  assert.equal(q<HTMLElement>('[data-part="done"]').hidden, false, 'the sent state is up');
  return clock;
}

test('the thank-you stays 2 s, the known-issue sentence 4 s, then the sheet closes by itself', async () => {
  assert.equal(SENT_HOLD_MS, 2000);
  assert.equal(SENT_KNOWN_HOLD_MS, 4000);
  const c = await sent();
  c.advance(SENT_HOLD_MS - 1);
  assert.ok(isOpen());
  c.advance(1);
  assert.equal(isOpen(), false);
  fb!.destroy();

  const k = await sent(true);
  assert.equal(q<HTMLElement>('[data-part="done-text"]').textContent, "Thanks. We already know about this one and we're on it.");
  k.advance(SENT_KNOWN_HOLD_MS - 1);
  assert.ok(isOpen(), 'the longer sentence stays longer');
  k.advance(1);
  assert.equal(isOpen(), false);
});

test('focus lands on Done; the message is announced by its own polite live region; the ✕ stays visible', async () => {
  await sent();
  assert.equal(shadow().activeElement, q('[data-act="done-close"]'));
  assert.equal(q<HTMLElement>('[data-act="done-close"]').textContent, 'Done');
  assert.equal(q<HTMLElement>('[data-part="done-text"]').getAttribute('aria-live'), 'polite');
  const x = q<HTMLElement>('.head [data-act="close"]');
  assert.ok(x && !x.closest('[hidden]'), 'the ✕ is not under anything hidden');
});

test('the pointer over the sheet pauses the clock; leaving resumes it with what was left', async () => {
  const c = await sent();
  const sheet = q<HTMLElement>('.sheet');
  c.advance(1500);
  sheet.dispatchEvent(new Event('pointerenter'));
  c.advance(60_000);
  assert.ok(isOpen(), 'held while the pointer is over it');
  sheet.dispatchEvent(new Event('pointerleave'));
  c.advance(999);
  assert.ok(isOpen(), 'at least a second to finish reading');
  c.advance(1);
  assert.equal(isOpen(), false);
});

test('focus moved to Done by the person pauses it (the library\'s own move does not)', async () => {
  const c = await sent();
  const done = q<HTMLButtonElement>('[data-act="done-close"]');
  // The library focused Done itself: the clock runs.
  c.advance(SENT_HOLD_MS);
  assert.equal(isOpen(), false, 'the library\'s own focus is not a hold');
  fb!.destroy();

  const d = await sent();
  const btn = q<HTMLButtonElement>('[data-act="done-close"]');
  btn.blur();
  btn.focus(); // the person tabbed back to it
  d.advance(60_000);
  assert.ok(isOpen(), 'held while Done has the person\'s focus');
  btn.blur();
  d.advance(SENT_HOLD_MS - 1);
  assert.ok(isOpen(), 'the time it had left when it was paused');
  d.advance(1);
  assert.equal(isOpen(), false);
  void done;
});

for (const [name, close] of [
  ['Done', () => q<HTMLButtonElement>('[data-act="done-close"]').click()],
  ['the ✕', () => q<HTMLButtonElement>('.head [data-act="close"]').click()],
  ['Esc', () => q<HTMLElement>('[data-act="done-close"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }))],
  ['a click outside', () => q<HTMLElement>('.backdrop').dispatchEvent(new MouseEvent('click', { bubbles: true }))],
] as const) {
  test(`${name} closes it at once, and the timer does not fire later`, async () => {
    const c = await sent();
    close();
    assert.equal(isOpen(), false);
    assert.equal(q<HTMLElement>('[data-part="done"]').hidden, true);
    // Reopened before the old timer would have fired: it must not close the new sheet.
    fb!.open();
    c.advance(SENT_KNOWN_HOLD_MS * 2);
    assert.ok(isOpen(), 'the old timer is gone');
  });
}
