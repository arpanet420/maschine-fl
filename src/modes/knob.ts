// Knob handling shared by the modes: how far a turn moves a 0–1 value, and how long our own value
// wins over FL's while FL catches up.
import type { ModeContext } from "./mode.js";

/** One turn is 1000 counts, so ≈1.2 turns cover 0…1. */
export const COUNTS_FULL_RANGE = 1200;
/** Shift divides a turn by this. */
export const FINE_DIVISOR = 10;
/** Our own value wins over FL's this long after the last turn, so FL catching up can't jump it. */
export const PENDING_MS = 300;

export const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));

/** The change of a 0–1 value for `delta` counts. */
export const knobStep = (delta: number, shift: boolean) =>
  delta / COUNTS_FULL_RANGE / (shift ? FINE_DIVISOR : 1);

/** A value we set ourselves, at time `at` (ms). */
export interface PendingValue<T> {
  value: T;
  at: number;
}

export const isLive = (pending: { at: number } | undefined, now: number): boolean =>
  pending !== undefined && now - pending.at < PENDING_MS;

/** Redraws now, and once more when our values stop overriding FL's. */
export class RenderSoon {
  private timer: NodeJS.Timeout | undefined;

  request(mc: ModeContext): void {
    mc.requestRender();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => mc.requestRender(), PENDING_MS + 30);
    this.timer.unref();
  }
}
