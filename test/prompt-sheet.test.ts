/**
 * The error prompt on a page, with Node's fake timers: what sets it off (an uncaught error, a 5xx
 * from the app's own hosts, a request that failed), what never does (a caught error, a 4xx, another
 * site's 5xx, our own door, an abort), the pill itself, and reporting from it.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { $, page } from './dom.ts';
import { init } from '../src/index.ts';
import { appUrlMatcher } from '../src/feedback.ts';
import { keyboardUp } from '../src/prompt.ts';
import type { FeedbackBody, FeedbackInstance, InitOptions } from '../src/types.ts';
import { Clock } from './clock.ts';

const ON = { verification: 'off', errorPrompt: { enabled: true, on: ['exception', 'server_error', 'network'], minHoursBetween: 24 }, screenshots: true };

// The page's own fetch: the answer is in the url.
window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('/down')) throw new TypeError('Failed to fetch');
  if (url.includes('/abort')) throw new DOMException('The operation was aborted.', 'AbortError');
  const status = Number(/\/(\d{3})(?:$|\?)/.exec(url)?.[1] ?? 200);
  return new Response('{}', { status });
}) as typeof fetch;

const shadow = () => document.querySelector('overblast-feedback')?.shadowRoot ?? null;
const pill = () => shadow()?.querySelector<HTMLElement>('.pill') ?? null;
/** The prompt's clock: handed to `init`, moved by hand. */
let clock = new Clock();
const advance = (ms: number) => clock.advance(ms);
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

function door(config: unknown = ON) {
  const bodies: FeedbackBody[] = [];
  const f = (async (url: string, i: RequestInit) => {
    if (url.endsWith('/config')) return new Response(JSON.stringify(config), { status: 200, headers: { ETag: '"1"' } });
    bodies.push(JSON.parse(new TextDecoder().decode(i.body as Uint8Array)) as FeedbackBody);
    return new Response(JSON.stringify({ id: 'fbr_1', taskId: 't', conversationId: null }), { status: 201 });
  }) as unknown as typeof fetch;
  return { f, bodies };
}

let fb: FeedbackInstance | null = null;
beforeEach(() => {
  localStorage.clear();
  clock = new Clock();
  clock.now = 1_760_440_000_000;
});
afterEach(() => {
  fb?.destroy();
  fb = null;
});

/** init, then let the idle-time settings read land. */
async function start(opts: { config?: unknown; errorPrompt?: boolean; appHosts?: string[] } = {}) {
  page('<main><input id="name"><button id="b">b</button></main>');
  const d = door(opts.config ?? ON);
  const c = clock;
  const o: InitOptions & { _promptClock: unknown } = {
    key: 'obfk_prompt',
    fetch: d.f,
    _promptClock: { now: () => c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout },
  };
  if (opts.errorPrompt === false) o.errorPrompt = false;
  if (opts.appHosts) o.appHosts = opts.appHosts;
  fb = init(o);
  // The key's settings are read in idle time (a real 200 ms here, there being no requestIdleCallback).
  await new Promise((r) => setTimeout(r, 300));
  await flush();
  return d;
}

const uncaught = (msg = 'kaput') => window.dispatchEvent(new ErrorEvent('error', { message: msg, error: new Error(msg) }));

test('an uncaught error: the pill after 10 s, polite, and Report opens the sheet as error_prompt', async () => {
  const d = await start();
  uncaught('Cannot read properties of undefined');
  advance(9000);
  assert.equal(pill(), null, 'not in the first 10 seconds');
  advance(1000);
  const p = pill()!;
  assert.ok(p, 'shown');
  assert.equal(p.getAttribute('role'), 'status');
  assert.equal(p.getAttribute('aria-live'), 'polite');
  assert.match(p.textContent!, /Something may have gone wrong\. Tell us\?/);

  advance(1500);
  const tapAt = Date.now();
  p.querySelector<HTMLButtonElement>('[data-act="prompt-report"]')!.click();
  const tapEnd = Date.now();
  assert.equal(pill(), null);
  const sheet = shadow()!;
  assert.equal(sheet.querySelector<HTMLInputElement>('input[value="bug"]')!.checked, true);
  const ta = sheet.querySelector<HTMLTextAreaElement>('textarea')!;
  ta.value = 'It broke';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  sheet.querySelector<HTMLButtonElement>('[data-act="send"]')!.click();
  await flush();
  const body = d.bodies[0]!;
  assert.equal(body.context.trigger, 'error_prompt');
  assert.ok(body.context.openedAt! >= tapAt && body.context.openedAt! <= tapEnd, 'openedAt at the tap');
  assert.equal(body.category, 'bug');
  const msgs = body.logs!.map((l) => `${l.src}: ${l.msg}`);
  assert.ok(msgs.some((m) => m.includes('Cannot read properties of undefined')));
  assert.ok(msgs.includes('overblast: error prompt shown'));
  assert.ok(msgs.includes('overblast: error prompt: reporting'));
});

