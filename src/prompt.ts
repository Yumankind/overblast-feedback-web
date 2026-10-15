/**
 * The error prompt (contract §3.6): after something goes wrong, a small pill offers to report it.
 * This file is the when and how often; `ui.ts` draws the pill.
 *
 * It must never be in the way, so it only appears when all of these hold:
 *
 * - the key has it on, for this kind of error, and the integrator has not turned it off;
 * - at least 10 seconds since `init`;
 * - the person is not typing (a key in a text field in the last 5 s, or the on-screen keyboard up;
 *   a field that merely has focus does not count) and the page is visible (it waits up to 30
 *   seconds for that, then gives up), and the report sheet is not open;
 * - not yet shown in this page session, not within `minHoursBetween` of the last time on this
 *   device, and not within seven days of the person closing it twice without reporting.
 *
 * Errors less than a second apart are one prompt. Every clock and timer comes in through `deps`, so
 * the tests drive each rule with a fake clock.
 */

import type { ErrorKind, KeyConfig } from './config.ts';

export const PROMPT_STORAGE_KEY = 'ob-feedback-prompt';
export const PROMPT_MIN_AGE_MS = 10_000;
export const PROMPT_WAIT_MS = 30_000;
export const PROMPT_POLL_MS = 500;
export const PROMPT_VISIBLE_MS = 8_000;
export const PROMPT_MERGE_MS = 1_000;
export const PROMPT_QUIET_MS = 7 * 24 * 3600 * 1000;
export const PROMPT_DISMISSALS_FOR_QUIET = 2;

export interface PromptHandlers {
  report(): void;
  close(): void;
  /** The pointer (or focus) is over the pill: hold it; false lets the clock run again. */
  hold(inside: boolean): void;
}

export interface PromptClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PromptDeps extends PromptClock {
  config(): KeyConfig;
  /** `errorPrompt: false` in `init`. */
  locallyOff: boolean;
  /** When `init` ran. */
  startedAt: number;
  isSheetOpen(): boolean;
  isTyping(): boolean;
  isVisible(): boolean;
  show(handlers: PromptHandlers): void;
  hide(): void;
  /** Open the sheet from the prompt (`trigger: error_prompt`, category `bug`). */
  openSheet(): void;
  /** A line in the report's log, `src: overblast`. */
  log(msg: string): void;
  storage(): Storage | null;
}

interface Memory {
  lastShown?: number;
  dismissals?: number;
  quietUntil?: number;
}

export class ErrorPrompt {
  private readonly d: PromptDeps;
  private shown = false;
  private visible = false;
  private pending = false;
  private destroyed = false;
  private lastSignalAt = -Infinity;
  private waitStart: number | null = null;
  private timer: unknown = null;
  private expireTimer: unknown = null;
  private expireAt = 0;
  private remaining = PROMPT_VISIBLE_MS;

  constructor(deps: PromptDeps) {
    this.d = deps;
  }

  get isShowing(): boolean {
    return this.visible;
  }

  /** Something went wrong, of this kind. */
  signal(kind: ErrorKind): void {
    if (this.destroyed || this.shown || this.d.locallyOff) return;
    const cfg = this.d.config().errorPrompt;
    if (!cfg.enabled || !cfg.on.includes(kind)) return;
    const now = this.d.now();
    const merged = this.pending || now - this.lastSignalAt < PROMPT_MERGE_MS;
    this.lastSignalAt = now;
    if (merged) return;
    this.pending = true;
    this.waitStart = null;
    this.schedule(Math.max(0, this.d.startedAt + PROMPT_MIN_AGE_MS - now));
  }

