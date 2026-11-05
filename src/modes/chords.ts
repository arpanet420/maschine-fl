// Scales and chords for the KEYBOARD and CHORDS pages (docs/workflow.md, "Scales and chords"). Pure:
// no MIDI, no FL. The root of everything is the pad base note (PadState): pad 0 plays it.
//
// - KEYBOARD with a scale: pad i plays scale degree i counted up from the base note (octave wrap
//   included), Chromatic is `base + i` as it always was.
// - CHORDS, harmonizer, as Maschine's: each pad plays its KEYBOARD note and the notes stacked on it.
//   With a scale the stack is counted in the scale's own notes and named by its degrees (1-3-5 = 0, 2
//   and 4 scale steps up), so in a pentatonic scale 1-5 is not a perfect fifth (C gives C and A). With
//   Chromatic a step is a semitone, and the types are real intervals and chords (Perfect 5 = 7). The
//   type is kept for each of the two lists.
// - CHORDS, chord set: pads 1–7 the diatonic triads I…vii, 8 = I an octave up, 9–15 the diatonic
//   sevenths, 16 = I7 an octave up. The scale is the selected one when it has 7 notes, else Major.
// - Position = inversion: the lowest n notes move up an octave. All notes are clamped to MIDI 0–127
//   (and a note that clamping makes a duplicate sounds once).

export interface Scale {
  name: string;
  /** Semitones above the root, ascending, starting with 0. */
  intervals: readonly number[];
}

export const SCALES: readonly Scale[] = [
  { name: "Chromatic", intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { name: "Major", intervals: [0, 2, 4, 5, 7, 9, 11] },
  { name: "Minor", intervals: [0, 2, 3, 5, 7, 8, 10] },
  { name: "Harmonic minor", intervals: [0, 2, 3, 5, 7, 8, 11] },
  { name: "Melodic minor", intervals: [0, 2, 3, 5, 7, 9, 11] },
  { name: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10] },
  { name: "Phrygian", intervals: [0, 1, 3, 5, 7, 8, 10] },
  { name: "Lydian", intervals: [0, 2, 4, 6, 7, 9, 11] },
  { name: "Mixolydian", intervals: [0, 2, 4, 5, 7, 9, 10] },
  { name: "Locrian", intervals: [0, 1, 3, 5, 6, 8, 10] },
  { name: "Major pent.", intervals: [0, 2, 4, 7, 9] },
  { name: "Minor pent.", intervals: [0, 3, 5, 7, 10] },
  { name: "Blues", intervals: [0, 3, 5, 6, 7, 10] },
];
export const CHROMATIC = 0;
const MAJOR = 1;

export const clampNote = (note: number): number => Math.min(127, Math.max(0, note));
const mod = (value: number, by: number): number => ((value % by) + by) % by;

const scaleAt = (index: number): Scale => SCALES[index] ?? (SCALES[CHROMATIC] as Scale);

/** The note `degree` scale steps above `root` (unclamped; degree may be negative). */
export function scaleNote(root: number, scale: Scale, degree: number): number {
  const count = scale.intervals.length;
  const octave = Math.floor(degree / count);
  return root + 12 * octave + (scale.intervals[mod(degree, count)] ?? 0);
}

/** The note KEYBOARD's pad plays: scale degree `pad` from `base`, within MIDI 0–127. */
export const keyboardNote = (base: number, scaleIndex: number, pad: number): number =>
  clampNote(scaleNote(base, scaleAt(scaleIndex), pad));

/** Is the pad's note a root (an octave of the base note; a C in Chromatic, as the keyboard marks)? */
export function isRootDegree(scaleIndex: number, note: number, pad: number): boolean {
  if (scaleIndex === CHROMATIC) return mod(note, 12) === 0;
  return pad % scaleAt(scaleIndex).intervals.length === 0;
}

// ── Chord modes and types ────────────────────────────────────────────────────

export type ChordMode = "harmonizer" | "set";
export const CHORD_MODES: readonly ChordMode[] = ["harmonizer", "set"];
export const CHORD_MODE_NAMES: Record<ChordMode, string> = {
  harmonizer: "Harmonizer",
  set: "Chord set",
};