test('it goes by itself after about 8 seconds, and the pointer over it holds it', async () => {
  await start();
  advance(10_000);
  uncaught();
  advance(1);
  const p = pill()!;
  assert.ok(p);
  advance(7000);
  p.dispatchEvent(new Event('mouseenter'));
  advance(30_000);
  assert.ok(pill(), 'held');
  p.dispatchEvent(new Event('mouseleave'));
  advance(2100);
  assert.equal(pill(), null);
});

test('Close counts as a dismissal; a second error this session does not bring it back', async () => {
  await start();
  advance(10_000);
  uncaught();
  advance(1);
  pill()!.querySelector<HTMLButtonElement>('[data-act="prompt-close"]')!.click();
  assert.equal(pill(), null);
  assert.equal(JSON.parse(localStorage.getItem('ob-feedback-prompt')!).dismissals, 1);
  advance(5000);
  uncaught('again');
  advance(60_000);
  assert.equal(pill(), null);
});

const key = (el: Element) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));

test('a field that merely has focus does not hold it back', async () => {
  await start();
  advance(10_000);
  ($('#name') as HTMLInputElement).focus();
  uncaught();
  advance(1);
  assert.ok(pill());
});

test('typing holds it back until 5 s after the last key; typing on for 30 s and it gives up', async () => {
  await start();
  advance(10_000);
  key($('#name'));
  uncaught();
  advance(4000);
  assert.equal(pill(), null, 'a key 4 s ago');
  advance(1500);
  assert.ok(pill(), 'shown once 5 s have passed without a key');

  fb!.destroy();
  localStorage.removeItem('ob-feedback-prompt'); // a new day, as far as minHoursBetween goes
  await start();
  advance(10_000);
  uncaught();
  key($('#name'));
  advance(1);
  // Still typing: a key every 2 s for 32 s.
  for (let i = 0; i < 16; i++) {
    key($('#name'));
    advance(2000);
  }
  advance(10_000);
  assert.equal(pill(), null, 'it gave up rather than waiting on');
  // A key outside a text field is not typing.
  fb!.destroy();
  localStorage.removeItem('ob-feedback-prompt');
  await start();
  advance(10_000);
  key($('#b'));
  uncaught();
  advance(1);
  assert.ok(pill());
});

test('requests: a 5xx or a failure from the app\'s own hosts counts; a 4xx, another site, an abort and our door do not', async () => {
  await start({ appHosts: ['api.shop.example.com'] });
  advance(10_000);
  const call = (u: string) => window.fetch(u).catch(() => undefined);
  await call('https://shop.example.com/api/404');
  await call('https://cdn.elsewhere.example/assets/503');
  await call('https://cdn.elsewhere.example/down');
  await call('https://shop.example.com/api/abort');
  await call('https://brain.deployd.network/v1/feedback/500');
  advance(5000);
  assert.equal(pill(), null);
  await call('https://api.shop.example.com/cart/502');
  advance(1);
  assert.ok(pill(), 'a 502 from the app\'s API');
});

test('a failed request to the page\'s own origin counts as `network`', async () => {
  await start();
  advance(10_000);
  await window.fetch('https://shop.example.com/down').catch(() => undefined);
  advance(1);
  assert.ok(pill());
});

test('an error the page caught and logged does not count', async () => {
  await start();
  advance(10_000);
  try {
    throw new Error('handled');
  } catch (e) {
    console.error('we handled it', e);
  }
  advance(30_000);
  assert.equal(pill(), null);
});

test('off: by default (no answer, or the key off), and with errorPrompt: false', async () => {
  await start({ config: { verification: 'off' } });
  advance(10_000);
  uncaught();
  advance(30_000);
  assert.equal(pill(), null, 'the key has it off');
  fb!.destroy();
  await start({ errorPrompt: false });
  advance(10_000);
  uncaught();
  advance(30_000);
  assert.equal(pill(), null, 'the integrator has it off');
});

test('appHosts: hosts, wildcards and origins', () => {
  const m = appUrlMatcher(['api.example.com', '*.cdn.example.net', 'https://auth.example.org:8443/x']);
  assert.ok(m('https://api.example.com/v1/cart'));
  assert.ok(m('https://img.cdn.example.net/x.png'));
  assert.ok(!m('https://cdn.example.net/x.png'), 'the wildcard is for subdomains');
  assert.ok(m('https://auth.example.org:8443/login'));
  assert.ok(!m('https://evil.example/api.example.com'));
  assert.ok(m('/relative/path'), 'the page\'s own origin');
});

test('the on-screen keyboard: a visual viewport notably shorter than the layout one, on touch', () => {
  const w = (inner: number, vv: number, touch: number) =>
    ({ innerHeight: inner, visualViewport: { height: vv }, navigator: { maxTouchPoints: touch } }) as unknown as Window;
  assert.equal(keyboardUp(w(800, 450, 5)), true);
  assert.equal(keyboardUp(w(800, 740, 5)), false, 'a toolbar sliding in');
  assert.equal(keyboardUp(w(800, 450, 0)), false, 'not a touch device');
  assert.equal(keyboardUp({ innerHeight: 800, navigator: { maxTouchPoints: 5 } } as unknown as Window), false, 'no visualViewport');
});
