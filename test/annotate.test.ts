/**
 * The screenshot edits and the pick's thumbnail: rectangle geometry, the crop around the picked
 * element, and the order of painting for a cover and a blur (with filters, pixelated without them,
 * covered when neither is possible), watched on a recording 2D context.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COVER_COLOUR, blurRadius, cropAround, paintEdits, spanRect, supportsFilter, type EditRect, type Paint2D } from '../src/annotate.ts';

/** A 2D context that records what is done to it. `filters: false` behaves like a canvas without them. */
function recorder(filters = true) {
  const calls: string[] = [];
  let filter = 'none';
  const ctx = {
    fillStyle: '#000' as string,
    imageSmoothingEnabled: true,
    fillRect: (x: number, y: number, w: number, h: number) => calls.push(`fillRect ${ctx.fillStyle} ${x},${y},${w},${h}`),
    drawImage: (_i: unknown, ...a: number[]) => calls.push(`drawImage ${a.join(',')}${filters && filter !== 'none' ? ` [${filter}]` : ''}${ctx.imageSmoothingEnabled ? '' : ' [crisp]'}`),
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    rect: (x: number, y: number, w: number, h: number) => calls.push(`rect ${x},${y},${w},${h}`),
    clip: () => calls.push('clip'),
  } as unknown as Paint2D & { fillStyle: string };
  if (filters) {
    Object.defineProperty(ctx, 'filter', {
      get: () => filter,
      set: (v: string) => {
        filter = v;
      },
      enumerable: true,
    });
  }
  return { ctx, calls };
}

const base = {} as CanvasImageSource;

test('spanRect: either drag direction, clamped to the image', () => {
  assert.deepEqual(spanRect({ x: 50, y: 40 }, { x: 10, y: 10 }, 100, 100), { x: 10, y: 10, w: 40, h: 30 });
  assert.deepEqual(spanRect({ x: -20, y: 90 }, { x: 130, y: 120 }, 100, 100), { x: 0, y: 90, w: 100, h: 10 });
});

test('a cover is a solid box over the base image', () => {
  const { ctx, calls } = recorder();
  paintEdits(ctx, base, 800, 600, [{ x: 10, y: 20, w: 100, h: 50, kind: 'cover' }]);
  assert.deepEqual(calls, ['drawImage 0,0,800,600', `fillRect ${COVER_COLOUR} 10,20,100,50`]);
});

test('a blur redraws the base blurred, clipped to the box, twice; the filter is reset after', () => {
  const { ctx, calls } = recorder();
  assert.equal(supportsFilter(ctx), true);
  paintEdits(ctx, base, 1200, 800, [{ x: 5, y: 6, w: 70, h: 80, kind: 'blur' }]);
  const r = blurRadius(1200, 800);
  assert.ok(r >= 10);
  assert.deepEqual(calls, [
    'drawImage 0,0,1200,800',
    'save',
    'beginPath',
    'rect 5,6,70,80',
    'clip',
    `drawImage 0,0,1200,800 [blur(${r}px)]`,
    `drawImage 0,0,1200,800 [blur(${r}px)]`,
    'restore',
  ]);
  assert.equal(ctx.filter, 'none');
});

test('without canvas filters a blur is pixelated through a scratch canvas; with no scratch, covered', () => {
  const { ctx, calls } = recorder(false);
  assert.equal(supportsFilter(ctx), false);
  const scratch = recorder();
  let size = '';
  paintEdits(ctx, base, 1000, 500, [{ x: 100, y: 100, w: 240, h: 120, kind: 'blur' }], () => ({
    ctx: scratch.ctx,
    canvas: {} as CanvasImageSource,
    resize: (w, h) => (size = `${w}x${h}`),
  }));
  assert.match(size, /^\d+x\d+$/);
  const [sw, sh] = size.split('x').map(Number) as [number, number];
  assert.ok(sw < 240 / 8 && sh < 120 / 8, `pixelated to ${size}`);
  assert.deepEqual(scratch.calls, [`drawImage 100,100,240,120,0,0,${sw},${sh}`]);
  assert.ok(calls.includes(`drawImage 0,0,${sw},${sh},100,100,240,120 [crisp]`), calls.join('\n'));

  const none = recorder(false);
  paintEdits(none.ctx, base, 1000, 500, [{ x: 1, y: 2, w: 30, h: 40, kind: 'blur' }]);
  assert.ok(none.calls.includes(`fillRect ${COVER_COLOUR} 1,2,30,40`), 'no way to blur: covered rather than sent readable');
});

test('edits are painted in order, after the base (so private masks in the base stay under them)', () => {
  const { ctx, calls } = recorder();
  const edits: EditRect[] = [
    { x: 0, y: 0, w: 10, h: 10, kind: 'blur' },
    { x: 5, y: 5, w: 10, h: 10, kind: 'cover' },
  ];
  paintEdits(ctx, base, 100, 100, edits);
  assert.equal(calls[0], 'drawImage 0,0,100,100');
  assert.equal(calls.at(-1), `fillRect ${COVER_COLOUR} 5,5,10,10`);
});

test('cropAround: the element with a margin, at the thumbnail\'s aspect, inside the image, in image pixels', () => {
  // A 1000 × 800 viewport captured at 2× (2000 × 1600).
  const vp = { w: 1000, h: 800 };
  const img = { w: 2000, h: 1600 };
  const c = cropAround({ x: 400, y: 300, w: 100, h: 40 }, vp, img, 3 / 2, 16);
  assert.ok(Math.abs(c.w / c.h - 1.5) < 0.02, `aspect ${c.w}/${c.h}`);
  // The element (800..1000 × 600..680 in image px) is inside the crop, with its margin.
  assert.ok(c.x <= 800 - 32 && c.x + c.w >= 1000 + 32, JSON.stringify(c));
  assert.ok(c.y <= 600 - 32 && c.y + c.h >= 680 + 32, JSON.stringify(c));
  // Centred on it.
  assert.ok(Math.abs(c.x + c.w / 2 - 900) <= 1 && Math.abs(c.y + c.h / 2 - 640) <= 1);

  // At the corner: slid back inside the image, not cut.
  const corner = cropAround({ x: 0, y: 0, w: 20, h: 20 }, vp, img);
  assert.deepEqual([corner.x, corner.y], [0, 0]);
  const far = cropAround({ x: 990, y: 790, w: 10, h: 10 }, vp, img);
  assert.equal(far.x + far.w, 2000);
  assert.equal(far.y + far.h, 1600);
  // Larger than the image: the whole width, the aspect kept.
  const huge = cropAround({ x: -50, y: 100, w: 1100, h: 100 }, vp, img);
  assert.equal(huge.w, 2000);
  assert.ok(huge.y >= 0 && huge.y + huge.h <= 1600);
});
