/**
 * The log buffer, kept bounded however much or however fast the page logs (contract §3.5).
 *
 * - **Intake is capped per second**: 50 lines, or up to 200 when the line is a warning or an error.
 *   A line over the cap is counted and dropped BEFORE it is formatted or redacted, so a storm of ten
 *   thousand lines in one tick costs ten thousand counter increments, not ten thousand redactions.
 *   One `warn` entry from `overblast` then marks the gap.
 * - **Repeats collapse**: a line identical to the one before (level, source, text) bumps that line's
 *   `repeat` (the total count, the first included) and `last` instead of being stored.
 * - **A byte budget as well as a count** (1 MB, 20,000 lines). When full, the oldest debug and info
 *   lines go first, and warnings and errors only when there is nothing else left to drop.
 *
 * Two lanes, each in arrival order, keep that eviction cheap: low (debug, info) and high (warn,
 * error), merged back into one order by a sequence number when the buffer is read.
 */

import { cleanMessage, utf8Length } from './redact.ts';
import type { LogEntry, LogLevel } from './types.ts';

export const BUFFER_MAX_LINES = 20_000;
export const BUFFER_MAX_BYTES = 1024 * 1024;
export const RATE_LINES = 50;
export const RATE_URGENT = 200;
/** The source of the entries the library writes about the log itself. */
export const SELF_SRC = 'overblast';

interface Slot {
  e: LogEntry;
  seq: number;
  bytes: number;
}