  /** The sheet opened some other way: the pill, if up, goes without counting as a dismissal. */
  sheetOpened(): void {
    if (this.visible) this.takeDown();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) this.d.clearTimeout(this.timer);
    if (this.visible) this.takeDown();
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.d.clearTimeout(this.timer);
    this.timer = this.d.setTimeout(() => {
      this.timer = null;
      this.attempt();
    }, ms);
  }

  private memory(): Memory {
    try {
      const raw = this.d.storage()?.getItem(PROMPT_STORAGE_KEY);
      const m = raw ? (JSON.parse(raw) as Memory) : {};
      return m && typeof m === 'object' ? m : {};
    } catch {
      return {};
    }
  }

  private remember(m: Memory): void {
    try {
      this.d.storage()?.setItem(PROMPT_STORAGE_KEY, JSON.stringify(m));
    } catch {
      /* then the once-per-session rule is the only one this page keeps */
    }
  }

  private giveUp(): void {
    this.pending = false;
    this.waitStart = null;
  }

  private attempt(): void {
    if (this.destroyed || this.shown) return this.giveUp();
    const now = this.d.now();
    const m = this.memory();
    const hours = this.d.config().errorPrompt.minHoursBetween;
    if (typeof m.lastShown === 'number' && now - m.lastShown < hours * 3600 * 1000) return this.giveUp();
    if (typeof m.quietUntil === 'number' && now < m.quietUntil) return this.giveUp();
    if (this.d.isSheetOpen()) return this.giveUp();
    if (this.d.isTyping() || !this.d.isVisible()) {
      if (this.waitStart === null) this.waitStart = now;
      if (now - this.waitStart >= PROMPT_WAIT_MS) return this.giveUp();
      this.schedule(PROMPT_POLL_MS);
      return;
    }
    this.pending = false;
    this.waitStart = null;
    this.shown = true;
    this.visible = true;
    this.remember({ ...m, lastShown: now });
    this.d.log('error prompt shown');
    this.d.show({
      report: () => this.onReport(),
      close: () => this.onClose(),
      hold: (inside) => this.onHold(inside),
    });
    this.remaining = PROMPT_VISIBLE_MS;
    this.startExpiry();
  }

  private startExpiry(): void {
    this.expireAt = this.d.now() + this.remaining;
    this.expireTimer = this.d.setTimeout(() => {
      this.expireTimer = null;
      if (!this.visible) return;
      this.d.log('error prompt went by itself');
      this.takeDown();
    }, this.remaining);
  }

  private stopExpiry(): void {
    if (this.expireTimer !== null) {
      this.d.clearTimeout(this.expireTimer);
      this.expireTimer = null;
      this.remaining = Math.max(0, this.expireAt - this.d.now());
    }
  }

  private onHold(inside: boolean): void {
    if (!this.visible) return;
    if (inside) this.stopExpiry();
    else if (this.expireTimer === null) {
      // A moment to read it again after the pointer leaves.
      this.remaining = Math.max(this.remaining, 2_000);
      this.startExpiry();
    }
  }

  private takeDown(): void {
    this.stopExpiry();
    this.visible = false;
    this.d.hide();
  }

  private onClose(): void {
    if (!this.visible) return;
    const m = this.memory();
    const dismissals = (m.dismissals ?? 0) + 1;
    if (dismissals >= PROMPT_DISMISSALS_FOR_QUIET) this.remember({ ...m, dismissals: 0, quietUntil: this.d.now() + PROMPT_QUIET_MS });
    else this.remember({ ...m, dismissals });
    this.d.log('error prompt dismissed');
    this.takeDown();
  }

  private onReport(): void {
    if (!this.visible) return;
    const m = this.memory();
    this.remember({ ...m, dismissals: 0 });
    this.d.log('error prompt: reporting');
    this.takeDown();
    this.d.openSheet();
  }
}

/** Whether an element takes text: a text-like input, a textarea, or something contenteditable. */
export function isTextField(el: Element | null | undefined): boolean {
  try {
    if (!el || typeof el.tagName !== 'string') return false;
    if ((el as HTMLElement).isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
    }
    const ce = el.getAttribute('contenteditable');
    return ce === 'true' || ce === '' || ce === 'plaintext-only';
  } catch {
    return false;
  }
}

/** A key pressed in a text field this recently counts as typing (§3.6). */
export const TYPING_WINDOW_MS = 5_000;

/**
 * On a touch device, whether the on-screen keyboard is up: the visual viewport is notably shorter
 * than the layout viewport (a quarter of it, and at least 120 px, so a browser's own toolbars
 * sliding in and out do not count).
 */
export function keyboardUp(win: Window): boolean {
  try {
    const vv = win.visualViewport;
    if (!vv || !(win.navigator?.maxTouchPoints > 0)) return false;
    const gap = win.innerHeight - vv.height;
    return gap > 120 && vv.height < win.innerHeight * 0.75;
  } catch {
    return false;
  }
}

/**
 * Whether the person is typing: a `keydown` or `input` in a text field in the last 5 seconds, or the
 * on-screen keyboard up. A field that merely has focus does not count: many pages focus one by
 * themselves.
 */
export class TypingTracker {
  private lastAt = -Infinity;
  private readonly off: () => void;
  private readonly win: Window;
  private readonly now: () => number;
  constructor(win: Window, now: () => number) {
    this.win = win;
    this.now = now;
    const doc = win.document;
    const on = (e: Event) => {
      try {
        const target = (typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target) as Element | null;
        if (isTextField(target)) this.lastAt = this.now();
      } catch {
        /* not typing, as far as we can tell */
      }
    };
    doc.addEventListener('keydown', on, true);
    doc.addEventListener('input', on, true);
    this.off = () => {
      doc.removeEventListener('keydown', on, true);
      doc.removeEventListener('input', on, true);
    };
  }
  typing(): boolean {
    return this.now() - this.lastAt < TYPING_WINDOW_MS || keyboardUp(this.win);
  }
  destroy(): void {
    this.off();
  }
}
