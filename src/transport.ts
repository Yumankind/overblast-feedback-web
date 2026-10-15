/**
 * The POST to the door, and its answers read the way contract §3.3 spells them. A `429` is handed
 * back with its `retryAfter` and the caller keeps the report (§4); it is never retried here.
 *
 * The one resend this file makes is the device's (§8.3): a signature the door does not accept
 * (`unknown_device`, `device_signature_invalid`) or a key that needs one (`device_required`) gets a
 * fresh registration and exactly one more try, with the same bytes.
 */

import { RETRY_WAIT_MS, SEND_WAIT_MS, type DeviceClient } from './device.ts';
import { FeedbackError } from './payload.ts';
import type { FeedbackBody, ReportResult } from './types.ts';

export const DEFAULT_ENDPOINT = 'https://brain.deployd.network/v1/feedback';
export const KEY_HEADER = 'X-Overblast-Feedback-Key';

const FALLBACK: Record<number, string> = {
  400: 'The report could not be accepted.',
  401: 'This feedback key is not valid any more.',
  403: 'Feedback is not accepted from this site.',
  413: 'The report is too large to send.',
  429: 'Too many reports have been sent from here. Please try again later.',
  500: 'Feedback is not available right now.',
};

interface Answer {
  id?: unknown;
  taskId?: unknown;
  conversationId?: unknown;
  code?: unknown;
  error?: unknown;
  field?: unknown;
  retryAfter?: unknown;
}

/** The body as the bytes that are both signed and sent: encoded once, so the two cannot differ. */
export function encodeBody(body: FeedbackBody): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

export interface SendOptions {
  /** The registered device, or null to send unsigned. */
  device?: DeviceClient | null | undefined;
  /** How long Send waits for a registration under way. Default 3 s. */
  waitMs?: number | undefined;
  /** How long a resend waits for a new registration. Default 30 s. */
  retryWaitMs?: number | undefined;
}

export async function sendReport(
  fetchImpl: typeof fetch,
  endpoint: string,
  key: string,
  body: FeedbackBody,
  opts: SendOptions = {},
): Promise<ReportResult> {
  const bytes = encodeBody(body);
  const device = opts.device ?? null;
  if (!device) return post(fetchImpl, endpoint, key, bytes, {});

  const first = await device.ready(opts.waitMs ?? SEND_WAIT_MS);
  const headers = first.device ? await device.sign(first.device, bytes) : {};
  try {
    return await post(fetchImpl, endpoint, key, bytes, headers);
  } catch (err) {
    if (!(err instanceof FeedbackError)) throw err;
    const retryWait = opts.retryWaitMs ?? RETRY_WAIT_MS;

    // The door does not know this device (dropped, or another endpoint's) or will not take its
    // signature: forget it, register a new one, and send once more, unsigned if that failed.
    if (err.status === 401 && (err.code === 'unknown_device' || err.code === 'device_signature_invalid')) {
      await device.drop();
      const again = await device.ready(retryWait, true);
      return post(fetchImpl, endpoint, key, bytes, again.device ? await device.sign(again.device, bytes) : {});
    }

    // The key takes only registered devices. Register, unless this send already tried and failed,
    // and send once more; without a device, the door's own sentence is what the person sees.
    if (err.status === 403 && err.code === 'device_required' && !first.device) {
      if (first.state === 'failed' || first.state === 'unavailable') throw err;
      const again = await device.ready(retryWait, first.state === 'cooldown');
      if (!again.device) throw err;
      return post(fetchImpl, endpoint, key, bytes, await device.sign(again.device, bytes));
    }
    throw err;
  }
}

async function post(fetchImpl: typeof fetch, endpoint: string, key: string, bytes: Uint8Array, extraHeaders: Record<string, string>): Promise<ReportResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [KEY_HEADER]: key, ...extraHeaders },
      body: bytes as BodyInit,
      credentials: 'omit',
      mode: 'cors',
    });
  } catch {
    throw new FeedbackError(0, 'network_error', 'The report could not be sent. Check the connection and try again.');
  }
  let answer: Answer = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object') answer = parsed as Answer;
  } catch {
    /* a body that is not JSON: the status alone speaks */
  }
  const ids = typeof answer.id === 'string' && typeof answer.taskId === 'string';
  if (response.status === 201 || (response.ok && ids)) {
    if (!ids) throw new FeedbackError(response.status, 'bad_answer', 'The report was sent, but the answer could not be read.');
    return {
      id: answer.id as string,
      taskId: answer.taskId as string,
      conversationId: typeof answer.conversationId === 'string' ? answer.conversationId : null,
    };
  }
  // 507: the workspace is out of storage. The task is still filed, without the files (§3.3, §5.3).
  if (response.status === 507 && ids) {
    return {
      id: answer.id as string,
      taskId: answer.taskId as string,
      conversationId: typeof answer.conversationId === 'string' ? answer.conversationId : null,
      storageFull: true,
    };
  }
  const code = typeof answer.code === 'string' ? answer.code : `http_${response.status}`;
  const sentence = typeof answer.error === 'string' && answer.error ? answer.error : (FALLBACK[response.status] ?? FALLBACK[500]!);
  const extra: { field?: string; retryAfter?: number } = {};
  if (typeof answer.field === 'string') extra.field = answer.field;
  let retry = typeof answer.retryAfter === 'number' ? answer.retryAfter : Number(response.headers.get('Retry-After'));
  if (Number.isFinite(retry) && retry > 0) extra.retryAfter = Math.ceil(retry);
  throw new FeedbackError(response.status, code, sentence, extra);
}
