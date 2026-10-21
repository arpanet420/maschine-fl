// The play position inside the thing that loops, for the touch strip's play-position LEDs (no mode).
//
// SONG_POS arrives about every 50 ms with bar, step and tick (16 steps to the bar, 24 ticks to the
// step at PPQ 96). Read straight, that is a position that jumps by a step or two with the jitter
// of FL's service pass, and in song mode a wrap of the absolute position by the pattern's length
// that has nothing to do with where the song loops. So:
//   - pattern mode: the position within the current pattern (steps modulo its length);
//   - song mode: the position within the song loop (LOOP_STATE) when one is active, else within
//     the current pattern;
//   - between two SONG_POS messages the position is estimated from the tempo and the time since
//     the last one (as NOTE REPEAT's scheduler does), held at the end of the range until the next
//     message shows the wrap;
//   - it never steps backwards, except at a wrap (a step back of more than half the range).
import type { FlState } from "./fl/flState.js";
import {
  FALLBACK_BPM,
  SONG_POS_STALE_MS,
  STEPS_PER_BAR,
  TICKS_PER_STEP,
} from "./modes/repeatScheduler.js";

export interface PlayRange {
  /** Steps from the start of the pattern or loop. */
  position: number;
  /** The pattern's or the loop's length in steps. */
  length: number;
}

export class PlayPosition {
  private last = -1;
  private key = "";

  constructor(private readonly now: () => number) {}

  /** Where FL is now in its pattern or song loop, undefined while it is not playing. */
  at(fl: FlState): PlayRange | undefined {
    const stamp = fl.songPosAt;
    if (!fl.connected || !fl.transport.playing || stamp === undefined) return this.reset();
    let start = 0;
    let length = fl.pattern.length;
    let key = `pattern|${length}`;
    const { loop } = fl;
    if (fl.transport.songMode && loop.active && loop.end > loop.start) {
      const stepTicks = (fl.ppq > 0 ? fl.ppq : 96) / (STEPS_PER_BAR / 4);
      start = loop.start / stepTicks;
      length = (loop.end - loop.start) / stepTicks;
      key = `loop|${loop.start}|${loop.end}`;
    }
    if (!(length > 0)) return this.reset();
    const { bar, step, tick } = fl.songPos;
    const steps = (bar - 1) * STEPS_PER_BAR + (step - 1) + tick / TICKS_PER_STEP;
    const base = (((steps - start) % length) + length) % length;
    const elapsed = Math.min(Math.max(this.now() - stamp, 0), SONG_POS_STALE_MS);
    const bpm = fl.tempo > 0 ? fl.tempo : FALLBACK_BPM;
    let position = Math.min(base + (elapsed * bpm * (STEPS_PER_BAR / 4)) / 60000, length);
    if (
      key === this.key &&
      this.last >= 0 &&
      position < this.last &&
      this.last - position <= length / 2
    ) {
      position = this.last; // not backwards, unless it wrapped
    }
    this.key = key;
    this.last = position;
    return { position, length };
  }

  private reset(): undefined {
    this.last = -1;
    this.key = "";
    return undefined;
  }
}
