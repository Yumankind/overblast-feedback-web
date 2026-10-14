import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, page, setRect } from './dom.ts';
import { describeElement, isSensitiveField, labelOf, rectFractions, sanitizeHtml, textQuote } from '../src/element.ts';

const P = '[data-overblast-private]';

test('html keeps only id, class, role, name, type, href and aria-*', () => {
  page('<button id="rm" class="btn rm" style="color:red" onclick="steal()" data-secret="x" role="button" aria-label="Remove item" title="t" tabindex="0">Remove</button>');
  assert.equal(sanitizeHtml($('#rm')), '<button id="rm" class="btn rm" role="button" aria-label="Remove item">Remove</button>');
});

test('html drops every child element and keeps direct text', () => {
  page('<div id="d">Total: <strong>€12</strong> <img src="x.png"> left</div>');
  assert.equal(sanitizeHtml($('#d')), '<div id="d">Total: left …</div>');
  page('<ul id="u"><li>a</li><li>b</li></ul>');
  assert.equal(sanitizeHtml($('#u')), '<ul id="u">…</ul>');
});

test('html never carries a form value', () => {
  page('<input id="q" name="q" type="text" value="my address 12"><textarea id="t" name="t">private notes</textarea><select id="s" name="s"><option selected>Lisbon</option></select>');
  ($('#q') as HTMLInputElement).value = 'typed by the person';
  assert.equal(sanitizeHtml($('#q')), '<input id="q" name="q" type="text">');
  assert.equal(sanitizeHtml($('#t')), '<textarea id="t" name="t">…</textarea>');
  assert.equal(sanitizeHtml($('#s')), '<select id="s" name="s">…</select>');
});

test('html: hrefs are redacted and script urls removed; attribute values escaped', () => {
  page(`<a id="a" href="https://x.example/r?token=abc&page=2">go</a><a id="j" href="javascript:alert(1)">x</a><span id="q" class='a"b'>y</span>`);
  assert.equal(sanitizeHtml($('#a')), '<a id="a" href="https://x.example/r?token=[redacted]&amp;page=2">go</a>');
  assert.equal(sanitizeHtml($('#j')), '<a id="j" href="">x</a>');
  assert.equal(sanitizeHtml($('#q')), '<span id="q" class="a&quot;b">y</span>');
});

test('html is never over 2000 characters', () => {
  page(`<div id="big" class="${'c '.repeat(2000)}" aria-description="${'d'.repeat(5000)}">${'text '.repeat(1000)}</div>`);
  const html = sanitizeHtml($('#big'))!;
  assert.ok(html.length <= 2000, `${html.length}`);
});

test('password and card fields are sensitive', () => {
  page(`<input id="p" type="password"><input id="c" autocomplete="cc-number"><input id="n" name="cardNumber"><input id="cvc" name="cvc"><input id="e" type="email">`);
  assert.equal(isSensitiveField($('#p')), true);
  assert.equal(isSensitiveField($('#c')), true);
  assert.equal(isSensitiveField($('#n')), true);
  assert.equal(isSensitiveField($('#cvc')), true);
  assert.equal(isSensitiveField($('#e')), false);
});

test('rect fractions are clamped to the viewport', () => {
  assert.deepEqual(rectFractions({ left: 100, top: 200, right: 300, bottom: 240 }, 1000, 800), { x: 0.1, y: 0.25, w: 0.2, h: 0.05 });
  // Half off the left and bottom edges: only the visible part.
  assert.deepEqual(rectFractions({ left: -50, top: 700, right: 50, bottom: 900 }, 1000, 800), { x: 0, y: 0.875, w: 0.05, h: 0.125 });
  // Entirely off-screen: a zero box at the edge.
  assert.deepEqual(rectFractions({ left: 1200, top: -300, right: 1300, bottom: -100 }, 1000, 800), { x: 1, y: 0, w: 0, h: 0 });
  // Degenerate viewport: still 0..1.
  const r = rectFractions({ left: 5, top: 5, right: 10, bottom: 10 }, 0, 0);
  for (const v of Object.values(r)) assert.ok(v >= 0 && v <= 1);
});

test('describeElement: the full anchor', () => {
  page('<main><p>Your cart</p><div class="line">Shoes <button class="rm" aria-label="Remove shoes">Remove</button> €40</div></main>');
  const btn = $('button.rm');
  setRect(btn, { left: 610, top: 336, width: 200, height: 40 });
  const a = describeElement(btn, P);
  assert.deepEqual(a, {
    kind: 'dom',
    selector: 'main > div.line > button.rm',
    tag: 'button',
    rect: { x: 0.61, y: 0.42, w: 0.2, h: 0.05 },
    viewport: { w: 1000, h: 800 },
    role: 'button',
    label: 'Remove shoes',
    textQuote: { exact: 'Remove', prefix: 'Shoes ', suffix: ' €40' },
    html: '<button class="rm" aria-label="Remove shoes">Remove</button>',
  });
});

test('a private element keeps where it is and loses what it says', () => {
  page('<div data-overblast-private><span id="acct">IBAN PT50 0002 0123 1234 5678 9015 4</span></div><input id="pw" type="password" aria-label="Password">');
  for (const id of ['#acct', '#pw']) {
    const a = describeElement($(id), P);
    assert.equal(a.html, undefined, id);
    assert.equal(a.label, undefined, id);
    assert.equal(a.textQuote, undefined, id);
    assert.ok(a.selector && a.tag && a.rect && a.viewport, id);
  }
});

test('text of a container leaves out its private parts and its fields', () => {
  page('<div id="box">Hello <span data-overblast-private>secret name</span> <input value="typed"> world</div>');
  assert.equal(labelOf($('#box'), P), 'Hello world');
  assert.equal(textQuote($('#box'), P)?.exact, 'Hello world');
});

test('textQuote: prefix and suffix are at most 32 characters, exact at most 200', () => {
  page(`<p>${'a'.repeat(100)} <b>${'x'.repeat(500)}</b> ${'z'.repeat(100)}</p>`);
  const q = textQuote($('b'), P)!;
  assert.equal(q.exact.length, 200);
  assert.ok(q.prefix.length <= 32 && q.suffix.length <= 32);
});

test('labels of form fields come from their <label>, never their value', () => {
  page('<label for="city">City</label><input id="city" value="Lisbon"><label><input id="agree" type="checkbox"> I agree</label>');
  assert.equal(labelOf($('#city'), P), 'City');
  assert.equal(labelOf($('#agree'), P), 'I agree');
});
