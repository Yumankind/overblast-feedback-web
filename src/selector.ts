/**
 * A CSS selector for the element a person pointed at, within the `dom` anchor's limits (contract
 * §3.2, the same as the artifacts comments'): at most 300 characters, at most 6 steps joined by
 * `>`, and no quote character anywhere. So: no attribute selectors with values, ids only when they
 * are plain identifiers, classes only when they look written by a person rather than by a build.
 *
 * It anchors at the nearest ancestor with a usable id, else at `main` or `body`. When that anchor is
 * more than six steps up, the anchor is joined to the last six steps by a descendant space, which
 * does not count as a `>` step: approximate, and usually still unique.
 */

export const MAX_SELECTOR = 300;
export const MAX_STEPS = 6;

const IDENT = /^[A-Za-z][\w-]*$/;
const CLASS_IDENT = /^[A-Za-z_][\w-]*$/;

/**
 * Classes that are generated rather than chosen: CSS modules (`Button_root__a1B2c`), styled
 * components (`sc-bdVaJa`), emotion (`css-1x2y3z`), JSS (`makeStyles-root-12`), and the like. A
 * selector made of them breaks on the next build.
 */
function looksHashed(name: string): boolean {
  if (name.length > 32) return true;
  if (/^(css|sc|jsx|emotion|svelte|astro|tw|chakra|jss|mui|makeStyles|styled)-/i.test(name) && /\d|[a-z][A-Z]/.test(name.slice(3))) return true;
  if (/__[A-Za-z0-9_-]{4,}$/.test(name)) return true; // CSS modules' hash suffix
  if (/\d{3,}/.test(name)) return true;
  if (/^[a-z]{1,3}[A-Z][A-Za-z]{3,}$/.test(name)) return true; // sc-style short prefix + random caps
  const digits = name.replace(/[^0-9]/g, '').length;
  return digits >= 2 && /[a-z]/i.test(name) && digits / name.length > 0.2;
}

/** Utility classes (Tailwind and friends): true of half the page, so they identify nothing. */
const UTILITY_PREFIX =
  /^(-?(p|m)[trblxyse]?|w|h|min-w|min-h|max-w|max-h|size|text|bg|border|rounded|ring|outline|shadow|opacity|z|top|left|right|bottom|inset|gap|space-[xy]|items|justify|content|self|place|font|leading|tracking|line-clamp|overflow|cursor|transition|duration|delay|ease|animate|translate|rotate|scale|skew|origin|order|col|row|grid-cols|grid-rows|basis|grow|shrink|flex|fill|stroke|object|aspect|columns|break|decoration|underline-offset|divide|from|via|to|backdrop|blur|brightness|select|pointer-events|whitespace|align|list|table|caption|sr|not-sr|tw)-/;
const UTILITY_WORD = new Set([
  'flex',
  'grid',
  'block',
  'inline',
  'inline-block',
  'inline-flex',
  'hidden',
  'contents',
  'relative',
  'absolute',
  'fixed',
  'sticky',
  'static',
  'container',
  'truncate',
  'italic',
  'underline',
  'uppercase',
  'lowercase',
  'capitalize',
  'grow',
  'shrink',
  'border',
  'rounded',
  'shadow',
  'transition',
  'visible',
  'invisible',
  'clearfix',
  'row',
  'col',
  'active',
  'focus',
  'hover',
  'show',
  'open',
  'selected',
  'disabled',
  'is-active',
  'is-open',
]);

export function isStableClass(name: string): boolean {
  if (!CLASS_IDENT.test(name)) return false;
  if (UTILITY_WORD.has(name)) return false;
  if (UTILITY_PREFIX.test(name)) return false;
  return !looksHashed(name);
}

export function isSimpleId(id: string): boolean {
  return IDENT.test(id) && id.length <= 64 && !looksHashed(id);
}

