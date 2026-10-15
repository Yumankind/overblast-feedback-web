/**
 * The request body, built to contract §3.1 and nothing else: the door refuses an unknown top-level
 * field by name, and refuses a field over its limit with `400 invalid_field`. So every limit is
 * applied here, on this side, where cutting a string is better than losing the report.
 */

import { MAX_LOGS, MAX_LOG_MSG, MAX_NETWORK } from './capture.ts';
import { utf8Length } from './redact.ts';
import { MAX_HTML, MAX_LABEL, MAX_QUOTE_CONTEXT, MAX_QUOTE } from './element.ts';
import { selectorWithinLimits } from './selector.ts';
import type { Category, DomElement, FeedbackBody, FeedbackContext, LogEntry, NetworkEntry, Reporter, ScreenshotBody, Trigger } from './types.ts';

export const MAX_MESSAGE = 4000;
export const MAX_LOG_BYTES = 256 * 1024;
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_EXTRA_KEYS = 20;
export const CATEGORIES: readonly Category[] = ['bug', 'idea', 'question', 'other'];
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const TRIGGERS: readonly Trigger[] = ['shake', 'button', 'shortcut', 'agent', 'api', 'relaunch', 'error_prompt'];

/** The top-level fields contract §3.1 names. Anything else is a bug in this file. */
export const BODY_FIELDS = ['v', 'message', 'category', 'reporter', 'context', 'element', 'screenshot', 'logs', 'logFile', 'network'] as const;

export class FeedbackError extends Error {
  /** The HTTP status; 0 when the request never got an answer, -1 when refused before sending. */
  readonly status: number;
  /** The door's `code` (`invalid_field`, `rate_limited`, …), or `network_error`. */
  readonly code: string;
  /** For `invalid_field`, the field the door named. */
  readonly field: string | undefined;
  /** For `rate_limited`, seconds until a retry may succeed. */
  readonly retryAfter: number | undefined;

  constructor(status: number, code: string, message: string, extra: { field?: string; retryAfter?: number } = {}) {
    super(message);
    this.name = 'FeedbackError';
    this.status = status;
    this.code = code;
    this.field = extra.field;
    this.retryAfter = extra.retryAfter;
  }
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Deliberately loose: one `@`, something on each side, a dot in the domain. The door decides. */
export function isEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export { utf8Length };

export function cleanReporter(r: Reporter | null | undefined): Reporter | undefined {
  if (!r) return undefined;
  const out: Reporter = {};
  const email = typeof r.email === 'string' ? r.email.trim() : '';
  if (email) {
    if (!isEmail(email)) throw new FeedbackError(-1, 'invalid_field', 'That email address does not look right.', { field: 'reporter.email' });
    out.email = email;
  }
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (name) out.name = cut(name, 120);
  const ref = typeof r.accountRef === 'string' ? r.accountRef.trim() : typeof r.accountRef === 'number' ? String(r.accountRef) : '';
  if (ref) out.accountRef = cut(ref, 200);
  return Object.keys(out).length ? out : undefined;
}

export function cleanExtra(extra: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!extra) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(extra)) {
    if (n >= MAX_EXTRA_KEYS) break;
    if (!k || v === undefined || v === null) continue;
    out[cut(k, 64)] = cut(typeof v === 'string' ? v : String(v), 200);
    n++;
  }
  return n ? out : undefined;
}

