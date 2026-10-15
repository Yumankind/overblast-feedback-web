/**
 * The site's chat (`window.InfiniteAgent`, the 00 Mini embed), when it is on the page
 * (feedback-chat-integration §2.1, §5a). Then:
 *
 * - it is the one button in the corner: the library hides its own;
 * - a report is signed with the chat's device rather than the library's own, so the task points at
 *   the visitor's conversation and the conversation shows the task;
 * - the library tells the chat what it can do and hands it an opener, so the chat's agent (or its
 *   "Report a problem" entry) opens the library's sheet with the visitor's words;
 * - the error prompt is a nudge from the chat's launcher instead of the library's pill.
 *
 * The page API is a contract with the embed (00Local `docs/HANDOFF-infinite-agent.md`, "Contract:
 * problem reports in the chat"). Everything here is read defensively: the embed loads async, may be
 * an older version, and may throw.
 */

import { base64url } from './device.ts';
import type { Category } from './types.ts';
import type { ErrorKind } from './config.ts';

export const CHAT_READY_EVENT = 'infinite:ready';
export const EMBED_APP_HEADER = 'X-Overblast-Feedback-App';
export const EMBED_NONCE_HEADER = 'X-Overblast-Feedback-Nonce';

export interface FeedbackCapabilities {
  available: boolean;
  source: 'library' | 'embed';
  picker: boolean;
  screenshot: boolean;
  shake: boolean;
  pointer: 'fine' | 'coarse';
  /** The kinds of report the key takes (§2 of the feedback contract), so the chat offers only those. */
  categories: Category[];
}

export interface FeedbackOpenOptions {
  message?: string;
  category?: Category;
  pick?: boolean;
  turnId?: string;
  trigger?: 'agent' | 'api' | 'error_prompt';
}

export interface FeedbackOpenResult {
  filed: boolean;
  reportId?: string;
  reference?: string;
  reason?: string;
}

export type FeedbackOpener = (opts: FeedbackOpenOptions) => Promise<FeedbackOpenResult>;

export interface FeedbackPageApi {
  device(): { appId: string; deviceId: string } | null;
  sign(canonical: string): Promise<string>;
  announce(caps: FeedbackCapabilities, open?: FeedbackOpener): void;
  open?(opts?: FeedbackOpenOptions): Promise<FeedbackOpenResult>;
  /** Resolves once the bubble has gone (plan §5a). */
  nudge?(opts: { text: string; reason: ErrorKind }): Promise<{ shown: boolean; outcome?: 'tapped' | 'dismissed' | 'expired' }>;
}

type ChatWindow = { InfiniteAgent?: { feedback?: Partial<FeedbackPageApi> } | null };

/** Whether the chat is on the page at all (its button is then the one in the corner). */
export function chatPresent(win: Window | undefined): boolean {
  try {
    return !!win && !!(win as unknown as ChatWindow).InfiniteAgent;
  } catch {
    return false;
  }
}

/** The chat's feedback page API, when it has one (it comes once the chat knows the site's app). */
export function chatApi(win: Window | undefined): Partial<FeedbackPageApi> | null {
  try {
    const fb = win ? (win as unknown as ChatWindow).InfiniteAgent?.feedback : null;
    return fb && typeof fb === 'object' ? fb : null;
  } catch {
    return null;
  }
}

/** The embed's canonical string: the feedback one with a nonce line (plan §2.1). */
export function embedCanonical(deviceId: string, time: string | number, nonce: string, bodyHash: string): string {
  return `overblast-feedback-v1\n${deviceId}\n${time}\n${nonce}\n${bodyHash}`;
}

/** 16 random bytes, base64url: 22 characters of `[A-Za-z0-9_-]`, inside the embed's 16 to 64. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

const APP_ID = /^iaa_[A-Za-z0-9_-]{1,80}$/;
const DEVICE_ID = /^iad_[A-Za-z0-9_-]{1,80}$/;

/**
 * The five headers over `body`, signed by the chat's device; null when the chat has no device to lend
 * (none yet, forgotten), or anything fails, and the library then signs with its own.
 */
export async function embedHeaders(api: Partial<FeedbackPageApi> | null, body: Uint8Array, now: () => number = Date.now): Promise<Record<string, string> | null> {
  try {
    if (!api || typeof api.device !== 'function' || typeof api.sign !== 'function') return null;
    const dev = api.device();
    if (!dev || typeof dev.deviceId !== 'string' || typeof dev.appId !== 'string' || !DEVICE_ID.test(dev.deviceId) || !APP_ID.test(dev.appId)) return null;
    const hash = base64url(await crypto.subtle.digest('SHA-256', body as BufferSource));
    const time = String(now());
    const nonce = makeNonce();
    const signature = await api.sign(embedCanonical(dev.deviceId, time, nonce, hash));
    if (typeof signature !== 'string' || !signature) return null;
    return {
      'X-Overblast-Feedback-Device': dev.deviceId,
      [EMBED_APP_HEADER]: dev.appId,
      'X-Overblast-Feedback-Time': time,
      [EMBED_NONCE_HEADER]: nonce,
      'X-Overblast-Feedback-Signature': signature,
    };
  } catch {
    return null;
  }
}
