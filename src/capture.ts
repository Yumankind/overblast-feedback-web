/**
 * What the page said while the person was using it: console lines, uncaught errors, unhandled
 * rejections, and the shape of its requests (method, address without query, status, time).
 *
 * Every wrapper here is transparent: it calls the original with the same `this` and arguments,
 * returns what the original returned, and lets what the original threw through untouched. On
 * `uninstall` each original is put back if ours is still the one installed; if something wrapped
 * over ours since, ours stays in the chain as a pass-through instead, so their wrapper keeps working.
 */

import { LogBuffer } from './logbuffer.ts';
import { MAX_LOG_MSG, cleanMessage, networkUrl } from './redact.ts';
import type { ErrorKind } from './config.ts';
import type { EarlyBuffer, LogLevel, NetworkEntry } from './types.ts';

export { MAX_LOG_MSG, cleanMessage };
/** The excerpt's cap (`logs` in the body); the buffer itself holds far more (§3.5). */
export const MAX_LOGS = 500;
export const MAX_NETWORK = 100;
/**
 * Where `@overblast/feedback/early` leaves what it caught. Spelled again in `early.ts` rather than
 * imported, so the library's module graph never reaches the early recorder's bundle (a test keeps
 * the two equal).
 */
export const EARLY_KEY = '__overblastFeedbackEarly';

/** A fixed-size ring: the newest `size` items, oldest first. */
export class Ring<T> {
  private items: T[] = [];
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }
  list(): T[] {
    return this.items.slice();
  }
  clear(): void {
    this.items = [];
  }
  get length(): number {
    return this.items.length;
  }
}

/** One value as a log line would show it. Never throws. */
export function formatValue(value: unknown, depth = 0): string {
  try {
    if (typeof value === 'string') return value;
    if (value instanceof Error) {
      const head = `${value.name}: ${value.message}`;
      return value.stack && !value.stack.includes(value.message) ? `${head}\n${value.stack}` : (value.stack ?? head);
    }
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return String(value);
    if (typeof Element !== 'undefined' && value instanceof Element) {
      const id = value.id ? `#${value.id}` : '';
      return `<${value.tagName.toLowerCase()}${id}>`;
    }
    if (depth > 0) return Array.isArray(value) ? '[Array]' : '[Object]';
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (typeof v === 'function') return '[Function]';
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
    return json === undefined ? String(value) : json.length > MAX_LOG_MSG * 2 ? json.slice(0, MAX_LOG_MSG * 2) : json;
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return '[unprintable]';
    }
  }
}