export function cleanContext(c: FeedbackContext): FeedbackContext {
  const out: FeedbackContext = { platform: 'web' };
  if (c.url) out.url = cut(c.url, 2000);
  if (c.title) out.title = cut(c.title, 200);
  if (c.appVersion) out.appVersion = cut(c.appVersion, 40);
  if (c.build) out.build = cut(c.build, 40);
  if (c.locale) out.locale = cut(c.locale, 40);
  if (c.timeZone) out.timeZone = cut(c.timeZone, 40);
  if (c.viewport) {
    const { w, h, dpr } = c.viewport;
    if ([w, h, dpr].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) out.viewport = { w: Math.round(w), h: Math.round(h), dpr };
  }
  if (c.userAgent) out.userAgent = cut(c.userAgent, 400);
  if (c.sdk) out.sdk = { name: cut(c.sdk.name, 80), version: cut(c.sdk.version, 40) };
  if (c.deviceId && /^[A-Za-z0-9_-]{1,64}$/.test(c.deviceId)) out.deviceId = c.deviceId;
  const extra = cleanExtra(c.extra);
  if (extra) out.extra = extra;
  if (typeof c.openedAt === 'number' && Number.isFinite(c.openedAt) && c.openedAt > 0) out.openedAt = Math.round(c.openedAt);
  if (c.trigger && TRIGGERS.includes(c.trigger)) out.trigger = c.trigger;
  return out;
}

const frac = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Re-check an anchor (ours, or one the integrator built) against §3.2; undefined when it cannot be made to fit. */
export function cleanElement(e: DomElement | null | undefined): DomElement | undefined {
  if (!e || e.kind !== 'dom') return undefined;
  if (typeof e.selector !== 'string' || !selectorWithinLimits(e.selector)) return undefined;
  if (typeof e.tag !== 'string' || !e.tag) return undefined;
  const r = e.rect;
  if (!r || !frac(r.x) || !frac(r.y) || !frac(r.w) || !frac(r.h)) return undefined;
  const vp = e.viewport;
  if (!vp || !(vp.w > 0 && vp.w <= 20000 && vp.h > 0 && vp.h <= 20000)) return undefined;
  const out: DomElement = {
    kind: 'dom',
    selector: e.selector,
    tag: cut(e.tag, 32),
    rect: { x: r.x, y: r.y, w: r.w, h: r.h },
    viewport: { w: vp.w, h: vp.h },
  };
  if (e.role) out.role = cut(e.role, 32);
  if (e.label) out.label = cut(e.label, MAX_LABEL);
  if (e.textQuote && e.textQuote.exact) {
    out.textQuote = {
      exact: cut(e.textQuote.exact, MAX_QUOTE),
      prefix: cut(e.textQuote.prefix ?? '', MAX_QUOTE_CONTEXT),
      suffix: cut(e.textQuote.suffix ?? '', MAX_QUOTE_CONTEXT),
    };
  }
  if (e.html && e.html.length <= MAX_HTML) out.html = e.html;
  return out;
}

/** One entry as the door takes it: `t`, `level`, `msg` ≤ 4000, `src` ≤ 40, and `repeat`/`last` when set. */
export function cleanLog(l: LogEntry): LogEntry {
  const out: LogEntry = { t: Math.round(l.t), level: l.level, msg: cut(l.msg, MAX_LOG_MSG), src: cut(l.src || 'console', 40) };
  if (typeof l.repeat === 'number' && l.repeat > 1) out.repeat = Math.round(l.repeat);
  if (typeof l.last === 'number' && Number.isFinite(l.last)) out.last = Math.round(l.last);
  return out;
}

const isLog = (l: LogEntry) => !!l && typeof l.msg === 'string' && typeof l.t === 'number' && LEVELS.has(l.level);

/** Errors and warnings this long before `openedAt` are always in the excerpt, room allowing (§3.5). */
export const EXCERPT_URGENT_WINDOW_MS = 2 * 60 * 1000;

/**
 * The excerpt sent as `logs` (§3.5): at most 500 entries and 256 KB, chosen as every error and
 * warning in the two minutes before `openedAt` (the newest first if even they do not all fit), then
 * the newest other lines up to the cap. Returned in the buffer's order.
 */