export interface ChordType {
  name: string;
  /** Steps up from the pad's note (a step is a note of the scale); `count` is the scale's size. */
  steps(count: number): readonly number[];
}

const OCTAVE: ChordType = { name: "Octave", steps: (count) => [0, count] };

/** A chord in semitones, for Chromatic. */
const semitones = (name: string, ...steps: number[]): ChordType => ({ name, steps: () => steps });

/** A stack named by its scale degrees: `1-3-5` is 0, 2 and 4 scale steps up. */
const degrees = (name: string): ChordType => {
  const steps = name.split("-").map((degree) => Number(degree) - 1);
  return { name, steps: () => steps };
};

/** The chord types of a scale. */
const SCALE_CHORDS: readonly ChordType[] = [
  OCTAVE,
  ...["1-3", "1-5", "1-3-5", "1-4-5", "1-3-5-7", "1-3-5-7-9", "1-4-7"].map(degrees),
];

/** The chord types of Chromatic: real intervals and chords. */
const CHROMATIC_CHORDS: readonly ChordType[] = [
  OCTAVE,
  semitones("Perf 4", 0, 5),
  semitones("Perf 5", 0, 7),
  semitones("Major", 0, 4, 7),
  semitones("Minor", 0, 3, 7),
  semitones("Sus 4", 0, 5, 7),
  semitones("Dim", 0, 3, 6),
  semitones("Aug", 0, 4, 8),
  semitones("Maj 7", 0, 4, 7, 11),
  semitones("Min 7", 0, 3, 7, 10),
  semitones("Dom 7", 0, 4, 7, 10),
  semitones("Min 7b5", 0, 3, 6, 10),
  semitones("Dim 7", 0, 3, 6, 9),
  semitones("Maj 9", 0, 4, 7, 11, 14),
  semitones("Dom 9", 0, 4, 7, 10, 14),
  semitones("Quartal", 0, 5, 10, 15),
  semitones("Trichord", 0, 5, 11),
];

/** The chord types the knob steps through with this scale. */
export const chordTypes = (scaleIndex: number): readonly ChordType[] =>
  scaleIndex === CHROMATIC ? CHROMATIC_CHORDS : SCALE_CHORDS;

const DEFAULT_SCALE_TYPE = SCALE_CHORDS.findIndex((type) => type.name === "1-3-5");
const DEFAULT_CHROMATIC_TYPE = CHROMATIC_CHORDS.findIndex((type) => type.name === "Major");
const defaultType = (scaleIndex: number): number =>
  scaleIndex === CHROMATIC ? DEFAULT_CHROMATIC_TYPE : DEFAULT_SCALE_TYPE;

const TRIAD = [0, 2, 4] as const;
const SEVENTH = [0, 2, 4, 6] as const;

/** The highest position of chord set: its sevenths have 4 notes. */
const SET_MAX_POSITION = 3;

/** Move the lowest `position` notes of an ascending chord up an octave (clamped to its notes − 1). */
export function invert(notes: readonly number[], position: number): number[] {
  const result = [...notes];
  const count = Math.min(Math.max(0, Math.round(position)), result.length - 1);
  for (let i = 0; i < count; i++) {
    const lowest = result.shift();
    if (lowest !== undefined) result.push(lowest + 12);
  }
  return result;
}

// ── Names ────────────────────────────────────────────────────────────────────

// Flats are written with `b`: Barlow, FL's UI font, has no ♭ glyph (the ° of a diminished chord exists).
const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;
const FLAT = "b";
const DIM = "°";

/** A pitch class's name, flats for the black keys. */
export const pitchName = (note: number): string => NAMES[mod(note, 12)] ?? "C";