const CONSOLE_LEVELS: Array<[keyof Console & ('debug' | 'info' | 'log' | 'warn' | 'error'), LogLevel]> = [
  ['debug', 'debug'],
  ['info', 'info'],
  ['log', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
];

export interface CaptureOptions {
  console: boolean;
  network: boolean;
  /** Requests to this address are not recorded (the library's own reports). */
  ignoreUrl?: string;
  now?: () => number;
  /**
   * Whether a request went to the app's own hosts, for the error prompt's `server_error` and
   * `network` (§3.6). Default: the page's own origin.
   */
  isAppUrl?: (url: string) => boolean;
}

/** Same origin as the page. */
export function sameOrigin(url: string): boolean {
  try {
    if (typeof location === 'undefined') return false;
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

type AnyFn = (...args: unknown[]) => unknown;

interface Patch {
  restore(): void;
}

/**
 * Put `wrapper` in place of `target[name]`. `restore` puts the original back when ours is still
 * the installed one; otherwise it switches ours to a pass-through and leaves the chain alone.
 */
function patch<T extends object>(target: T, name: string, make: (original: AnyFn, live: () => boolean) => AnyFn): Patch | null {
  const holder = target as unknown as Record<string, unknown>;
  const original = holder[name];
  if (typeof original !== 'function') return null;
  let active = true;
  const wrapper = make(original as AnyFn, () => active);
  try {
    Object.defineProperty(wrapper, 'name', { value: (original as AnyFn).name, configurable: true });
    Object.defineProperty(wrapper, 'length', { value: (original as AnyFn).length, configurable: true });
  } catch {
    /* a frozen function: the name is cosmetic */
  }
  holder[name] = wrapper;
  return {
    restore() {
      active = false;
      if (holder[name] === wrapper) holder[name] = original;
    },
  };
}

export class Capture {
  /** The log buffer (§3.5): rate-capped, repeats collapsed, 1 MB / 20,000 lines. */
  readonly logs: LogBuffer;
  readonly network = new Ring<NetworkEntry>(MAX_NETWORK);
  private pausedFlag = false;
  private patches: Patch[] = [];
  private listeners: Array<() => void> = [];
  /** The page's `fetch` as it was before we wrapped it; the library sends through this one. */
  originalFetch: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly ignoreUrl: string | undefined;
  /** Set while the library's own code runs, so nothing it does is recorded. */
  quiet = 0;
  /** Told when the page has an uncaught error, a 5xx from its own hosts, or a request that failed (§3.6). */
  onSignal: ((kind: ErrorKind) => void) | null = null;

  private readonly opts: CaptureOptions;

  constructor(opts: CaptureOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.logs = new LogBuffer({ now: this.now });
    this.ignoreUrl = opts.ignoreUrl ? networkUrl(opts.ignoreUrl) : undefined;
  }

  /** Add a line of your own (also used for errors the library catches). */
  log(level: LogLevel, msg: string | (() => string), src = 'console'): void {
    if (this.quiet) return;
    this.logs.add(level, src, msg, this.now());
  }

  /**
   * True while the sheet is open: nothing is recorded, so the sheet's own activity never fills the
   * buffer (§3.4). Recording resumes when it closes.
   */
  get paused(): boolean {
    return this.pausedFlag;
  }
  set paused(v: boolean) {
    this.pausedFlag = v;
    this.logs.paused = v;
  }

  /** Run `fn` without recording anything it logs or fetches. */
  silently<T>(fn: () => T): T {
    this.quiet++;
    try {
      return fn();
    } finally {
      this.quiet--;
    }
  }

  install(win: Window & typeof globalThis): void {
    this.adoptEarly(win);
    if (this.opts.console && win.console) this.installConsole(win.console);
    this.installErrors(win);
    if (this.opts.network) {
      this.installFetch(win);
      this.installXhr(win);
    }
    if (!this.originalFetch && typeof win.fetch === 'function') this.originalFetch = win.fetch;
  }

  /**
   * Take over from `@overblast/feedback/early`: stop it, put back the originals it wrapped where its
   * wrapper is still the installed one (so ours wraps the original, never a wrapper), adopt its
   * entries with their own timestamps, and remove the buffer from the window.
   */
  private adoptEarly(win: Window & typeof globalThis): void {
    const holder = win as unknown as Record<string, unknown>;
    let early: EarlyBuffer | undefined;
    try {
      early = holder[EARLY_KEY] as EarlyBuffer | undefined;
    } catch {
      return;
    }
    if (!early || typeof early !== 'object' || early.v !== 1) return;
    try {
      early.stop();
    } catch {
      /* its wrappers check a flag of their own; a failed stop leaves them recording into a buffer nobody reads */
    }
    const targets: Array<[Record<string, unknown> | undefined, string]> = [
      [win.console as unknown as Record<string, unknown> | undefined, 'warn'],
      [win.console as unknown as Record<string, unknown> | undefined, 'error'],
      [holder, 'fetch'],
    ];
    for (const [target, name] of targets) {
      try {
        const original = early.originals?.[name];
        const wrapper = early.wrappers?.[name];
        if (target && original && wrapper && target[name] === wrapper) target[name] = original;
      } catch {
        /* a frozen console: its pass-through stays in the chain */
      }
    }
    try {
      const logs = Array.isArray(early.logs) ? early.logs : [];
      this.logs.adopt(this.opts.console ? logs : logs.filter((l) => l && l.src !== 'console'), early.dropped || 0);
      if (this.opts.network && Array.isArray(early.network)) {
        for (const n of early.network) {
          if (n && typeof n.url === 'string') this.network.push({ ...n, method: String(n.method || 'GET').toUpperCase().slice(0, 16), url: networkUrl(n.url) });
        }
      }
    } catch {
      /* what could be read was read */
    }
    try {
      delete holder[EARLY_KEY];
    } catch {
      holder[EARLY_KEY] = undefined;
    }
  }

  uninstall(): void {
    for (const p of this.patches.splice(0)) p.restore();
    for (const off of this.listeners.splice(0)) off();
  }

  private installConsole(con: Console): void {
    // Plain functions below, so that `this` stays whatever the caller gave the console method.
    const capture = this;
    for (const [method, level] of CONSOLE_LEVELS) {
      const p = patch(con, method, (original, live) =>
        function (this: unknown, ...args: unknown[]) {
          if (live()) {
            try {
              // Formatted only if the line is kept: a storm over the per-second cap costs a count.
              capture.log(level, () => args.map((a) => formatValue(a)).join(' '), 'console');
            } catch {
              /* recording must never break logging */
            }
          }
          return original.apply(this, args);
        },
      );
      if (p) this.patches.push(p);
    }
  }

  private signal(kind: ErrorKind): void {
    try {
      this.onSignal?.(kind);
    } catch {
      /* the prompt must never break recording */
    }
  }

  private installErrors(win: Window): void {
    const onError = (event: Event) => {
      try {
        if (typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent) {
          const where = event.filename ? ` (${networkUrl(event.filename)}:${event.lineno}:${event.colno})` : '';
          const text = event.error !== undefined && event.error !== null ? formatValue(event.error) : event.message;
          this.log('error', `${text || 'Script error.'}${where}`, 'onerror');
          // Uncaught by definition: an error the page caught never reaches this event.
          this.signal('exception');
          return;
        }
        // A resource that failed to load (an <img>, a <script>): the event does not bubble, so it is
        // only seen in the capture phase, and its target is the element.
        const target = event.target as (Element & { src?: string; href?: string }) | null;
        if (target && target !== (win as unknown) && typeof target.tagName === 'string') {
          const url = target.src || target.href || '';
          this.log('error', `Failed to load <${target.tagName.toLowerCase()}> ${url ? networkUrl(url) : ''}`.trim(), 'onerror');
        }
      } catch {
        /* never let the recorder throw into the page's error path */
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      try {
        this.log('error', `Unhandled rejection: ${formatValue(event.reason)}`, 'unhandledrejection');
        this.signal('exception');
      } catch {
        /* as above */
      }
    };
    win.addEventListener('error', onError, true);
    win.addEventListener('unhandledrejection', onRejection as EventListener);
    this.listeners.push(() => {
      win.removeEventListener('error', onError, true);
      win.removeEventListener('unhandledrejection', onRejection as EventListener);
    });
  }

  /** `failed`: the request never answered (a network error or a timeout, not an abort). */
  private record(method: string, url: string, status: number, start: number, failed = false): void {
    if (this.quiet || this.pausedFlag) return;
    try {
      const clean = networkUrl(url);
      // The door and its device doors (`…/devices`, `…/devices/challenge`) are the library's own,
      // and never count towards the error prompt either.
      if (this.ignoreUrl && (clean === this.ignoreUrl || clean.startsWith(`${this.ignoreUrl.replace(/\/+$/, '')}/`))) return;
      if ((failed || (status >= 500 && status <= 599)) && (this.opts.isAppUrl ?? sameOrigin)(url)) this.signal(failed ? 'network' : 'server_error');
      this.network.push({
        t: start,
        method: (method || 'GET').toUpperCase().slice(0, 16),
        url: clean,
        status: Number.isInteger(status) && status >= 0 ? status : 0,
        ms: Math.max(0, Math.round(this.now() - start)),
      });
    } catch {
      /* a url we cannot parse is a request we do not record */
    }
  }

  private installFetch(win: Window & typeof globalThis): void {
    if (typeof win.fetch !== 'function') return;
    this.originalFetch = win.fetch;
    const capture = this;
    const p = patch(win, 'fetch', (original, live) =>
      function (this: unknown, ...args: unknown[]) {
        if (!live()) return original.apply(this, args);
        let method = 'GET';
        let url = '';
        try {
          const input = args[0] as RequestInfo | URL;
          const init = args[1] as RequestInit | undefined;
          if (typeof input === 'string') url = input;
          else if (input instanceof URL) url = input.href;
          else if (input && typeof (input as Request).url === 'string') {
            url = (input as Request).url;
            method = (input as Request).method || method;
          }
          if (init?.method) method = init.method;
        } catch {
          /* recorded with what we have */
        }
        const start = capture.now();
        // A synchronous throw from the original (a bad argument) propagates as it would have.
        const result = original.apply(this, args) as Promise<Response>;
        if (!result || typeof result.then !== 'function') return result;
        return result.then(
          (response) => {
            capture.record(method, url, response?.status ?? 0, start);
            return response;
          },
          (error: unknown) => {
            // An abort is the page's own decision, not a failure.
            capture.record(method, url, 0, start, (error as { name?: unknown } | null)?.name !== 'AbortError');
            throw error;
          },
        );
      },
    );
    if (p) this.patches.push(p);
  }

  private installXhr(win: Window & typeof globalThis): void {
    const Xhr = win.XMLHttpRequest;
    if (typeof Xhr !== 'function' || !Xhr.prototype) return;
    const proto = Xhr.prototype;
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    const capture = this;
    const open = patch(proto, 'open', (original, live) =>
      function (this: XMLHttpRequest, ...args: unknown[]) {
        if (live()) {
          try {
            const url = args[1];
            meta.set(this, { method: String(args[0] ?? 'GET'), url: url instanceof URL ? url.href : String(url ?? '') });
          } catch {
            /* unrecorded */
          }
        }
        return original.apply(this, args);
      },
    );
    const send = patch(proto, 'send', (original, live) =>
      function (this: XMLHttpRequest, ...args: unknown[]) {
        const info = live() && !capture.quiet ? meta.get(this) : undefined;
        if (info) {
          const start = capture.now();
          let failed = false;
          const fail = () => {
            failed = true;
          };
          const done = () => {
            this.removeEventListener('loadend', done);
            this.removeEventListener('error', fail);
            this.removeEventListener('timeout', fail);
            let status = 0;
            try {
              status = this.status;
            } catch {
              /* status unreadable: never answered */
            }
            capture.record(info.method, info.url, status, start, failed);
          };
          try {
            this.addEventListener('error', fail);
            this.addEventListener('timeout', fail);
            this.addEventListener('loadend', done);
          } catch {
            /* unrecorded */
          }
        }
        return original.apply(this, args);
      },
    );
    if (open) this.patches.push(open);
    if (send) this.patches.push(send);
  }
}
