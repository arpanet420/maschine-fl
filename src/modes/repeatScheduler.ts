// The clock behind NOTE REPEAT (docs/workflow.md): which notes repeat, when, and for how long.
// No MIDI and no FL in here: the notes go out through a `RepeatPlayer`, the tempo and the song
// position come from a `timing` function, and the clock and the timers are injected, so the tests
// run it on a fake clock.
//
// - All held pads share one grid (a slot every `interval`), not a phase each. The first hit of a pad
//   sounds at the press and is not on the grid; its next repeat is the next free slot.
// - Slot `n` sits `n × interval` after the grid's origin; every odd slot is delayed by `swing ×
//   interval`. The note's off follows `gate × interval` after its on; before every on, a note that
//   still sounds is ended first, so every on has an off.
// - While FL plays (and SONG_POS is fresh) the origin is bar 1, and the position is estimated from
//   the last SONG_POS plus the time since it arrived. While FL is stopped the grid runs free from
//   the press. The grid is kept in beats, so a tempo change moves the next slot, not the phase.
// - One timer is always set to the next due thing (a slot or an off) from absolute target times; a
//   slot that is late by more than half an interval is skipped, never played in a burst.
import type { SongPosition } from "../fl/sysex.js";

export interface RepeatRate {
  label: string;
  /** The note value: 4 = a quarter note. */
  denominator: number;
  triplet: boolean;
}

/** In the order of the knob and of display buttons 2–8. */
export const REPEAT_RATES: readonly RepeatRate[] = [
  { label: "1/4", denominator: 4, triplet: false },
  { label: "1/8", denominator: 8, triplet: false },
  { label: "1/16", denominator: 16, triplet: false },
  { label: "1/32", denominator: 32, triplet: false },
  { label: "1/8T", denominator: 8, triplet: true },
  { label: "1/16T", denominator: 16, triplet: true },
  { label: "1/32T", denominator: 32, triplet: true },
];

export interface RepeatSettings {
  /** Index into REPEAT_RATES. */
  rate: number;
  /** Fraction of the interval a note sounds, 0.1–1. */
  gate: number;
  /** Fraction of the interval every second repeat is delayed by, 0–0.5. */
  swing: number;
}

export const DEFAULT_RATE = 2;
export const GATE_MIN = 0.1;
export const GATE_MAX = 1;
export const SWING_MAX = 0.5;
export const DEFAULT_SETTINGS: RepeatSettings = { rate: DEFAULT_RATE, gate: 0.5, swing: 0 };

/** The tempo used while FL's is unknown (0). */
export const FALLBACK_BPM = 120;
/** SONG_POS has 16 steps per bar (as the STEP page assumes) and 96 PPQ, so 24 ticks per step. */
export const STEPS_PER_BAR = 16;
export const TICKS_PER_STEP = 24;
/** A SONG_POS older than this no longer says where FL is (it arrives every 50 ms while playing). */
export const SONG_POS_STALE_MS = 500;
/** A new pad's first repeat is at least this far (of an interval) after its hit. */
const MIN_GAP = 0.25;
const EPSILON_MS = 1e-6;

export const clampRate = (rate: number): number =>
  Math.min(REPEAT_RATES.length - 1, Math.max(0, Math.round(rate)));

const rateOf = (rate: number): RepeatRate =>
  REPEAT_RATES[clampRate(rate)] ?? REPEAT_RATES[DEFAULT_RATE]!;

/** Beats between repeats: a 1/16 is a quarter of a beat, a triplet two thirds of that. */
export function intervalBeats(rate: number): number {
  const { denominator, triplet } = rateOf(rate);
  return (4 / denominator) * (triplet ? 2 / 3 : 1);
}

/** Milliseconds between repeats: 60 / BPM × 4 / denominator (× 2/3 for triplets). */
export function intervalMs(bpm: number, rate: number): number {
  const tempo = bpm > 0 ? bpm : FALLBACK_BPM;
  return (60000 / tempo) * intervalBeats(rate);
}

/** SONG_POS in beats from bar 1 (a bar is 4 beats). */
export function songBeats(pos: SongPosition): number {
  const steps = (pos.bar - 1) * STEPS_PER_BAR + (pos.step - 1) + pos.tick / TICKS_PER_STEP;
  return steps / (STEPS_PER_BAR / 4);
}

