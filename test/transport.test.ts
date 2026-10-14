import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedbackError } from '../src/payload.ts';
import { DEFAULT_ENDPOINT, KEY_HEADER, sendReport } from '../src/transport.ts';
import type { FeedbackBody } from '../src/types.ts';

const body: FeedbackBody = { v: 1, message: 'x', category: 'bug', context: { platform: 'web' } };

function answering(status: number, json: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(json === undefined ? 'not json' : JSON.stringify(json), { status, headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function refusal(status: number, json: unknown, headers?: Record<string, string>): Promise<FeedbackError> {
  const { f } = answering(status, json, headers);
  try {
    await sendReport(f, DEFAULT_ENDPOINT, 'obfk_x', body);
  } catch (e) {
    assert.ok(e instanceof FeedbackError);
    return e;
  }
  throw new Error('expected a refusal');
}

test('201: the ids, and the request as the contract spells it', async () => {
  const { f, calls } = answering(201, { id: 'fbr_1', taskId: 't1', conversationId: null });
  assert.deepEqual(await sendReport(f, DEFAULT_ENDPOINT, 'obfk_abc', body), { id: 'fbr_1', taskId: 't1', conversationId: null });
  assert.equal(calls[0]!.url, 'https://brain.deployd.network/v1/feedback');
  assert.equal(calls[0]!.init.method, 'POST');
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h[KEY_HEADER], 'obfk_abc');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(calls[0]!.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), body);
});

test('201 with a conversation', async () => {
  const { f } = answering(201, { id: 'fbr_1', taskId: 't1', conversationId: 'c:ana@example.com' });
  assert.equal((await sendReport(f, DEFAULT_ENDPOINT, 'k', body)).conversationId, 'c:ana@example.com');
});

test('the refusals carry the door\'s code, sentence and field', async () => {
  const e400 = await refusal(400, { code: 'invalid_field', field: 'reporter.email', error: 'The email address is not valid.' });
  assert.deepEqual([e400.status, e400.code, e400.field, e400.message], [400, 'invalid_field', 'reporter.email', 'The email address is not valid.']);
  assert.equal((await refusal(401, { code: 'unknown_key', error: 'Unknown key.' })).code, 'unknown_key');
  assert.equal((await refusal(403, { code: 'origin_not_allowed', error: 'Not from this site.' })).code, 'origin_not_allowed');
  assert.equal((await refusal(413, { code: 'too_large', error: 'Too large.' })).code, 'too_large');
  assert.equal((await refusal(500, { code: 'misconfigured', error: 'Missing binding DB.' })).message, 'Missing binding DB.');
});

test('429: retryAfter from the body, or from the header', async () => {
  const a = await refusal(429, { code: 'rate_limited', error: 'Slow down.', retryAfter: 120 });
  assert.deepEqual([a.status, a.code, a.retryAfter, a.message], [429, 'rate_limited', 120, 'Slow down.']);
  const b = await refusal(429, undefined, { 'Retry-After': '30' });
  assert.equal(b.retryAfter, 30);
  assert.equal(b.code, 'http_429');
  assert.ok(b.message.length > 0);
});

test('507 storage_full with ids: filed, without the files', async () => {
  const { f } = answering(507, { code: 'storage_full', error: 'Out of storage.', id: 'fbr_2', taskId: 't2', conversationId: null });
  assert.deepEqual(await sendReport(f, DEFAULT_ENDPOINT, 'k', body), { id: 'fbr_2', taskId: 't2', conversationId: null, storageFull: true });
  const e = await refusal(507, { code: 'storage_full', error: 'Out of storage.' });
  assert.equal(e.code, 'storage_full');
});

test('no answer at all: status 0', async () => {
  const f = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  await assert.rejects(sendReport(f, DEFAULT_ENDPOINT, 'k', body), (e: unknown) => e instanceof FeedbackError && e.status === 0 && e.code === 'network_error');
});