function rootOf(el: Element): Document | ShadowRoot | Element {
  const root = el.getRootNode() as Node;
  if (root && (root.nodeType === 9 || root.nodeType === 11)) return root as Document | ShadowRoot;
  return el.ownerDocument?.documentElement ?? el;
}

function uniqueId(el: Element): boolean {
  if (!isSimpleId(el.id)) return false;
  try {
    return rootOf(el).querySelectorAll(`#${el.id}`).length === 1;
  } catch {
    return false;
  }
}

/** The element's step: tag, up to two stable classes, and `:nth-of-type` when a sibling shares its tag. */
function step(el: Element, withClasses: boolean): string {
  const tag = el.tagName.toLowerCase();
  let out = /^[a-z][a-z0-9-]*$/.test(tag) ? tag : '*';
  if (withClasses) {
    const classes = Array.from(el.classList).filter(isStableClass).slice(0, 2);
    for (const c of classes) out += `.${c}`;
  }
  const parent = el.parentElement;
  if (parent) {
    let index = 0;
    let count = 0;
    for (const sibling of Array.from(parent.children)) {
      if (sibling.tagName === el.tagName) {
        count++;
        if (sibling === el) index = count;
      }
    }
    if (count > 1) out += `:nth-of-type(${index})`;
  }
  return out;
}

function isAnchorTag(el: Element): 'main' | 'body' | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'body') return 'body';
  if (tag === 'main') {
    try {
      if (rootOf(el).querySelectorAll('main').length === 1) return 'main';
    } catch {
      return null;
    }
  }
  return null;
}

function compose(anchor: string | null, steps: string[], descendant: boolean): string {
  const chain = steps.join(' > ');
  if (!anchor) return chain;
  if (!chain) return anchor;
  return descendant ? `${anchor} ${chain}` : `${anchor} > ${chain}`;
}

/** True when `selector` honours the anchor's limits. */
export function selectorWithinLimits(selector: string): boolean {
  return selector.length > 0 && selector.length <= MAX_SELECTOR && selector.split('>').length <= MAX_STEPS && !/["'`]/.test(selector);
}

export function buildSelector(el: Element): string {
  const build = (withClasses: boolean): string => {
    if (el.tagName.toLowerCase() === 'html') return 'html';
    const own = isAnchorTag(el);
    if (own) return own;
    if (uniqueId(el)) return `#${el.id}`;
    const steps: string[] = [];
    let cur: Element | null = el;
    let anchor: string | null = null;
    // Up to six child steps, or five plus an anchor joined by `>`.
    while (cur && steps.length < MAX_STEPS) {
      if (steps.length > 0) {
        const tag = isAnchorTag(cur);
        if (uniqueId(cur)) anchor = `#${cur.id}`;
        else if (tag) anchor = tag;
        if (anchor) break;
      }
      steps.unshift(step(cur, withClasses));
      cur = cur.parentElement;
    }
    if (anchor) {
      // An anchor costs a step of its own when joined by `>`: drop the oldest step if we would exceed.
      if (steps.length + 1 > MAX_STEPS) return compose(anchor, steps.slice(1), true);
      return compose(anchor, steps, false);
    }
    // Six steps and no anchor yet: keep climbing for one, to join by a descendant space.
    while (cur) {
      if (uniqueId(cur)) {
        anchor = `#${cur.id}`;
        break;
      }
      const tag = isAnchorTag(cur);
      if (tag) {
        anchor = tag;
        break;
      }
      cur = cur.parentElement;
    }
    // Inside a shadow root with no anchor of its own, the chain stands alone.
    return compose(anchor, steps, true);
  };

  let selector = build(true);
  if (!selectorWithinLimits(selector)) selector = build(false);
  // Still too long (very long ids or deep custom elements): drop leading steps until it fits.
  while (!selectorWithinLimits(selector) && selector.includes('>')) {
    selector = selector.slice(selector.indexOf('>') + 1).trim();
  }
  if (!selectorWithinLimits(selector)) selector = el.tagName.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || '*';
  return selector;
}