/** The suffix of a chord from its intervals above the root; `?` for a stack with no name. */
export function chordQuality(intervals: readonly number[]): string {
  const [, i1 = 0, i2 = 0, i3, i4] = intervals;
  const flat = FLAT;
  const dim = DIM;
  if (intervals.length === 2) {
    if (i1 === 12) return " oct";
    return i1 === 7 ? "5" : i1 === 6 ? `5${flat}` : i1 === 8 ? "5#" : "?";
  }
  let triad: string;
  if (i1 === 4 && i2 === 7) triad = "";
  else if (i1 === 3 && i2 === 7) triad = "m";
  else if (i1 === 3 && i2 === 6) triad = dim;
  else if (i1 === 4 && i2 === 8) triad = "+";
  else if (i1 === 5 && i2 === 7) triad = "sus4";
  else if (i1 === 2 && i2 === 7) triad = "sus2";
  else return "?";
  if (i3 === undefined) return triad;
  let name: string;
  if (triad === "" && i3 === 11) name = "maj7";
  else if (triad === "" && i3 === 10) name = "7";
  else if (triad === "m" && i3 === 10) name = "m7";
  else if (triad === "m" && i3 === 11) name = "mmaj7";
  else if (triad === dim && i3 === 10) name = `m7${flat}5`;
  else if (triad === dim && i3 === 9) name = `${dim}7`;
  else if (triad === "+" && i3 === 10) name = "7#5";
  else if (triad === "+" && i3 === 11) name = "maj7#5";
  else name = `${triad}${i3 === 11 ? "maj7" : i3 === 10 ? "7" : "6"}`;
  if (i4 === undefined) return name;
  // a ninth replaces the 7 of the seventh chord's name (maj9, 9, m9); a lowered or raised one is added
  if (i4 === 14) return name.replace("7", "9");
  return `${name}${i4 === 13 ? `${flat}9` : "#9"}`;
}

/**
 * A chord's name from its notes in root position: `Cm`, `D°`, `Ebmaj7`. A stack with no name (a 1-4-5
 * on the fourth degree of Major, most stacks in a pentatonic scale) shows its notes: `F B C`.
 */
export function chordName(rootPosition: readonly number[]): string {
  const root = rootPosition[0];
  if (root === undefined) return "";
  const quality = chordQuality(rootPosition.map((note) => note - root));
  return quality === "?"
    ? rootPosition.map((note) => pitchName(note)).join(" ")
    : `${pitchName(root)}${quality}`;
}

// ── Pad -> notes ─────────────────────────────────────────────────────────────

export interface Chord {
  /** Ascending, inverted by the position, within 0–127, no duplicates. */
  notes: number[];
  name: string;
  /** The chord of a root pad (a root of the scale, or a I chord in chord set). */
  root: boolean;
}

export interface PadMusic {
  base: number;
  scale: number;
  mode: ChordMode;
  type: number;
  position: number;
}

const finish = (notes: readonly number[], position: number): number[] => {
  const clamped = invert(notes, position).map(clampNote);
  return [...new Set(clamped)].sort((a, b) => a - b);
};

/** The chord a pad plays now, in harmonizer or chord set mode. `pad` is 0–15. */
export function chordAt(music: PadMusic, pad: number): Chord {
  const { base, scale: scaleIndex } = music;
  if (music.mode === "set") {
    const scale = scaleAt(scaleIndex);
    const sc = scale.intervals.length === 7 ? scale : scaleAt(MAJOR);
    const octave = pad === 7 || pad === 15;
    const sevenths = pad >= 8;
    const degree = octave ? sc.intervals.length : pad % 8;
    const steps = sevenths ? SEVENTH : TRIAD;
    const stack = steps.map((step) => scaleNote(base, sc, degree + step));
    return {
      notes: finish(stack, music.position),
      name: chordName(stack),
      root: pad % 8 === 0 || octave,
    };
  }
  const sc = scaleAt(scaleIndex);
  const stack = typeAt(scaleIndex, music.type)
    .steps(sc.intervals.length)
    .map((step) => scaleNote(base, sc, pad + step));
  const padNote = keyboardNote(base, scaleIndex, pad);
  return {
    notes: finish(stack, music.position),
    name: chordName(stack),
    root: isRootDegree(scaleIndex, padNote, pad),
  };
}

/** The chord type at `index` of the scale's list, the list's default if there is none. */
const typeAt = (scaleIndex: number, index: number): ChordType => {
  const types = chordTypes(scaleIndex);
  return types[index] ?? (types[defaultType(scaleIndex)] as ChordType);
};

