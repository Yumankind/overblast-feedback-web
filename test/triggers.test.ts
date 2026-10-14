import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHORTCUT, ShakeDetector, describeShortcut, matchShortcut, parseShortcut } from '../src/triggers.ts';

const key = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ code, key: code.replace(/^Key/, '').toLowerCase(), metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

test('the default shortcut is mod+shift+f: ⌘⇧F on Apple, Ctrl+Shift+F elsewhere', () => {
  const s = parseShortcut(DEFAULT_SHORTCUT)!;
  assert.equal(matchShortcut(s, key('KeyF', { metaKey: true, shiftKey: true }), true), true);
  assert.equal(matchShortcut(s, key('KeyF', { ctrlKey: true, shiftKey: true }), true), false);
  assert.equal(matchShortcut(s, key('KeyF', { ctrlKey: true, shiftKey: true }), false), true);
  assert.equal(matchShortcut(s, key('KeyF', { ctrlKey: true }), false), false, 'shift is required');
  assert.equal(matchShortcut(s, key('KeyF', { ctrlKey: true, shiftKey: true, altKey: true }), false), false, 'no extra modifiers');
  assert.equal(describeShortcut(s, true), '⇧⌘F');
  assert.equal(describeShortcut(s, false), 'Ctrl+Shift+F');
});

test('the physical key matches even when Option changes the character', () => {
  const s = parseShortcut('alt+shift+b')!;
  assert.equal(matchShortcut(s, { code: 'KeyB', key: 'ı', metaKey: false, ctrlKey: false, altKey: true, shiftKey: true } as KeyboardEvent, true), true);
});

test('shortcut parsing', () => {
  assert.deepEqual(parseShortcut('ctrl+alt+period'), { key: '.', mod: false, ctrl: true, meta: false, alt: true, shift: false });
  assert.equal(parseShortcut('hyper+f'), null);
  assert.equal(parseShortcut(''), null);
});

test('shake: three sharp jolts within a second, then a cooldown', () => {
  const d = new ShakeDetector();
  let t = 0;
  const at = (x: number) => d.sample(x, 0, 9.8, (t += 100));
  assert.equal(at(0), false); // the first sample only sets the baseline
  assert.equal(at(30), false);
  assert.equal(at(-5), false);
  assert.equal(at(30), true);
  // During the cooldown, the same motion does nothing.
  assert.equal(at(-5), false);
  assert.equal(at(30), false);
  assert.equal(at(-5), false);
});

test('shake: walking-sized motion never fires; jolts too far apart never add up', () => {
  const d = new ShakeDetector();
  let t = 0;
  for (let i = 0; i < 200; i++) assert.equal(d.sample(Math.sin(i) * 4, Math.cos(i) * 4, 9.8 + Math.sin(i * 3) * 3, (t += 50)), false);
  const slow = new ShakeDetector();
  t = 0;
  slow.sample(0, 0, 0, t);
  for (let i = 0; i < 10; i++) assert.equal(slow.sample(i % 2 ? 0 : 40, 0, 0, (t += 600)), false);
});

test('shake: ignores samples with missing axes', () => {
  const d = new ShakeDetector();
  assert.equal(d.sample(NaN, 0, 0, 1), false);
});
