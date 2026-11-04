// The clock behind NOTE REPEAT (docs/workflow.md): which notes repeat, when, and for how long.
// No MIDI and no FL in here: the notes go out through a `RepeatPlayer`, the tempo and the song
// position come from a `timing` function, and the clock and the timers are injected, so the tests
// run it on a fake clock.
//
// - All held pads share one grid (a slot every `interval`), not a phase each.
// - While FL plays, a hit goes on the grid the way Maschine's Input Quantize treats played notes: in
//   the first half of a slot it sounds at once and counts as that slot, in the second half it waits
//   for the next slot (a pad let go before that still plays its one note). So the repeats, and the
//   gap to the first one, are never shorter than half an interval. While FL is stopped the press is
//   the grid's origin. A pad joining a running free grid sounds at once.
// - Slot `n` sits `n × interval` after the grid's origin; every odd slot is delayed by `swing ×
//   interval`. The note's off follows `gate × interval` after its on; before every on, a note that
//   still sounds is ended first, so every on has an off.
// - While FL plays (and SONG_POS is fresh) the origin is bar 1; a rate that does not fit a bar
//   (dotted, 1/4T) starts where it was first needed instead (`anchorUnit`), so a press on a beat gets
//   a rhythm from that beat. While FL is stopped the grid runs free from the press. The grid is kept
//   in beats, so a tempo change moves the next slot, not the phase.
// - The position is a running estimate, not the last SONG_POS. A SONG_POS can only arrive late (FL's
//   UI thread and the MIDI port add 0 to tens of ms, different every time), and taking each one as
//   the truth moved every note by that difference. So the estimate runs on the tempo and follows the
//   earliest arrivals: a reading ahead of it corrects it at once, one behind it only slowly. A
//   reading far off counts only when the next one agrees (a loop restart or a jump, not a stall).
// - One timer is always set to the next due thing (a slot or an off) from absolute target times; a
//   slot that is late by more than half an interval is skipped, never played in a burst.
import type { SongPosition } from "../fl/sysex.js";

export type RateFeel = "straight" | "dotted" | "triplet";

export interface RepeatRate {
  label: string;
  /** The note value: 4 = a quarter note. */
  denominator: number;
  feel: RateFeel;
}

/** A rate's place here is what the page state saves, so new rates go last. */
export const REPEAT_RATES: readonly RepeatRate[] = [
  { label: "1/4", denominator: 4, feel: "straight" },
  { label: "1/8", denominator: 8, feel: "straight" },
  { label: "1/16", denominator: 16, feel: "straight" },
  { label: "1/32", denominator: 32, feel: "straight" },
  { label: "1/8T", denominator: 8, feel: "triplet" },
  { label: "1/16T", denominator: 16, feel: "triplet" },
  { label: "1/32T", denominator: 32, feel: "triplet" },
  { label: "1/4T", denominator: 4, feel: "triplet" },
  { label: "1/4D", denominator: 4, feel: "dotted" },
  { label: "1/8D", denominator: 8, feel: "dotted" },
  { label: "1/16D", denominator: 16, feel: "dotted" },
  { label: "1/32D", denominator: 32, feel: "dotted" },
];

/** The note values, in the order of NOTE REPEAT's display buttons 5–8 and of the Rate knob. */
export const RATE_VALUES: readonly number[] = [4, 8, 16, 32];
/** In the order of the Unit knob. */
export const RATE_FEELS: readonly RateFeel[] = ["straight", "dotted", "triplet"];
export const FEEL_LABELS: Record<RateFeel, string> = {
  straight: "Normal",
  dotted: "Dotted",
  triplet: "Triplet",
};

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
/** A reading behind the running estimate pulls it back by this share (each arrives every 50 ms). */
const LATE_GAIN = 0.005;
/** A reading further off than this is a jump (once the next one agrees) or a stall. */
const JUMP_MS = 80;
/** Two jump readings within this of each other agree. */
const JUMP_AGREE_MS = 30;
const EPSILON_MS = 1e-6;

export const clampRate = (rate: number): number =>
  Math.min(REPEAT_RATES.length - 1, Math.max(0, Math.round(rate)));

const rateOf = (rate: number): RepeatRate =>
  REPEAT_RATES[clampRate(rate)] ?? REPEAT_RATES[DEFAULT_RATE]!;

