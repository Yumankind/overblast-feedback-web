/**
 * The script-tag build's entry (`dist/overblast-feedback.global.js`). It puts `OverblastFeedback`
 * on `window` and, when the tag carries `data-key`, starts it straight away:
 *
 * ```html
 * <script src="https://cdn.jsdelivr.net/npm/@overblast/feedback/dist/overblast-feedback.global.js"
 *         data-key="obfk_…" defer></script>
 * ```
 */

import { init } from './feedback.ts';
import { describeElement } from './element.ts';
import { FeedbackError } from './payload.ts';
import { redact } from './redact.ts';
import type { FeedbackInstance } from './types.ts';
import { SDK_VERSION } from './version.ts';

interface GlobalApi {
  init: typeof init;
  version: string;
  FeedbackError: typeof FeedbackError;
  describeElement: typeof describeElement;
  redact: typeof redact;
  /** The instance started from the script tag's `data-key`, if any. */
  instance: FeedbackInstance | null;
}

const api: GlobalApi = { init, version: SDK_VERSION, FeedbackError, describeElement, redact, instance: null };

if (typeof window !== 'undefined') {
  (window as unknown as { OverblastFeedback: GlobalApi }).OverblastFeedback = api;
  const script = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;
  const key = script?.dataset?.key;
  if (key) {
    const d = script.dataset;
    try {
      api.instance = init({
        key,
        ...(d.endpoint ? { endpoint: d.endpoint } : {}),
        ...(d.appVersion ? { appVersion: d.appVersion } : {}),
        ...(d.device === 'false' ? { device: false } : {}),
        trigger: {
          button: d.button === 'false' ? false : { position: (d.position as 'bottom-right' | undefined) ?? 'bottom-right' },
          ...(d.shortcut ? { shortcut: d.shortcut === 'false' ? false : d.shortcut } : {}),
          shake: d.shake !== 'false',
        },
      });
    } catch (err) {
      console.warn('OverblastFeedback:', err);
    }
  }
}
