/**
 * The sheet's look, from `init({ theme })` and the page: an accent colour, a font, a corner radius and
 * a colour scheme. Applied as custom properties on the shadow host, so the stylesheet stays one
 * string and every part (sheet, chips, buttons, picker, pill) follows.
 *
 * The accent, when the integrator gives none, is the page's own `--overblast-accent` if it sets one,
 * else the library's blue. The text on the accent is white or near-black, whichever reads better.
 */

export type ColorScheme = 'auto' | 'light' | 'dark';

export interface ThemeOptions {
  /** Any CSS colour: `#0a5cff`, `rgb(…)`, `hsl(…)`, a named colour. */
  accent?: string;
  /** A CSS `font-family` list. Default the system UI font. */
  font?: string;
  /** The sheet's corner radius in px (buttons and fields follow at about two thirds). Default 14. */
  radius?: number;
  /** Default `'auto'`: the reader's light or dark preference. */
  colorScheme?: ColorScheme;
}

export interface ResolvedTheme {
  /** Custom properties to set on the host. Absent ones keep the stylesheet's defaults. */
  vars: Record<string, string>;
  scheme: ColorScheme;
}

export const DEFAULT_RADIUS = 14;
export const PAGE_ACCENT_VAR = '--overblast-accent';

/** `#rgb`, `#rrggbb`, `rgb()`/`rgba()` as 0..255 channels; null for anything else. */
export function parseColor(input: string): [number, number, number] | null {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) {
    const h = m[1]!;
    return [parseInt(h[0]! + h[0]!, 16), parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16)];
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) {
    const h = m[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((n) => Math.max(0, Math.min(255, n))) as [number, number, number];
  return null;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** White or near-black, whichever has the better contrast on `accent`; white when it cannot be read. */
export function textOn(accent: string): string {
  const rgb = parseColor(accent);
  if (!rgb) return '#ffffff';
  const l = luminance(rgb);
  const onWhite = 1.05 / (l + 0.05);
  const onBlack = (l + 0.05) / 0.05;
  return onBlack > onWhite ? '#0b0b0c' : '#ffffff';
}

/** The page's `--overblast-accent`, read from the root element; empty when unset. */
export function pageAccent(doc: Document | undefined): string {
  try {
    if (!doc?.documentElement || !doc.defaultView) return '';
    return doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue(PAGE_ACCENT_VAR).trim();
  } catch {
    return '';
  }
}

/** A value safe to put in a custom property: no braces, semicolons or angle brackets. */
function safe(v: string, max = 200): string {
  return /[{};<>]/.test(v) ? '' : v.trim().slice(0, max);
}

export function resolveTheme(opts: ThemeOptions | undefined, doc: Document | undefined): ResolvedTheme {
  const vars: Record<string, string> = {};
  const accent = safe(opts?.accent ?? '') || safe(pageAccent(doc));
  if (accent) {
    vars['--ob-accent'] = accent;
    vars['--ob-accent-fg'] = textOn(accent);
  }
  const font = safe(opts?.font ?? '', 300);
  if (font) vars['--ob-font'] = font;
  const r = opts?.radius;
  if (typeof r === 'number' && Number.isFinite(r) && r >= 0) {
    const radius = Math.min(32, Math.round(r));
    vars['--ob-radius'] = `${radius}px`;
    vars['--ob-radius-sm'] = `${Math.round(radius * 0.7)}px`;
  }
  const scheme: ColorScheme = opts?.colorScheme === 'light' || opts?.colorScheme === 'dark' ? opts.colorScheme : 'auto';
  return { vars, scheme };
}

/** Put a resolved theme on the shadow host. */
export function applyTheme(host: HTMLElement, theme: ResolvedTheme): void {
  for (const [k, v] of Object.entries(theme.vars)) host.style.setProperty(k, v);
  if (theme.scheme === 'auto') host.removeAttribute('data-scheme');
  else host.setAttribute('data-scheme', theme.scheme);
}
