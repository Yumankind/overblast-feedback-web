/**
 * `init()`: the one object an integrator holds. It starts recording at once (console, errors,
 * requests), puts up the triggers, and sends reports from the sheet or from code.
 *
 * Nothing here touches `window` until `init` is called, so importing the package during server
 * rendering is safe; `init` without a DOM gives an instance whose `report()` still works and whose
 * UI methods do nothing.
 */

import { Capture } from './capture.ts';
import { collectContext, safeStorage } from './context.ts';
import { DeviceClient } from './device.ts';
import { DEFAULT_PRIVATE_SELECTOR, describeElement } from './element.ts';
import { DEFAULT_LABELS } from './labels.ts';
import { attachLogFile } from './logfile.ts';
import { FeedbackError, buildBody, cleanExtra } from './payload.ts';
import { blobToBase64, finishHookBlob, planShot, takeScreenshot, type Shot } from './screenshot.ts';
import { DEFAULT_ENDPOINT, sendReport } from './transport.ts';
import {
  DEFAULT_SHORTCUT,
  ShakeDetector,
  hasMotion,
  isTouchDevice,
  matchShortcut,
  motionNeedsPermission,
  parseShortcut,
  requestMotion,
} from './triggers.ts';
import type { DomElement, FeedbackInstance, InitOptions, ReportInput, ReportResult, Reporter, Trigger } from './types.ts';
import { FeedbackUi, type SheetValues } from './ui.ts';

/** `granted` | `denied` | `dismissed`: what became of the one-time shake offer on iOS. */
export const SHAKE_KEY = 'ob-feedback-shake';

let current: FeedbackInstance | null = null;

function readShakeState(): string | null {
  try {
    return safeStorage()?.getItem(SHAKE_KEY) ?? null;
  } catch {
    return null;
  }
}
function writeShakeState(v: string): void {
  try {
    safeStorage()?.setItem(SHAKE_KEY, v);
  } catch {
    /* the offer will be shown again next visit */
  }
}

function isDomAnchor(v: unknown): v is DomElement {
  return !!v && typeof v === 'object' && (v as DomElement).kind === 'dom';
}

