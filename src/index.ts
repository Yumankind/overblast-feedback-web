/**
 * @overblast/feedback - a feedback button, shortcut and shake for any website.
 *
 * ```ts
 * import { init } from '@overblast/feedback';
 * const feedback = init({ key: 'obfk_…' });
 * ```
 *
 * Importing this module touches nothing global; `init` is where the page is first read.
 */

import { init } from './feedback.ts';
import { SDK_VERSION } from './version.ts';

export { init };
export { FeedbackError } from './payload.ts';
export { describeElement } from './element.ts';
export { buildSelector } from './selector.ts';
export { redact } from './redact.ts';
export { DEFAULT_LABELS } from './labels.ts';
export { DEFAULT_ENDPOINT } from './transport.ts';
export { SDK_NAME, SDK_VERSION as version } from './version.ts';
export type {
  ButtonPosition,
  Category,
  DeviceLevel,
  DomElement,
  FeedbackBody,
  FeedbackContext,
  FeedbackInstance,
  InitOptions,
  Labels,
  LogEntry,
  LogFileBody,
  LogLevel,
  NetworkEntry,
  ReportInput,
  ReportResult,
  Reporter,
  ThemeOptions,
  Trigger,
  TriggerOptions,
} from './types.ts';

/** The same functions as one object, the shape the script-tag build puts on `window`. */
export const OverblastFeedback = { init, version: SDK_VERSION };
export default OverblastFeedback;
