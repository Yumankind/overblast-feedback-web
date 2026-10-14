import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, page, setRect } from './dom.ts';
import { finishShot, MAX_SIDE, planShot, type ShotPlan } from '../src/screenshot.ts';

/** A canvas that records what was painted and encodes to a Blob of a size we choose. */
function fakeDoc(sizeFor: (w: number, h: number, q: number) => number) {
  const canvases: Array<{ width: number; height: number; ops: Array<[string, ...number[]]>; type?: string; quality?: number }> = [];
  const doc = {
    createElement(tag: string) {
      assert.equal(tag, 'canvas');
      const c = {
        width: 0,
        height: 0,
        ops: [] as Array<[string, ...number[]]>,
        getContext() {
          const ctx = {
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 0,
            fillRect: (...a: number[]) => c.ops.push([`fill ${ctx.fillStyle}`, ...a]),
            strokeRect: (...a: number[]) => c.ops.push([`stroke ${ctx.strokeStyle}`, ...a]),
            drawImage: (_s: unknown, ...a: number[]) => c.ops.push(['draw', ...a]),
          };
          return ctx;
        },
        toBlob(cb: (b: Blob | null) => void, type: string, quality: number) {
          (c as { type?: string }).type = type;
          (c as { quality?: number }).quality = quality;
          cb(new Blob([new Uint8Array(sizeFor(c.width, c.height, quality))], { type }));
        },
      };
      canvases.push(c);
      return c;
    },
  } as unknown as Document;
  return { doc, canvases };
}

const plan: ShotPlan = { vw: 1000, vh: 800, blanks: [{ x: 10, y: 20, w: 100, h: 30 }], highlight: { x: 600, y: 300, w: 200, h: 40 } };

test('private boxes are painted solid and the selected element is outlined, in image pixels', async () => {
  const { doc, canvases } = fakeDoc(() => 1000);
  // A 2x screenshot of a 1000x800 viewport.
  const shot = await finishShot(doc, {} as CanvasImageSource, 2000, 1600, plan);
  assert.ok(shot);
  assert.equal(shot.contentType, 'image/jpeg');
  assert.equal(shot.highlighted, true);
  const c = canvases[0]!;
  assert.equal(c.width, 2000);
  assert.equal(c.quality, 0.8);
  const blank = c.ops.find((o) => o[0] === 'fill #3a3a3c')!;
  assert.deepEqual(blank.slice(1), [20, 40, 201, 61], 'the blank covers the box at 2x, rounded outwards');
  const ops = c.ops.map((o) => o[0]);
  assert.ok(ops.indexOf('draw') < ops.indexOf('fill #3a3a3c'), 'blanked after the page is drawn');
  assert.ok(ops.includes('stroke #ff3b30'));
});

test('the long side is held to 2400 px', async () => {
  const { doc, canvases } = fakeDoc(() => 1000);
  await finishShot(doc, {} as CanvasImageSource, 4000, 3200, plan);
  assert.equal(Math.max(canvases[0]!.width, canvases[0]!.height), MAX_SIDE);
});

test('an image over 5 MB is shrunk until it fits; one that never fits is dropped', async () => {
  const shrinking = fakeDoc((w) => (w > 1200 ? 6 * 1024 * 1024 : 2 * 1024 * 1024));
  const shot = await finishShot(shrinking.doc, {} as CanvasImageSource, 2000, 1600, plan);
  assert.ok(shot && shot.blob.size <= 5 * 1024 * 1024);
  assert.ok(shrinking.canvases.length > 1);
  assert.ok(shrinking.canvases.at(-1)!.quality! < 0.8);
  const never = fakeDoc(() => 6 * 1024 * 1024);
  assert.equal(await finishShot(never.doc, {} as CanvasImageSource, 2000, 1600, plan), null);
});

test('planShot finds private elements, password and card fields on screen, and the selection', () => {
  page(`<main>
    <div data-overblast-private id="a">secret</div>
    <input type="password" id="pw"><input autocomplete="cc-number" id="cc">
    <input id="name"><div data-overblast-private id="off">off-screen</div>
    <button id="sel">x</button></main>`);
  setRect($('#a'), { left: 0, top: 0, width: 100, height: 20 });
  setRect($('#pw'), { left: 0, top: 30, width: 100, height: 20 });
  setRect($('#cc'), { left: 0, top: 60, width: 100, height: 20 });
  setRect($('#name'), { left: 0, top: 90, width: 100, height: 20 });
  setRect($('#off'), { left: 0, top: 5000, width: 100, height: 20 });
  setRect($('#sel'), { left: 500, top: 400, width: 50, height: 20 });
  const p = planShot(document, '[data-overblast-private]', $('#sel'));
  assert.deepEqual(p.blanks.map((b) => b.y).sort((a, b) => a - b), [0, 30, 60]);
  assert.deepEqual(p.highlight, { x: 500, y: 400, w: 50, h: 20 });
  assert.deepEqual([p.vw, p.vh], [1000, 800]);
});