/** What the scale of the chord set is: the selected scale if it has 7 notes, else Major. */
export function chordSetScale(scaleIndex: number): Scale {
  const scale = scaleAt(scaleIndex);
  return scale.intervals.length === 7 ? scale : scaleAt(MAJOR);
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** Knob counts per step of a stepped value (the same detent as NOTE REPEAT's rate). */
export const STEP_COUNTS = 120;

const wholeIn = (value: unknown, count: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < count
    ? value
    : undefined;

/**
 * Scale, chord mode, chord type and position: shared by KEYBOARD and CHORDS. All but the scale are saved with
 * the pages; every start of mk3d begins on Chromatic (the owner's call, 2026-11-05).
 */
export class HarmonySettings {
  scale = CHROMATIC;
  mode: ChordMode = "harmonizer";
  position = 0;
  /** The chord type kept for each list: Chromatic's, and the one of the other scales. */
  private chromaticType = DEFAULT_CHROMATIC_TYPE;
  private scaleType = DEFAULT_SCALE_TYPE;
  private readonly turns = [0, 0, 0, 0];

  /** The chord type, an index in `types`. */
  get type(): number {
    return this.scale === CHROMATIC ? this.chromaticType : this.scaleType;
  }

  private set type(index: number) {
    if (this.scale === CHROMATIC) this.chromaticType = index;
    else this.scaleType = index;
  }

  /** The chord types the knob steps through now. */
  get types(): readonly ChordType[] {
    return chordTypes(this.scale);
  }

  /** The highest position now: notes − 1 of the chord type, 3 for chord set (its sevenths). */
  get maxPosition(): number {
    if (this.mode === "set") return SET_MAX_POSITION;
    return typeAt(this.scale, this.type).steps(scaleAt(this.scale).intervals.length).length - 1;
  }

  /** The type knob does something now (not in chord set). */
  get typeActive(): boolean {
    return this.mode === "harmonizer";
  }

  /**
   * A knob turn of `counts`: 0 scale, 1 chord mode, 2 chord type, 3 position. True if the value
   * changed. A turn smaller than a detent adds up.
   */
  turn(knob: number, counts: number): boolean {
    if (knob < 0 || knob > 3) return false;
    if (knob === 2 && !this.typeActive) return false;
    this.turns[knob] = (this.turns[knob] ?? 0) + counts;
    const steps = Math.trunc((this.turns[knob] ?? 0) / STEP_COUNTS);
    if (steps === 0) return false;
    this.turns[knob] = (this.turns[knob] ?? 0) - steps * STEP_COUNTS;
    const before = this.snapshot();
    if (knob === 0) this.scale = Math.min(SCALES.length - 1, Math.max(0, this.scale + steps));
    else if (knob === 1) {
      this.mode =
        CHORD_MODES[Math.min(1, Math.max(0, CHORD_MODES.indexOf(this.mode) + steps))] ?? this.mode;
    } else if (knob === 2) {
      this.type = Math.min(this.types.length - 1, Math.max(0, this.type + steps));
    } else this.position += steps;
    this.position = Math.min(this.maxPosition, Math.max(0, this.position));
    return before !== this.snapshot();
  }

  private snapshot(): string {
    return `${this.scale}/${this.mode}/${this.type}/${this.position}`;
  }

  /** Chord types are saved by name: an index would change meaning if a list changes. */
  readonly persisted = {
    save: () => ({
      mode: this.mode,
      scaleType: SCALE_CHORDS[this.scaleType]?.name,
      chromaticType: CHROMATIC_CHORDS[this.chromaticType]?.name,
      position: this.position,
    }),
    load: (data: unknown) => {
      const saved = data as Record<string, unknown> | null;
      const named = (types: readonly ChordType[], name: unknown, fallback: number): number => {
        const index = types.findIndex((type) => type.name === name);
        return index >= 0 ? index : fallback;
      };
      this.scale = CHROMATIC;
      this.mode = CHORD_MODES.find((mode) => mode === saved?.mode) ?? "harmonizer";
      this.scaleType = named(SCALE_CHORDS, saved?.scaleType, DEFAULT_SCALE_TYPE);
      this.chromaticType = named(CHROMATIC_CHORDS, saved?.chromaticType, DEFAULT_CHROMATIC_TYPE);
      this.position = Math.min(this.maxPosition, wholeIn(saved?.position, 8) ?? 0);
    },
  };
}
