// The arpeggiator behind NOTE REPEAT in KEYBOARD and CHORDS (docs/mapping.md, "NOTE REPEAT"). No MIDI
// and no FL in here: the notes go out through an `ArpOutput`, the clock and the timers are
// injected (as in repeatScheduler.ts, whose grid it runs on), so the tests use a fake clock.
//
// - The held pads give a set of notes (KEYBOARD: the pad's note, CHORDS: every note of its chord).
//   `buildSteps` orders them by Type and extends them by Octaves (every note clamped to 127; a note
//   that clamping makes a duplicate sounds once). One step is one note, or all notes at once (Chord).
// - The steps play one per slot of the shared repeat grid: the engine is a single "pad" of the
//   RepeatScheduler (tempo-locked, SONG_POS-aligned, gate and swing as Note Repeat). The first note
//   sounds at the press, the rest on the grid. A pad pressed or released changes the set from the next
//   step on; the grid and the step counter go on.
// - HOLD: a released pad stays in the set; the first press after every pad was released starts a new
//   set. Turning HOLD off drops the pads that are not down. An empty set stops the grid.
// - Every note on has its off: the notes of a step end before the next step, at the gate, when the set
//   empties and on `stopAll`.
import {
  RepeatScheduler,
  type RepeatSettings,
  type RepeatTimers,
  type RepeatTiming,
} from "./repeatScheduler.js";

export type ArpType = "up" | "down" | "upDown" | "downUp" | "played" | "random" | "chord";

export interface ArpTypeInfo {
  id: ArpType;
  /** The name on the screen. */
  label: string;
}

/** In the order of knob 1. */
export const ARP_TYPES: readonly ArpTypeInfo[] = [
  { id: "up", label: "Up" },
  { id: "down", label: "Down" },
  { id: "upDown", label: "Up/Down" },
  { id: "downUp", label: "Down/Up" },
  { id: "played", label: "Played" },
  { id: "random", label: "Random" },
  { id: "chord", label: "Chord" },
];
export const isArpType = (value: unknown): value is ArpType =>
  ARP_TYPES.some((type) => type.id === value);

export const OCTAVES_MIN = 1;
export const OCTAVES_MAX = 4;

export interface ArpSettings extends RepeatSettings {
  type: ArpType;
  /** 1–4. */
  octaves: number;
}

export const DEFAULT_ARP_SETTINGS: ArpSettings = {
  rate: 2,
  gate: 0.5,
  swing: 0,
  type: "up",
  octaves: 1,
};

export interface ArpPreset {
  label: string;
  type: ArpType;
  rate: number;
  octaves: number;
  gate: number;
}

/** Display 5–8: Type, Rate, Octaves and Gate at once. */
export const ARP_PRESETS: readonly ArpPreset[] = [
  { label: "UP 16TH", type: "up", rate: 2, octaves: 1, gate: 0.5 },
  { label: "DOWN 16TH", type: "down", rate: 2, octaves: 1, gate: 0.5 },
  { label: "UP/DN 8TH", type: "upDown", rate: 1, octaves: 2, gate: 0.6 },
  { label: "RANDOM 16T", type: "random", rate: 5, octaves: 2, gate: 0.4 },
];

const GATE_TOLERANCE = 0.004;

/** Do the settings equal the preset (a gate within half a percent)? */
export const matchesPreset = (settings: ArpSettings, preset: ArpPreset): boolean =>
  settings.type === preset.type &&
  settings.rate === preset.rate &&
  settings.octaves === preset.octaves &&
  Math.abs(settings.gate - preset.gate) < GATE_TOLERANCE;

export const clampOctaves = (octaves: number): number =>
  Math.min(OCTAVES_MAX, Math.max(OCTAVES_MIN, Math.round(octaves)));

// ── Sequences ────────────────────────────────────────────────────────────────

/** A held pad: the notes it plays (in the order its chord has them), in press order. */
export interface ArpHeld {
  pad: number;
  notes: readonly number[];
  /** 1–127. */
  velocity: number;
}

/** One note of a step and the pad that owns it. */
export interface ArpNote {
  note: number;
  pad: number;
  velocity: number;
}
export type ArpStep = readonly ArpNote[];

const MAX_NOTE = 127;

