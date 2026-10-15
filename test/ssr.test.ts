/**
 * No DOM in this file on purpose: importing the package during server rendering must not touch
 * `window`, and `init` there gives an instance whose `report()` still works.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('importing touches nothing global', async () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
  const mod = await import('../src/index.ts');
  assert.equal(typeof mod.init, 'function');
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
});

test('init without a DOM: no UI, report() still sends, unsigned, without touching IndexedDB', async () => {
  // A server runtime that happens to have IndexedDB (and Node has WebCrypto): still never touched.
  let touched = false;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      touched = true;
      return undefined;
    },
  });
  const { init } = await import('../src/index.ts');
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fb = init({
    key: 'obfk_server',
    fetch: (async (u: string, i: RequestInit) => {
      urls.push(u);
      headers.push(i.headers as Record<string, string>);
      bodies.push(JSON.parse(new TextDecoder().decode(i.body as Uint8Array)));
      return new Response(JSON.stringify({ id: 'fbr_s', taskId: 't', conversationId: null }), { status: 201 });
    }) as unknown as typeof fetch,
  });
  fb.open();
  assert.equal(await fb.pick(), null);
  assert.deepEqual(await fb.report({ message: 'from a worker' }), { id: 'fbr_s', taskId: 't', conversationId: null });
  const body = bodies[0] as { context: { platform: string; deviceId: string; url?: string } };
  assert.equal(body.context.platform, 'web');
  assert.match(body.context.deviceId, /^[a-f0-9]{32}$/);
  assert.equal(body.context.url, undefined);
  assert.deepEqual(urls, ['https://brain.deployd.network/v1/feedback']);
  assert.equal(headers[0]!['X-Overblast-Feedback-Device'], undefined);
  assert.equal(await fb.deviceLevel(), 'none');
  assert.equal(touched, false, 'IndexedDB was never read');
  fb.destroy();
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});
