/**
 * The page every DOM test runs in: happy-dom registered onto `globalThis`, at an address with a
 * query string worth redacting and a fragment worth dropping. `node --test` runs each test file in
 * its own process, so each file gets a fresh page.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: 'https://shop.example.com/cart?step=2&token=abc123#section', width: 1000, height: 800 });
}

/** Replace the body with `html` and return the document. */
export function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

export function $(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
}

/** happy-dom does no layout: give an element the box a browser would have. */
export function setRect(el: Element, r: { left: number; top: number; width: number; height: number }): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON() {} }) as DOMRect;
}
