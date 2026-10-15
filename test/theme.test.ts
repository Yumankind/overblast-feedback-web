/**
 * The theme (`init({ theme })` and the page's `--overblast-accent`), and the layout rules that keep
 * the sheet inside the viewport: a body that scrolls, a bar that does not, the backdrop sized to the
 * visual viewport so an on-screen keyboard cannot push Send off the screen.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { $, page } from './dom.ts';
import { init } from '../src/index.ts';
import { CSS } from '../src/styles.ts';
import { DEFAULT_RADIUS, parseColor, resolveTheme, textOn } from '../src/theme.ts';
import type { FeedbackInstance } from '../src/types.ts';

window.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
const host = () => document.querySelector<HTMLElement>('overblast-feedback')!;
const inSheet = <T extends Element>(sel: string) => host().shadowRoot!.querySelector<T>(sel);
const noFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

let fb: FeedbackInstance | null = null;
afterEach(() => {
  fb?.destroy();
  fb = null;
  document.documentElement.style.removeProperty('--overblast-accent');
});

test('colours: parsing, and the text that reads on an accent', () => {
  assert.deepEqual(parseColor('#0a5cff'), [10, 92, 255]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColor('rgb(12, 34, 56)'), [12, 34, 56]);
  assert.equal(parseColor('papayawhip'), null);
  assert.equal(textOn('#0a5cff'), '#ffffff', 'white on blue');
  assert.equal(textOn('#ffd60a'), '#0b0b0c', 'near-black on yellow');
  assert.equal(textOn('#ffffff'), '#0b0b0c');
  assert.equal(textOn('hsl(10 50% 50%)'), '#ffffff', 'unreadable: white');
});

test('resolution: explicit accent, else the page\'s --overblast-accent, else the stylesheet\'s blue', () => {
  page('<main></main>');
  assert.deepEqual(resolveTheme(undefined, document), { vars: {}, scheme: 'auto' });
  document.documentElement.style.setProperty('--overblast-accent', '#ffd60a');
  assert.deepEqual(resolveTheme(undefined, document).vars, { '--ob-accent': '#ffd60a', '--ob-accent-fg': '#0b0b0c' });
  assert.equal(resolveTheme({ accent: '#e5484d' }, document).vars['--ob-accent'], '#e5484d', 'the integrator\'s wins');
  const t = resolveTheme({ font: '"Inter", sans-serif', radius: 20, colorScheme: 'dark' }, document);
  assert.equal(t.vars['--ob-font'], '"Inter", sans-serif');
  assert.equal(t.vars['--ob-radius'], '20px');
  assert.equal(t.vars['--ob-radius-sm'], '14px');
  assert.equal(t.scheme, 'dark');
  assert.equal(resolveTheme({ radius: 400 }, document).vars['--ob-radius'], '32px', 'capped');
  assert.equal(DEFAULT_RADIUS, 14);
  // Nothing that could break out of a custom property.
  assert.deepEqual(resolveTheme({ accent: 'red; } :host { display: none', font: 'x{' }, undefined).vars, {});
  assert.equal(resolveTheme({ colorScheme: 'sepia' as 'auto' }, undefined).scheme, 'auto');
});

test('applied on the host: the custom properties and the forced scheme', () => {
  page('<main></main>');
  fb = init({ key: 'obfk_t', fetch: noFetch, theme: { accent: '#7c3aed', radius: 8, colorScheme: 'light', font: 'Georgia, serif' } });
  const h = host();
  assert.equal(h.style.getPropertyValue('--ob-accent'), '#7c3aed');
  assert.equal(h.style.getPropertyValue('--ob-accent-fg'), '#ffffff');
  assert.equal(h.style.getPropertyValue('--ob-radius'), '8px');
  assert.equal(h.style.getPropertyValue('--ob-font'), 'Georgia, serif');
  assert.equal(h.getAttribute('data-scheme'), 'light');
  fb.destroy();
  fb = init({ key: 'obfk_t', fetch: noFetch });
  assert.equal(host().hasAttribute('data-scheme'), false, 'auto: the reader\'s preference');
});

test('the stylesheet: forced schemes, and everything themed through the tokens', () => {
  assert.match(CSS, /:host\(\[data-scheme="dark"\]\)/);
  assert.match(CSS, /:host\(:not\(\[data-scheme="light"\]\)\)/, 'auto dark does not override a forced light');
  for (const sel of ['.chip input:checked + span', '.btn.primary', '.pick-box', '.pill .btn', '.done .tick']) {
    const rule = CSS.slice(CSS.indexOf(sel), CSS.indexOf('}', CSS.indexOf(sel)));
    assert.match(rule, /var\(--ob-accent\)/, `${sel} uses the accent`);
  }
  assert.match(CSS, /font-family: var\(--ob-font,/);
  assert.match(CSS, /border-radius: var\(--ob-radius, 14px\)/);
});

/** The value of `prop` in the first rule whose selector is exactly `selector`. */
function ruleValue(selector: string, prop: string): string | null {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`);
  const m = re.exec(CSS);
  if (!m) return null;
  const p = new RegExp(`(^|[;\\s])${prop}:\\s*([^;]+);`).exec(m[2]!);
  return p ? p[2]!.trim() : null;
}

test('layout: never taller than the viewport, the body scrolls, the bar with Send does not', () => {
  assert.equal(ruleValue('.sheet', 'max-height'), '100%', 'at most the backdrop, which is the visual viewport');
  assert.equal(ruleValue('.sheet', 'overflow'), 'hidden');
  assert.equal(ruleValue('.sheet', 'display'), 'flex');
  assert.equal(ruleValue('form', 'min-height'), '0');
  assert.equal(ruleValue('.body', 'overflow-y'), 'auto');
  assert.equal(ruleValue('.body', 'min-height'), '0');
  assert.equal(ruleValue('.foot', 'flex'), 'none');
  assert.equal(ruleValue('.head', 'flex'), 'none');
  assert.equal(ruleValue('.backdrop', 'inset'), '0');
  assert.match(CSS, /@media \(max-width: 520px\) \{\s*\.backdrop \{ align-items: flex-end;/, 'a bottom sheet on phones');
  assert.match(CSS, /@media \(max-height: 600px\) \{ textarea \{ min-height: 96px; \} \}/);
});

test('short centred messages break into even lines: balance, and a ~30ch measure where it is missing', () => {
  assert.equal(ruleValue('.done p', 'text-wrap'), 'balance');
  assert.equal(ruleValue('.done p', 'max-width'), '30ch');
  assert.match(CSS, /\.pill > span \{ text-wrap: balance; \}/);
  assert.match(CSS, /\.pick-hint \{[^}]*text-wrap: balance;/);
  assert.match(CSS, /\.status \{[^}]*text-wrap: pretty;/, 'longer text: pretty, not balanced');
});

test('the sheet\'s order: categories on top, the message, and Cancel and Send in the bar', () => {
  page('<main></main>');
  fb = init({ key: 'obfk_t', fetch: noFetch });
  fb.open();
  const body = inSheet<HTMLElement>('[data-part="body"]')!;
  assert.equal(body.firstElementChild!.tagName, 'FIELDSET');
  assert.ok(body.querySelector('textarea'));
  const foot = inSheet<HTMLElement>('.foot')!;
  assert.ok(!body.contains(foot), 'the bar is outside the scrolling body');
  assert.deepEqual(Array.from(foot.querySelectorAll('button')).map((b) => b.getAttribute('data-act')), ['close', 'send']);
});

test('the backdrop follows the visual viewport: a keyboard of 300 px leaves the sheet the rest', () => {
  page('<main><input id="q"></main>');
  const listeners = new Map<string, () => void>();
  const vv = { height: 844, offsetTop: 0, width: 390, addEventListener: (t: string, f: () => void) => listeners.set(t, f), removeEventListener: (t: string) => listeners.delete(t) };
  const real = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  try {
    fb = init({ key: 'obfk_t', fetch: noFetch });
    fb.open();
    const backdrop = inSheet<HTMLElement>('.backdrop')!;
    assert.equal(backdrop.style.height, '844px');
    vv.height = 544;
    listeners.get('resize')!();
    assert.equal(backdrop.style.height, '544px');
    assert.equal(backdrop.style.top, '0px');
    vv.offsetTop = 120; // iOS scrolls the visual viewport rather than resizing the layout one
    vv.height = 360;
    listeners.get('scroll')!();
    assert.equal(backdrop.style.top, '120px');
    assert.equal(backdrop.style.height, '360px');
    fb.close();
    assert.equal(listeners.size, 0, 'listeners removed on close');
    assert.equal(backdrop.style.height, '');
    void $;
  } finally {
    if (real) Object.defineProperty(window, 'visualViewport', real);
    else delete (window as unknown as Record<string, unknown>).visualViewport;
  }
});
