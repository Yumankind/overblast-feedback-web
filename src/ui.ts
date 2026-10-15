/**
 * Everything the person sees: the floating button, the sheet, and the element picker. All of it
 * lives in one shadow root on one host element, so the page's CSS cannot break it and its CSS
 * cannot leak onto the page. The host carries `data-overblast-feedback`, which is how the picker
 * and the screenshot know to leave it out.
 */

import { clearDraft, loadDraft, saveDraft } from './draft.ts';
import { DEFAULT_PRIVATE_SELECTOR, describeElement } from './element.ts';
import { FeedbackError, isEmail } from './payload.ts';
import type { Shot } from './screenshot.ts';
import { BUG_ICON, CSS } from './styles.ts';
import type { ButtonPosition, Category, DomElement, Labels, ReportResult, Trigger } from './types.ts';

export const HOST_TAG = 'overblast-feedback';
export const HOST_ATTR = 'data-overblast-feedback';

export interface SheetValues {
  message: string;
  category: Category;
  email: string | undefined;
  element: Element | null;
  anchor: DomElement | null;
  shot: Shot | null;
  /** When the sheet last appeared, ms since the epoch (§3.4). */
  openedAt: number | null;
  /** What opened it. */
  trigger: Trigger;
}

export interface UiDeps {
  labels: Labels;
  /** Null: no floating button. */
  position: ButtonPosition | null;
  privateSelector: string;
  /** True when the integrator gave no email, so the sheet asks for one. */
  needsEmail(): boolean;
  takeScreenshot(selected: Element | null): Promise<Shot | null>;
  submit(values: SheetValues): Promise<ReportResult>;
  /** Called each time the sheet opens (collection pauses, the device registers in idle time). */
  onOpen?: (() => void) | undefined;
  /** Called when the sheet closes (collection resumes). */
  onClose?: (() => void) | undefined;
  /** Called inside the button's click handler, which is a user gesture (iOS motion permission). */
  onButtonGesture(): void;
  shake: {
    /** Whether to show the one-time "shake next time" offer. */
    offer(): boolean;
    /** Called inside the offer's click handler. */
    enable(): Promise<boolean>;
    dismiss(): void;
  };
  onSent?: ((result: ReportResult) => void) | undefined;
}

const CATEGORY_ORDER: Category[] = ['bug', 'idea', 'question', 'other'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The next paint, or 50 ms, whichever is first: a background tab never paints. */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 50);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });

