import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BODY_FIELDS, base64Bytes, buildBody, capLogs, capNetwork, cleanElement, FeedbackError, MAX_LOG_BYTES, utf8Length } from '../src/payload.ts';
import type { DomElement, LogEntry, NetworkEntry } from '../src/types.ts';

const ctx = { platform: 'web' as const, url: 'https://a.example/x?y=1', sdk: { name: 'overblast-feedback-web', version: '0.1.0' }, deviceId: 'abc_123' };

test('the smallest body is exactly v, message, category, context', () => {
  const body = buildBody({ message: '  The total does not update  ', context: ctx });
  assert.deepEqual(body, { v: 1, message: 'The total does not update', category: 'bug', context: ctx });
});

test('a full body has only the contract\'s top-level fields and its nested fields', () => {
  const element: DomElement = {
    kind: 'dom',
    selector: 'main > button',
    tag: 'button',
    role: 'button',
    label: 'Remove',
    rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
    viewport: { w: 393, h: 852 },
    textQuote: { exact: 'Remove', prefix: '', suffix: '' },
    html: '<button>Remove</button>',
  };
  const body = buildBody({
    message: 'x',
    category: 'idea',
    reporter: { email: 'ana@example.com', name: 'Ana', accountRef: 'cus_1' },
    context: { ...ctx, title: 'Cart', appVersion: '2.4.1', build: '412', locale: 'pt-PT', timeZone: 'Europe/Lisbon', viewport: { w: 393, h: 852, dpr: 3 }, userAgent: 'UA', extra: { plan: 'pro' } },
    element,
    screenshot: { contentType: 'image/jpeg', base64: 'AAAA', highlighted: true },
    logs: [{ t: 1, level: 'error', msg: 'boom', src: 'console' }],
    network: [{ t: 2, method: 'post', url: 'https://api.example/x', status: 500, ms: 31.6 }],
  });
  for (const k of Object.keys(body)) assert.ok((BODY_FIELDS as readonly string[]).includes(k), `unknown top-level field ${k}`);
  assert.deepEqual(Object.keys(body).sort(), [...BODY_FIELDS].sort());
  assert.deepEqual(Object.keys(body.reporter!).sort(), ['accountRef', 'email', 'name']);
  assert.deepEqual(Object.keys(body.context).sort(), ['appVersion', 'build', 'deviceId', 'extra', 'locale', 'platform', 'sdk', 'timeZone', 'title', 'url', 'userAgent', 'viewport']);
  assert.deepEqual(Object.keys(body.element!).sort(), ['html', 'kind', 'label', 'rect', 'role', 'selector', 'tag', 'textQuote', 'viewport']);
  assert.deepEqual(Object.keys(body.screenshot!).sort(), ['base64', 'contentType', 'highlighted']);
  assert.deepEqual(body.network, [{ t: 2, method: 'POST', url: 'https://api.example/x', status: 500, ms: 32 }]);
  assert.deepEqual(Object.keys(body.logs![0]!).sort(), ['level', 'msg', 'src', 't']);
});

test('message: required, and cut to 4000', () => {
  assert.throws(() => buildBody({ message: '   ', context: ctx }), (e: unknown) => e instanceof FeedbackError && e.field === 'message');
  assert.equal(buildBody({ message: 'm'.repeat(5000), context: ctx }).message.length, 4000);
});

test('an unknown category becomes bug', () => {
  assert.equal(buildBody({ message: 'x', category: 'rant' as never, context: ctx }).category, 'bug');
});

test('reporter: an invalid email is refused by name; long fields are cut; empty reporter is left out', () => {
  assert.throws(() => buildBody({ message: 'x', reporter: { email: 'not-an-email' }, context: ctx }), (e: unknown) => e instanceof FeedbackError && e.field === 'reporter.email');
  const b = buildBody({ message: 'x', reporter: { name: 'n'.repeat(300), accountRef: 'r'.repeat(300) }, context: ctx });
  assert.equal(b.reporter!.name!.length, 120);
  assert.equal(b.reporter!.accountRef!.length, 200);
  assert.equal(buildBody({ message: 'x', reporter: { email: ' ', name: '' }, context: ctx }).reporter, undefined);
});

