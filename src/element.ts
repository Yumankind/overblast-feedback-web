/**
 * The `dom` anchor for an element (contract §3.2) and the privacy rules that shape it (§6).
 *
 * An element inside the private selector, or a password or card field, still gets its selector,
 * tag, role and box, because those say WHERE the problem is; it never gets its `html`, its
 * `textQuote` or its `label`, because those could say WHAT was in it.
 */

import { buildSelector } from './selector.ts';
import { contextUrl, redact } from './redact.ts';
import type { DomElement, Rect } from './types.ts';

export const DEFAULT_PRIVATE_SELECTOR = '[data-overblast-private]';
export const MAX_HTML = 2000;
export const MAX_LABEL = 120;
export const MAX_QUOTE = 200;
/** The artifacts comments' anchor checker holds prefix and suffix to 32; the renderer is shared. */
export const MAX_QUOTE_CONTEXT = 32;

const SENSITIVE_AUTOCOMPLETE = /\b(cc-[a-z-]+|current-password|new-password|one-time-code)\b/i;
const SENSITIVE_NAME = /(passw|card.?num|cc.?(num|number|cvc|cvv|csc|exp)|cvv|cvc|csc|security.?code|iban)/i;

/** A password or payment-card field: blanked always, whatever the integrator marked. */
export function isSensitiveField(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'password') return true;
  const auto = el.getAttribute('autocomplete') ?? '';
  if (SENSITIVE_AUTOCOMPLETE.test(auto)) return true;
  const named = `${el.getAttribute('name') ?? ''} ${el.id ?? ''}`;
  return SENSITIVE_NAME.test(named);
}

export function isPrivate(el: Element, privateSelector: string): boolean {
  if (isSensitiveField(el)) return true;
  try {
    return !!el.closest(privateSelector);
  } catch {
    // An invalid selector from the integrator: treat the default as the rule.
    return !!el.closest(DEFAULT_PRIVATE_SELECTOR);
  }
}

/** Every element on the page that a screenshot must blank out. */
export function privateElements(doc: Document, privateSelector: string): Element[] {
  const out = new Set<Element>();
  const add = (sel: string) => {
    try {
      for (const el of Array.from(doc.querySelectorAll(sel))) out.add(el);
    } catch {
      /* invalid selector: skipped */
    }
  };
  add(privateSelector);
  if (privateSelector !== DEFAULT_PRIVATE_SELECTOR) add(DEFAULT_PRIVATE_SELECTOR);
  for (const el of Array.from(doc.querySelectorAll('input, textarea, select'))) {
    if (isSensitiveField(el)) out.add(el);
  }
  return Array.from(out);
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The visible text under `el`, leaving out private subtrees, form values, scripts and styles. */
export function visibleText(el: Element, privateSelector: string, limit = 2000): string {
  let out = '';
  const walk = (node: Node): void => {
    if (out.length >= limit) return;
    if (node.nodeType === 3) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (child !== el && isPrivate(child, privateSelector)) return;
    for (const n of Array.from(child.childNodes)) walk(n);
    if (/^(p|div|li|br|tr|h[1-6]|section|article|header|footer)$/.test(tag)) out += ' ';
  };
  walk(el);
  return collapse(out).slice(0, limit);
}

const IMPLICIT_ROLE: Record<string, string> = {
  button: 'button',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  form: 'form',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  img: 'img',
  select: 'combobox',
  textarea: 'textbox',
  dialog: 'dialog',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  article: 'article',
  progress: 'progressbar',
};

const INPUT_ROLE: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  search: 'searchbox',
  number: 'spinbutton',
};

export function roleOf(el: Element): string | undefined {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit.slice(0, 32);
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : undefined;
  if (tag === 'input') return INPUT_ROLE[(el.getAttribute('type') ?? 'text').toLowerCase()] ?? 'textbox';
  return IMPLICIT_ROLE[tag];
}