const FOCUSABLE = 'button:not([disabled]):not([hidden]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class FeedbackUi {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  private readonly deps: UiDeps;
  private readonly doc: Document;
  private fab: HTMLButtonElement | null = null;
  private backdrop: HTMLDivElement | null = null;
  private returnFocus: Element | null = null;
  private values: SheetValues = { message: '', category: 'bug', email: undefined, element: null, anchor: null, shot: null, openedAt: null, trigger: 'api' };
  /** Between `open` and `close`, whatever the backdrop does meanwhile (it hides for the picker and the screenshot). */
  private session = false;
  private shotUrl: string | null = null;
  private busy = false;
  private picking: { finish: (el: Element | null) => void } | null = null;
  private destroyed = false;

  constructor(doc: Document, deps: UiDeps) {
    this.doc = doc;
    this.deps = deps;
    this.host = doc.createElement(HOST_TAG);
    this.host.setAttribute(HOST_ATTR, '');
    // `all: initial` keeps page rules such as `* { display: grid }` off the host itself.
    this.host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    this.root.appendChild(style);
    (doc.body ?? doc.documentElement).appendChild(this.host);
    if (deps.position) this.mountButton(deps.position);
  }

  get isOpen(): boolean {
    return !!this.backdrop && !this.backdrop.hidden;
  }

  get isPicking(): boolean {
    return !!this.picking;
  }

  private mountButton(position: ButtonPosition): void {
    const b = this.doc.createElement('button');
    b.type = 'button';
    b.className = `fab ${position}`;
    b.innerHTML = `${BUG_ICON}<span>${esc(this.deps.labels.button)}</span>`;
    b.setAttribute('aria-haspopup', 'dialog');
    b.addEventListener('click', () => {
      this.deps.onButtonGesture();
      this.open('button');
    });
    this.root.appendChild(b);
    this.fab = b;
  }

  // ── The sheet ───────────────────────────────────────────────────────────────────────────────

  open(trigger: Trigger = 'api'): void {
    if (this.destroyed || this.picking) return;
    if (!this.backdrop) this.buildSheet();
    const backdrop = this.backdrop!;
    if (!backdrop.hidden) return;
    this.values.openedAt = Date.now();
    this.values.trigger = trigger;
    this.returnFocus = this.doc.activeElement;
    this.setStatus('', 'info');
    if (!this.values.message) {
      const draft = loadDraft();
      if (draft) {
        this.values.message = draft.message;
        this.values.category = draft.category;
        if (draft.email) this.values.email = draft.email;
        if (draft.element) this.values.anchor = draft.element;
        this.render();
        this.setStatus(this.deps.labels.draftRestored, 'info');
      }
    }
    this.render();
    backdrop.hidden = false;
    this.session = true;
    try {
      this.deps.onOpen?.();
    } catch {
      /* the sheet is open either way */
    }
    if (this.fab) this.fab.setAttribute('aria-expanded', 'true');
    this.q<HTMLTextAreaElement>('textarea')?.focus();
  }

  close(): void {
    if (!this.backdrop || this.backdrop.hidden) return;
    this.backdrop.hidden = true;
    this.endSession();
    if (this.fab) this.fab.setAttribute('aria-expanded', 'false');
    const back = this.returnFocus as HTMLElement | null;
    this.returnFocus = null;
    try {
      back?.focus?.();
    } catch {
      /* the element went away */
    }
  }

  private q<T extends Element>(sel: string): T | null {
    return this.backdrop?.querySelector<T>(sel) ?? null;
  }

  private buildSheet(): void {
    const L = this.deps.labels;
    const backdrop = this.doc.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.hidden = true;
    const chip = (c: Category) => {
      const text = { bug: L.categoryBug, idea: L.categoryIdea, question: L.categoryQuestion, other: L.categoryOther }[c];
      return `<label class="chip"><input type="radio" name="ob-category" value="${c}"><span>${esc(text)}</span></label>`;
    };
    backdrop.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ob-title">
        <div class="head">
          <h2 id="ob-title">${esc(L.title)}</h2>
          <button type="button" class="icon" data-act="close" aria-label="${esc(L.close)}">×</button>
        </div>
        <form novalidate>
          <div style="display:flex;flex-direction:column;gap:14px">
            <fieldset>
              <legend>${esc(L.categoryLegend)}</legend>
              <div class="chips">${CATEGORY_ORDER.map(chip).join('')}</div>
            </fieldset>
            <label class="field">${esc(L.messageLabel)}
              <textarea name="message" maxlength="4000" required aria-required="true" aria-describedby="ob-msg-err" placeholder="${esc(L.messagePlaceholder)}"></textarea>
              <span class="err" id="ob-msg-err" data-err="message" hidden></span>
            </label>
            <div class="row" data-part="pick">
              <button type="button" class="btn" data-act="pick">${esc(L.pointAt)}</button>
            </div>
            <div class="selected" data-part="selected" hidden>
              <span>${esc(L.selected)}:</span><code data-part="selected-text"></code>
              <button type="button" class="icon" data-act="pick" aria-label="${esc(L.pointAgain)}" title="${esc(L.pointAgain)}">⌖</button>
              <button type="button" class="icon" data-act="unselect" aria-label="${esc(L.removeElement)}">×</button>
            </div>
            <label class="field" data-part="email" hidden>${esc(L.emailLabel)}
              <input type="email" name="email" autocomplete="email" inputmode="email" aria-describedby="ob-email-hint ob-email-err">
              <span class="hint" id="ob-email-hint">${esc(L.emailHint)}</span>
              <span class="err" id="ob-email-err" data-err="email" hidden></span>
            </label>
            <div>
              <label class="check"><input type="checkbox" name="screenshot"><span>${esc(L.includeScreenshot)}</span></label>
              <p class="hint" data-part="shot-note" hidden></p>
              <div class="thumb" data-part="thumb" hidden>
                <img alt="" data-part="thumb-img">
                <button type="button" class="icon" data-act="unshot" aria-label="${esc(L.removeScreenshot)}">×</button>
              </div>
            </div>
            <div class="offer" data-part="shake" hidden>
              <span>${esc(L.shakeOffer)}</span>
              <button type="button" class="btn link" data-act="shake-on">${esc(L.shakeEnable)}</button>
              <button type="button" class="btn link" data-act="shake-off">${esc(L.shakeDismiss)}</button>
            </div>
            <p class="preview" data-part="preview"></p>
            <p class="status" role="status" aria-live="polite" data-part="status"></p>
            <div class="foot">
              <button type="submit" class="btn primary" data-act="send">${esc(L.send)}</button>
            </div>
          </div>
        </form>
      </div>`;
    this.root.appendChild(backdrop);
    this.backdrop = backdrop;

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        this.close();
        return;
      }
      const act = (e.target as Element).closest?.('[data-act]')?.getAttribute('data-act');
      if (act) this.act(act);
    });
    backdrop.addEventListener('keydown', (e) => this.onKey(e));
    const form = backdrop.querySelector('form')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send();
    });
    form.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'message') {
        this.values.message = t.value;
        this.showErr('message', '');
      } else if (t.name === 'email') {
        this.values.email = t.value;
        this.showErr('email', '');
      }
      this.renderPreview();
    });
    form.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'ob-category') this.values.category = t.value as Category;
      if (t.name === 'screenshot') void (t.checked ? this.captureShot() : this.dropShot());
    });
  }

  private act(act: string): void {
    if (act === 'close') this.close();
    else if (act === 'pick') void this.pickFromSheet();
    else if (act === 'unselect') {
      this.values.element = null;
      this.values.anchor = null;
      this.render();
      if (this.values.shot) void this.captureShot();
    } else if (act === 'unshot') void this.dropShot();
    else if (act === 'shake-on') {
      // Inside the click: iOS only shows its permission prompt from a gesture.
      const pending = this.deps.shake.enable();
      this.q('[data-part="shake"]')?.setAttribute('hidden', '');
      void pending;
    } else if (act === 'shake-off') {
      this.deps.shake.dismiss();
      this.q('[data-part="shake"]')?.setAttribute('hidden', '');
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    // The focus trap: Tab and Shift+Tab cycle inside the sheet.
    const items = Array.from(this.backdrop!.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[hidden]'));
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = this.root.activeElement;
    if (e.shiftKey && (active === first || !active)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private showErr(which: 'message' | 'email', text: string): void {
    const el = this.q<HTMLElement>(`[data-err="${which}"]`);
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
    const input = this.q<HTMLElement>(which === 'message' ? 'textarea' : 'input[type="email"]');
    if (text) input?.setAttribute('aria-invalid', 'true');
    else input?.removeAttribute('aria-invalid');
  }

  private setStatus(text: string, kind: 'info' | 'error' | 'ok'): void {
    const el = this.q<HTMLElement>('[data-part="status"]');
    if (!el) return;
    el.textContent = text;
    el.className = `status${kind === 'info' ? '' : ` ${kind}`}`;
  }

  private render(): void {
    if (!this.backdrop) return;
    const v = this.values;
    const ta = this.q<HTMLTextAreaElement>('textarea');
    if (ta && ta.value !== v.message) ta.value = v.message;
    for (const r of Array.from(this.backdrop.querySelectorAll<HTMLInputElement>('input[name="ob-category"]'))) r.checked = r.value === v.category;
    const emailPart = this.q<HTMLElement>('[data-part="email"]');
    if (emailPart) emailPart.hidden = !this.deps.needsEmail();
    const email = this.q<HTMLInputElement>('input[type="email"]');
    if (email && email.value !== (v.email ?? '')) email.value = v.email ?? '';
    const sel = this.q<HTMLElement>('[data-part="selected"]');
    const pickRow = this.q<HTMLElement>('[data-part="pick"]');
    if (sel && pickRow) {
      sel.hidden = !v.anchor;
      pickRow.hidden = !!v.anchor;
      const text = this.q<HTMLElement>('[data-part="selected-text"]');
      if (text && v.anchor) text.textContent = v.anchor.label ? `${v.anchor.tag} · ${v.anchor.label}` : v.anchor.selector;
    }
    const box = this.q<HTMLInputElement>('input[name="screenshot"]');
    if (box) box.checked = !!v.shot;
    const thumb = this.q<HTMLElement>('[data-part="thumb"]');
    const img = this.q<HTMLImageElement>('[data-part="thumb-img"]');
    if (thumb && img) {
      thumb.hidden = !v.shot;
      if (v.shot && this.shotUrl) img.src = this.shotUrl;
    }
    const offer = this.q<HTMLElement>('[data-part="shake"]');
    if (offer) offer.hidden = !this.deps.shake.offer();
    this.renderPreview();
  }

  private renderPreview(): void {
    const L = this.deps.labels;
    const parts = [L.partMessage];
    if (this.values.anchor) parts.push(L.partElement);
    if (this.values.shot) parts.push(L.partScreenshot);
    parts.push(L.partLogs, L.partDevice);
    const el = this.q<HTMLElement>('[data-part="preview"]');
    if (el) el.textContent = `${L.willSend} ${parts.join(', ')}.`;
  }

  private async captureShot(): Promise<void> {
    const note = this.q<HTMLElement>('[data-part="shot-note"]');
    if (note) note.hidden = true;
    const backdrop = this.backdrop;
    // Out of the way while the page is captured, then back.
    const prev = this.host.style.visibility;
    this.host.style.visibility = 'hidden';
    if (backdrop) backdrop.hidden = true;
    let shot: Shot | null = null;
    try {
      await nextFrame();
      await nextFrame();
      shot = await this.deps.takeScreenshot(this.values.element);
    } catch {
      shot = null;
    } finally {
      this.host.style.visibility = prev;
      if (backdrop) backdrop.hidden = false;
    }
    this.setShot(shot);
    if (!shot && note) {
      note.textContent = this.deps.labels.screenshotFailed;
      note.hidden = false;
    }
    this.render();
  }

  private setShot(shot: Shot | null): void {
    if (this.shotUrl) {
      try {
        URL.revokeObjectURL(this.shotUrl);
      } catch {
        /* nothing to revoke */
      }
    }
    this.shotUrl = null;
    this.values.shot = shot;
    if (shot) {
      try {
        this.shotUrl = URL.createObjectURL(shot.blob);
      } catch {
        this.shotUrl = null;
      }
    }
  }

  private async dropShot(): Promise<void> {
    this.setShot(null);
    this.render();
  }

  private async pickFromSheet(): Promise<void> {
    const wasOpen = this.isOpen;
    if (this.backdrop) this.backdrop.hidden = true;
    const el = await this.pick();
    if (el) {
      this.values.element = el;
      this.values.anchor = describeElement(el, this.deps.privateSelector || DEFAULT_PRIVATE_SELECTOR);
    }
    if (wasOpen && this.backdrop) {
      this.backdrop.hidden = false;
      this.render();
      if (el && this.values.shot) await this.captureShot();
      this.q<HTMLButtonElement>('[data-act="pick"]:not([hidden])')?.focus();
    }
  }

  private async send(): Promise<void> {
    if (this.busy) return;
    const L = this.deps.labels;
    const v = this.values;
    const message = v.message.trim();
    if (!message) {
      this.showErr('message', L.messageRequired);
      this.q<HTMLTextAreaElement>('textarea')?.focus();
      return;
    }
    const email = this.deps.needsEmail() ? (v.email ?? '').trim() : '';
    if (email && !isEmail(email)) {
      this.showErr('email', L.emailInvalid);
      this.q<HTMLInputElement>('input[type="email"]')?.focus();
      return;
    }
    this.busy = true;
    const button = this.q<HTMLButtonElement>('[data-act="send"]');
    if (button) {
      button.disabled = true;
      button.textContent = L.sending;
    }
    this.setStatus(L.sending, 'info');
    try {
      const result = await this.deps.submit({ ...v, message, email: email || undefined });
      clearDraft();
      this.reset();
      this.setStatus(L.sent, 'ok');
      if (button) button.textContent = L.send;
      this.deps.onSent?.(result);
    } catch (err) {
      const e = err instanceof FeedbackError ? err : new FeedbackError(-1, 'error', L.genericError);
      if (e.code === 'invalid_field' && e.field === 'reporter.email') this.showErr('email', e.message);
      else if (e.code === 'invalid_field' && e.field === 'message') this.showErr('message', e.message);
      const keep = e.status === 0 || e.status === 429 || e.status >= 500;
      let text = e.message || L.genericError;
      if (keep) {
        const kept = saveDraft({
          message,
          category: v.category,
          ...(email ? { email } : {}),
          ...(v.anchor ? { element: v.anchor } : {}),
          savedAt: Date.now(),
          ...(e.retryAfter ? { retryAt: Date.now() + e.retryAfter * 1000 } : {}),
        });
        if (kept) text += ` ${L.draftKept}`;
      }
      this.setStatus(text, 'error');
      if (button) button.textContent = keep ? L.retry : L.send;
    } finally {
      this.busy = false;
      if (button) button.disabled = false;
    }
  }

  private reset(): void {
    this.setShot(null);
    // Still the same opening of the sheet: `openedAt` and `trigger` stay.
    const { openedAt, trigger } = this.values;
    this.values = { message: '', category: 'bug', email: this.values.email, element: null, anchor: null, shot: null, openedAt, trigger };
    this.render();
  }

  // ── The picker ──────────────────────────────────────────────────────────────────────────────

  /** Let the person point at an element. Resolves with it, or null when they cancel. */
  pick(): Promise<Element | null> {
    if (this.picking) return Promise.resolve(null);
    const L = this.deps.labels;
    const doc = this.doc;
    const layer = doc.createElement('div');
    layer.className = 'pick-layer';
    const box = doc.createElement('div');
    box.className = 'pick-box';
    box.hidden = true;
    layer.appendChild(box);
    const bar = doc.createElement('div');
    bar.className = 'pick-bar';
    bar.setAttribute('role', 'toolbar');
    bar.innerHTML = `<span data-part="hint">${esc(L.pickerHint)}</span>
      <button type="button" class="btn primary" data-act="confirm" hidden>${esc(L.pickerConfirm)}</button>
      <button type="button" class="btn" data-act="again" hidden>${esc(L.pickerAgain)}</button>
      <button type="button" class="btn" data-act="cancel">${esc(L.pickerCancel)}</button>`;
    this.root.appendChild(layer);
    this.root.appendChild(bar);

    let current: Element | null = null;
    let staged: Element | null = null;
    let lastPointer = 'mouse';

    const usable = (t: EventTarget | null): Element | null => {
      if (!t || !(t as Element).tagName) return null;
      const el = t as Element;
      if (el === this.host || el.closest?.(`[${HOST_ATTR}]`)) return null;
      const tag = el.tagName.toLowerCase();
      if (tag === 'html') return null;
      return el;
    };
    const show = (el: Element | null) => {
      current = el;
      if (!el) {
        box.hidden = true;
        return;
      }
      const r = el.getBoundingClientRect();
      box.hidden = false;
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      // Keep the bar out of the way of what is highlighted.
      const vh = doc.defaultView?.innerHeight ?? 0;
      bar.classList.toggle('bottom', r.top < 80 && r.bottom < vh - 80);
    };
    const setStaged = (el: Element | null) => {
      staged = el;
      const hint = bar.querySelector<HTMLElement>('[data-part="hint"]')!;
      bar.querySelector<HTMLElement>('[data-act="confirm"]')!.hidden = !el;
      bar.querySelector<HTMLElement>('[data-act="again"]')!.hidden = !el;
      hint.textContent = el ? (el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '')) : lastPointer === 'touch' ? L.pickerHintTouch : L.pickerHint;
      if (el) bar.querySelector<HTMLElement>('[data-act="confirm"]')!.focus();
    };

    return new Promise<Element | null>((resolve) => {
      const block = (e: Event) => {
        if (!usable(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
      };
      const onMove = (e: PointerEvent) => {
        lastPointer = e.pointerType || 'mouse';
        if (staged || e.pointerType === 'touch') return;
        const el = usable(doc.elementFromPoint(e.clientX, e.clientY));
        if (el) show(el);
      };
      const onDown = (e: PointerEvent) => {
        lastPointer = e.pointerType || 'mouse';
        block(e);
      };
      const onClick = (e: MouseEvent) => {
        const el = usable(e.target);
        if (!el) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const hit = usable(doc.elementFromPoint(e.clientX, e.clientY)) ?? el;
        if (lastPointer === 'touch' || lastPointer === 'pen') {
          // A tap shows what it would select and asks first: a fingertip covers what it points at.
          show(hit);
          setStaged(hit);
        } else finish(hit);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          finish(null);
        } else if (e.key === 'Enter' && current && e.target !== this.host) {
          e.preventDefault();
          e.stopImmediatePropagation();
          finish(current);
        }
      };
      const onFocus = (e: FocusEvent) => {
        const el = usable(e.target);
        if (el && el !== doc.body) show(el);
      };
      const onBar = (e: Event) => {
        const act = (e.target as Element).closest?.('[data-act]')?.getAttribute('data-act');
        if (act === 'cancel') finish(null);
        else if (act === 'confirm') finish(staged);
        else if (act === 'again') {
          setStaged(null);
          show(null);
        }
      };
      const onViewport = () => {
        if (current) show(current);
      };
      const win = doc.defaultView;
      const finish = (el: Element | null) => {
        if (!this.picking) return;
        this.picking = null;
        doc.removeEventListener('pointermove', onMove, true);
        doc.removeEventListener('pointerdown', onDown, true);
        doc.removeEventListener('mousedown', block, true);
        doc.removeEventListener('pointerup', block, true);
        doc.removeEventListener('mouseup', block, true);
        doc.removeEventListener('click', onClick, true);
        doc.removeEventListener('keydown', onKey, true);
        doc.removeEventListener('focusin', onFocus, true);
        win?.removeEventListener('scroll', onViewport, true);
        win?.removeEventListener('resize', onViewport);
        bar.removeEventListener('click', onBar);
        layer.remove();
        bar.remove();
        resolve(el);
      };
      this.picking = { finish };
      doc.addEventListener('pointermove', onMove, true);
      doc.addEventListener('pointerdown', onDown, true);
      doc.addEventListener('mousedown', block, true);
      doc.addEventListener('pointerup', block, true);
      doc.addEventListener('mouseup', block, true);
      doc.addEventListener('click', onClick, true);
      doc.addEventListener('keydown', onKey, true);
      doc.addEventListener('focusin', onFocus, true);
      win?.addEventListener('scroll', onViewport, true);
      win?.addEventListener('resize', onViewport);
      bar.addEventListener('click', onBar);
      bar.querySelector<HTMLElement>('[data-act="cancel"]')?.focus();
    });
  }

  private endSession(): void {
    if (!this.session) return;
    this.session = false;
    try {
      this.deps.onClose?.();
    } catch {
      /* closed either way */
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.endSession();
    this.picking?.finish(null);
    this.setShot(null);
    this.host.remove();
  }
}
