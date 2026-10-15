/**
 * `@overblast/feedback/early`: catch errors from the first line of the page, before the library
 * itself has loaded (contract §3.4). Put in `<head>`, it records `console.warn`, `console.error`,
 * uncaught errors, unhandled rejections and, when asked, failed `fetch` calls into
 * `window.__overblastFeedbackEarly`, at most 200 lines, redacted by the same rules as the library.
 *
 * It restores nothing. When `init()` runs it adopts the buffer: it stops this recorder, puts back
 * the originals this file wrapped wherever its wrapper is still the installed one (so the library
 * wraps the original, never a wrapper), keeps the entries with their own timestamps, and deletes
 * the buffer.
 *
 * Self-contained by build: the script-tag file bundles its own copy of the redaction, so it never
 * loads the library, and it stays a little over a kilobyte.
 */

import { redact } from './redact.ts';
import type { EarlyBuffer, LogEntry, LogLevel, NetworkEntry } from './types.ts';

export const EARLY_KEY = '__overblastFeedbackEarly';
export const EARLY_MAX = 200;

type Fn = (...args: unknown[]) => unknown;

/**
 * A value as a log line shows it. Errors keep their stack; anything JSON cannot hold becomes its
 * `String`. The library formats more carefully; the early recorder is kept small on purpose.
 */
function text(v: unknown): string {
  try {
    return typeof v === 'string' ? v : v instanceof Error ? v.stack || `${v}` : (JSON.stringify(v) ?? `${v}`);
  } catch {
    return `${v}`;
  }
}

/** No query string, no fragment; `init` passes it through the library's own `networkUrl` as well. */
const bare = (url: string) => url.split(/[?#]/)[0]!.slice(0, 500);

export interface EarlyOptions {
  /** Also record failed `fetch` calls (thrown, or answered 4xx/5xx). Default false. */
  fetch?: boolean | undefined;
}

/**
 * Start recording. Idempotent: a second call returns the buffer already there. Repeats are not
 * collapsed here but when `init` adopts the buffer, and lines over 200 in a second are counted in
 * `dropped` without being formatted or redacted.
 */
export function startEarly(opts: EarlyOptions = {}): EarlyBuffer | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown> & Window;
  if (w[EARLY_KEY]) return w[EARLY_KEY] as EarlyBuffer;
  let live = 1;
  let sec = 0;
  let inSec = 0;
  const logs: LogEntry[] = [];
  const network: NetworkEntry[] = [];
  const originals: Record<string, Fn> = {};
  const wrappers: Record<string, Fn> = {};

  const keep = <T>(list: T[], item: T) => list.push(item) > EARLY_MAX && list.shift();

  const push = (level: LogLevel, src: string, raw: () => string): void => {
    const t = Date.now();
    if (!live) return;
    if (t - sec >= 1000) {
      sec = t;
      inSec = 0;
    }
    // Only errors and warnings come here, so the library's cap for them: 200 a second.
    if (inSec++ >= 200) {
      buf.dropped++;
      return;
    }
    // `text` never throws, and neither does the redaction. Redacted first, then cut, as the
    // library's own `cleanMessage` does; the library cuts again, with its ellipsis, on adoption.
    keep(logs, { t, level, msg: redact(raw().slice(0, 16e3)).slice(0, 4e3), src });
  };

  const wrap = (holder: Record<string, unknown>, name: string, make: (orig: Fn) => Fn): void => {
    const orig = holder[name];
    if (typeof orig === 'function') holder[name] = wrappers[name] = make((originals[name] = orig as Fn));
  };

  for (const level of ['warn', 'error'] as const) {
    wrap(w.console as unknown as Record<string, unknown>, level, (orig) =>
      function (this: unknown, ...a: unknown[]) {
        push(level, 'console', () => a.map(text).join(' '));
        return orig.apply(this, a);
      },
    );
  }

  // Left in place by `stop()`, which only silences them: removing them would cost bytes in every
  // page's <head> to save two listeners that return at once.
  w.addEventListener(
    'error',
    (e) => {
      const ev = e as ErrorEvent;
      if (ev.message || ev.error) {
        push('error', 'onerror', () => (ev.error ? text(ev.error) : ev.message) + (ev.filename ? ` (${bare(ev.filename)}:${ev.lineno}:${ev.colno})` : ''));
      }
    },
    true,
  );
  w.addEventListener('unhandledrejection', (e) => push('error', 'unhandledrejection', () => `Unhandled rejection: ${text(e.reason)}`));

  if (opts.fetch) {
    wrap(w, 'fetch', (orig) =>
      function (this: unknown, ...a: unknown[]) {
        const t = Date.now();
        const input = a[0] as Request | string | URL;
        const note = (status: number) => {
          if (live) {
            // The library upper-cases the method and cleans the url again when it adopts this.
            keep(network, { t, method: (a[1] as RequestInit | undefined)?.method || (input as Request).method || 'GET', url: bare(`${(input as Request).url || input}`), status, ms: Date.now() - t });
          }
        };
        return (orig.apply(this, a) as Promise<Response>).then(
          (r) => {
            if (r.status >= 400) note(r.status);
            return r;
          },
          (err: unknown) => {
            note(0);
            throw err;
          },
        );
      },
    );
  }

  const buf: EarlyBuffer = {
    v: 1,
    logs,
    network,
    dropped: 0,
    originals,
    wrappers,
    stop: () => (live = 0),
  };
  w[EARLY_KEY] = buf;
  return buf;
}