/** A hit velocity (0–1) as the first note's MIDI velocity: 1–127. */
export const hitVelocity = (velocity: number): number =>
  Math.min(127, Math.max(1, Math.round(velocity * 126) + 1));

/** A pad's pressure (0–1) as a repeat's MIDI velocity, never below 1. */
export const pressureVelocity = (pressure: number): number =>
  Math.min(127, Math.max(1, Math.round(pressure * 127)));

export interface RepeatTiming {
  /** FL's tempo; 0 or less = unknown. */
  bpm: number;
  playing: boolean;
  /** The last SONG_POS: its position in beats from bar 1, and when it arrived (the clock's ms). */
  songPos?: { beats: number; at: number };
}

export interface RepeatPlayer {
  on(pad: number, velocity: number): void;
  off(pad: number): void;
}

export interface RepeatTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface RepeatOptions {
  player: RepeatPlayer;
  timing: () => RepeatTiming;
  settings: () => RepeatSettings;
  /** Milliseconds; `performance.now()` by default. */
  clock?: () => number;
  timers?: RepeatTimers;
}

interface PadRepeat {
  /** 0–1, from the pad's aftertouch. */
  pressure: number;
  sounding: boolean;
  /** When its note ends (the clock's ms). */
  offAt: number;
  /** No grid slot before this plays for the pad (it was just hit). */
  silentUntil: number;
}

interface Slot {
  n: number;
  /** When the slot sounds, swing included. */
  wall: number;
  /** When it would sound without swing. */
  gridWall: number;
}