/** An array used as a queue: `shift` moves a head index instead of moving every element. */
class Lane {
  items: Array<Slot | undefined> = [];
  head = 0;
  push(s: Slot): void {
    this.items.push(s);
  }
  shift(): Slot | undefined {
    if (this.head >= this.items.length) return undefined;
    const s = this.items[this.head];
    this.items[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return s;
  }
  get size(): number {
    return this.items.length - this.head;
  }
  clear(): void {
    this.items = [];
    this.head = 0;
  }
}

/** `12345` → `12,345`, the same in every locale. */
export function groupDigits(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The bytes an entry takes as one line of JSON, near enough, without serialising it. */
function sizeOf(e: LogEntry): number {
  return utf8Length(e.msg) + e.src.length + 64;
}

export interface LogBufferOptions {
  maxLines?: number;
  maxBytes?: number;
  now?: () => number;
}

export class LogBuffer {
  /** While true, nothing enters (the sheet is open, §3.4). */
  paused = false;
  private readonly low = new Lane();
  private readonly high = new Lane();
  private seq = 0;
  private bytes = 0;
  private lastSlot: Slot | null = null;
  /** The text of the newest line before redaction, to spot a repeat without redacting it. */
  private lastRaw = '';
  private second = -1;
  private inSecond = 0;
  private dropped = 0;
  private dropFrom = 0;
  private dropTo = 0;
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(opts: LogBufferOptions = {}) {
    this.maxLines = opts.maxLines ?? BUFFER_MAX_LINES;
    this.maxBytes = opts.maxBytes ?? BUFFER_MAX_BYTES;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Offer a line. `msg` may be a function, called only if the line is kept: the console wrapper
   * passes one, so a dropped line is never formatted.
   */
  add(level: LogLevel, src: string, msg: string | (() => string), t = this.now()): void {
    if (this.paused) return;
    const sec = Math.floor(t / 1000);
    if (sec !== this.second) {
      this.second = sec;
      this.inSecond = 0;
    }
    const urgent = level === 'warn' || level === 'error';
    if (this.inSecond >= (urgent ? RATE_URGENT : RATE_LINES)) {
      if (!this.dropped) this.dropFrom = t;
      this.dropped++;
      this.dropTo = t;
      return;
    }
    this.inSecond++;
    // The gap is marked once the storm has passed: a full second after the last dropped line.
    if (this.dropped && sec >= Math.floor(this.dropTo / 1000) + 2) this.flushDrops();

    let raw: string;
    try {
      raw = typeof msg === 'function' ? msg() : msg;
    } catch {
      raw = '[unprintable]';
    }
    const source = src.slice(0, 40);
    const last = this.lastSlot;
    if (last && last.e.level === level && last.e.src === source && this.lastRaw === raw) {
      if (last.e.repeat === undefined) {
        last.bytes += 32;
        this.bytes += 32;
      }
      // The total number of occurrences, the first included (§3.5): no `repeat` means once.
      last.e.repeat = (last.e.repeat ?? 1) + 1;
      last.e.last = t;
      return;
    }
    this.store({ t, level, msg: cleanMessage(raw), src: source });
    this.lastRaw = raw;
  }

  /**
   * Entries made elsewhere (the early recorder's), with their own timestamps. They are cleaned
   * again, and repeats collapse here: the early recorder leaves that to this side to stay small.
   */
  adopt(entries: LogEntry[], dropped = 0): void {
    let prev: LogEntry | null = null;
    for (const e of entries) {
      if (!e || typeof e.msg !== 'string' || typeof e.t !== 'number') continue;
      const copy: LogEntry = { t: e.t, level: e.level, msg: cleanMessage(e.msg), src: String(e.src || 'console').slice(0, 40) };
      if (prev && prev.level === copy.level && prev.src === copy.src && prev.msg === copy.msg) {
        prev.repeat = (prev.repeat ?? 1) + (e.repeat ?? 1);
        prev.last = e.last ?? e.t;
        continue;
      }
      if (typeof e.repeat === 'number' && e.repeat > 1) copy.repeat = e.repeat;
      if (typeof e.last === 'number') copy.last = e.last;
      this.store(copy);
      prev = copy;
    }
    this.lastRaw = '';
    this.lastSlot = null;
    if (dropped > 0) {
      const t = entries.length ? entries[entries.length - 1]!.t : this.now();
      this.store(this.marker(dropped, t, t));
    }
  }

  /** Everything the buffer holds, oldest first, with a pending drop marker written out first. */
  list(): LogEntry[] {
    if (this.dropped) this.flushDrops();
    const out: LogEntry[] = [];
    const a = this.low.items;
    const b = this.high.items;
    let i = this.low.head;
    let j = this.high.head;
    while (i < a.length || j < b.length) {
      const x = i < a.length ? a[i] : undefined;
      const y = j < b.length ? b[j] : undefined;
      if (x && (!y || x.seq < y.seq)) {
        out.push(x.e);
        i++;
      } else if (y) {
        out.push(y.e);
        j++;
      } else {
        i++;
        j++;
      }
    }
    return out;
  }

  clear(): void {
    this.low.clear();
    this.high.clear();
    this.bytes = 0;
    this.lastSlot = null;
    this.lastRaw = '';
    this.dropped = 0;
  }

  get length(): number {
    return this.low.size + this.high.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  private marker(n: number, from: number, to: number): LogEntry {
    const secs = Math.max(1, Math.ceil((to - from) / 1000));
    return { t: to, level: 'warn', msg: `${groupDigits(n)} lines dropped in ${secs} s (too fast)`, src: SELF_SRC };
  }

  private flushDrops(): void {
    const n = this.dropped;
    this.dropped = 0;
    this.store(this.marker(n, this.dropFrom, this.dropTo));
    this.lastSlot = null;
    this.lastRaw = '';
  }

  private store(e: LogEntry): void {
    const slot: Slot = { e, seq: this.seq++, bytes: sizeOf(e) };
    (e.level === 'warn' || e.level === 'error' ? this.high : this.low).push(slot);
    this.bytes += slot.bytes;
    this.lastSlot = slot;
    while (this.length > this.maxLines || (this.bytes > this.maxBytes && this.length > 1)) {
      const gone = this.low.size ? this.low.shift() : this.high.shift();
      if (!gone) break;
      this.bytes -= gone.bytes;
      if (gone === this.lastSlot) {
        this.lastSlot = null;
        this.lastRaw = '';
      }
    }
  }
}