export function init(options: InitOptions): FeedbackInstance {
  if (!options || typeof options.key !== 'string' || !options.key.trim()) {
    throw new FeedbackError(-1, 'missing_key', 'OverblastFeedback.init needs `key`, the workspace feedback key (obfk_…).');
  }
  if (current) current.destroy();

  const key = options.key.trim();
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const privateSelector = options.privateSelector || DEFAULT_PRIVATE_SELECTOR;
  const labels = { ...DEFAULT_LABELS, ...(options.labels ?? {}) };
  const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
  const win = hasDom ? window : undefined;
  const doc = hasDom ? document : undefined;
  let reporterOverride: Reporter | null | undefined;
  let destroyed = false;
  const cleanups: Array<() => void> = [];

  const capture = new Capture({
    console: options.captureConsole !== false,
    network: options.captureNetwork !== false,
    ignoreUrl: endpoint,
  });
  if (win) capture.install(win);

  const reporter = (): Reporter | undefined => {
    if (reporterOverride !== undefined) return reporterOverride ?? undefined;
    const r = options.reporter;
    if (typeof r === 'function') {
      try {
        return r() ?? undefined;
      } catch (err) {
        capture.log('warn', `OverblastFeedback: the reporter function threw: ${String(err)}`, 'overblast-feedback');
        return undefined;
      }
    }
    return r ?? undefined;
  };

  // ── The device (contract §8) ───────────────────────────────────────────────────────────────
  // Made on first use, never at init and never without a DOM: server rendering must not reach
  // IndexedDB, and a page that never reports never makes a key.
  const deviceWanted = options.device !== false && hasDom;
  let device: DeviceClient | null = null;
  const getDevice = (): DeviceClient | null => {
    if (!deviceWanted || destroyed) return null;
    if (!device) {
      try {
        device = new DeviceClient({ endpoint, key, fetch: sendFetch });
      } catch {
        return null;
      }
    }
    return device;
  };
  let idleHandle: { cancel: () => void } | null = null;
  /** Register in idle time once the sheet is open, so it is usually done before Send is pressed. */
  const registerWhenIdle = () => {
    if (!deviceWanted || destroyed || idleHandle) return;
    const run = () => {
      idleHandle = null;
      getDevice()?.start();
    };
    const w = win as (Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }) | undefined;
    if (w && typeof w.requestIdleCallback === 'function') {
      const h = w.requestIdleCallback(run, { timeout: 1500 });
      idleHandle = { cancel: () => w.cancelIdleCallback?.(h) };
    } else {
      const h = setTimeout(run, 300);
      idleHandle = { cancel: () => clearTimeout(h) };
    }
  };
  cleanups.push(() => {
    idleHandle?.cancel();
    idleHandle = null;
  });

  const sendFetch = (): typeof fetch => {
    const f = options.fetch ?? capture.originalFetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new FeedbackError(-1, 'no_fetch', 'There is no fetch to send the report with.');
    // The page's own fetch must be called with the window as `this`.
    return options.fetch ? f : (f.bind(globalThis) as typeof fetch);
  };

  async function screenshotFor(selected: Element | null): Promise<Shot | null> {
    if (!doc) return null;
    return takeScreenshot(doc, privateSelector, selected, options.captureScreenshot);
  }

  async function send(input: ReportInput, element: DomElement | undefined, shot: Shot | null, opened: { at: number; trigger: Trigger }): Promise<ReportResult> {
    if (destroyed) throw new FeedbackError(-1, 'destroyed', 'This feedback instance was destroyed.');
    const extra = cleanExtra({ ...(options.extra ?? {}), ...(input.extra ?? {}) });
    const withLogs = input.includeLogs !== false;
    const context = collectContext({ appVersion: options.appVersion, build: options.build, locale: options.locale, extra });
    context.openedAt = opened.at;
    context.trigger = opened.trigger;
    const lines = withLogs ? capture.logs.list() : [];
    const body = buildBody({
      message: input.message,
      category: input.category,
      reporter: { ...(reporter() ?? {}), ...(input.reporter ?? {}) },
      context,
      element,
      screenshot: shot ? { contentType: shot.contentType, base64: await blobToBase64(shot.blob), highlighted: shot.highlighted } : undefined,
      logs: withLogs ? lines : undefined,
      network: withLogs ? capture.network.list() : undefined,
    });
    // The whole buffer as a file (§3.5), in the room the rest of the body leaves.
    await attachLogFile(body, lines);
    return sendReport(sendFetch(), endpoint, key, body, { device: getDevice() });
  }

  async function report(input: ReportInput): Promise<ReportResult> {
    if (destroyed) throw new FeedbackError(-1, 'destroyed', 'This feedback instance was destroyed.');
    const opened = { at: Date.now(), trigger: (input.trigger === 'agent' ? 'agent' : 'api') as Trigger };
    let element: DomElement | undefined;
    let selected: Element | null = null;
    if (isDomAnchor(input.element)) element = input.element;
    else if (input.element && typeof (input.element as Element).getBoundingClientRect === 'function') {
      selected = input.element as Element;
      element = describeElement(selected, privateSelector);
    }
    let shot: Shot | null = null;
    if (input.screenshot === true) shot = await screenshotFor(selected);
    else if (input.screenshot && typeof (input.screenshot as Blob).arrayBuffer === 'function' && doc) {
      shot = await finishHookBlob(doc, input.screenshot as Blob, planShot(doc, privateSelector, selected));
    }
    return send(input, element, shot, opened);
  }

  // ── Shake ──────────────────────────────────────────────────────────────────────────────────

  const trigger = options.trigger ?? {};
  const shakeWanted = trigger.shake !== false && hasDom && isTouchDevice() && hasMotion();
  let listening = false;
  let ui: FeedbackUi | null = null;

  const startMotion = () => {
    if (listening || !win || destroyed) return;
    listening = true;
    const detector = new ShakeDetector();
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity ?? e.acceleration;
      if (!a) return;
      if (detector.sample(a.x ?? NaN, a.y ?? NaN, a.z ?? NaN, Date.now()) && ui && !ui.isOpen && !ui.isPicking) ui.open('shake');
    };
    win.addEventListener('devicemotion', onMotion);
    cleanups.push(() => win.removeEventListener('devicemotion', onMotion));
  };

  async function enableShake(): Promise<boolean> {
    if (!shakeWanted) return false;
    const ok = await requestMotion();
    writeShakeState(ok ? 'granted' : 'denied');
    if (ok) startMotion();
    return ok;
  }

  if (shakeWanted && !motionNeedsPermission()) startMotion();

  // ── UI ─────────────────────────────────────────────────────────────────────────────────────

  const mountUi = () => {
    if (destroyed || !doc || ui) return;
    const button = trigger.button ?? true;
    ui = new FeedbackUi(doc, {
      labels,
      position: button === false ? null : button === true ? 'bottom-right' : (button.position ?? 'bottom-right'),
      privateSelector,
      needsEmail: () => !reporter()?.email,
      takeScreenshot: screenshotFor,
      submit: reportFromSheet,
      onOpen: () => {
        capture.paused = true;
        registerWhenIdle();
      },
      onClose: () => {
        capture.paused = false;
      },
      onButtonGesture: () => {
        // iOS forgets the motion grant between page loads but answers a repeat request silently,
        // from a tap. This is a tap.
        if (shakeWanted && !listening && motionNeedsPermission() && readShakeState() === 'granted') void enableShake();
      },
      shake: {
        offer: () => shakeWanted && !listening && motionNeedsPermission() && readShakeState() === null,
        enable: enableShake,
        dismiss: () => writeShakeState('dismissed'),
      },
      onSent: options.onSent,
    });
  };

  /** The sheet's anchor was taken when the person pointed, and its screenshot is already finished. */
  function reportFromSheet(v: SheetValues): Promise<ReportResult> {
    const input: ReportInput = { message: v.message, category: v.category };
    if (v.email) input.reporter = { email: v.email };
    return send(input, v.anchor ?? undefined, v.shot, { at: v.openedAt ?? Date.now(), trigger: v.trigger });
  }

  if (doc) {
    if (doc.body) mountUi();
    else {
      const onReady = () => mountUi();
      doc.addEventListener('DOMContentLoaded', onReady, { once: true });
      cleanups.push(() => doc.removeEventListener('DOMContentLoaded', onReady));
    }
  }

  // ── Shortcut ───────────────────────────────────────────────────────────────────────────────

  if (win && trigger.shortcut !== false) {
    const shortcut = parseShortcut(trigger.shortcut ?? DEFAULT_SHORTCUT);
    if (!shortcut) capture.log('warn', `OverblastFeedback: the shortcut "${String(trigger.shortcut)}" could not be read`, 'overblast-feedback');
    else {
      const onKey = (e: KeyboardEvent) => {
        // The page handled these keys itself: they are the page's.
        if (e.defaultPrevented || e.repeat || !matchShortcut(shortcut, e)) return;
        e.preventDefault();
        if (ui?.isOpen) ui.close();
        else ui?.open('shortcut');
      };
      win.addEventListener('keydown', onKey);
      cleanups.push(() => win.removeEventListener('keydown', onKey));
    }
  }

  const instance: FeedbackInstance = {
    open: (o) => ui?.open(o?.trigger === 'agent' ? 'agent' : 'api'),
    close: () => ui?.close(),
    async pick() {
      if (!ui) return null;
      const el = await ui.pick();
      return el ? describeElement(el, privateSelector) : null;
    },
    setReporter(r) {
      reporterOverride = r;
    },
    report,
    enableShake,
    async deviceLevel() {
      const d = getDevice();
      return d ? d.level() : 'none';
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of cleanups.splice(0)) off();
      capture.uninstall();
      ui?.destroy();
      ui = null;
      if (current === instance) current = null;
    },
  };
  current = instance;
  return instance;
}
