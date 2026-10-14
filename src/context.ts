/**
 * Where the report was made: the page, the browser, and a random id for this browser so the door
 * can hold its per-device limits (contract §4). Every storage access is guarded, because a private
 * window, a sandboxed iframe or blocked site data makes `localStorage` throw on touch.
 */

import { contextUrl } from './redact.ts';
import type { FeedbackContext } from './types.ts';
import { SDK_NAME, SDK_VERSION } from './version.ts';

export const DEVICE_KEY = 'ob-feedback-device';

export function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let ephemeral: string | null = null;

/** The id kept in `localStorage`, or one for this page's life when storage is unavailable. */
export function deviceId(): string {
  const store = safeStorage();
  try {
    const kept = store?.getItem(DEVICE_KEY);
    if (kept && /^[A-Za-z0-9_-]{1,64}$/.test(kept)) return kept;
  } catch {
    /* fall through */
  }
  const id = ephemeral ?? randomId();
  try {
    store?.setItem(DEVICE_KEY, id);
  } catch {
    /* ephemeral it is */
  }
  ephemeral = id;
  return id;
}

export interface ContextOptions {
  appVersion?: string | undefined;
  build?: string | undefined;
  locale?: string | undefined;
  extra?: Record<string, string> | undefined;
}

export function collectContext(opts: ContextOptions): FeedbackContext {
  const ctx: FeedbackContext = { platform: 'web', sdk: { name: SDK_NAME, version: SDK_VERSION }, deviceId: deviceId() };
  const win = typeof window !== 'undefined' ? window : undefined;
  try {
    if (win?.location?.href) ctx.url = contextUrl(win.location.href);
  } catch {
    /* no url */
  }
  try {
    const title = win?.document?.title?.trim();
    if (title) ctx.title = title;
  } catch {
    /* no title */
  }
  try {
    if (win) ctx.viewport = { w: win.innerWidth || 1, h: win.innerHeight || 1, dpr: win.devicePixelRatio || 1 };
  } catch {
    /* no viewport */
  }
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.userAgent) ctx.userAgent = nav.userAgent;
    const locale = opts.locale ?? nav?.language;
    if (locale) ctx.locale = locale;
  } catch {
    /* no navigator */
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) ctx.timeZone = tz;
  } catch {
    /* no Intl */
  }
  if (opts.appVersion) ctx.appVersion = opts.appVersion;
  if (opts.build) ctx.build = opts.build;
  if (opts.extra && Object.keys(opts.extra).length) ctx.extra = opts.extra;
  return ctx;
}
