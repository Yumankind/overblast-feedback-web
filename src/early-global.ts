/**
 * The early recorder's script-tag build (`dist/overblast-feedback-early.global.js`). It starts as
 * soon as it runs; `data-fetch` on the tag also records failed requests:
 *
 * ```html
 * <script src="https://cdn.jsdelivr.net/npm/@overblast/feedback@0.2/dist/overblast-feedback-early.global.js" data-fetch></script>
 * ```
 */

import { startEarly } from './early.ts';

startEarly({ fetch: (document.currentScript as HTMLScriptElement | null)?.hasAttribute('data-fetch') });
