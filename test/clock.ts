/** A fake clock for the error prompt's tests: its own timer queue, moved by hand. */
export class Clock {
  now = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number);
  };
  /** Move the clock forward, running every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
}