/** The set of notes of the held pads without duplicates, ascending (or in press order). */
function pool(held: readonly ArpHeld[], inPressOrder: boolean): ArpNote[] {
  const seen = new Set<number>();
  const notes: ArpNote[] = [];
  for (const { pad, notes: padNotes, velocity } of held) {
    const own = inPressOrder ? [...padNotes].sort((a, b) => a - b) : padNotes;
    for (const note of own) {
      if (seen.has(note)) continue;
      seen.add(note);
      notes.push({ note, pad, velocity });
    }
  }
  return inPressOrder ? notes : notes.sort((a, b) => a.note - b.note);
}

/** The notes once per octave (the whole set, then an octave up ...), a duplicate once. */
function octaves(notes: readonly ArpNote[], count: number): ArpNote[] {
  const seen = new Set<number>();
  const result: ArpNote[] = [];
  for (let octave = 0; octave < count; octave++) {
    for (const entry of notes) {
      const note = Math.min(MAX_NOTE, entry.note + 12 * octave);
      if (seen.has(note)) continue;
      seen.add(note);
      result.push({ ...entry, note });
    }
  }
  return result;
}

/** Up/Down: up, then down without repeating the ends (1 2 3 4 3 2). */
const bounce = <T>(up: readonly T[]): T[] => [...up, ...[...up].reverse().slice(1, -1)];

/**
 * The steps of one round for the held pads (in press order), `type` and `octaves`. Random has no
 * order: its steps are the pool, ascending (the engine picks from them). Empty set = no steps.
 */
export function buildSteps(
  held: readonly ArpHeld[],
  type: ArpType,
  octaveCount: number,
): ArpStep[] {
  const count = clampOctaves(octaveCount);
  if (held.length === 0) return [];
  if (type === "chord") {
    const set = pool(held, false);
    return Array.from({ length: count }, (_, octave) => {
      const step = set.map((entry) => ({
        ...entry,
        note: Math.min(MAX_NOTE, entry.note + 12 * octave),
      }));
      return step.filter((entry, i) => step.findIndex((o) => o.note === entry.note) === i);
    });
  }
  const up = octaves(pool(held, type === "played"), count);
  let sequence: ArpNote[];
  switch (type) {
    case "down":
      sequence = [...up].reverse();
      break;
    case "upDown":
      sequence = bounce(up);
      break;
    case "downUp":
      sequence = bounce([...up].reverse());
      break;
    case "played":
      sequence = octaves(pool(held, true), count);
      break;
    default:
      sequence = up; // up and random
  }
  return sequence.map((entry) => [entry]);
}

// ── The engine ───────────────────────────────────────────────────────────────

export interface ArpOutput {
  on(note: number, velocity: number): void;
  off(note: number): void;
  /** The pads that play or are latched changed (a LED refresh). */
  changed?(): void;
}

export interface ArpOptions {
  output: ArpOutput;
  timing: () => RepeatTiming;
  settings: () => ArpSettings;
  /** Milliseconds; `performance.now()` by default. */
  clock?: () => number;
  timers?: RepeatTimers;
  /** 0 ≤ x < 1; `Math.random` by default. */
  random?: () => number;
}

interface Held extends ArpHeld {
  /** The pad is down now (a latched one is not). */
  down: boolean;
}

/** The engine is one "pad" of the scheduler. */
const GRID_PAD = 0;

export class Arpeggiator {
  private readonly scheduler: RepeatScheduler;
  private readonly random: () => number;
  private held: Held[] = [];
  private hold = false;
  /** The step the next slot plays. */
  private next = 0;
  /** The notes on now. */
  private sounding: number[] = [];
  private readonly playing = new Set<number>();
  /** The step that played last: its index in the round (for the screen). */
  private lastIndex = -1;
  private lastNote = -1;

  constructor(private readonly options: ArpOptions) {
    this.random = options.random ?? Math.random;
    this.scheduler = new RepeatScheduler({
      player: {
        on: () => this.play(),
        off: () => this.end(),
      },
      timing: options.timing,
      settings: options.settings,
      clock: options.clock,
      timers: options.timers,
    });
  }

  /** Is the arpeggiator running (a set to play)? */
  get active(): boolean {
    return this.scheduler.active;
  }

  get holding(): boolean {
    return this.hold;
  }

  /** Pads whose note sounds now (they flash). */
  get playingPads(): ReadonlySet<number> {
    return this.playing;
  }