export function excerpt(logs: LogEntry[], openedAt?: number): LogEntry[] {
  const all = logs.filter(isLog).map(cleanLog);
  const at = typeof openedAt === 'number' && Number.isFinite(openedAt) ? openedAt : (all.at(-1)?.t ?? 0);
  const budget = MAX_LOG_BYTES - 1024;
  let bytes = 2;
  let count = 0;
  const chosen = new Uint8Array(all.length);
  const take = (i: number): boolean => {
    if (count >= MAX_LOGS) return false;
    const size = utf8Length(JSON.stringify(all[i])) + 1;
    if (bytes + size > budget) return true; // too big to fit now; a smaller one still might
    bytes += size;
    count++;
    chosen[i] = 1;
    return true;
  };
  for (let i = all.length - 1; i >= 0; i--) {
    const l = all[i]!;
    if ((l.level === 'error' || l.level === 'warn') && l.t <= at && l.t >= at - EXCERPT_URGENT_WINDOW_MS) {
      if (!take(i)) break;
    }
  }
  for (let i = all.length - 1; i >= 0 && count < MAX_LOGS && bytes < budget - 64; i--) {
    if (!chosen[i]) take(i);
  }
  return all.filter((_, i) => chosen[i] === 1);
}

/** The newest entries that fit both caps: 500 lines and 256 KB of JSON. */
export function capLogs(logs: LogEntry[]): LogEntry[] {
  const clean = logs.filter(isLog).map(cleanLog);
  const newest = clean.slice(-MAX_LOGS);
  // A margin under the door's 256 KB, for the brackets and commas and whatever it counts as a KB.
  const budget = MAX_LOG_BYTES - 1024;
  let bytes = 2;
  let from = newest.length;
  while (from > 0) {
    const size = utf8Length(JSON.stringify(newest[from - 1])) + 1;
    if (bytes + size > budget) break;
    bytes += size;
    from--;
  }
  return newest.slice(from);
}

export function capNetwork(entries: NetworkEntry[]): NetworkEntry[] {
  return entries.slice(-MAX_NETWORK).map((n) => ({
    t: Math.round(n.t),
    method: cut(String(n.method || 'GET').toUpperCase(), 16),
    url: cut(n.url, 500),
    status: Number.isInteger(n.status) && n.status >= 0 ? n.status : 0,
    ms: Math.max(0, Math.round(n.ms)),
  }));
}

export interface BodyInput {
  message: string;
  category?: Category | undefined;
  reporter?: Reporter | undefined;
  context: FeedbackContext;
  element?: DomElement | undefined;
  screenshot?: ScreenshotBody | undefined;
  logs?: LogEntry[] | undefined;
  network?: NetworkEntry[] | undefined;
}

export function buildBody(input: BodyInput): FeedbackBody {
  const message = (input.message ?? '').trim();
  if (!message) throw new FeedbackError(-1, 'invalid_field', 'Please say what happened.', { field: 'message' });
  const category: Category = input.category && CATEGORIES.includes(input.category) ? input.category : 'bug';
  const body: FeedbackBody = {
    v: 1,
    message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message,
    category,
    context: cleanContext(input.context),
  };
  const reporter = cleanReporter(input.reporter);
  if (reporter) body.reporter = reporter;
  const element = cleanElement(input.element);
  if (element) body.element = element;
  if (input.screenshot) {
    const s = input.screenshot;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(s.contentType)) {
      throw new FeedbackError(-1, 'invalid_field', 'The screenshot is not an image the door takes.', { field: 'screenshot.contentType' });
    }
    if (base64Bytes(s.base64) > MAX_SCREENSHOT_BYTES) {
      throw new FeedbackError(-1, 'too_large', 'The screenshot is larger than 5 MB.', { field: 'screenshot' });
    }
    body.screenshot = { contentType: s.contentType, base64: s.base64, highlighted: !!s.highlighted };
  }
  const logs = input.logs ? excerpt(input.logs, body.context.openedAt) : [];
  if (logs.length) body.logs = logs;
  const network = input.network ? capNetwork(input.network) : [];
  if (network.length) body.network = network;
  return body;
}

/** The decoded size of a base64 string. */
export function base64Bytes(b64: string): number {
  const len = b64.length;
  if (!len) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}