export const realTimers: RepeatTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class RepeatScheduler {
  private readonly pads = new Map<number, PadRepeat>();
  private readonly clock: () => number;
  private readonly timers: RepeatTimers;
  private timer: unknown;
  private mode: "free" | "song" | undefined;
  /** The grid's reference: this position (beats) was at this time. */
  private refAt = 0;
  private refBeats = 0;
  /** The tempo the free grid has been advanced with. */
  private refBpm = FALLBACK_BPM;
  private lastRate = DEFAULT_RATE;
  private lastFireWall = -Infinity;
  private lastGridWall = 0;

  constructor(private readonly options: RepeatOptions) {
    this.clock = options.clock ?? (() => performance.now());
    this.timers = options.timers ?? realTimers;
  }

  /** Is any pad repeating? */
  get active(): boolean {
    return this.pads.size > 0;
  }

  isRepeating(pad: number): boolean {
    return this.pads.has(pad);
  }

  /** The pads that repeat now. */
  get repeating(): readonly number[] {
    return [...this.pads.keys()];
  }

  /** A pad went down: sound it now (`velocity` 1–127, `pressure` 0–1) and repeat it. */
  start(pad: number, velocity: number, pressure: number): void {
    const now = this.clock();
    this.stop(pad);
    if (this.pads.size === 0) this.begin(now);
    this.sync(now);
    const interval = this.intervalNow();
    this.pads.set(pad, {
      pressure,
      sounding: false,
      offAt: now,
      silentUntil: now + MIN_GAP * interval,
    });
    this.sound(pad, velocity, now + this.options.settings().gate * interval, now);
    this.arm(now);
  }

  /** The pad's current pressure (0–1): the velocity of its next repeat. */
  setPressure(pad: number, pressure: number): void {
    const held = this.pads.get(pad);
    if (held) held.pressure = pressure;
  }

  /** The pad was released: end its note and its repeats. */
  stop(pad: number): void {
    const held = this.pads.get(pad);
    if (!held) return;
    this.pads.delete(pad);
    if (held.sounding) this.options.player.off(pad);
    if (this.pads.size === 0) this.idle();
    else this.arm(this.clock());
  }

  /** End every note and every repeat. */
  stopAll(): void {
    for (const pad of [...this.pads.keys()]) {
      const held = this.pads.get(pad);
      this.pads.delete(pad);
      if (held?.sounding) this.options.player.off(pad);
    }
    this.idle();
  }

  /** The tempo, the transport or a setting changed: plan again (due things happen now). */
  refresh(): void {
    if (this.pads.size === 0) return;
    this.timers.clear(this.timer);
    this.timer = undefined;
    this.wake();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private idle(): void {
    this.timers.clear(this.timer);
    this.timer = undefined;
    this.mode = undefined;
  }

  /** The first pad: the free grid starts here (slot 0 is the press). */
  private begin(now: number): void {
    this.mode = undefined;
    this.lastFireWall = now;
    this.lastGridWall = now;
    this.lastRate = this.options.settings().rate;
  }

  private bpm(): number {
    const { bpm } = this.options.timing();
    return bpm > 0 ? bpm : FALLBACK_BPM;
  }

  private intervalNow(): number {
    return intervalMs(this.bpm(), this.options.settings().rate);
  }

  /** Pick the grid: FL's song position while it plays, else free from `lastGridWall`. */
  private sync(now: number): void {
    const timing = this.options.timing();
    const { rate } = this.options.settings();
    const bpm = timing.bpm > 0 ? timing.bpm : FALLBACK_BPM;
    const pos = timing.songPos;
    if (timing.playing && pos && now - pos.at <= SONG_POS_STALE_MS && pos.at <= now + 1) {
      this.mode = "song";
      this.refAt = pos.at;
      this.refBeats = pos.beats;
    } else if (this.mode !== "free" || rate !== this.lastRate) {
      // Stopped (or FL went quiet), or another rate: the grid restarts at the last slot.
      this.mode = "free";
      this.refAt = this.lastGridWall;
      this.refBeats = 0;
    } else {
      this.refBeats += ((now - this.refAt) * this.refBpm) / 60000;
      this.refAt = now;
    }
    this.refBpm = bpm;
    this.lastRate = rate;
  }

  private beatsAt(now: number): number {
    return this.refBeats + ((now - this.refAt) * this.bpm()) / 60000;
  }

  private slotWall(n: number, swing: boolean): number {
    const { rate, swing: amount } = this.options.settings();
    const beats =
      n * intervalBeats(rate) + (swing && Math.abs(n) % 2 === 1 ? amount * intervalBeats(rate) : 0);
    return this.refAt + ((beats - this.refBeats) * 60000) / this.bpm();
  }

  /** The next slot worth playing: after the last one, and not more than half an interval late. */
  private nextSlot(now: number): Slot | undefined {
    const { rate } = this.options.settings();
    const interval = this.intervalNow();
    let n = Math.floor(this.beatsAt(now) / intervalBeats(rate)) - 2;
    for (let i = 0; i < 24; i++, n++) {
      const wall = this.slotWall(n, true);
      if (wall > this.lastFireWall + MIN_GAP * interval && wall >= now - interval / 2) {
        return { n, wall, gridWall: this.slotWall(n, false) };
      }
    }
    return undefined;
  }

  private sound(pad: number, velocity: number, offAt: number, now: number): void {
    const held = this.pads.get(pad);
    if (!held) return;
    if (held.sounding) this.options.player.off(pad);
    this.options.player.on(pad, velocity);
    held.sounding = true;
    held.offAt = Math.max(offAt, now);
  }

  private wake(): void {
    this.timer = undefined;
    const now = this.clock();
    if (this.pads.size === 0) return;
    this.sync(now);
    // Offs first: a note ends before the next one starts.
    for (const [pad, held] of this.pads) {
      if (held.sounding && held.offAt <= now + EPSILON_MS) {
        held.sounding = false;
        this.options.player.off(pad);
      }
    }
    const slot = this.nextSlot(now);
    if (slot && slot.wall <= now + EPSILON_MS) this.fire(slot, now);
    this.arm(now);
  }

  private fire(slot: Slot, now: number): void {
    this.lastFireWall = slot.wall;
    this.lastGridWall = slot.gridWall;
    const { gate } = this.options.settings();
    const offAt = slot.wall + gate * this.intervalNow();
    for (const [pad, held] of [...this.pads]) {
      if (slot.wall < held.silentUntil) continue;
      this.sound(pad, pressureVelocity(held.pressure), offAt, now);
    }
  }

  /** One timer for the earliest of the next slot and the next off. */
  private arm(now: number): void {
    this.timers.clear(this.timer);
    this.timer = undefined;
    if (this.pads.size === 0) return;
    let due = this.nextSlot(now)?.wall ?? Infinity;
    for (const held of this.pads.values()) if (held.sounding) due = Math.min(due, held.offAt);
    if (due === Infinity) return;
    this.timer = this.timers.set(() => this.wake(), Math.max(0, due - now));
  }
}
