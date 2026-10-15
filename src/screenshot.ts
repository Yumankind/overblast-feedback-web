/**
 * The screenshot, only ever taken when the person ticked the box (contract §6).
 *
 * Two sources: the integrator's `captureScreenshot` hook (html2canvas, a native bridge), or the
 * built-in best effort, which clones the page with its computed styles inlined, wraps the clone in an
 * SVG `foreignObject` and draws that onto a canvas. Whatever the source, the finishing step is the
 * same: private elements and password or card fields are painted over with solid boxes, the
 * selected element's box is drawn, and the image is encoded as JPEG small enough for the door
 * (≤ 5 MB decoded, long side ≤ 2400 px).
 *
 * Every step can fail (a canvas tainted by a cross-origin image, Safari refusing to read back a
 * foreignObject drawing, a page too large to clone): each failure ends in "no screenshot", never in
 * a report that cannot be sent.
 */

import { privateElements } from './element.ts';
import { MAX_SCREENSHOT_BYTES } from './payload.ts';

export const MAX_SIDE = 2400;
/** Beyond this many elements the built-in capture gives up rather than freeze the page. */
export const MAX_NODES = 6000;
const HOST_ATTR = 'data-overblast-feedback';

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShotPlan {
  /** Viewport size in CSS pixels. */
  vw: number;
  vh: number;
  /** Boxes to paint over, in viewport CSS pixels. */
  blanks: PixelRect[];
  /** The selected element's box, in viewport CSS pixels. */
  highlight: PixelRect | null;
}

export interface Shot {
  blob: Blob;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  highlighted: boolean;
  /** The viewport the image shows, in CSS px, for mapping a page box onto the image. */
  viewport?: { w: number; h: number };
  /** The selected element's box when it was captured, in viewport CSS px. */
  box?: PixelRect | null;
  /** The image's own size in pixels. */
  size?: { w: number; h: number };
}

function boxOf(el: Element): PixelRect | null {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Where to paint, measured now, before anything is drawn. */
export function planShot(doc: Document, privateSelector: string, selected: Element | null): ShotPlan {
  const win = doc.defaultView;
  const vw = Math.max(1, win?.innerWidth || doc.documentElement.clientWidth || 1);
  const vh = Math.max(1, win?.innerHeight || doc.documentElement.clientHeight || 1);
  const blanks: PixelRect[] = [];
  for (const el of privateElements(doc, privateSelector)) {
    const b = boxOf(el);
    if (b && b.x < vw && b.y < vh && b.x + b.w > 0 && b.y + b.h > 0) blanks.push(b);
  }
  return { vw, vh, blanks, highlight: selected && selected.isConnected ? boxOf(selected) : null };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      // SecurityError: the canvas is tainted.
      resolve(null);
    }
  });
}

/**
 * Paint `source` (already the viewport) into a fresh canvas, blank, highlight, encode. Scales down
 * and lowers the quality until the JPEG fits under 5 MB.
 */
export async function finishShot(doc: Document, source: CanvasImageSource, srcW: number, srcH: number, plan: ShotPlan): Promise<Shot | null> {
  if (!(srcW > 0 && srcH > 0)) return null;
  let scale = Math.min(1, MAX_SIDE / Math.max(srcW, srcH));
  let quality = 0.8;
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(srcW * scale));
    canvas.height = Math.max(1, Math.round(srcH * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    // CSS px → image px. The source covers the viewport, so its width is the viewport's width.
    const kx = canvas.width / plan.vw;
    const ky = canvas.height / plan.vh;
    ctx.fillStyle = '#3a3a3c';
    for (const b of plan.blanks) ctx.fillRect(Math.floor(b.x * kx), Math.floor(b.y * ky), Math.ceil(b.w * kx) + 1, Math.ceil(b.h * ky) + 1);
    let highlighted = false;
    if (plan.highlight) {
      const h = plan.highlight;
      const line = Math.max(2, Math.round(3 * Math.min(kx, ky)));
      ctx.fillStyle = 'rgba(255, 59, 48, 0.14)';
      ctx.fillRect(h.x * kx, h.y * ky, h.w * kx, h.h * ky);
      // A white edge outside the red one, so the box reads on a red button as well as a white page.
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = line;
      ctx.strokeRect(h.x * kx - line * 1.5, h.y * ky - line * 1.5, h.w * kx + line * 3, h.h * ky + line * 3);
      ctx.strokeStyle = '#ff3b30';
      ctx.strokeRect(h.x * kx - line / 2, h.y * ky - line / 2, h.w * kx + line, h.h * ky + line);
      highlighted = true;
    }
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (!blob) return null;
    if (blob.size <= MAX_SCREENSHOT_BYTES) {
      return { blob, contentType: 'image/jpeg', highlighted, viewport: { w: plan.vw, h: plan.vh }, box: plan.highlight, size: { w: canvas.width, h: canvas.height } };
    }
    scale *= 0.75;
    quality = Math.max(0.5, quality - 0.1);
  }
  return null;
}

