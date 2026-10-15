/**
 * The wire shapes of the feedback door (`POST /v1/feedback`, body `v: 1`) and the options this
 * library takes. The wire half is copied from the Overblast feedback contract; the server refuses an
 * unknown top-level field by name, so nothing here may grow a field the contract does not have.
 */

/** Contract §8.1, as far as a browser can reach: the web is `registered` at best. */
export type DeviceLevel = 'registered' | 'none';

export type Category = 'bug' | 'idea' | 'question' | 'other';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Reporter {
  /** A valid address. When present, the team can answer this person by email. */
  email?: string;
  /** At most 120 characters. */
  name?: string;
  /** Your own id for this person (a customer id, a user id). At most 200 characters. */
  accountRef?: string;
}

export interface LogEntry {
  /** Milliseconds since the epoch. */
  t: number;
  level: LogLevel;
  /** At most 4000 characters, redacted. */
  msg: string;
  /** At most 40 characters: `console`, `onerror`, `unhandledrejection`, or your own. */
  src: string;
  /** How many times the line occurred in a row, the first included; absent means once (§3.5). */
  repeat?: number;
  /** When the last of those repeats came, ms since the epoch. */
  last?: number;
}

export interface NetworkEntry {
  t: number;
  method: string;
  /** No query string, no fragment, at most 500 characters. */
  url: string;
  /** 0 when the request never got an answer. */
  status: number;
  ms: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Contract §3.2: the artifacts comments' `dom` anchor, with the same limits. */
export interface DomElement {
  kind: 'dom';
  selector: string;
  tag: string;
  role?: string;
  label?: string;
  rect: Rect;
  viewport: { w: number; h: number };
  textQuote?: { exact: string; prefix: string; suffix: string };
  html?: string;
}

export interface FeedbackContext {
  platform: 'web';
  url?: string;
  title?: string;
  appVersion?: string;
  build?: string;
  locale?: string;
  timeZone?: string;
  viewport?: { w: number; h: number; dpr: number };
  userAgent?: string;
  sdk?: { name: string; version: string };
  deviceId?: string;
  extra?: Record<string, string>;
  /** When the reporter opened the report: the sheet appearing, or `report()` being called (§3.4). */
  openedAt?: number;
  /** What opened it. */
  trigger?: Trigger;
}

/** Contract §3.1. The web sends `button`, `shortcut`, `shake`, `api`, `error_prompt`, and `agent` when told to. */
export type Trigger = 'shake' | 'button' | 'shortcut' | 'agent' | 'api' | 'relaunch' | 'error_prompt';

/** Contract §3.5: the whole buffer, as a gzip NDJSON file. */
export interface LogFileBody {
  contentType: 'application/x-ndjson';
  encoding: 'gzip' | 'identity';
  base64: string;
  lines: number;
  from: number;
  to: number;
}

/**
 * What `@overblast/feedback/early` leaves on `window.__overblastFeedbackEarly` for `init()` to
 * adopt: the lines and failed requests from before the library loaded, the functions it wrapped
 * (so `init` can hand the originals back rather than wrap a wrapper), and `stop()`.
 */
export interface EarlyBuffer {
  v: 1;
  logs: LogEntry[];
  network: NetworkEntry[];
  /** Lines over the per-second cap, counted and not kept. */
  dropped: number;
  originals: Record<string, (...args: unknown[]) => unknown>;
  wrappers: Record<string, (...args: unknown[]) => unknown>;
  /** Silence the recorder: its listeners and wrappers become pass-throughs. Restores nothing. */
  stop(): void;
}

export interface ScreenshotBody {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
  highlighted: boolean;
}

/** Contract §3.1, exactly. */
export interface FeedbackBody {
  v: 1;
  message: string;
  category: Category;
  reporter?: Reporter;
  context: FeedbackContext;
  element?: DomElement;
  screenshot?: ScreenshotBody;
  logs?: LogEntry[];
  logFile?: LogFileBody;
  network?: NetworkEntry[];
}

/** Contract §3.3, the 201 answer. */
export interface ReportResult {
  id: string;
  taskId: string;
  conversationId: string | null;
  /**
   * True when the workspace was out of storage (`507 storage_full`): the task was filed, without
   * the screenshot and the attached report file.
   */
  storageFull?: boolean;
}

export type ButtonPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface TriggerOptions {
  /** The floating button. Default `true`. */
  button?: boolean | { position?: ButtonPosition };
  /** A keyboard shortcut such as `'mod+shift+f'` (`mod` is ⌘ on Apple, Ctrl elsewhere), or `false`. */
  shortcut?: string | false;
  /** Shake to report, on touch devices with a motion sensor. Default `true`. */
  shake?: boolean;
}

export interface Labels {
  button: string;
  title: string;
  close: string;
  categoryLegend: string;
  categoryBug: string;
  categoryIdea: string;
  categoryQuestion: string;
  categoryOther: string;
  messageLabel: string;
  messagePlaceholder: string;
  messageRequired: string;
  pointAt: string;
  pointAgain: string;
  removeElement: string;
  selected: string;
  emailLabel: string;
  emailHint: string;
  emailInvalid: string;
  includeScreenshot: string;
  screenshotFailed: string;
  removeScreenshot: string;
  willSend: string;
  partMessage: string;
  partElement: string;
  partScreenshot: string;
  partLogs: string;
  partDevice: string;
  send: string;
  sending: string;
  sent: string;
  draftKept: string;
  draftRestored: string;
  retry: string;
  genericError: string;
  pickerHint: string;
  pickerHintTouch: string;
  pickerCancel: string;
  pickerConfirm: string;
  pickerAgain: string;
  shakeOffer: string;
  shakeEnable: string;
  shakeDismiss: string;
  /** The error prompt (§3.6). */
  promptText: string;
  promptReport: string;
  promptClose: string;
}

export interface InitOptions {
  /** The workspace's public feedback key, `obfk_…`. */
  key: string;
  /** Default `https://brain.deployd.network/v1/feedback`. */
  endpoint?: string;
  /** Who is reporting, or a function that says so at send time. */
  reporter?: Reporter | (() => Reporter | null | undefined);
  trigger?: TriggerOptions;
  appVersion?: string;
  build?: string;
  /** At most 20 keys; values become strings of at most 200 characters. */
  extra?: Record<string, string | number | boolean>;
  /**
   * Your own screenshot of the viewport (html2canvas, a native bridge). Return `null` for none.
   * Private elements are still blanked and the selected element still drawn on what it returns.
   */
  captureScreenshot?: () => Promise<Blob | null>;
  /** Elements whose content is never sent. Default `[data-overblast-private]`. */
  privateSelector?: string;
  /** What `context.locale` says. Default `navigator.language`. */
  locale?: string;
  labels?: Partial<Labels>;
  /** Record console lines. Default `true`. */
  captureConsole?: boolean;
  /** Record request methods, urls without query, statuses and timings. Default `true`. */
  captureNetwork?: boolean;
  /** Called after a report has been filed from the sheet. */
  onSent?: (result: ReportResult) => void;
  /** The `fetch` used to send. Default the page's own (unwrapped) `fetch`. */
  fetch?: typeof fetch;
  /**
   * The error prompt (§3.6), when the key's owner has switched it on. `false` keeps it off on this
   * site whatever the key says; nothing here can turn it on.
   */
  errorPrompt?: boolean;
  /**
   * Hosts that count as this app's own for the error prompt, besides the page's origin: a 5xx or a
   * failed request to one of these may prompt. `api.example.com`, `*.example.com`, or an origin.
   */
  appHosts?: string[];
  /**
   * Register this browser as a device and sign each report with its key (contract §8), when the
   * key's verification is `flag` or `require`. Default `true`; `false` keeps it off whatever the key
   * says. Where IndexedDB or WebCrypto is missing, reports go unsigned, as with `false`.
   */
  device?: boolean;
}

export interface ReportInput {
  message: string;
  category?: Category;
  /** Merged over the reporter given to `init` or `setReporter`. */
  reporter?: Reporter;
  /** An element on the page, or an anchor you built. */
  element?: Element | DomElement | null;
  /** `true` captures the viewport now; a Blob is used as given (after blanking). Default none. */
  screenshot?: boolean | Blob | null;
  /** Default `true`. False leaves out the console lines, the log file and the requests. */
  includeLogs?: boolean;
  /** @internal What opened the report: Overblast's own chat passes `'agent'`. Default `'api'`. */
  trigger?: 'api' | 'agent';
  /** Merged over `init`'s `extra`. */
  extra?: Record<string, string | number | boolean>;
}

export interface FeedbackInstance {
  /**
   * Open the sheet. `trigger` is internal: Overblast's own chat passes `'agent'` when it opens the
   * sheet for the person; everything else is `'api'`.
   */
  open(options?: { trigger?: 'api' | 'agent' }): void;
  /** Close the sheet (the draft stays in memory until the page goes). */
  close(): void;
  /** Start the element picker; resolves with the anchor, or `null` when cancelled. */
  pick(): Promise<DomElement | null>;
  setReporter(reporter: Reporter | null): void;
  /** File a report without the sheet. */
  report(input: ReportInput): Promise<ReportResult>;
  /** Ask for motion permission on iOS. Call it from a tap. Resolves to whether shake is on. */
  enableShake(): Promise<boolean>;
  /**
   * `registered` when this browser holds a device the door registered (or one being registered
   * finishes with one), `none` otherwise. Never starts a registration.
   */
  deviceLevel(): Promise<DeviceLevel>;
  /** Remove the button, the listeners and every wrapper this instance installed. */
  destroy(): void;
}
