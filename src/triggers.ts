/**
 * The two triggers that are not a button: a keyboard shortcut, and a shake.
 *
 * The shortcut listens on `window` in the bubbling phase and stands aside when the page has already
 * handled the key (`defaultPrevented`): a page that binds the same keys keeps them.
 *
 * The shake reads `devicemotion`. On iOS Safari motion needs a permission that can only be asked
 * for from inside a tap (`DeviceMotionEvent.requestPermission()`), so this file never asks on its
 * own; `requestMotion()` is called by the sheet's "turn on" link or the integrator's own button.
 */

export const DEFAULT_SHORTCUT = 'mod+shift+f';

export interface Shortcut {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const NAMED: Record<string, string> = { period: '.', comma: ',', slash: '/', space: ' ', esc: 'escape' };

export function parseShortcut(spec: string): Shortcut | null {
  const parts = spec
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const s: Shortcut = { key: NAMED[key] ?? key, mod: false, ctrl: false, meta: false, alt: false, shift: false };
  for (const p of parts) {
    if (p === 'mod') s.mod = true;
    else if (p === 'ctrl' || p === 'control') s.ctrl = true;
    else if (p === 'meta' || p === 'cmd' || p === 'command') s.meta = true;
    else if (p === 'alt' || p === 'option' || p === 'opt') s.alt = true;
    else if (p === 'shift') s.shift = true;
    else return null;
  }
  return s;
}

export function isApple(): boolean {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
    return /mac|iphone|ipad|ipod/i.test(platform);
  } catch {
    return false;
  }
}

/** The physical key of a letter or digit (`KeyF` → `f`), so Option and other layouts still match. */
function keyOf(e: KeyboardEvent): string {
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code === 'Period') return '.';
  if (code === 'Comma') return ',';
  if (code === 'Slash') return '/';
  return (e.key ?? '').toLowerCase();
}

export function matchShortcut(s: Shortcut, e: KeyboardEvent, apple = isApple()): boolean {
  const wantMeta = s.meta || (s.mod && apple);
  const wantCtrl = s.ctrl || (s.mod && !apple);
  return (
    keyOf(e) === s.key && e.metaKey === wantMeta && e.ctrlKey === wantCtrl && e.altKey === s.alt && e.shiftKey === s.shift
  );
}

export function describeShortcut(s: Shortcut, apple = isApple()): string {
  const parts: string[] = [];
  if (s.ctrl || (s.mod && !apple)) parts.push(apple ? '⌃' : 'Ctrl');
  if (s.alt) parts.push(apple ? '⌥' : 'Alt');
  if (s.shift) parts.push(apple ? '⇧' : 'Shift');
  if (s.meta || (s.mod && apple)) parts.push(apple ? '⌘' : 'Meta');
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return apple ? parts.join('') : parts.join('+');
}

export interface ShakeOptions {
  /** Change in acceleration (m/s², summed over the three axes) that counts as one jolt. */
  threshold?: number;
  /** Jolts needed within `window` ms. */
  jolts?: number;
  window?: number;
  /** After a shake, ignore motion for this long. */
  cooldown?: number;
}

/**
 * Pure: fed samples, says when they add up to a shake. A shake is `jolts` sharp changes in
 * acceleration within `window` ms, and after one there is a `cooldown`, so a phone being waved
 * about opens the sheet once.
 */
export class ShakeDetector {
  private last: { x: number; y: number; z: number } | null = null;
  private hits: number[] = [];
  private quietUntil = 0;
  private readonly threshold: number;
  private readonly jolts: number;
  private readonly span: number;
  private readonly cooldown: number;

  constructor(opts: ShakeOptions = {}) {
    this.threshold = opts.threshold ?? 24;
    this.jolts = opts.jolts ?? 3;
    this.span = opts.window ?? 1000;
    this.cooldown = opts.cooldown ?? 3000;
  }

  /** True when this sample completes a shake. */
  sample(x: number, y: number, z: number, t: number): boolean {
    if (![x, y, z].every(Number.isFinite)) return false;
    const prev = this.last;
    this.last = { x, y, z };
    if (!prev || t < this.quietUntil) return false;
    const delta = Math.abs(x - prev.x) + Math.abs(y - prev.y) + Math.abs(z - prev.z);
    if (delta < this.threshold) return false;
    this.hits = this.hits.filter((h) => t - h <= this.span);
    this.hits.push(t);
    if (this.hits.length < this.jolts) return false;
    this.hits = [];
    this.quietUntil = t + this.cooldown;
    return true;
  }
}

type MotionCtor = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };

export function hasMotion(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { DeviceMotionEvent?: unknown }).DeviceMotionEvent !== 'undefined';
}

export function isTouchDevice(): boolean {
  try {
    return (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) || (typeof window !== 'undefined' && 'ontouchstart' in window);
  } catch {
    return false;
  }
}

/** True on iOS 13+ Safari, where motion events stay silent until a tap grants them. */
export function motionNeedsPermission(): boolean {
  if (!hasMotion()) return false;
  const ctor = (window as unknown as { DeviceMotionEvent: MotionCtor }).DeviceMotionEvent;
  return typeof ctor.requestPermission === 'function';
}

/** Ask for motion. MUST be called from inside a user gesture's handler, or iOS refuses outright. */
export async function requestMotion(): Promise<boolean> {
  if (!hasMotion()) return false;
  const ctor = (window as unknown as { DeviceMotionEvent: MotionCtor }).DeviceMotionEvent;
  if (typeof ctor.requestPermission !== 'function') return true;
  try {
    return (await ctor.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
