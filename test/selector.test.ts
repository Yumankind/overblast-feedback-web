import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, page } from './dom.ts';
import { buildSelector, isStableClass, MAX_SELECTOR, MAX_STEPS, selectorWithinLimits } from '../src/selector.ts';

/** The checker the door shares with the artifacts comments' `dom` anchor. */
function doorAccepts(selector: string): boolean {
  return !!selector && selector.length <= 300 && selector.split('>').length <= 6 && !/["'`]/.test(selector);
}

function assertGood(el: Element, mustResolve = true): string {
  const sel = buildSelector(el);
  assert.ok(doorAccepts(sel), `the door would refuse ${sel}`);
  assert.ok(selectorWithinLimits(sel));
  if (mustResolve) assert.equal(document.querySelector(sel), el, `${sel} does not resolve to the element`);
  return sel;
}

test('a simple unique id is the whole selector', () => {
  page('<div><button id="checkout">Pay</button></div>');
  assert.equal(assertGood($('#checkout')), '#checkout');
});

test('anchors at the nearest ancestor with a simple id', () => {
  page('<div id="cart"><ul><li>a</li><li><button class="rm">Remove</button></li></ul></div>');
  const sel = assertGood($('li:nth-of-type(2) button'));
  assert.ok(sel.startsWith('#cart > '), sel);
  assert.ok(sel.includes('button.rm'), sel);
});

test('anchors at main, then body', () => {
  page('<main><section><p>x</p></section><section><button>Go</button></section></main>');
  assert.equal(assertGood($('main section:nth-of-type(2) button')), 'main > section:nth-of-type(2) > button');
  page('<div><span>a</span><span>b</span></div>');
  assert.equal(assertGood($('div span:nth-of-type(2)')), 'body > div > span:nth-of-type(2)');
});

test('ids that are not plain identifiers, or are not unique, are not used', () => {
  page('<div id="a&quot;b"><p id="1x">one</p><p id="dup">two</p><p id="dup">three</p><p id=":r1:">four</p></div>');
  for (const el of Array.from(document.querySelectorAll('p'))) {
    const sel = assertGood(el);
    assert.ok(!sel.includes('#'), sel);
  }
});

test('hashed and utility classes are skipped, chosen ones kept', () => {
  for (const c of ['Button_root__a1B2c', 'css-1x2y3z', 'sc-bdVaJa', 'jsx-3456789', 'p-4', 'flex', 'text-sm', 'bg-white', 'md:flex', 'w-[30px]', 'makeStyles-root-12']) {
    assert.equal(isStableClass(c), false, c);
  }
  for (const c of ['cart-item', 'btn-primary', 'remove', 'product_card', 'navbar']) {
    assert.equal(isStableClass(c), true, c);
  }
  page('<div id="list"><div class="p-4 flex css-1x2y3z cart-item">x</div></div>');
  assert.equal(assertGood($('.cart-item')), '#list > div.cart-item');
});

test('no quote characters, ever, even when the page is full of them', () => {
  page(`<div class="it's" data-x='"' title="a'b"><a href="/x?y='1'" class="go">it's "here"</a></div>`);
  const sel = assertGood($('a'));
  assert.ok(!/["'`]/.test(sel));
});

test('the depth cap: at most six steps, joined to a far anchor by a descendant space', () => {
  let html = '';
  for (let i = 0; i < 12; i++) html += `<div><span>pad</span>`;
  html += '<button>deep</button>';
  for (let i = 0; i < 12; i++) html += '</div>';
  page(`<div id="app">${html}</div>`);
  const sel = assertGood($('button'));
  assert.ok(sel.split('>').length <= MAX_STEPS, sel);
  assert.ok(sel.startsWith('#app '), sel);
});

test('the depth cap without any id: the chain stands under body', () => {
  let html = '';
  for (let i = 0; i < 15; i++) html += '<section><i></i>';
  html += '<em>deep</em>';
  for (let i = 0; i < 15; i++) html += '</section>';
  page(html);
  const sel = assertGood($('em'));
  assert.ok(sel.startsWith('body '), sel);
});

test('very long ids and class names still fit in 300 characters', () => {
  const longId = `a${'b'.repeat(400)}`;
  page(`<div id="${longId}"><p class="${'c'.repeat(31)} ${'d'.repeat(31)}">x</p></div>`);
  const sel = assertGood($('p'), false);
  assert.ok(sel.length <= MAX_SELECTOR);
});

test('elements of a generated page: every selector is accepted, and almost all resolve', () => {
  // A deterministic pseudo-random tree, with ids, classes, repeats and depth.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const tags = ['div', 'section', 'ul', 'li', 'span', 'p', 'a', 'button', 'article'];
  const classes = ['card', 'row', 'flex', 'p-2', 'css-9x8y7z', 'item', 'title', 'Button_root__x9Y8z'];
  const make = (depth: number): string => {
    if (depth > 9) return 'leaf';
    const n = 1 + Math.floor(rnd() * 3);
    let out = '';
    for (let i = 0; i < n; i++) {
      const tag = tags[Math.floor(rnd() * tags.length)]!;
      const cls = rnd() < 0.5 ? ` class="${classes[Math.floor(rnd() * classes.length)]} ${classes[Math.floor(rnd() * classes.length)]}"` : '';
      const id = rnd() < 0.05 ? ` id="n${Math.floor(rnd() * 1e6)}x"` : '';
      out += `<${tag}${id}${cls}>${rnd() < 0.7 ? make(depth + 1) : 'text'}</${tag}>`;
    }
    return out;
  };
  page(`<main>${make(0)}</main>`);
  const all = Array.from(document.querySelectorAll('main *'));
  assert.ok(all.length > 50, `only ${all.length} elements`);
  let resolved = 0;
  for (const el of all) {
    const sel = buildSelector(el);
    assert.ok(doorAccepts(sel), sel);
    if (document.querySelector(sel) === el) resolved++;
  }
  // Six steps from an anchor is exact; deeper than that, the descendant join is approximate.
  assert.ok(resolved / all.length > 0.9, `${resolved}/${all.length} resolved`);
});