test('context: limits applied, a malformed deviceId dropped, extra held to 20 string values', () => {
  const extra: Record<string, string> = {};
  for (let i = 0; i < 30; i++) extra[`k${i}`] = 'v'.repeat(300);
  const b = buildBody({
    message: 'x',
    context: { platform: 'web', url: 'u'.repeat(3000), title: 't'.repeat(300), userAgent: 'a'.repeat(500), deviceId: 'has space', extra },
  });
  assert.equal(b.context.url!.length, 2000);
  assert.equal(b.context.title!.length, 200);
  assert.equal(b.context.userAgent!.length, 400);
  assert.equal(b.context.deviceId, undefined);
  assert.equal(Object.keys(b.context.extra!).length, 20);
  assert.ok(Object.values(b.context.extra!).every((v) => v.length === 200));
});

test('logs: at most 500, newest kept', () => {
  const logs: LogEntry[] = Array.from({ length: 800 }, (_, i) => ({ t: i, level: 'info', msg: `line ${i}`, src: 'console' }));
  const capped = capLogs(logs);
  assert.equal(capped.length, 500);
  assert.equal(capped[0]!.msg, 'line 300');
  assert.equal(capped.at(-1)!.msg, 'line 799');
});

test('logs: at most 256 KB of JSON, newest kept', () => {
  const logs: LogEntry[] = Array.from({ length: 400 }, (_, i) => ({ t: i, level: 'warn', msg: `${i} ${'é'.repeat(1500)}`, src: 'console' }));
  const capped = capLogs(logs);
  assert.ok(capped.length < 400);
  assert.ok(utf8Length(JSON.stringify(capped)) <= MAX_LOG_BYTES, `${utf8Length(JSON.stringify(capped))}`);
  assert.equal(capped.at(-1)!.t, 399);
  // Each line is at most 4000 characters.
  const long = capLogs([{ t: 1, level: 'error', msg: 'x'.repeat(9000), src: 's'.repeat(80) }]);
  assert.equal(long[0]!.msg.length, 4000);
  assert.equal(long[0]!.src.length, 40);
});

test('network: at most 100, newest kept', () => {
  const entries: NetworkEntry[] = Array.from({ length: 150 }, (_, i) => ({ t: i, method: 'GET', url: `https://a/${i}`, status: 200, ms: 1 }));
  const capped = capNetwork(entries);
  assert.equal(capped.length, 100);
  assert.equal(capped[0]!.t, 50);
  const body = buildBody({ message: 'x', context: ctx, network: entries });
  assert.equal(body.network!.length, 100);
});

test('element: an anchor outside the limits is dropped rather than refused', () => {
  const ok: DomElement = { kind: 'dom', selector: 'main > a', tag: 'a', rect: { x: 0, y: 0, w: 1, h: 1 }, viewport: { w: 1, h: 1 } };
  assert.ok(cleanElement(ok));
  assert.equal(cleanElement({ ...ok, selector: 'a[href="x"]' }), undefined);
  assert.equal(cleanElement({ ...ok, selector: 'a>b>c>d>e>f>g' }), undefined);
  assert.equal(cleanElement({ ...ok, rect: { x: 1.2, y: 0, w: 0, h: 0 } }), undefined);
  assert.equal(cleanElement({ ...ok, viewport: { w: 0, h: 1 } }), undefined);
  const cut = cleanElement({ ...ok, label: 'l'.repeat(500), textQuote: { exact: 'e'.repeat(500), prefix: 'p'.repeat(100), suffix: 's'.repeat(100) }, html: 'h'.repeat(3000) })!;
  assert.equal(cut.label!.length, 120);
  assert.equal(cut.textQuote!.exact.length, 200);
  assert.equal(cut.textQuote!.prefix.length, 32);
  assert.equal(cut.html, undefined);
});

test('screenshot: only the three image types, at most 5 MB decoded', () => {
  assert.throws(() => buildBody({ message: 'x', context: ctx, screenshot: { contentType: 'image/gif' as never, base64: 'AA==', highlighted: false } }));
  const big = 'A'.repeat(Math.ceil(((5 * 1024 * 1024 + 10) * 4) / 3));
  assert.throws(() => buildBody({ message: 'x', context: ctx, screenshot: { contentType: 'image/jpeg', base64: big, highlighted: false } }), (e: unknown) => e instanceof FeedbackError && e.code === 'too_large');
  assert.equal(base64Bytes('AAAA'), 3);
  assert.equal(base64Bytes('AA=='), 1);
});
