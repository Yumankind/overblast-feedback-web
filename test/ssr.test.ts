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

test('init without a DOM: no UI, report() still sends', async () => {
  const { init } = await import('../src/index.ts');
  const bodies: unknown[] = [];
  const fb = init({
    key: 'obfk_server',
    fetch: (async (_u: string, i: RequestInit) => {
      bodies.push(JSON.parse(i.body as string));
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
  fb.destroy();
});
