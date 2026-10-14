/**
 * One POST to the door, and its answers read the way contract §3.3 spells them. Never retries:
 * a `429` is handed back with its `retryAfter` and the caller keeps the report (§4).
 */

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

export async function sendReport(fetchImpl: typeof fetch, endpoint: string, key: string, body: FeedbackBody): Promise<ReportResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [KEY_HEADER]: key },
      body: JSON.stringify(body),
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