const FEEL_FACTOR: Record<RateFeel, number> = { straight: 1, dotted: 3 / 2, triplet: 2 / 3 };

/** Beats between repeats: a 1/16 is a quarter of a beat, a triplet 2/3 of that, a dotted one 3/2. */
export function intervalBeats(rate: number): number {
  const { denominator, feel } = rateOf(rate);
  return (4 / denominator) * FEEL_FACTOR[feel];
}

export const rateFeel = (rate: number): RateFeel => rateOf(rate).feel;
export const rateValue = (rate: number): number => rateOf(rate).denominator;

/** The rate with this note value and feel. */
export function rateIndex(denominator: number, feel: RateFeel): number {
  const index = REPEAT_RATES.findIndex((r) => r.denominator === denominator && r.feel === feel);
  return index >= 0 ? index : DEFAULT_RATE;
}

/** `rate` with its note value moved `steps` along the knob, stopping at the ends; the feel stays. */
export function stepRate(rate: number, steps: number): number {
  const place = RATE_VALUES.indexOf(rateValue(rate)) + steps;
  const value = RATE_VALUES[Math.min(RATE_VALUES.length - 1, Math.max(0, place))] ?? 16;
  return rateIndex(value, rateFeel(rate));
}

/** `rate` with its unit (Normal, Dotted, Triplet) moved `steps` along the knob. */
export function stepFeel(rate: number, steps: number): number {
  const place = RATE_FEELS.indexOf(rateFeel(rate)) + steps;
  const feel = RATE_FEELS[Math.min(RATE_FEELS.length - 1, Math.max(0, place))] ?? "straight";
  return rateIndex(rateValue(rate), feel);
}

/** Where the rate's note value and its unit sit on their knobs, 0–1. */
export const ratePosition = (rate: number): number =>
  RATE_VALUES.indexOf(rateValue(rate)) / (RATE_VALUES.length - 1);
export const feelPosition = (rate: number): number =>
  RATE_FEELS.indexOf(rateFeel(rate)) / (RATE_FEELS.length - 1);

/**
 * What a rate's song grid starts from, in beats. 0 = bar 1: the rate fits every bar. A dotted rate
 * or 1/4T comes back to the bar only after several, so bar 1 would put its slots anywhere; its grid
 * starts at the press, rounded to this unit (the straight value under a dotted one, a beat for 1/4T).
 */
export function anchorUnit(rate: number): number {
  const { denominator, feel } = rateOf(rate);
  if (feel === "dotted") return 4 / denominator / 2;
  return feel === "triplet" && denominator === 4 ? 1 : 0;
}

/** Milliseconds between repeats: 60 / BPM × `intervalBeats`. */
export function intervalMs(bpm: number, rate: number): number {
  const tempo = bpm > 0 ? bpm : FALLBACK_BPM;
  return (60000 / tempo) * intervalBeats(rate);
}

/** SONG_POS in beats from bar 1 (a bar is 4 beats); `ppq` is the project's ticks per beat. */
export function songBeats(pos: SongPosition, ppq = TICKS_PER_STEP * 4): number {
  const steps = (pos.bar - 1) * STEPS_PER_BAR + (pos.step - 1);
  return steps / (STEPS_PER_BAR / 4) + pos.tick / ppq;
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
  /** A pad let go before its first note (`release`) has played that note. */
  ended?(pad: number): void;
}

/** One slot as it played, for MK3D_REPEAT_LOG. */
export interface RepeatTrace {
  n: number;
  /** How long after the slot's time it played, ms. */
  lateMs: number;
  /** Since the slot before played, ms: what the ear gets. */
  gapMs: number;
  /** The grid's position of this slot, beats; undefined while free running. */
  beats: number | undefined;
  /** The last SONG_POS against the running estimate, ms (late readings are negative). */
  readingMs: number;
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
  trace?: (slot: RepeatTrace) => void;
}

