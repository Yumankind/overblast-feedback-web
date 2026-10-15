/**
 * `context.openedAt` and `context.trigger` (contract §3.4), and collection paused while the sheet is
 * open, so the sheet's own activity never fills the buffer.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { $, page } from './dom.ts';
import { init } from '../src/index.ts';
import { isApple } from '../src/triggers.ts';
import type { FeedbackBody, FeedbackInstance } from '../src/types.ts';

window.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

const shadow = () => document.querySelector('overblast-feedback')?.shadowRoot ?? null;
const inSheet = <T extends Element>(sel: string) => shadow()!.querySelector<T>(sel);
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

function door() {
  const bodies: FeedbackBody[] = [];
  const f = (async (_u: string, i: RequestInit) => {
    bodies.push(JSON.parse(new TextDecoder().decode(i.body as Uint8Array)) as FeedbackBody);
    return new Response(JSON.stringify({ id: 'fbr_1', taskId: 't', conversationId: null }), { status: 201 });
  }) as unknown as typeof fetch;
  return { f, bodies };
}

async function sendFromSheet(message: string): Promise<void> {
  const textarea = inSheet<HTMLTextAreaElement>('textarea')!;
  textarea.value = message;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  inSheet<HTMLButtonElement>('[data-act="send"]')!.click();
  await settle();
}

let fb: FeedbackInstance | null = null;
afterEach(() => {
  fb?.destroy();
  fb = null;
});

test('the button: trigger and openedAt; nothing recorded while the sheet is open; recording again after', async () => {
  page('<main></main>');
  const { f, bodies } = door();
  fb = init({ key: 'obfk_t', fetch: f, device: false });
  console.warn('before the sheet');
  const before = Date.now();
  inSheet<HTMLButtonElement>('.fab')!.click();
  const after = Date.now();
  console.warn('while the sheet is open');
  await window.fetch('https://shop.example.com/api/while-open');
  await sendFromSheet('from the button');
  const body = bodies[0]!;
  assert.equal(body.context.trigger, 'button');
  assert.ok(body.context.openedAt! >= before && body.context.openedAt! <= after, 'openedAt is when the sheet appeared');
  const msgs = body.logs!.map((l) => l.msg);
  assert.ok(msgs.includes('before the sheet'));
  assert.ok(!msgs.includes('while the sheet is open'), 'paused while open');
  assert.ok(!body.network?.some((n) => n.url.includes('while-open')));
  // A handful of lines: the excerpt holds them all, so there is no log file.
  assert.equal(body.logFile, undefined);

  fb.close();
  console.warn('after the sheet closed');
  await fb.report({ message: 'from code' });
  assert.ok(bodies[1]!.logs!.some((l) => l.msg === 'after the sheet closed'), 'recording resumed');
});

test('the shortcut, open(), open({ trigger: "agent" }), report() and report({ trigger: "agent" })', async () => {
  page('<main><input id="q"></main>');
  const { f, bodies } = door();
  fb = init({ key: 'obfk_t', fetch: f, device: false });

  const apple = isApple();
  $('#q').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyF', key: 'F', shiftKey: true, ...(apple ? { metaKey: true } : { ctrlKey: true }) }));
  await sendFromSheet('from the shortcut');
  fb.close();
  fb.open();
  await sendFromSheet('from open()');
  fb.close();
  fb.open({ trigger: 'agent' });
  await sendFromSheet('from the chat');
  fb.close();
  const t = Date.now();
  await fb.report({ message: 'report()' });
  await fb.report({ message: 'report() for the chat', trigger: 'agent' });
  assert.deepEqual(
    bodies.map((b) => [b.message, b.context.trigger]),
    [
      ['from the shortcut', 'shortcut'],
      ['from open()', 'api'],
      ['from the chat', 'agent'],
      ['report()', 'api'],
      ['report() for the chat', 'agent'],
    ],
  );
  assert.ok(bodies[3]!.context.openedAt! >= t && bodies[3]!.context.openedAt! <= Date.now());
  // A trigger outside what the integrator may pass is not taken.
  await fb.report({ message: 'x', trigger: 'relaunch' as unknown as 'api' });
  assert.equal(bodies.at(-1)!.context.trigger, 'api');
});

test('a second report from the same opening keeps its openedAt; reopening sets a new one', async () => {
  page('<main></main>');
  const { f, bodies } = door();
  fb = init({ key: 'obfk_t', fetch: f, device: false });
  fb.open();
  await sendFromSheet('first');
  await new Promise((r) => setTimeout(r, 5));
  await sendFromSheet('second, same opening');
  fb.close();
  await new Promise((r) => setTimeout(r, 5));
  fb.open();
  await sendFromSheet('after reopening');
  assert.equal(bodies[0]!.context.openedAt, bodies[1]!.context.openedAt);
  assert.ok(bodies[2]!.context.openedAt! > bodies[1]!.context.openedAt!);
});
