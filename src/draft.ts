/**
 * A report the door refused for now (`429`, a dropped connection, a `500`) is kept on this device so
 * the person can send it later without typing it again (contract §4). The screenshot is not kept:
 * it is large, and it shows the page as it was, which the person can capture again.
 */

import { safeStorage } from './context.ts';
import type { Category, DomElement } from './types.ts';

export const DRAFT_KEY = 'ob-feedback-draft';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface Draft {
  message: string;
  category: Category;
  email?: string;
  element?: DomElement;
  /** When the draft was kept, ms since the epoch. */
  savedAt: number;
  /** Not before this time, ms since the epoch, when the door said `retryAfter`. */
  retryAt?: number;
}

export function saveDraft(draft: Draft): boolean {
  try {
    const store = safeStorage();
    if (!store) return false;
    store.setItem(DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(now = Date.now()): Draft | null {
  try {
    const raw = safeStorage()?.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (!d || typeof d.message !== 'string' || typeof d.savedAt !== 'number' || now - d.savedAt > MAX_AGE_MS) {
      clearDraft();
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    safeStorage()?.removeItem(DRAFT_KEY);
  } catch {
    /* nothing to clear */
  }
}