/** The accessible name, roughly: aria-label, aria-labelledby, alt, title, a <label>, else the text. */
export function labelOf(el: Element, privateSelector: string): string | undefined {
  const doc = el.ownerDocument;
  const pick = (s: string | null | undefined) => {
    const v = collapse(s ?? '');
    return v ? redact(v).slice(0, MAX_LABEL) : undefined;
  };
  const aria = pick(el.getAttribute('aria-label'));
  if (aria) return aria;
  const by = el.getAttribute('aria-labelledby');
  if (by && doc) {
    const text = by
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter((n): n is HTMLElement => !!n && !isPrivate(n, privateSelector))
      .map((n) => visibleText(n, privateSelector, 300))
      .join(' ');
    const v = pick(text);
    if (v) return v;
  }
  const attr = pick(el.getAttribute('alt')) ?? pick(el.getAttribute('title'));
  if (attr) return attr;
  const tag = el.tagName.toLowerCase();
  if ((tag === 'input' || tag === 'textarea' || tag === 'select') && doc) {
    const id = el.id;
    let label: Element | null = null;
    if (id && /^[A-Za-z][\w-]*$/.test(id)) label = doc.querySelector(`label[for=${id}]`);
    label ??= el.closest('label');
    if (label) {
      const v = pick(visibleText(label, privateSelector, 300));
      if (v) return v;
    }
    return pick(el.getAttribute('placeholder'));
  }
  return pick(visibleText(el, privateSelector, 300));
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * A client rect as fractions of the viewport, clamped to it: an element half off-screen is drawn
 * as the half that was visible, and an element entirely off it as a zero-sized box at the edge.
 */
export function rectFractions(r: { left: number; top: number; right: number; bottom: number }, vw: number, vh: number): Rect {
  const w = vw > 0 ? vw : 1;
  const h = vh > 0 ? vh : 1;
  const x0 = clamp01(r.left / w);
  const y0 = clamp01(r.top / h);
  const x1 = clamp01(r.right / w);
  const y1 = clamp01(r.bottom / h);
  return { x: round4(x0), y: round4(y0), w: round4(Math.max(0, x1 - x0)), h: round4(Math.max(0, y1 - y0)) };
}

const ALLOWED_ATTR = new Set(['id', 'class', 'role', 'name', 'type', 'href']);

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * The element's own tag, sanitised (contract §6): only `id`, `class`, `role`, `name`, `type`,
 * `href` and `aria-*` attributes; no value of any form field; no child elements. Its own direct
 * text stays (redacted), and `…` stands where child elements were. At most 2000 characters.
 */
export function sanitizeHtml(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!tag) return undefined;
  const attrs: Array<[string, string]> = [];
  for (const a of Array.from(el.attributes)) {
    const name = a.name.toLowerCase();
    if (!ALLOWED_ATTR.has(name) && !name.startsWith('aria-')) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;
    let value = a.value;
    if (name === 'href') value = /^\s*(javascript|data|vbscript):/i.test(value) ? '' : contextUrl(value);
    else value = redact(value);
    attrs.push([name, value.slice(0, 300)]);
  }
  const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
  let inner = '';
  if (!VOID.has(tag) && !isField) {
    let text = '';
    let hadElements = false;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) text += n.nodeValue ?? '';
      else if (n.nodeType === 1) {
        hadElements = true;
        text += ' ';
      }
    }
    text = redact(collapse(text)).slice(0, 200);
    inner = escapeText(text) + (hadElements ? (text ? ' …' : '…') : '');
  } else if (tag === 'select' || tag === 'textarea') {
    inner = el.childNodes.length ? '…' : '';
  }
  const render = (list: Array<[string, string]>, body: string) => {
    const open = `<${tag}${list.map(([n, v]) => ` ${n}="${escapeAttr(v)}"`).join('')}>`;
    return VOID.has(tag) ? open : `${open}${body}</${tag}>`;
  };
  let html = render(attrs, inner);
  if (html.length > MAX_HTML) html = render(attrs, inner ? '…' : '');
  if (html.length > MAX_HTML) html = render(attrs.map(([n, v]) => [n, v.slice(0, 60)]), inner ? '…' : '');
  if (html.length > MAX_HTML) html = render(attrs.filter(([n]) => n === 'id' || n === 'role' || n === 'type'), inner ? '…' : '');
  return html.length <= MAX_HTML ? html : undefined;
}

/** `exact` is the element's own visible text; prefix and suffix are what sits around it in its parent. */
export function textQuote(el: Element, privateSelector: string): DomElement['textQuote'] | undefined {
  const exact = visibleText(el, privateSelector, MAX_QUOTE * 4);
  if (!exact) return undefined;
  const safe = redact(exact).slice(0, MAX_QUOTE);
  let prefix = '';
  let suffix = '';
  const parent = el.parentElement;
  if (parent && !isPrivate(parent, privateSelector)) {
    const around = visibleText(parent, privateSelector, 4000);
    const at = around.indexOf(exact);
    if (at >= 0) {
      prefix = redact(around.slice(Math.max(0, at - MAX_QUOTE_CONTEXT), at)).slice(-MAX_QUOTE_CONTEXT);
      suffix = redact(around.slice(at + exact.length, at + exact.length + MAX_QUOTE_CONTEXT)).slice(0, MAX_QUOTE_CONTEXT);
    }
  }
  return { exact: safe, prefix, suffix };
}

export interface ViewportInfo {
  w: number;
  h: number;
}

export function viewportOf(win: Window | undefined): ViewportInfo {
  const w = Math.round(win?.innerWidth || win?.document?.documentElement?.clientWidth || 1);
  const h = Math.round(win?.innerHeight || win?.document?.documentElement?.clientHeight || 1);
  return { w: Math.min(20000, Math.max(1, w)), h: Math.min(20000, Math.max(1, h)) };
}

/** Contract §3.2's `dom` anchor for `el`. */
export function describeElement(el: Element, privateSelector = DEFAULT_PRIVATE_SELECTOR): DomElement {
  const win = el.ownerDocument?.defaultView ?? undefined;
  const viewport = viewportOf(win);
  const box = el.getBoundingClientRect();
  const out: DomElement = {
    kind: 'dom',
    selector: buildSelector(el),
    tag: (el.tagName.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'element').slice(0, 32),
    rect: rectFractions(box, viewport.w, viewport.h),
    viewport,
  };
  const role = roleOf(el);
  if (role) out.role = role;
  if (!isPrivate(el, privateSelector)) {
    const label = labelOf(el, privateSelector);
    if (label) out.label = label;
    const quote = textQuote(el, privateSelector);
    if (quote) out.textQuote = quote;
    const html = sanitizeHtml(el);
    if (html) out.html = html;
  }
  return out;
}