  /** Pads in the set that are not down: HOLD keeps them. */
  get latchedPads(): readonly number[] {
    return this.held.filter((h) => !h.down).map((h) => h.pad);
  }

  /** Is the pad in the set? */
  has(pad: number): boolean {
    return this.held.some((h) => h.pad === pad);
  }

  /** A pad went down playing `notes` (`velocity` 1–127). */
  press(pad: number, notes: readonly number[], velocity: number): void {
    if (notes.length === 0) return;
    // HOLD: the first press after every pad was let go starts a new set.
    if (this.hold && this.held.length > 0 && this.held.every((h) => !h.down)) {
      this.held = [];
      this.next = 0;
    }
    this.held = this.held.filter((h) => h.pad !== pad);
    this.held.push({ pad, notes: [...notes], velocity, down: true });
    if (this.scheduler.active) this.options.output.changed?.();
    else {
      this.next = 0;
      this.scheduler.start(GRID_PAD, velocity, 0);
    }
  }

  /** A pad was let go: out of the set, or latched while HOLD is on. */
  release(pad: number): void {
    const held = this.held.find((h) => h.pad === pad);
    if (!held) return;
    if (this.hold) held.down = false;
    else this.held = this.held.filter((h) => h !== held);
    this.settle();
  }

  /** HOLD on or off. Off drops every pad that is not down; an empty set stops the arpeggiator. */
  setHold(on: boolean): void {
    if (on === this.hold) return;
    this.hold = on;
    if (!on) {
      this.held = this.held.filter((h) => h.down);
      this.settle();
    }
  }

  /** The tempo, the transport or a setting changed. */
  refresh(): void {
    this.scheduler.refresh();
  }

  /** Every note ends, the set is emptied, HOLD stays as it is. */
  stopAll(): void {
    this.held = [];
    this.next = 0;
    this.lastNote = -1;
    this.scheduler.stopAll();
    this.end();
    this.options.output.changed?.();
  }

  /** The steps of one round now (the current set, Type and Octaves). */
  steps(): ArpStep[] {
    const { type, octaves } = this.options.settings();
    return buildSteps(this.held, type, octaves);
  }

  /**
   * The notes to show: the round in order, and the indexes of the ones that played last (the
   * highlight stays until the next step; none while the arpeggiator is stopped).
   */
  view(): { notes: number[]; lit: Set<number> } {
    const steps = this.steps();
    const random = this.options.settings().type === "random";
    const notes: number[] = [];
    const lit = new Set<number>();
    steps.forEach((step, stepIndex) => {
      for (const entry of step) {
        const playedLast = random ? entry.note === this.lastNote : stepIndex === this.lastIndex;
        if (this.active && playedLast) lit.add(notes.length);
        notes.push(entry.note);
      }
    });
    return { notes, lit };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Nothing is held (or latched) any more: stop. Else the pads changed: refresh the LEDs. */
  private settle(): void {
    if (this.held.length === 0) {
      this.next = 0;
      this.lastNote = -1;
      this.scheduler.stop(GRID_PAD);
      this.end();
    }
    this.options.output.changed?.();
  }

  /** A slot: end the notes still on, play the next step. */
  private play(): void {
    this.end();
    const steps = this.steps();
    if (steps.length === 0) return;
    let index: number;
    if (this.options.settings().type === "random") {
      const others = steps.filter((step) => step[0]?.note !== this.lastNote);
      const choices = others.length > 0 ? others : steps;
      const choice =
        choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))];
      index = Math.max(0, steps.indexOf(choice as ArpStep));
    } else {
      index = this.next % steps.length;
      this.next = index + 1;
    }
    const step = steps[index] ?? [];
    this.lastIndex = index;
    for (const entry of step) {
      this.options.output.on(entry.note, entry.velocity);
      this.sounding.push(entry.note);
      this.playing.add(entry.pad);
    }
    this.lastNote = step[0]?.note ?? -1;
    this.options.output.changed?.();
  }

  /** Every note that is on ends. */
  private end(): void {
    if (this.sounding.length === 0 && this.playing.size === 0) return;
    for (const note of this.sounding) this.options.output.off(note);
    this.sounding = [];
    this.playing.clear();
    this.options.output.changed?.();
  }
}