interface PadRepeat {
  /** 0–1, from the pad's aftertouch. */
  pressure: number;
  sounding: boolean;
  /** When its note ends (the clock's ms). */
  offAt: number;
  /** No grid slot before this plays for the pad (it was just hit). */
  silentUntil: number;
  /** The hit's velocity while the first note waits for its slot. */
  firstVelocity: number | undefined;
  /** Let go while the first note waited: one note, then it is gone. */
  released: boolean;
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
  /** The tempo the reference has been advanced with. */
  private refBpm = FALLBACK_BPM;
  /** Slot `n` is `n` intervals after this position (beats). */
  private anchor = 0;
  /** The SONG_POS the song estimate last took in, and its offset if that looked like a jump. */
  private lastPosAt = -Infinity;
  private jumpMs: number | undefined;
  private readingMs = 0;
  private lastRate = DEFAULT_RATE;
  private lastFireWall = -Infinity;
  private lastGridWall = 0;
  private lastTraceAt = -Infinity;
  /** The last slot played, while its number means the same: a tempo change moves its time back. */
  private lastFireN = -Infinity;

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

  /** Does the pad's first note still wait for its slot? */
  isWaiting(pad: number): boolean {
    return this.pads.get(pad)?.firstVelocity !== undefined;
  }

  /** A pad went down: sound it (`velocity` 1–127, `pressure` 0–1) and repeat it. */
  start(pad: number, velocity: number, pressure: number): void {
    const now = this.clock();
    this.stop(pad);
    const first = this.pads.size === 0;
    if (first) this.begin(now);
    this.sync(now);
    const interval = this.intervalNow();
    const held: PadRepeat = {
      pressure,
      sounding: false,
      offAt: now,
      silentUntil: now + MIN_GAP * interval,
      firstVelocity: undefined,
      released: false,
    };
    this.pads.set(pad, held);
    if (this.mode === "song") {
      const place = (this.beatsAt(now) - this.anchor) / intervalBeats(this.options.settings().rate);
      const slot = Math.floor(place);
      held.silentUntil = now;
      if (first) {
        // This slot counts as played, whichever way the hit goes.
        this.lastFireWall = this.slotWall(slot, true);
        this.lastGridWall = this.slotWall(slot, false);
        this.lastFireN = slot;
      }
      if (place - slot >= 0.5) {
        held.firstVelocity = velocity;
        this.arm(now);
        return;
      }
    }
    this.sound(pad, velocity, now + this.options.settings().gate * interval, now);
    this.arm(now);
  }

