/**
 * What the key's owner has switched on (contract §2.1): `GET <endpoint>/config`, read in idle time
 * after `init`, kept in `localStorage` with its ETag, re-read at most every five minutes, and used as
 * kept when the door cannot be reached. Before there has ever been an answer the library behaves as
 * the defaults: no device registration, no error prompt, screenshots offered.
 *
 * The integrator's own options can only turn things off (`device: false`, `errorPrompt: false`);
 * nothing here turns on what the key has off.
 */

import { safeStorage } from './context.ts';
import { KEY_HEADER } from './transport.ts';
import type { Category } from './types.ts';

export type Verification = 'off' | 'flag' | 'require';
export type ErrorKind = 'exception' | 'server_error' | 'network';

export interface KeyConfig {
  verification: Verification;
  errorPrompt: { enabled: boolean; on: ErrorKind[]; minHoursBetween: number };
  screenshots: boolean;
  /** The kinds of report the key takes (§2), never empty; the first is the sheet's default. */
  categories: Category[];
}

export const ALL_CATEGORIES: readonly Category[] = ['bug', 'idea', 'question', 'other'];

export const DEFAULT_CONFIG: KeyConfig = Object.freeze({
  verification: 'off',
  errorPrompt: Object.freeze({ enabled: false, on: ['exception'] as ErrorKind[], minHoursBetween: 24 }),
  screenshots: true,
  categories: Object.freeze([...ALL_CATEGORIES]) as Category[],
}) as KeyConfig;

/** How long an answer is good for before a long-lived page asks again (the door's `max-age`). */
export const CONFIG_MAX_AGE_MS = 5 * 60 * 1000;
export const CONFIG_STORAGE_PREFIX = 'ob-feedback-config';

const KINDS: readonly ErrorKind[] = ['exception', 'server_error', 'network'];

/** Read an answer defensively: anything missing or malformed is the default. */
export function parseConfig(raw: unknown): KeyConfig {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const v = o.verification;
  const ep = o.errorPrompt && typeof o.errorPrompt === 'object' ? (o.errorPrompt as Record<string, unknown>) : {};
  const on = Array.isArray(ep.on) ? (ep.on.filter((k) => KINDS.includes(k as ErrorKind)) as ErrorKind[]) : [...DEFAULT_CONFIG.errorPrompt.on];
  const hours = typeof ep.minHoursBetween === 'number' && Number.isFinite(ep.minHoursBetween) && ep.minHoursBetween >= 0 ? ep.minHoursBetween : DEFAULT_CONFIG.errorPrompt.minHoursBetween;
  return {
    verification: v === 'flag' || v === 'require' ? v : 'off',
    errorPrompt: { enabled: ep.enabled === true, on, minHoursBetween: hours },
    screenshots: o.screenshots !== false,
    categories: parseCategories(o.categories),
  };
}

/** A non-empty subset of the four, in the key's order, without repeats; all four otherwise. */
function parseCategories(raw: unknown): Category[] {
  if (!Array.isArray(raw)) return [...ALL_CATEGORIES];
  const out: Category[] = [];
  for (const c of raw) if (ALL_CATEGORIES.includes(c as Category) && !out.includes(c as Category)) out.push(c as Category);
  return out.length ? out : [...ALL_CATEGORIES];
}

/** The door's own sentence for a category the key does not take (403 `category_not_accepted`, §3.3). */
export function categoryRefusal(categories: readonly Category[]): string {
  return categories.length === 1 && categories[0] === 'bug' ? 'This app only takes problem reports.' : 'This app does not take that kind of report.';
}

/** `…/v1/feedback` → `…/v1/feedback/config`. */
export function configUrl(endpoint: string): string {
  const q = endpoint.indexOf('?');
  return `${(q >= 0 ? endpoint.slice(0, q) : endpoint).replace(/\/+$/, '')}/config`;
}

interface Kept {
  config: KeyConfig;
  etag: string | null;
  /** When the door last answered (200 or 304), ms since the epoch. */
  at: number;
}

export interface ConfigClientOptions {
  endpoint: string;
  key: string;
  fetch: () => typeof fetch;
  now?: () => number;
}

export class ConfigClient {
  private readonly opts: ConfigClientOptions;
  private readonly storageKey: string;
  private kept: Kept | null;
  private inflight: Promise<void> | null = null;
  /** When this page last asked, answered or not, so a door that is down is not asked in a loop. */
  private askedAt = -Infinity;
  private readonly listeners = new Set<(c: KeyConfig) => void>();

  constructor(opts: ConfigClientOptions) {
    this.opts = opts;
    this.storageKey = `${CONFIG_STORAGE_PREFIX} ${opts.endpoint} ${opts.key}`;
    this.kept = this.load();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The kept answer, or the defaults. */
  get current(): KeyConfig {
    return this.kept?.config ?? DEFAULT_CONFIG;
  }

  /** Whether there has ever been an answer (now, or kept from an earlier visit). */
  get known(): boolean {
    return !!this.kept;
  }

  onChange(fn: (c: KeyConfig) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Ask the door unless this page asked less than five minutes ago. The first call of a page always
   * asks (once per start, §2.1); a long-lived page asks again when it next has a reason to.
   */
  maybeRefresh(): Promise<void> {
    if (this.now() - this.askedAt < CONFIG_MAX_AGE_MS) return this.inflight ?? Promise.resolve();
    return this.refresh();
  }

  /** Ask the door now. Never rejects: an unreachable door leaves the kept answer in place. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.askedAt = this.now();
    const run = (async () => {
      try {
        const headers: Record<string, string> = { [KEY_HEADER]: this.opts.key };
        if (this.kept?.etag) headers['If-None-Match'] = this.kept.etag;
        const r = await this.opts.fetch()(configUrl(this.opts.endpoint), { method: 'GET', headers, credentials: 'omit', mode: 'cors' });
        if (r.status === 304 && this.kept) {
          this.kept = { ...this.kept, at: this.now() };
          this.save();
          return;
        }
        if (!r.ok) return;
        const config = parseConfig(await r.json());
        const before = JSON.stringify(this.current);
        this.kept = { config, etag: r.headers.get('ETag'), at: this.now() };
        this.save();
        if (JSON.stringify(config) !== before) for (const fn of this.listeners) fn(config);
      } catch {
        /* offline, or the door is down: the kept answer stands */
      }
    })();
    this.inflight = run.finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private load(): Kept | null {
    try {
      const raw = safeStorage()?.getItem(this.storageKey);
      if (!raw) return null;
      const k = JSON.parse(raw) as Partial<Kept>;
      if (!k || typeof k !== 'object' || typeof k.at !== 'number') return null;
      return { config: parseConfig(k.config), etag: typeof k.etag === 'string' ? k.etag : null, at: k.at };
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      safeStorage()?.setItem(this.storageKey, JSON.stringify(this.kept));
    } catch {
      /* kept for this page only */
    }
  }
}
