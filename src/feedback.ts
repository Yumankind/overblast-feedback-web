/**
 * `init()`: the one object an integrator holds. It starts recording at once (console, errors,
 * requests), puts up the triggers, and sends reports from the sheet or from code.
 *
 * Nothing here touches `window` until `init` is called, so importing the package during server
 * rendering is safe; `init` without a DOM gives an instance whose `report()` still works and whose
 * UI methods do nothing.
 */

import { Capture, sameOrigin } from './capture.ts';
import { ConfigClient, DEFAULT_CONFIG, categoryRefusal, type KeyConfig } from './config.ts';
import { CHAT_READY_EVENT, chatApi, chatPresent, embedHeaders, type FeedbackCapabilities, type FeedbackOpenOptions, type FeedbackOpenResult } from './chat.ts';
import { ErrorPrompt, TypingTracker, type PromptClock } from './prompt.ts';
import { resolveTheme } from './theme.ts';
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
import type { Category, DomElement, FeedbackInstance, InitOptions, ReportInput, ReportResult, Reporter, Trigger } from './types.ts';
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

  const isAppUrl = appUrlMatcher(options.appHosts);
  const capture = new Capture({
    console: options.captureConsole !== false,
    network: options.captureNetwork !== false,
    ignoreUrl: endpoint,
    isAppUrl,
  });
  if (win) capture.install(win);

  // ── What the key's owner switched on (§2.1) ────────────────────────────────────────────────
  // Read in idle time after init, never without a DOM. Until there is an answer (now, or kept from
  // an earlier visit) everything is as the defaults: no device, no error prompt, screenshots offered.
  let config: ConfigClient | null = null;
  const keyConfig = (): KeyConfig => config?.current ?? DEFAULT_CONFIG;
  /** Set when the door said `device_required` although the kept answer said otherwise. */
  let deviceDemanded = false;

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
  // `device: false` wins; otherwise only when the key asks for devices at all (`flag`, `require`).
  const deviceWanted = (): boolean => options.device !== false && hasDom && (deviceDemanded || keyConfig().verification !== 'off');
  let device: DeviceClient | null = null;
  const getDevice = (): DeviceClient | null => {
    if (!deviceWanted() || destroyed) return null;
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
    if (!deviceWanted() || destroyed || idleHandle) return;
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
    // The key's kinds of report (§2): none is sent that the door would refuse, and the refusal is
    // the door's own, so code handling it is the same whether this side or the worker said no.
    const allowed = keyConfig().categories;
    const category: Category = input.category ?? allowed[0] ?? 'bug';
    if (!allowed.includes(category)) {
      throw new FeedbackError(403, 'category_not_accepted', categoryRefusal(allowed));
    }
    input = { ...input, category };
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
    const dev = getDevice();
    // The chat's device first (feedback-chat-integration §2.1), so the task lands in the visitor's
    // conversation; the library's own when the chat has none to lend.
    const embed = (bytes: Uint8Array) => embedHeaders(chatApi(win), bytes);
    try {
      return await sendReport(sendFetch(), endpoint, key, body, { device: dev, embed });
    } catch (err) {
      // The kept answer was stale: the key requires a device now. Register and send once more.
      if (!dev && err instanceof FeedbackError && err.code === 'device_required' && options.device !== false && hasDom) {
        deviceDemanded = true;
        void config?.refresh();
        const now = getDevice();
        if (now) return sendReport(sendFetch(), endpoint, key, body, { device: now, embed });
      }
      throw err;
    }
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
    const shotsAllowed = keyConfig().screenshots;
    if (!shotsAllowed) shot = null;
    else if (input.screenshot === true) shot = await screenshotFor(selected);
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
    announce(true);
    return ok;
  }

  if (shakeWanted && !motionNeedsPermission()) startMotion();

  // ── UI ─────────────────────────────────────────────────────────────────────────────────────

  const mountUi = () => {
    if (destroyed || !doc || ui) return;
    ui = new FeedbackUi(doc, {
      labels,
      theme: resolveTheme(options.theme, doc),
      position: buttonShow === false ? null : typeof buttonSetting === 'object' ? (buttonSetting.position ?? 'bottom-right') : 'bottom-right',
      privateSelector,
      needsEmail: () => !reporter()?.email,
      takeScreenshot: screenshotFor,
      submit: reportFromSheet,
      screenshotsAllowed: () => keyConfig().screenshots,
      categories: () => keyConfig().categories,
      onOpen: () => {
        capture.paused = true;
        prompt?.sheetOpened();
        void config?.maybeRefresh();
        registerWhenIdle();
      },
      onClose: () => {
        capture.paused = false;
        settleOpen({ filed: false, reason: 'cancelled' });
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
    placeButton();
  };

  // ── The site's chat (feedback-chat-integration §2.1, §5a) ──────────────────────────────────
  // `'auto'`: the floating button only when the chat is not on the page. The chat may load after
  // this library, so it is looked for at init, in idle time, and on its `infinite:ready`.
  const buttonSetting = trigger.button ?? 'auto';
  const buttonShow = typeof buttonSetting === 'object' ? (buttonSetting.show ?? 'auto') : buttonSetting;
  const placeButton = () => {
    if (!ui) return;
    if (buttonShow === true) ui.setButtonVisible(true);
    else if (buttonShow === 'auto') ui.setButtonVisible(!chatPresent(win));
  };

  /** The open the chat asked for, settled when the visitor sends or closes the sheet. */
  let pendingOpen: ((r: FeedbackOpenResult) => void) | null = null;
  const settleOpen = (r: FeedbackOpenResult) => {
    const done = pendingOpen;
    pendingOpen = null;
    done?.(r);
  };

  const capabilities = (): FeedbackCapabilities => {
    let coarse = false;
    try {
      coarse = !!win?.matchMedia?.('(pointer: coarse)').matches;
    } catch {
      /* fine */
    }
    return {
      available: !destroyed && !!ui,
      source: 'library',
      picker: !!ui,
      screenshot: !!doc && keyConfig().screenshots,
      shake: listening,
      pointer: coarse ? 'coarse' : 'fine',
      categories: [...keyConfig().categories],
    };
  };

  /** The chat's agent, or its "Report a problem" entry, opens the sheet with the visitor's words. */
  const opener = (o: FeedbackOpenOptions = {}): Promise<FeedbackOpenResult> => {
    if (destroyed || !ui) return Promise.resolve({ filed: false, reason: 'unavailable' });
    const sheet = ui;
    const trig: Trigger = o.trigger === 'agent' ? 'agent' : o.trigger === 'error_prompt' ? 'error_prompt' : 'api';
    const allowed = keyConfig().categories;
    const wanted = o.category ?? (trig === 'error_prompt' ? 'bug' : undefined);
    const category = wanted && allowed.includes(wanted) ? wanted : allowed[0];
    settleOpen({ filed: false, reason: 'superseded' });
    return new Promise<FeedbackOpenResult>((resolve) => {
      pendingOpen = resolve;
      // Logged before the sheet opens: collection pauses while it is open.
      if (trig === 'error_prompt') prompt?.reportedFromChat();
      sheet.open(trig, { ...(category ? { category } : {}), ...(typeof o.message === 'string' ? { message: o.message } : {}) });
      if (o.pick) void sheet.startPick();
    });
  };

  let announcedTo: unknown = null;
  /** Tell the chat what this page can do, and hand it the opener (again whenever that changes). */
  const announce = (force = false) => {
    const api = chatApi(win);
    if (!api || typeof api.announce !== 'function') return;
    if (!force && announcedTo === api && !destroyed) return;
    announcedTo = api;
    try {
      if (destroyed) api.announce({ ...capabilities(), available: false });
      else api.announce(capabilities(), opener);
    } catch {
      /* an older chat: it simply does not know about us */
    }
  };

  const meetChat = () => {
    placeButton();
    announce();
  };

  /** The sheet's anchor was taken when the person pointed, and its screenshot is already finished. */
  async function reportFromSheet(v: SheetValues): Promise<ReportResult> {
    const input: ReportInput = { message: v.message, category: v.category };
    if (v.email) input.reporter = { email: v.email };
    const result = await send(input, v.anchor ?? undefined, v.shot, { at: v.openedAt ?? Date.now(), trigger: v.trigger });
    settleOpen({ filed: true, reportId: result.id, ...(result.reference ? { reference: result.reference } : {}) });
    return result;
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

  // ── The error prompt (§3.6) ──────────────────────────────────────────────────────────────────

  // The prompt's clock and timers. Not an option: the tests hand in a fake clock this way, so every
  // rule can be driven without waiting for it.
  const clock = (options as { _promptClock?: PromptClock })._promptClock ?? {
    now: () => Date.now(),
    setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const startedAt = clock.now();
  const typing = win && options.errorPrompt !== false ? new TypingTracker(win, clock.now) : null;
  if (typing) cleanups.push(() => typing.destroy());
  const prompt: ErrorPrompt | null =
    doc && options.errorPrompt !== false
      ? new ErrorPrompt({
          now: clock.now,
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
          config: keyConfig,
          locallyOff: false,
          startedAt,
          isSheetOpen: () => !!ui?.isOpen || !!ui?.isPicking,
          isTyping: () => !!typing?.typing(),
          isVisible: () => doc.visibilityState !== 'hidden',
          show: (h) => ui?.showPrompt(h),
          hide: () => ui?.hidePrompt(),
          openSheet: () => ui?.open('error_prompt', { category: 'bug' }),
          log: (msg) => capture.log('info', msg, 'overblast'),
          storage: safeStorage,
          // With the chat on the page, its launcher shows the prompt, or nothing does (§5a).
          nudge: (kind) => {
            if (!chatPresent(win)) return null;
            const api = chatApi(win);
            const none = { shown: false };
            if (!api || typeof api.nudge !== 'function') return Promise.resolve(none);
            try {
              return Promise.resolve(api.nudge({ text: labels.promptText, reason: kind })).then(
                (r) => {
                  const a = (r ?? {}) as { shown?: unknown; outcome?: unknown };
                  const outcome = a.outcome === 'tapped' || a.outcome === 'dismissed' ? a.outcome : 'expired';
                  return { shown: a.shown === true, outcome };
                },
                () => none,
              );
            } catch {
              return Promise.resolve(none);
            }
          },
        })
      : null;
  if (prompt) {
    capture.onSignal = (kind) => {
      // A long-lived page asks the door again (at most every five minutes) when it has a reason to.
      void config?.maybeRefresh();
      prompt.signal(kind);
    };
    cleanups.push(() => prompt.destroy());
  }

  if (doc) {
    config = new ConfigClient({ endpoint, key, fetch: sendFetch });
    const cfg = config;
    const ask = () => {
      if (destroyed) return;
      void cfg.refresh();
      meetChat();
    };
    const w = win as (Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }) | undefined;
    if (w && typeof w.requestIdleCallback === 'function') {
      const h = w.requestIdleCallback(ask, { timeout: 2000 });
      cleanups.push(() => w.cancelIdleCallback?.(h));
    } else {
      const h = setTimeout(ask, 200);
      cleanups.push(() => clearTimeout(h));
    }
    const onVisible = () => {
      if (doc.visibilityState === 'visible') void cfg.maybeRefresh();
    };
    doc.addEventListener('visibilitychange', onVisible);
    cleanups.push(() => doc.removeEventListener('visibilitychange', onVisible));
    // A key switched to `flag` or `require` while the sheet is open: register now. And the chat
    // hears of new categories or screenshots.
    cleanups.push(
      cfg.onChange(() => {
        if (ui?.isOpen) registerWhenIdle();
        announce(true);
      }),
    );
  }

  if (win) {
    const onChat = () => {
      if (!destroyed) meetChat();
    };
    win.addEventListener(CHAT_READY_EVENT, onChat);
    cleanups.push(() => win.removeEventListener(CHAT_READY_EVENT, onChat));
    meetChat();
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
      settleOpen({ filed: false, reason: 'unavailable' });
      announce(true); // `available: false`: the chat stops offering the library's sheet
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

/**
 * The app's own hosts, for the error prompt's `server_error` and `network`: the page's origin, and
 * the hosts the integrator lists (`api.example.com`, `*.example.com`, or a full origin).
 */
export function appUrlMatcher(hosts: string[] | undefined): (url: string) => boolean {
  const list = (hosts ?? [])
    .map((h) => {
      const v = String(h).trim().toLowerCase();
      if (!v) return '';
      try {
        return v.includes('://') ? new URL(v).host : v.replace(/\/.*$/, '');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  return (url: string) => {
    if (sameOrigin(url)) return true;
    if (!list.length) return false;
    let host: string;
    try {
      host = new URL(url, typeof location !== 'undefined' ? location.href : undefined).host.toLowerCase();
    } catch {
      return false;
    }
    return list.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));
  };
}