  /**
   * The pad was let go. If its first note still waits, it plays on its slot and `ended` follows:
   * returns true, and the pad stays until then. Otherwise this is `stop`.
   */
  release(pad: number): boolean {
    const held = this.pads.get(pad);
    if (held?.firstVelocity !== undefined) {
      held.released = true;
      return true;
    }
    this.stop(pad);
    return false;
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

  /** The tempo, the transport, the position or a setting changed: plan again (due things happen now). */
  refresh(): void {
    if (this.pads.size === 0) {
      // Keep the song estimate running, so the next press finds it settled.
      if (!this.followSong(this.clock()) && this.mode === "song") this.mode = undefined;
      return;
    }
    this.timers.clear(this.timer);
    this.timer = undefined;
    this.wake();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private idle(): void {
    this.timers.clear(this.timer);
    this.timer = undefined;
    if (this.mode === "free") this.mode = undefined;
  }

  /** The first pad: the free grid starts here (slot 0 is the press). */
  private begin(now: number): void {
    if (this.mode === "song") this.anchorHere(now);
    else this.mode = undefined;
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
    const { rate } = this.options.settings();
    if (!this.followSong(now)) {
      if (this.mode !== "free" || rate !== this.lastRate) {
        // Stopped (or FL went quiet), or another rate: the grid restarts at the last slot.
        this.mode = "free";
        this.refAt = this.lastGridWall;
        this.refBeats = 0;
        this.anchor = 0;
        this.lastFireN = -Infinity;
      } else {
        this.refBeats += ((now - this.refAt) * this.refBpm) / 60000;
        this.refAt = now;
      }
      this.refBpm = this.bpm();
    }
    this.lastRate = rate;
  }

  /** The running song estimate: false while FL is not playing or SONG_POS is stale. */
  private followSong(now: number): boolean {
    const timing = this.options.timing();
    const pos = timing.songPos;
    if (!timing.playing || !pos || now - pos.at > SONG_POS_STALE_MS || pos.at > now + 1) {
      return false;
    }
    const bpm = this.bpm();
    if (this.mode !== "song" || pos.at - this.lastPosAt > SONG_POS_STALE_MS) {
      this.mode = "song";
      this.setSongRef(pos, bpm);
      this.anchorHere(now);
      return true;
    }
    this.refBeats += ((now - this.refAt) * this.refBpm) / 60000;
    this.refAt = now;
    this.refBpm = bpm;
    if (pos.at !== this.lastPosAt) this.takeReading(pos, bpm, now);
    if (this.options.settings().rate !== this.lastRate) this.anchorHere(now);
    return true;
  }

  private setSongRef(pos: { beats: number; at: number }, bpm: number): void {
    this.refAt = pos.at;
    this.refBeats = pos.beats;
    this.refBpm = bpm;
    this.lastPosAt = pos.at;
    this.jumpMs = undefined;
    this.readingMs = 0;
    this.lastFireN = -Infinity;
  }

  /** A new SONG_POS against the estimate: see the top of this file. */
  private takeReading(pos: { beats: number; at: number }, bpm: number, now: number): void {
    this.lastPosAt = pos.at;
    const msPerBeat = 60000 / bpm;
    const estimate = this.refBeats - (now - pos.at) / msPerBeat;
    const offMs = (pos.beats - estimate) * msPerBeat;
    this.readingMs = offMs;
    if (Math.abs(offMs) > JUMP_MS) {
      if (this.jumpMs === undefined || Math.abs(offMs - this.jumpMs) > JUMP_AGREE_MS) {
        this.jumpMs = offMs;
        return;
      }
      this.setSongRef(pos, bpm);
      this.anchorHere(now);
      return;
    }
    this.jumpMs = undefined;
    this.refBeats += ((offMs > 0 ? 1 : LATE_GAIN) * offMs) / msPerBeat;
  }

  /** The song grid of the current rate starts here (no change for a rate that fits the bar). */
  private anchorHere(now: number): void {
    this.lastFireN = -Infinity;
    const unit = anchorUnit(this.options.settings().rate);
    this.anchor = unit > 0 ? Math.round(this.beatsAt(now) / unit) * unit : 0;
  }

  private beatsAt(now: number): number {
    return this.refBeats + ((now - this.refAt) * this.bpm()) / 60000;
  }

  private slotWall(n: number, swing: boolean): number {
    const { rate, swing: amount } = this.options.settings();
    const beats =
      this.anchor +
      n * intervalBeats(rate) +
      (swing && Math.abs(n) % 2 === 1 ? amount * intervalBeats(rate) : 0);
    return this.refAt + ((beats - this.refBeats) * 60000) / this.bpm();
  }

  /** The next slot worth playing: after the last one, and not more than half an interval late. */
  private nextSlot(now: number): Slot | undefined {
    const { rate } = this.options.settings();
    const interval = this.intervalNow();
    let n = Math.floor((this.beatsAt(now) - this.anchor) / intervalBeats(rate)) - 2;
    for (let i = 0; i < 24; i++, n++) {
      if (n <= this.lastFireN) continue;
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
        if (held.released) {
          this.pads.delete(pad);
          this.options.player.ended?.(pad);
        }
      }
    }
    if (this.pads.size === 0) {
      this.idle();
      return;
    }
    const slot = this.nextSlot(now);
    if (slot && slot.wall <= now + EPSILON_MS) this.fire(slot, now);
    this.arm(now);
  }

  private fire(slot: Slot, now: number): void {
    this.options.trace?.({
      n: slot.n,
      lateMs: now - slot.wall,
      gapMs: now - this.lastTraceAt,
      beats:
        this.mode === "song"
          ? this.anchor + slot.n * intervalBeats(this.options.settings().rate)
          : undefined,
      readingMs: this.readingMs,
    });
    this.lastTraceAt = now;
    this.lastFireN = slot.n;
    this.lastFireWall = slot.wall;
    this.lastGridWall = slot.gridWall;
    const { gate } = this.options.settings();
    const offAt = slot.wall + gate * this.intervalNow();
    for (const [pad, held] of [...this.pads]) {
      if (slot.wall < held.silentUntil) continue;
      this.sound(pad, held.firstVelocity ?? pressureVelocity(held.pressure), offAt, now);
      held.firstVelocity = undefined;
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
