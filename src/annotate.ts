/**
 * Two things done to the screenshot before it is sent, by the person:
 *
 * - **Hiding parts of it**: rectangles drawn in the editor that cover a region with a solid box, or
 *   blur it. They are painted onto the image itself, so what is hidden never leaves the device. The
 *   private masks the library painted when it took the screenshot are part of the base image, so no
 *   edit can take them off.
 * - **The pick's thumbnail**: a crop of the screenshot around the element the person pointed at.
 *
 * The geometry is pure functions; the painting takes a 2D context, so the tests can watch the calls.
 */

import type { PixelRect, Shot } from './screenshot.ts';
import { decodeBlob } from './screenshot.ts';
import { MAX_SCREENSHOT_BYTES } from './payload.ts';

export type EditKind = 'cover' | 'blur';

/** A rectangle in the image's own pixels. */
export interface EditRect extends PixelRect {
  kind: EditKind;
}

/** The colour a cover is painted with: the same as the private masks. */
export const COVER_COLOUR = '#3a3a3c';
/** Rectangles smaller than this (image px) are a slip of the pointer, not an edit. */
export const MIN_EDIT = 6;

/** The rectangle two corners span, clamped to the image. */
export function spanRect(a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number): PixelRect {
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(w, Math.max(a.x, b.x));
  const y1 = Math.min(h, Math.max(a.y, b.y));
  return { x: Math.round(x0), y: Math.round(y0), w: Math.max(0, Math.round(x1 - x0)), h: Math.max(0, Math.round(y1 - y0)) };
}

/** How strong a blur is on an image of this size: enough that text under it cannot be read. */
export function blurRadius(imgW: number, imgH: number): number {
  return Math.max(10, Math.round(Math.max(imgW, imgH) / 110));
}

/** The 2D context calls the painting uses (a real `CanvasRenderingContext2D` has them all). */
export interface Paint2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  filter?: string;
  imageSmoothingEnabled: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, ...args: number[]): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
}

/** Whether a context does CSS filters (Safari's 2D canvas did not until recently). */
export function supportsFilter(ctx: Paint2D): boolean {
  try {
    if (!('filter' in ctx)) return false;
    const before = ctx.filter;
    ctx.filter = 'blur(1px)';
    const ok = ctx.filter === 'blur(1px)';
    ctx.filter = before ?? 'none';
    return ok;
  } catch {
    return false;
  }
}

/**
 * Paint `base` (w × h) and then every edit in order. A blur is the base image redrawn blurred inside
 * the rectangle; where the context has no filters, the region is pixelated instead (drawn small into
 * `scratch` and back up without smoothing), which hides text as well.
 */
export function paintEdits(ctx: Paint2D, base: CanvasImageSource, w: number, h: number, edits: readonly EditRect[], scratch?: () => { ctx: Paint2D; canvas: CanvasImageSource; resize(w: number, h: number): void } | null): void {
  ctx.drawImage(base, 0, 0, w, h);
  const filters = supportsFilter(ctx);
  for (const e of edits) {
    if (e.w < 1 || e.h < 1) continue;
    if (e.kind === 'cover') {
      ctx.fillStyle = COVER_COLOUR;
      ctx.fillRect(e.x, e.y, e.w, e.h);
      continue;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(e.x, e.y, e.w, e.h);
    ctx.clip();
    if (filters) {
      ctx.filter = `blur(${blurRadius(w, h)}px)`;
      // Twice: one pass of a blur at this radius can still leave large type legible.
      ctx.drawImage(base, 0, 0, w, h);
      ctx.drawImage(base, 0, 0, w, h);
      ctx.filter = 'none';
    } else {
      const s = scratch?.();
      const cell = Math.max(8, Math.round(blurRadius(w, h) * 1.2));
      const sw = Math.max(1, Math.round(e.w / cell));
      const sh = Math.max(1, Math.round(e.h / cell));
      if (s) {
        s.resize(sw, sh);
        s.ctx.imageSmoothingEnabled = true;
        s.ctx.drawImage(base, e.x, e.y, e.w, e.h, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(s.canvas, 0, 0, sw, sh, e.x, e.y, e.w, e.h);
        ctx.imageSmoothingEnabled = true;
      } else {
        // No way to blur at all: cover it, rather than send it readable.
        ctx.fillStyle = COVER_COLOUR;
        ctx.fillRect(e.x, e.y, e.w, e.h);
      }
    }
    ctx.restore();
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    } catch {
      resolve(null);
    }
  });
}

/** The edited screenshot: `shot` with every edit painted on, as a new JPEG. Null when it cannot be made. */
export async function composeEdits(doc: Document, shot: Shot, edits: readonly EditRect[]): Promise<Shot | null> {
  if (!edits.length) return shot;
  const img = await decodeBlob(doc, shot.blob);
  if (!img) return null;
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = img.w;
    canvas.height = img.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const scratchCanvas = doc.createElement('canvas');
    const scratchCtx = scratchCanvas.getContext('2d');
    paintEdits(ctx as unknown as Paint2D, img.source, img.w, img.h, edits, () =>
      scratchCtx
        ? {
            ctx: scratchCtx as unknown as Paint2D,
            canvas: scratchCanvas,
            resize: (w, h) => {
              scratchCanvas.width = w;
              scratchCanvas.height = h;
            },
          }
        : null,
    );
    let quality = 0.85;
    for (let i = 0; i < 4; i++) {
      const blob = await toBlob(canvas, quality);
      if (!blob) return null;
      if (blob.size <= MAX_SCREENSHOT_BYTES) return { ...shot, blob, contentType: 'image/jpeg' };
      quality -= 0.15;
    }
    return null;
  } finally {
    img.close();
  }
}

/**
 * The part of the image to show as the pick's thumbnail: the element's box with a margin round it,
 * grown to the thumbnail's aspect, kept inside the image. In image pixels.
 */
export function cropAround(box: PixelRect, viewport: { w: number; h: number }, image: { w: number; h: number }, aspect = 3 / 2, pad = 16): PixelRect {
  const kx = image.w / Math.max(1, viewport.w);
  const ky = image.h / Math.max(1, viewport.h);
  let x = (box.x - pad) * kx;
  let y = (box.y - pad) * ky;
  let w = (box.w + pad * 2) * kx;
  let h = (box.h + pad * 2) * ky;
  // Grow the short side to the aspect, about the centre.
  if (w / h < aspect) {
    const nw = h * aspect;
    x -= (nw - w) / 2;
    w = nw;
  } else {
    const nh = w / aspect;
    y -= (nh - h) / 2;
    h = nh;
  }
  // Never larger than the image; then slide back inside it.
  if (w > image.w) {
    const k = image.w / w;
    w = image.w;
    h *= k;
  }
  if (h > image.h) {
    const k = image.h / h;
    h = image.h;
    w *= k;
  }
  x = Math.min(Math.max(0, x), image.w - w);
  y = Math.min(Math.max(0, y), image.h - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
