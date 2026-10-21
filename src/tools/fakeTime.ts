// A clock and timers a test moves by hand: `advance(ms)` runs every timer that falls due, in
// order, with `now` set to the moment each one was due.
import type { RepeatTimers } from "../modes/repeatScheduler.js";

interface Pending {
  id: number;
  due: number;
  callback: () => void;
}

export class FakeTime {
  now: number;
  private nextId = 1;
  private pending: Pending[] = [];

  constructor(start = 1000) {
    this.now = start;
  }

  readonly clock = (): number => this.now;

  readonly timers: RepeatTimers = {
    set: (callback, ms) => {
      const id = this.nextId++;
      this.pending.push({ id, due: this.now + Math.max(0, ms), callback });
      return id;
    },
    clear: (handle) => {
      this.pending = this.pending.filter((p) => p.id !== handle);
    },
  };

  /** Timers waiting to fire. */
  get timerCount(): number {
    return this.pending.length;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = this.pending
        .filter((p) => p.due <= target + 1e-9)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      this.pending = this.pending.filter((p) => p !== next);
      this.now = Math.max(this.now, next.due);
      next.callback();
    }
    this.now = target;
  }
}
