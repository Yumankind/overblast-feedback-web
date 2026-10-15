/**
 * Everything the person sees: the floating button, the sheet, the element picker, the screenshot
 * editor and the error prompt's pill. All of it lives in one shadow root on one host element, so the
 * page's CSS cannot break it and its CSS cannot leak onto the page. The host carries
 * `data-overblast-feedback`, which is how the picker and the screenshot know to leave it out.
 *
 * The sheet is three bands: the title, a body that scrolls, and a bar with Send that does not. It is
 * never taller than the visible viewport (the visual viewport, so an on-screen keyboard shrinks it
 * and Send stays above the keys), at 320 × 480 as at 1440 × 900.
 */

import { composeEdits, cropAround, MIN_EDIT, paintEdits, spanRect, type EditKind, type EditRect, type Paint2D } from './annotate.ts';
import { clearDraft, loadDraft, saveDraft } from './draft.ts';
import { DEFAULT_PRIVATE_SELECTOR, describeElement } from './element.ts';
import { FeedbackError, isEmail } from './payload.ts';
import { decodeBlob, type Shot } from './screenshot.ts';
import { BUG_ICON, CHECK_ICON, CSS } from './styles.ts';
import { applyTheme, type ResolvedTheme } from './theme.ts';
import type { ButtonPosition, Category, DomElement, Labels, ReportResult, Trigger } from './types.ts';

export const HOST_TAG = 'overblast-feedback';
export const HOST_ATTR = 'data-overblast-feedback';
/** How long "Sent, thank you" stays before the sheet closes by itself: time to read it. */
export const SENT_HOLD_MS = 2000;
/** The same for the longer known-issue sentence. */
export const SENT_KNOWN_HOLD_MS = 4000;

/** The timers the sent state uses; the tests hand in a fake clock. */
export interface UiClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: UiClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

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
  /** Colours, font, radius and scheme (`init({ theme })` and the page's `--overblast-accent`). */
  theme?: ResolvedTheme | undefined;
  clock?: UiClock | undefined;
  /** True when the integrator gave no email, so the sheet asks for one. */
  needsEmail(): boolean;
  takeScreenshot(selected: Element | null): Promise<Shot | null>;
  submit(values: SheetValues): Promise<ReportResult>;
  /** Called each time the sheet opens (collection pauses, the device registers in idle time). */
  onOpen?: (() => void) | undefined;
  /** Called when the sheet closes (collection resumes). */
  onClose?: (() => void) | undefined;
  /** False when the key has screenshots off (§2.1): the sheet does not offer one. */
  screenshotsAllowed?: (() => boolean) | undefined;
  /** The kinds of report the key takes (§2); one means no choice, and the "Report a problem" title. */
  categories?: (() => Category[]) | undefined;
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