/** Decode an image Blob into something `drawImage` takes. */
export async function decodeBlob(doc: Document, blob: Blob): Promise<{ source: CanvasImageSource; w: number; h: number; close: () => void } | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    }
  } catch {
    /* fall back to an <img> */
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(doc, url);
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function loadImage(doc: Document, src: string, timeoutMs = 8000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = doc.createElement('img');
    const timer = setTimeout(() => reject(new Error('image load timed out')), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('image failed to load'));
    };
    img.decoding = 'sync';
    img.src = src;
  });
}

/**
 * The integrator's image, finished. If it cannot be decoded and there was nothing to blank or
 * draw, it is sent as given; if there WAS something private on screen and it cannot be painted
 * over, nothing is sent: an unblanked password field is worse than no picture.
 */
export async function finishHookBlob(doc: Document, blob: Blob, plan: ShotPlan): Promise<Shot | null> {
  const decoded = await decodeBlob(doc, blob);
  if (decoded) {
    try {
      const shot = await finishShot(doc, decoded.source, decoded.w, decoded.h, plan);
      if (shot) return shot;
    } catch {
      /* fall through */
    } finally {
      decoded.close();
    }
  }
  const type = blob.type as Shot['contentType'];
  if (plan.blanks.length || !['image/png', 'image/jpeg', 'image/webp'].includes(type) || blob.size > MAX_SCREENSHOT_BYTES) return null;
  return { blob, contentType: type, highlighted: false };
}

// ── The built-in capture ─────────────────────────────────────────────────────────────────────

/** UA default styles per tag, read from a blank same-origin iframe so the page's CSS is not in them. */
class Defaults {
  private frame: HTMLIFrameElement | null = null;
  private cache = new Map<string, Map<string, string>>();
  private readonly doc: Document;
  constructor(doc: Document) {
    this.doc = doc;
  }

  private sandbox(): Document | null {
    if (!this.frame) {
      const f = this.doc.createElement('iframe');
      f.setAttribute(HOST_ATTR, '');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:fixed;left:-10000px;top:0;width:10px;height:10px;visibility:hidden;border:0';
      this.doc.documentElement.appendChild(f);
      this.frame = f;
    }
    return this.frame.contentDocument;
  }

  get(tag: string): Map<string, string> {
    const hit = this.cache.get(tag);
    if (hit) return hit;
    const out = new Map<string, string>();
    try {
      const d = this.sandbox();
      const view = d?.defaultView;
      if (d && view && d.body) {
        const el = d.createElement(tag);
        d.body.appendChild(el);
        const cs = view.getComputedStyle(el);
        for (let i = 0; i < cs.length; i++) {
          const name = cs.item(i);
          out.set(name, cs.getPropertyValue(name));
        }
        el.remove();
      }
    } catch {
      /* no defaults: every property is emitted */
    }
    this.cache.set(tag, out);
    return out;
  }

  dispose(): void {
    this.frame?.remove();
    this.frame = null;
  }
}

const SKIP_TAGS = new Set(['script', 'noscript', 'template', 'link', 'meta', 'style', 'title', 'head', 'base']);
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function imageToDataUrl(doc: Document, img: HTMLImageElement): string | null {
  try {
    if (!img.complete || !img.naturalWidth) return null;
    const k = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = doc.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png'); // throws on a cross-origin image without CORS
  } catch {
    return null;
  }
}

interface CloneState {
  doc: Document;
  win: Window;
  defaults: Defaults;
  privateSet: Set<Element>;
  nodes: number;
  images: number;
  sx: number;
  sy: number;
}

function styleText(state: CloneState, el: Element, parentStyle: CSSStyleDeclaration | null, cs: CSSStyleDeclaration): string {
  const defaults = state.defaults.get(el.tagName.toLowerCase());
  let out = '';
  for (let i = 0; i < cs.length; i++) {
    const name = cs.item(i);
    const value = cs.getPropertyValue(name);
    if (!value) continue;
    const parentValue = parentStyle ? parentStyle.getPropertyValue(name) : undefined;
    if (defaults.size && defaults.get(name) === value && (parentValue === undefined || parentValue === value)) continue;
    // Animations and transitions would replay inside the image; the frame on screen is what we want.
    if (name.startsWith('animation') || name.startsWith('transition')) continue;
    out += `${name}:${value};`;
  }
  // Fixed boxes are positioned against the viewport; the clone is laid out against the whole
  // document, so pin them where they are on screen right now.
  if (cs.position === 'fixed') {
    const r = el.getBoundingClientRect();
    out += `position:absolute;left:${r.left + state.sx}px;top:${r.top + state.sy}px;right:auto;bottom:auto;`;
  }
  return out;
}

function cloneNode(state: CloneState, node: Node, parentStyle: CSSStyleDeclaration | null): Node | null {
  if (node.nodeType === 3) return state.doc.createTextNode(node.nodeValue ?? '');
  if (node.nodeType !== 1) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag) || el.hasAttribute(HOST_ATTR)) return null;
  if (++state.nodes > MAX_NODES) throw new Error('page too large to capture');
  const cs = state.win.getComputedStyle(el);
  if (cs.display === 'none') return null;
  const copy = el.cloneNode(false) as Element;
  // Drop handlers and anything that could fetch inside the image: it cannot, and it would not help.
  for (const a of Array.from(copy.attributes)) {
    if (a.name.startsWith('on') || a.name === 'srcset' || a.name === 'loading') copy.removeAttribute(a.name);
  }
  let style = styleText(state, el, parentStyle, cs);
  const isPrivate = state.privateSet.has(el);
  if (isPrivate) style += 'visibility:hidden;';
  copy.setAttribute('style', style);

  if (tag === 'img') {
    const data = state.images < 60 ? imageToDataUrl(state.doc, el as HTMLImageElement) : null;
    state.images++;
    copy.setAttribute('src', data ?? TRANSPARENT_PIXEL);
  } else if (tag === 'canvas') {
    let data: string | null = null;
    try {
      data = (el as HTMLCanvasElement).toDataURL('image/png');
    } catch {
      data = null;
    }
    const img = state.doc.createElement('img');
    img.setAttribute('style', style);
    img.setAttribute('src', data ?? TRANSPARENT_PIXEL);
    return img;
  } else if (tag === 'iframe' || tag === 'video' || tag === 'object' || tag === 'embed') {
    const box = state.doc.createElement('div');
    box.setAttribute('style', `${style}background:#e5e5ea;`);
    return box;
  } else if (tag === 'input') {
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') {
      if (input.checked) copy.setAttribute('checked', '');
      else copy.removeAttribute('checked');
    } else copy.setAttribute('value', isPrivate ? '' : input.value);
  } else if (tag === 'textarea') {
    copy.textContent = isPrivate ? '' : (el as HTMLTextAreaElement).value;
    return copy;
  } else if (tag === 'select') {
    const select = el as HTMLSelectElement;
    for (const child of Array.from(el.childNodes)) {
      const c = cloneNode(state, child, cs);
      if (c) copy.appendChild(c);
    }
    Array.from((copy as HTMLSelectElement).options ?? []).forEach((o, i) => {
      if (i === select.selectedIndex) o.setAttribute('selected', '');
      else o.removeAttribute('selected');
    });
    return copy;
  }

  const children = el.shadowRoot ? Array.from(el.shadowRoot.childNodes) : Array.from(el.childNodes);
  for (const child of children) {
    const c = cloneNode(state, child, cs);
    if (c) copy.appendChild(c);
  }
  return copy;
}

function pageBackground(win: Window, doc: Document): string {
  const clear = (c: string) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  try {
    const root = win.getComputedStyle(doc.documentElement).backgroundColor;
    if (!clear(root)) return root;
    const body = doc.body ? win.getComputedStyle(doc.body).backgroundColor : '';
    if (!clear(body)) return body;
  } catch {
    /* white */
  }
  return '#ffffff';
}

/** Render the visible viewport into a canvas, best effort. Null when the browser will not. */
export async function renderViewport(doc: Document, privateSelector: string, timeoutMs = 10000): Promise<{ canvas: HTMLCanvasElement; w: number; h: number } | null> {
  const win = doc.defaultView;
  if (!win || typeof XMLSerializer === 'undefined') return null;
  const defaults = new Defaults(doc);
  try {
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const state: CloneState = {
      doc,
      win,
      defaults,
      privateSet: new Set(privateElements(doc, privateSelector)),
      nodes: 0,
      images: 0,
      sx: win.scrollX,
      sy: win.scrollY,
    };
    const root = cloneNode(state, doc.documentElement, null) as Element | null;
    if (!root) return null;
    root.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    const docW = Math.max(vw, doc.documentElement.scrollWidth);
    const docH = Math.max(vh, doc.documentElement.scrollHeight);
    const xhtml = new XMLSerializer().serializeToString(root);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}">` +
      `<foreignObject x="${-state.sx}" y="${-state.sy}" width="${docW}" height="${docH}">${xhtml}</foreignObject></svg>`;
    const img = await loadImage(doc, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, timeoutMs);
    const canvas = doc.createElement('canvas');
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // A browser paints the root's (or else the body's) background over the whole viewport; the
    // clone's root box ends where the content does, so paint it first.
    ctx.fillStyle = pageBackground(win, doc);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Reading one pixel back is where Safari (and any taint) refuses: find out now, not at encode.
    ctx.getImageData(0, 0, 1, 1);
    return { canvas, w: canvas.width, h: canvas.height };
  } catch {
    return null;
  } finally {
    defaults.dispose();
  }
}

/** The whole pipeline: the hook if given, else the built-in render; then finished. */
export async function takeScreenshot(
  doc: Document,
  privateSelector: string,
  selected: Element | null,
  hook: (() => Promise<Blob | null>) | undefined,
): Promise<Shot | null> {
  const plan = planShot(doc, privateSelector, selected);
  try {
    if (hook) {
      const blob = await hook();
      return blob ? await finishHookBlob(doc, blob, plan) : null;
    }
    const rendered = await renderViewport(doc, privateSelector);
    if (!rendered) return null;
    return await finishShot(doc, rendered.canvas, rendered.w, rendered.h, plan);
  } catch {
    return null;
  }
}

/** Base64 of a Blob, without a data-URL prefix. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}