const FOCUSABLE = 'button:not([disabled]):not([hidden]), input:not([disabled]), textarea:not([disabled]), canvas[tabindex], [tabindex]:not([tabindex="-1"])';

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
  /** The screenshot as taken, before the person's edits; edits are painted from it each time. */
  private shotBase: Shot | null = null;
  private edits: EditRect[] = [];
  private busy = false;
  private picking: { finish: (el: Element | null) => void } | null = null;
  private destroyed = false;
  /** The sent state's auto-close: what is left of it, and the timer while it runs (null: paused). */
  private sent: { remaining: number; startedAt: number; timer: unknown; held: Set<string> } | null = null;
  /** Set while the library itself moves focus to Done, so that focus does not count as a hold. */
  private focusingDone = false;
  private viewportOff: (() => void) | null = null;
  private editor: { el: HTMLElement; close: (apply: boolean) => void } | null = null;
  private thumbToken = 0;

  constructor(doc: Document, deps: UiDeps) {
    this.doc = doc;
    this.deps = deps;
    this.host = doc.createElement(HOST_TAG);
    this.host.setAttribute(HOST_ATTR, '');
    // `all: initial` keeps page rules such as `* { display: grid }` off the host itself.
    this.host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    if (deps.theme) applyTheme(this.host, deps.theme);
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

  /** Show or hide the floating button (hidden while the site's chat is the one in the corner). */
  setButtonVisible(visible: boolean): void {
    if (this.fab) this.fab.hidden = !visible;
  }

  get buttonVisible(): boolean {
    return !!this.fab && !this.fab.hidden;
  }

  /** Start pointing at an element from the open sheet, as its "Point at the problem" button does. */
  startPick(): Promise<void> {
    return this.pickFromSheet();
  }

  private allowedCategories(): Category[] {
    const c = this.deps.categories?.();
    return c && c.length ? c : CATEGORY_ORDER;
  }

  open(trigger: Trigger = 'api', preset: { category?: Category; message?: string } = {}): void {
    if (this.destroyed || this.picking) return;
    if (!this.backdrop) this.buildSheet();
    const backdrop = this.backdrop!;
    if (!backdrop.hidden) return;
    this.hideDone();
    this.hidePrompt();
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
    // A fresh sheet starts on the key's first kind (§2); a restored draft keeps its own.
    if (!this.values.message) this.values.category = this.allowedCategories()[0]!;
    if (preset.message && !this.values.message) this.values.message = preset.message.slice(0, 4000);
    if (preset.category) this.values.category = preset.category;
    this.render();
    backdrop.hidden = false;
    this.followViewport();
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
    this.editor?.close(false);
    this.backdrop.hidden = true;
    this.hideDone();
    this.viewportOff?.();
    this.viewportOff = null;
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

  /**
   * Fit the backdrop to the visual viewport: with an on-screen keyboard up, that is the part of the
   * screen above the keys, so the sheet (at most the backdrop's height) keeps Send in view.
   */
  private followViewport(): void {
    const backdrop = this.backdrop;
    const vv = this.doc.defaultView?.visualViewport;
    if (!backdrop || !vv || this.viewportOff) return;
    const sync = () => {
      backdrop.style.top = `${Math.round(vv.offsetTop)}px`;
      backdrop.style.height = `${Math.round(vv.height)}px`;
      backdrop.style.bottom = 'auto';
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    this.viewportOff = () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      backdrop.style.top = '';
      backdrop.style.height = '';
      backdrop.style.bottom = '';
    };
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
          <div class="body" data-part="body">
            <fieldset class="cats">
              <legend class="sr">${esc(L.categoryLegend)}</legend>
              <div class="chips">${CATEGORY_ORDER.map(chip).join('')}</div>
            </fieldset>
            <label class="field">${esc(L.messageLabel)}
              <textarea name="message" maxlength="4000" required aria-required="true" aria-describedby="ob-msg-err" placeholder="${esc(L.messagePlaceholder)}"></textarea>
              <span class="err" id="ob-msg-err" data-err="message" hidden></span>
            </label>
            <div class="row" data-part="pick">
              <button type="button" class="btn" data-act="pick"><span aria-hidden="true">⌖</span> ${esc(L.pointAt)}</button>
            </div>
            <div class="selected" data-part="selected" hidden>
              <div class="pick-thumb" data-part="pick-thumb" aria-hidden="true"></div>
              <div class="sel-text"><span class="hint">${esc(L.selected)}</span><code data-part="selected-text"></code></div>
              <div class="sel-actions">
                <button type="button" class="btn small" data-act="pick" aria-label="${esc(L.pointAgain)}">${esc(L.changeElement)}</button>
                <button type="button" class="btn small" data-act="unselect" aria-label="${esc(L.removeElement)}">${esc(L.removeElementShort)}</button>
              </div>
            </div>
            <label class="field" data-part="email" hidden>${esc(L.emailLabel)}
              <input type="email" name="email" autocomplete="email" inputmode="email" aria-describedby="ob-email-hint ob-email-err">
              <span class="hint" id="ob-email-hint">${esc(L.emailHint)}</span>
              <span class="err" id="ob-email-err" data-err="email" hidden></span>
            </label>
            <div class="shot" data-part="shot-row">
              <label class="check"><input type="checkbox" name="screenshot"><span>${esc(L.includeScreenshot)}</span></label>
              <p class="hint" data-part="shot-note" hidden></p>
              <div class="thumb" data-part="thumb" hidden>
                <button type="button" class="shot-preview" data-act="edit-shot" aria-label="${esc(L.editShot)}" title="${esc(L.editShot)}">
                  <img alt="" data-part="thumb-img">
                </button>
                <button type="button" class="icon on-image" data-act="unshot" aria-label="${esc(L.removeScreenshot)}">×</button>
                <p class="hint">${esc(L.editShotHint)}</p>
              </div>
            </div>
            <div class="offer" data-part="shake" hidden>
              <span>${esc(L.shakeOffer)}</span>
              <button type="button" class="btn link" data-act="shake-on">${esc(L.shakeEnable)}</button>
              <button type="button" class="btn link" data-act="shake-off">${esc(L.shakeDismiss)}</button>
            </div>
            <p class="preview" data-part="preview"></p>
          </div>
          <div class="foot">
            <p class="status" role="status" aria-live="polite" data-part="status"></p>
            <button type="button" class="btn" data-act="close">${esc(L.cancel)}</button>
            <button type="submit" class="btn primary" data-act="send">${esc(L.send)}</button>
          </div>
        </form>
        <div class="done" data-part="done" hidden>
          <span class="tick">${CHECK_ICON}</span>
          <p data-part="done-text" role="status" aria-live="polite"></p>
          <button type="button" class="btn primary" data-act="done-close">${esc(L.sentDone)}</button>
        </div>
      </div>`;
    this.root.appendChild(backdrop);
    this.backdrop = backdrop;

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        if (!this.editor) this.close();
        return;
      }
      const act = (e.target as Element).closest?.('[data-act]')?.getAttribute('data-act');
      if (act) this.act(act);
    });
    backdrop.addEventListener('keydown', (e) => this.onKey(e));
    // The sent state's clock stops while the person is over the sheet or has moved to Done.
    const sheetEl = backdrop.querySelector<HTMLElement>('.sheet')!;
    sheetEl.addEventListener('pointerenter', () => this.holdSent('pointer', true));
    sheetEl.addEventListener('pointerleave', () => this.holdSent('pointer', false));
    const doneBtn = backdrop.querySelector<HTMLElement>('[data-act="done-close"]')!;
    doneBtn.addEventListener('focus', () => {
      if (!this.focusingDone) this.holdSent('focus', true);
    });
    doneBtn.addEventListener('blur', () => this.holdSent('focus', false));
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
    if (act === 'close' || act === 'done-close') this.close();
    else if (act === 'pick') void this.pickFromSheet();
    else if (act === 'unselect') {
      this.values.element = null;
      this.values.anchor = null;
      this.render();
      if (this.values.shot) void this.captureShot();
    } else if (act === 'unshot') void this.dropShot();
    else if (act === 'edit-shot') void this.openEditor();
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
      if (this.editor) this.editor.close(false);
      else this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    // The focus trap: Tab and Shift+Tab cycle inside the sheet, or inside the editor when it is up.
    const scope: ParentNode = this.editor?.el ?? this.backdrop!;
    const items = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[hidden]') && (this.editor || !el.closest('.editor')));
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = this.root.activeElement;
    if (e.shiftKey && (active === first || !active || !items.includes(active as HTMLElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !items.includes(active as HTMLElement))) {
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
    const allowed = this.allowedCategories();
    if (!allowed.includes(v.category)) v.category = allowed[0]!;
    for (const r of Array.from(this.backdrop.querySelectorAll<HTMLInputElement>('input[name="ob-category"]'))) {
      r.checked = r.value === v.category;
      const chip = r.closest('label');
      if (chip) (chip as HTMLElement).hidden = !allowed.includes(r.value as Category);
    }
    // One kind only: no choice to make, and the sheet says what it is for.
    const fieldset = this.q<HTMLElement>('fieldset');
    if (fieldset) fieldset.hidden = allowed.length < 2;
    const title = this.q<HTMLElement>('#ob-title');
    if (title) title.textContent = allowed.length < 2 ? this.deps.labels.titleSingle : this.deps.labels.title;
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
      if (v.anchor) void this.renderPickThumb();
    }
    const shotsAllowed = this.deps.screenshotsAllowed?.() !== false;
    if (!shotsAllowed && v.shot) this.setShot(null);
    const shotRow = this.q<HTMLElement>('[data-part="shot-row"]');
    if (shotRow) shotRow.hidden = !shotsAllowed;
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

  /**
   * The pick's thumbnail: a crop of the screenshot around the element when there is one that shows
   * it, else a small card with the element's tag and text.
   */
  private async renderPickThumb(): Promise<void> {
    const slot = this.q<HTMLElement>('[data-part="pick-thumb"]');
    const anchor = this.values.anchor;
    if (!slot || !anchor) return;
    const token = ++this.thumbToken;
    const card = () => {
      slot.className = 'pick-thumb card';
      slot.innerHTML = `<b>&lt;${esc(anchor.tag)}&gt;</b><span>${esc(anchor.label ?? anchor.textQuote?.exact ?? '')}</span>`;
    };
    const shot = this.values.shot;
    if (!shot || !shot.box || !shot.viewport) return card();
    const decoded = await decodeBlob(this.doc, shot.blob).catch(() => null);
    if (token !== this.thumbToken) return decoded?.close();
    if (!decoded) return card();
    try {
      const canvas = this.doc.createElement('canvas');
      canvas.width = 168;
      canvas.height = 112;
      const ctx = canvas.getContext('2d');
      if (!ctx) return card();
      const c = cropAround(shot.box, shot.viewport, { w: decoded.w, h: decoded.h }, canvas.width / canvas.height);
      ctx.drawImage(decoded.source, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
      slot.className = 'pick-thumb';
      slot.replaceChildren(canvas);
    } catch {
      card();
    } finally {
      decoded.close();
    }
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
    // Edits made on the last screenshot still fit a new one of the same size (the same viewport).
    const keep = shot && this.edits.length && this.shotBase?.size && shot.size && this.shotBase.size.w === shot.size.w && this.shotBase.size.h === shot.size.h;
    if (!keep) this.edits = [];
    this.shotBase = shot;
    let shown = shot;
    if (shot && this.edits.length) shown = (await composeEdits(this.doc, shot, this.edits).catch(() => null)) ?? shot;
    this.setShot(shown, true);
    if (!shot && note) {
      note.textContent = this.deps.labels.screenshotFailed;
      note.hidden = false;
    }
    this.render();
  }

  /** `keepBase`: the shot is (an edit of) the current base; otherwise a new one replaces everything. */
  private setShot(shot: Shot | null, keepBase = false): void {
    if (this.shotUrl) {
      try {
        URL.revokeObjectURL(this.shotUrl);
      } catch {
        /* nothing to revoke */
      }
    }
    this.shotUrl = null;
    this.values.shot = shot;
    if (!keepBase) {
      this.shotBase = shot;
      this.edits = [];
    }
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

  // ── The screenshot editor ───────────────────────────────────────────────────────────────────

  /** Draw boxes that cover or blur parts of the screenshot. The private masks are in the base image. */
  private async openEditor(): Promise<void> {
    const base = this.shotBase;
    if (!base || this.editor || !this.backdrop) return;
    const decoded = await decodeBlob(this.doc, base.blob).catch(() => null);
    if (!decoded) return;
    const L = this.deps.labels;
    const doc = this.doc;
    const el = doc.createElement('div');
    el.className = 'editor';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', L.editShot);
    el.innerHTML = `
      <div class="ed-bar">
        <div class="seg" role="group" aria-label="${esc(L.editShot)}">
          <button type="button" data-ed="cover" aria-pressed="true">${esc(L.editorCover)}</button>
          <button type="button" data-ed="blur" aria-pressed="false">${esc(L.editorBlur)}</button>
        </div>
        <button type="button" class="btn small" data-ed="undo">${esc(L.editorUndo)}</button>
        <button type="button" class="btn small" data-ed="clear">${esc(L.editorClear)}</button>
        <span class="grow"></span>
        <button type="button" class="btn small" data-ed="cancel">${esc(L.cancel)}</button>
        <button type="button" class="btn primary small" data-ed="done">${esc(L.editorDone)}</button>
      </div>
      <p class="ed-hint">${esc(L.editorHint)}</p>
      <div class="ed-stage"><canvas tabindex="0" aria-label="${esc(L.editShot)}"></canvas></div>`;
    this.backdrop.appendChild(el);
    const canvas = el.querySelector('canvas')!;
    canvas.width = decoded.w;
    canvas.height = decoded.h;
    const ctx = canvas.getContext('2d') as (CanvasRenderingContext2D & Paint2D) | null;
    const scratchCanvas = doc.createElement('canvas');
    const scratchCtx = scratchCanvas.getContext('2d');
    const scratch = () =>
      scratchCtx
        ? {
            ctx: scratchCtx as unknown as Paint2D,
            canvas: scratchCanvas,
            resize: (w: number, h: number) => {
              scratchCanvas.width = w;
              scratchCanvas.height = h;
            },
          }
        : null;
    const before = this.edits.slice();
    let edits = this.edits.slice();
    let kind: EditKind = 'cover';
    let accent = '#0a5cff';
    try {
      accent = doc.defaultView?.getComputedStyle(this.host).getPropertyValue('--ob-accent').trim() || accent;
    } catch {
      /* the default */
    }
    const paint = (draft?: EditRect) => {
      if (!ctx) return;
      paintEdits(ctx, decoded.source, decoded.w, decoded.h, edits, scratch);
      if (draft) {
        ctx.save();
        ctx.lineWidth = Math.max(2, Math.round(decoded.w / 500));
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = '#ffffff';
        ctx.strokeRect(draft.x, draft.y, draft.w, draft.h);
        ctx.strokeStyle = accent;
        ctx.lineDashOffset = 7;
        ctx.strokeRect(draft.x, draft.y, draft.w, draft.h);
        ctx.restore();
      }
    };
    paint();
    const toImage = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * decoded.w, y: ((e.clientY - r.top) / Math.max(1, r.height)) * decoded.h };
    };
    let start: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      start = toImage(e);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* fine */
      }
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!start) return;
      paint({ ...spanRect(start, toImage(e), decoded.w, decoded.h), kind });
    });
    const end = (e: PointerEvent) => {
      if (!start) return;
      const r = spanRect(start, toImage(e), decoded.w, decoded.h);
      start = null;
      if (r.w >= MIN_EDIT && r.h >= MIN_EDIT) edits.push({ ...r, kind });
      paint();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => {
      start = null;
      paint();
    });
    const setKind = (k: EditKind) => {
      kind = k;
      for (const b of Array.from(el.querySelectorAll<HTMLElement>('[data-ed="cover"], [data-ed="blur"]'))) b.setAttribute('aria-pressed', String(b.dataset.ed === k));
    };
    const close = (apply: boolean) => {
      if (this.editor?.el !== el) return;
      this.editor = null;
      el.remove();
      decoded.close();
      if (!apply) this.edits = before;
      this.q<HTMLButtonElement>('[data-act="edit-shot"]')?.focus();
    };
    el.addEventListener('click', (e) => {
      const ed = (e.target as Element).closest?.('[data-ed]')?.getAttribute('data-ed');
      if (ed === 'cover' || ed === 'blur') setKind(ed);
      else if (ed === 'undo') {
        edits.pop();
        paint();
      } else if (ed === 'clear') {
        edits = [];
        paint();
      } else if (ed === 'cancel') close(false);
      else if (ed === 'done') {
        const chosen = edits.slice();
        this.edits = chosen;
        close(true);
        void composeEdits(this.doc, base, chosen).then((shot) => {
          if (shot && this.shotBase === base) {
            this.setShot(shot, true);
            this.render();
          }
        });
      }
      e.stopPropagation();
    });
    this.editor = { el, close };
    el.querySelector<HTMLElement>('[data-ed="cover"]')?.focus();
  }

  // ── Sending ─────────────────────────────────────────────────────────────────────────────────

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
      this.setStatus('', 'info');
      if (button) button.textContent = L.send;
      this.deps.onSent?.(result);
      this.showDone(result.known === true);
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

  private get clock(): UiClock {
    return this.deps.clock ?? REAL_CLOCK;
  }

  /**
   * "Sent, thank you" (or the known-issue sentence) over the form, announced politely; focus moves
   * to Done. The ✕, Done, Esc and a click outside all close it, and it closes by itself after long
   * enough to read it, the clock stopping while the pointer is over the sheet or the person has
   * moved to Done.
   */
  private showDone(known: boolean): void {
    const done = this.q<HTMLElement>('[data-part="done"]');
    const text = this.q<HTMLElement>('[data-part="done-text"]');
    if (!done || !text) return this.close();
    text.textContent = known ? this.deps.labels.sentKnown : this.deps.labels.sent;
    done.hidden = false;
    this.q<HTMLElement>('form')?.setAttribute('aria-hidden', 'true');
    this.stopSent();
    this.sent = { remaining: known ? SENT_KNOWN_HOLD_MS : SENT_HOLD_MS, startedAt: 0, timer: null, held: new Set() };
    let hovered = false;
    try {
      hovered = !!this.q<HTMLElement>('.sheet')?.matches(':hover');
    } catch {
      /* not known */
    }
    if (hovered) this.sent.held.add('pointer');
    this.runSent();
    this.focusingDone = true;
    try {
      this.q<HTMLButtonElement>('[data-act="done-close"]')?.focus();
    } finally {
      this.focusingDone = false;
    }
  }

  private runSent(): void {
    const s = this.sent;
    if (!s || s.timer !== null || s.held.size) return;
    s.startedAt = this.clock.now();
    s.timer = this.clock.setTimeout(() => {
      if (this.sent !== s) return;
      s.timer = null;
      this.close();
    }, s.remaining);
  }

  private holdSent(reason: string, on: boolean): void {
    const s = this.sent;
    if (!s) return;
    if (on) {
      s.held.add(reason);
      if (s.timer !== null) {
        this.clock.clearTimeout(s.timer);
        s.timer = null;
        // A moment to finish reading when it resumes.
        s.remaining = Math.max(1000, s.remaining - (this.clock.now() - s.startedAt));
      }
    } else {
      s.held.delete(reason);
      this.runSent();
    }
  }

  private stopSent(): void {
    if (this.sent?.timer != null) this.clock.clearTimeout(this.sent.timer);
    this.sent = null;
  }

  /** Whether the sent state is showing (for the tests and the chat). */
  get sentShowing(): boolean {
    return !!this.sent;
  }

  private hideDone(): void {
    this.stopSent();
    const done = this.q<HTMLElement>('[data-part="done"]');
    if (done) done.hidden = true;
    this.q<HTMLElement>('form')?.removeAttribute('aria-hidden');
  }

  private reset(): void {
    this.setShot(null);
    // Still the same opening of the sheet: `openedAt` and `trigger` stay.
    const { openedAt, trigger } = this.values;
    this.values = { message: '', category: this.allowedCategories()[0]!, email: this.values.email, element: null, anchor: null, shot: null, openedAt, trigger };
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
    const tag = doc.createElement('span');
    tag.className = 'pick-tag';
    box.appendChild(tag);
    layer.appendChild(box);
    const bar = doc.createElement('div');
    bar.className = 'pick-bar';
    bar.setAttribute('role', 'toolbar');
    const coarse = (() => {
      try {
        return !!doc.defaultView?.matchMedia?.('(pointer: coarse)').matches;
      } catch {
        return false;
      }
    })();
    bar.innerHTML = `<span class="pick-hint" data-part="hint" aria-live="polite">${esc(coarse ? L.pickerHintTouch : L.pickerHint)}</span>
      <button type="button" class="btn primary small" data-act="confirm" hidden>${esc(L.pickerConfirm)}</button>
      <button type="button" class="btn small" data-act="again" hidden>${esc(L.pickerAgain)}</button>
      <button type="button" class="btn small" data-act="cancel">${esc(L.pickerCancel)}</button>`;
    this.root.appendChild(layer);
    this.root.appendChild(bar);

    let current: Element | null = null;
    let staged: Element | null = null;
    let lastPointer = coarse ? 'touch' : 'mouse';

    const usable = (t: EventTarget | null): Element | null => {
      if (!t || !(t as Element).tagName) return null;
      const el = t as Element;
      if (el === this.host || el.closest?.(`[${HOST_ATTR}]`)) return null;
      const name = el.tagName.toLowerCase();
      if (name === 'html') return null;
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
      tag.textContent = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '');
      box.classList.toggle('tag-below', r.top < 26);
      // Keep the hint bar out of the way of what is highlighted.
      const vh = doc.defaultView?.innerHeight ?? 0;
      bar.classList.toggle('bottom', r.top < 72 && r.bottom < vh - 80);
    };
    const setStaged = (el: Element | null) => {
      staged = el;
      const hint = bar.querySelector<HTMLElement>('[data-part="hint"]')!;
      bar.querySelector<HTMLElement>('[data-act="confirm"]')!.hidden = !el;
      bar.querySelector<HTMLElement>('[data-act="again"]')!.hidden = !el;
      box.classList.toggle('staged', !!el);
      hint.textContent = el ? el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') : lastPointer === 'touch' ? L.pickerHintTouch : L.pickerHint;
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

  // ── The error prompt's pill (§3.6) ──────────────────────────────────────────────────────────

  private pill: HTMLDivElement | null = null;
  private pillOff: (() => void) | null = null;

  get promptShowing(): boolean {
    return !!this.pill;
  }

  /** Put up the pill. `role=status` makes screen readers announce it politely, not assertively. */
  showPrompt(h: { report(): void; close(): void; hold(inside: boolean): void }): void {
    if (this.destroyed) return;
    this.hidePrompt();
    const L = this.deps.labels;
    const pill = this.doc.createElement('div');
    const pos = this.deps.position;
    pill.className = `pill entering${pos === 'bottom-left' ? ' left' : ''}${pos === 'bottom-left' || pos === 'bottom-right' ? ' above' : ''}`;
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    pill.innerHTML = `<span>${esc(L.promptText)}</span><button type="button" class="btn" data-act="prompt-report">${esc(L.promptReport)}</button><button type="button" class="x" data-act="prompt-close" aria-label="${esc(L.promptClose)}">×</button>`;
    pill.addEventListener('click', (e) => {
      const act = (e.target as Element | null)?.closest?.('[data-act]')?.getAttribute('data-act');
      if (act === 'prompt-report') h.report();
      else if (act === 'prompt-close') h.close();
    });
    pill.addEventListener('mouseenter', () => h.hold(true));
    pill.addEventListener('mouseleave', () => h.hold(false));
    pill.addEventListener('focusin', () => h.hold(true));
    pill.addEventListener('focusout', () => h.hold(false));
    this.root.appendChild(pill);
    this.pill = pill;
    // It follows the on-screen keyboard: lifted by however much of the layout viewport the visual
    // viewport no longer shows at the bottom.
    const win = this.doc.defaultView;
    const vv = win?.visualViewport;
    if (win && vv) {
      const follow = () => {
        const hidden = Math.max(0, win.innerHeight - (vv.height + vv.offsetTop));
        pill.style.transform = hidden > 0 ? `translateY(${-Math.round(hidden)}px)` : '';
      };
      follow();
      vv.addEventListener('resize', follow);
      vv.addEventListener('scroll', follow);
      this.pillOff = () => {
        vv.removeEventListener('resize', follow);
        vv.removeEventListener('scroll', follow);
      };
    }
    // Fade in on the next frame (no animation with reduced motion: the stylesheet says so).
    void nextFrame().then(() => pill.classList.remove('entering'));
  }

  hidePrompt(): void {
    this.pillOff?.();
    this.pillOff = null;
    this.pill?.remove();
    this.pill = null;
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
    this.hideDone();
    this.viewportOff?.();
    this.hidePrompt();
    this.endSession();
    this.picking?.finish(null);
    this.setShot(null);
    this.host.remove();
  }
}
