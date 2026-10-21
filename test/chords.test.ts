import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHORD_TYPES,
  CHROMATIC,
  HarmonySettings,
  SCALES,
  chordAt,
  chordName,
  invert,
  keyboardNote,
  scaleNote,
  type PadMusic,
} from "../src/modes/chords.js";
import { flColorToPalette } from "../src/modes/format.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempPins = () => {
  const dir = mkdtempSync(join(tmpdir(), "mk3d-chords-"));
  dirs.push(dir);
  return join(dir, "pages.json");
};

const scaleIndex = (name: string) => SCALES.findIndex((scale) => scale.name === name);
const typeIndex = (name: string) => CHORD_TYPES.findIndex((type) => type.name === name);
const music = (patch: Partial<PadMusic> = {}): PadMusic => ({
  base: 36,
  scale: scaleIndex("Minor"),
  mode: "harmonizer",
  type: typeIndex("Triad"),
  position: 0,
  ...patch,
});
const notesOf = (patch: Partial<PadMusic>, pad: number) => chordAt(music(patch), pad).notes;
const nameOf = (patch: Partial<PadMusic>, pad: number) => chordAt(music(patch), pad).name;

/** Note ons and offs as ["on" | "off", note, velocity]. */
const noteEvents = (h: StackHarness) =>
  h.midi
    .filter((bytes) => [0x80, 0x90].includes((bytes[0] ?? 0) & 0xf0))
    .map((bytes) => [((bytes[0] ?? 0) & 0xf0) === 0x90 ? "on" : "off", bytes[1], bytes[2]]);
const onNotes = (h: StackHarness) =>
  noteEvents(h)
    .filter((e) => e[0] === "on")
    .map((e) => e[1]);

/** Turn a stepped knob by `steps` detents (120 counts each). */
const step = (h: StackHarness, knob: number, steps: number) => h.knob(knob, steps * 120);

describe("scale degrees", () => {
  it("Chromatic is base + pad, as before", () => {
    for (let pad = 0; pad < 16; pad++) expect(keyboardNote(36, CHROMATIC, pad)).toBe(36 + pad);
    expect(keyboardNote(112, CHROMATIC, 15)).toBe(127);
  });

  it("every scale plays its intervals from the base note and wraps by octaves", () => {
    for (const scale of SCALES) {
      const count = scale.intervals.length;
      for (let degree = 0; degree < 2 * count + 1; degree++) {
        const expected =
          36 + 12 * Math.floor(degree / count) + (scale.intervals[degree % count] ?? 0);
        expect(scaleNote(36, scale, degree)).toBe(expected);
      }
    }
  });

  it("the pads of Minor, Major pent. and Blues from C3", () => {
    const pads = (name: string) =>
      Array.from({ length: 16 }, (_, pad) => keyboardNote(36, scaleIndex(name), pad));
    expect(pads("Minor")).toEqual([36, 38, 39, 41, 43, 44, 46, 48, 50, 51, 53, 55, 56, 58, 60, 62]);
    expect(pads("Major pent.").slice(0, 7)).toEqual([36, 38, 40, 43, 45, 48, 50]);
    expect(pads("Blues").slice(0, 8)).toEqual([36, 39, 41, 42, 43, 46, 48, 51]);
  });

  it("clamps to 0–127", () => {
    expect(keyboardNote(112, scaleIndex("Major"), 15)).toBe(127);
    expect(keyboardNote(112, scaleIndex("Major"), 7)).toBe(124);
    expect(keyboardNote(0, scaleIndex("Major"), 0)).toBe(0);
  });

  it("knows 13 scales, Chromatic first", () => {
    expect(SCALES.map((scale) => scale.name)).toEqual([
      "Chromatic",
      "Major",
      "Minor",
      "Harmonic minor",
      "Melodic minor",
      "Dorian",
      "Phrygian",
      "Lydian",
      "Mixolydian",
      "Locrian",
      "Major pent.",
      "Minor pent.",
      "Blues",
    ]);
  });
});

describe("harmonizer", () => {
  it("stacks the chord types inside the scale on the pad's degree", () => {
    const at = (type: string, pad = 0) => notesOf({ type: typeIndex(type) }, pad);
    expect(at("Octave")).toEqual([36, 48]);
    expect(at("Fifth")).toEqual([36, 43]);
    expect(at("Triad")).toEqual([36, 39, 43]);
    expect(at("Sus4")).toEqual([36, 41, 43]);
    expect(at("Seventh")).toEqual([36, 39, 43, 46]);
    expect(at("Ninth")).toEqual([36, 39, 43, 46, 50]);
    expect(at("Triad", 1)).toEqual([38, 41, 44]); // D diminished in C minor
    expect(at("Triad", 2)).toEqual([39, 43, 46]);
    expect(at("Triad", 7)).toEqual([48, 51, 55]); // the octave root again
  });

  it("Chromatic stacks the major scale from the pad's note", () => {
    const chromatic = { scale: CHROMATIC };
    expect(notesOf(chromatic, 0)).toEqual([36, 40, 43]);
    expect(notesOf(chromatic, 1)).toEqual([37, 41, 44]);
    expect(notesOf({ ...chromatic, type: typeIndex("Ninth") }, 0)).toEqual([36, 40, 43, 47, 50]);
    expect(notesOf({ ...chromatic, type: typeIndex("Octave") }, 5)).toEqual([41, 53]);
  });

  it("inversions move the lowest notes up an octave, clamped to the chord's notes − 1", () => {
    expect(notesOf({ position: 1 }, 0)).toEqual([39, 43, 48]);
    expect(notesOf({ position: 2 }, 0)).toEqual([43, 48, 51]);
    expect(notesOf({ position: 5 }, 0)).toEqual([43, 48, 51]);
    expect(invert([60, 64, 67, 71], 3)).toEqual([71, 72, 76, 79]);
    expect(invert([60, 64], 0)).toEqual([60, 64]);
  });

  it("clamps every note to 0–127 and plays a note that collides once", () => {
    expect(notesOf({ base: 112, scale: scaleIndex("Major") }, 15)).toEqual([127]);
    expect(notesOf({ base: 112, scale: scaleIndex("Major"), position: 1 }, 3)).toEqual([
      121, 124, 127,
    ]);
    expect(notesOf({ base: 0, scale: CHROMATIC, type: typeIndex("Fifth") }, 0)).toEqual([0, 7]);
  });

  it("names the chord from its notes in root position", () => {
    expect(nameOf({}, 0)).toBe("Cm");
    expect(nameOf({}, 1)).toBe("D°");
    expect(nameOf({}, 2)).toBe("Eb");
    expect(nameOf({ type: typeIndex("Seventh") }, 2)).toBe("Ebmaj7");
    expect(nameOf({ type: typeIndex("Seventh") }, 1)).toBe("Dm7b5");
    expect(nameOf({ type: typeIndex("Seventh") }, 6)).toBe("Bb7");
    expect(nameOf({ type: typeIndex("Ninth") }, 0)).toBe("Cm9");
    expect(nameOf({ type: typeIndex("Sus4") }, 0)).toBe("Csus4");
    expect(nameOf({ type: typeIndex("Fifth") }, 0)).toBe("C5");
    expect(nameOf({ type: typeIndex("Octave") }, 0)).toBe("C oct");
    expect(nameOf({ position: 1 }, 0)).toBe("Cm"); // an inversion keeps the name
    expect(nameOf({ scale: CHROMATIC, type: typeIndex("Ninth") }, 0)).toBe("Cmaj9");
    expect(chordName([60, 64, 68])).toBe("C+");
    expect(chordName([60, 63, 66, 69])).toBe("C°7");
  });

  it("root pads are the roots of the scale (the C notes in Chromatic)", () => {
    const roots = (patch: Partial<PadMusic>) =>
      Array.from({ length: 16 }, (_, pad) => chordAt(music(patch), pad).root);
    expect(roots({}).flatMap((root, pad) => (root ? [pad] : []))).toEqual([0, 7, 14]);
    expect(roots({ scale: CHROMATIC }).flatMap((root, pad) => (root ? [pad] : []))).toEqual([
      0, 12,
    ]);
  });
});

describe("chord set", () => {
  const set = (patch: Partial<PadMusic> = {}) => music({ mode: "set", ...patch });
  const setNotes = (pad: number, patch: Partial<PadMusic> = {}) => chordAt(set(patch), pad).notes;
  const setName = (pad: number, patch: Partial<PadMusic> = {}) => chordAt(set(patch), pad).name;

  it("pads 1–7 are the diatonic triads, 8 is I up an octave", () => {
    expect(Array.from({ length: 8 }, (_, pad) => setNotes(pad))).toEqual([
      [36, 39, 43],
      [38, 41, 44],
      [39, 43, 46],
      [41, 44, 48],
      [43, 46, 50],
      [44, 48, 51],
      [46, 50, 53],
      [48, 51, 55],
    ]);
    expect(Array.from({ length: 8 }, (_, pad) => setName(pad))).toEqual([
      "Cm",
      "D°",
      "Eb",
      "Fm",
      "Gm",
      "Ab",
      "Bb",
      "Cm",
    ]);
  });

  it("pads 9–15 are the diatonic sevenths, 16 is I7 up an octave", () => {
    expect(Array.from({ length: 8 }, (_, i) => setNotes(8 + i))).toEqual([
      [36, 39, 43, 46],
      [38, 41, 44, 48],
      [39, 43, 46, 50],
      [41, 44, 48, 51],
      [43, 46, 50, 53],
      [44, 48, 51, 55],
      [46, 50, 53, 56],
      [48, 51, 55, 58],
    ]);
    expect(Array.from({ length: 8 }, (_, i) => setName(8 + i))).toEqual([
      "Cm7",
      "Dm7b5",
      "Ebmaj7",
      "Fm7",
      "Gm7",
      "Abmaj7",
      "Bb7",
      "Cm7",
    ]);
  });

  it("uses Major for Chromatic, pentatonic and Blues", () => {
    for (const scale of [CHROMATIC, scaleIndex("Major pent."), scaleIndex("Blues")]) {
      expect(setNotes(0, { scale })).toEqual([36, 40, 43]);
      expect(setName(1, { scale })).toBe("Dm");
      expect(setName(6, { scale })).toBe("B°");
      expect(setName(14, { scale })).toBe("Bm7b5");
    }
    expect(setNotes(3, { scale: scaleIndex("Lydian") })).toEqual([42, 45, 48]);
  });

  it("root chords are the I chords: pads 1, 8, 9 and 16", () => {
    const roots = Array.from({ length: 16 }, (_, pad) => chordAt(set(), pad).root);
    expect(roots.flatMap((root, pad) => (root ? [pad] : []))).toEqual([0, 7, 8, 15]);
  });

  it("positions invert each chord within its own notes, and clamp to 0–127", () => {
    expect(setNotes(0, { position: 1 })).toEqual([39, 43, 48]);
    expect(setNotes(0, { position: 3 })).toEqual([43, 48, 51]); // a triad stops at position 2
    expect(setNotes(8, { position: 3 })).toEqual([46, 48, 51, 55]);
    expect(setNotes(7, { base: 112, scale: scaleIndex("Major") })).toEqual([124, 127]);
  });
});

describe("harmony settings", () => {
  it("knobs step by 120 counts, small turns add up, values clamp", () => {
    const s = new HarmonySettings();
    expect(s.turn(0, 60)).toBe(false);
    expect(s.turn(0, 60)).toBe(true);
    expect(s.scale).toBe(1);
    s.turn(0, 120 * 40);
    expect(s.scale).toBe(SCALES.length - 1);
    s.turn(0, -120 * 40);
    expect(s.scale).toBe(0);
    expect(s.turn(1, -120)).toBe(false);
    s.turn(1, 120);
    expect(s.mode).toBe("set");
    expect(s.turn(5, 120)).toBe(false);
  });

  it("the position follows the chord type and chord set's four notes", () => {
    const s = new HarmonySettings(); // Triad
    expect(s.maxPosition).toBe(2);
    s.turn(3, 120 * 9);
    expect(s.position).toBe(2);
    s.turn(2, -120 * 5); // Octave: 2 notes
    expect(s.type).toBe(0);
    expect(s.position).toBe(1);
    s.turn(1, 120); // chord set: the type knob does nothing, positions go to 3
    expect(s.maxPosition).toBe(3);
    expect(s.turn(2, 120)).toBe(false);
    expect(s.type).toBe(0);
    s.turn(3, 120 * 9);
    expect(s.position).toBe(3);
  });

  it("saves, loads and ignores bad values", () => {
    const s = new HarmonySettings();
    s.persisted.load({ scale: 4, mode: "set", type: 5, position: 3 });
    expect(s.persisted.save()).toEqual({ scale: 4, mode: "set", type: 5, position: 3 });
    s.persisted.load({ scale: 99, mode: "strum", type: -1, position: "x" });
    expect(s.persisted.save()).toEqual({ scale: 0, mode: "harmonizer", type: 2, position: 0 });
    s.persisted.load(null);
    expect(s.persisted.save().scale).toBe(0);
  });
});

describe("KEYBOARD with a scale", () => {
  it("Chromatic is unchanged: base + pad, C notes bright", () => {
    const h = stackHarness();
    h.tap("keyboard");
    h.pad(5);
    expect(onNotes(h)).toEqual([41]);
    expect(h.padLed(0)).toBe(flColorToPalette(h.fl.selectedChannel.color, "bright"));
    expect(h.padLed(1)).toBe(flColorToPalette(h.fl.selectedChannel.color, "dim"));
  });

  it("knob 1 picks the scale; the pads play its degrees and its roots are bright", () => {
    const h = stackHarness();
    h.tap("keyboard");
    step(h, 0, 2);
    expect(h.pads.harmony.scale).toBe(scaleIndex("Minor"));
    h.pad(3);
    h.pad(7);
    expect(onNotes(h)).toEqual([41, 48]);
    const bright = flColorToPalette(h.fl.selectedChannel.color, "bright");
    const dim = flColorToPalette(h.fl.selectedChannel.color, "dim");
    h.pad(3, "up");
    h.pad(7, "up");
    expect([0, 1, 7, 8, 14, 15].map((pad) => h.padLed(pad))).toEqual([
      bright,
      dim,
      bright,
      dim,
      bright,
      dim,
    ]);
  });

  it("knobs 2–4 are not the page's", () => {
    const h = stackHarness();
    h.tap("keyboard");
    step(h, 1, 1);
    step(h, 3, 1);
    expect(h.pads.harmony.mode).toBe("harmonizer");
    expect(h.pads.harmony.position).toBe(0);
  });

  it("OCT and SEMI move the root of the scale, and the range follows", () => {
    const h = stackHarness();
    h.tap("keyboard");
    step(h, 0, 2);
    h.tap("display8"); // C#3 minor
    h.pad(0);
    h.pad(1);
    expect(onNotes(h)).toEqual([37, 39]);
  });

  it("renders both screens for every scale and the extremes", () => {
    const h = stackHarness();
    h.tap("keyboard");
    for (let i = 0; i < SCALES.length; i++) {
      step(h, 0, 1);
      expect(() => h.render()).not.toThrow();
    }
    h.pads.shiftBase(1000);
    expect(() => h.render()).not.toThrow();
  });
});

describe("CHORDS page", () => {
  it("opens with CHORDS, sets the pad mode, is latched with display 1 lit", () => {
    const h = stackHarness();
    expect(h.light("chords")).toBe("dim");
    h.tap("chords");
    expect(h.stack.top?.page.id).toBe("chords");
    expect(h.pads.mode).toBe("chords");
    expect(h.light("display1")).toBe("bright");
    h.tap("chords");
    expect(h.stack.top).toBeUndefined();
    expect(h.pads.mode).toBe("chords"); // leaving keeps the mode
  });

  it("SHIFT + CHORDS sets the mode without the page", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.tap("chords");
    h.state.shift = false;
    expect(h.stack.top).toBeUndefined();
    expect(h.pads.mode).toBe("chords");
  });

  it("exactly one of PAD MODE, KEYBOARD and CHORDS is bright", () => {
    const h = stackHarness();
    const radio = () => [h.light("padMode"), h.light("keyboard"), h.light("chords")];
    expect(radio()).toEqual(["dim", "bright", "dim"]);
    h.tap("chords");
    expect(radio()).toEqual(["dim", "dim", "bright"]);
    h.tap("step"); // another page on top: the mode stays lit
    expect(radio()).toEqual(["dim", "dim", "bright"]);
    h.tap("padMode");
    expect(radio()).toEqual(["bright", "dim", "dim"]);
    h.tap("keyboard");
    expect(radio()).toEqual(["dim", "bright", "dim"]);
    h.tap("keyboard"); // leaves the page, the mode stays keyboard
    expect(radio()).toEqual(["dim", "bright", "dim"]);
  });

  it("knobs 1–4 set scale, chord mode, chord type and position", () => {
    const h = stackHarness();
    h.tap("chords");
    step(h, 0, 2);
    step(h, 2, 2); // Seventh
    step(h, 3, 1);
    expect(h.pads.harmony.persisted.save()).toEqual({
      scale: 2,
      mode: "harmonizer",
      type: 4,
      position: 1,
    });
    step(h, 1, 1);
    expect(h.pads.harmony.mode).toBe("set");
  });

  it("a hit sends every note of the chord with the hit velocity on MIDI channel 1", () => {
    const h = stackHarness();
    h.tap("chords");
    step(h, 0, 2);
    h.pad(0, "down", { velocity: 1 });
    expect(h.midi).toEqual([
      [0x90, 36, 127],
      [0x90, 39, 127],
      [0x90, 43, 127],
    ]);
    h.midi.length = 0;
    h.pad(0, "up");
    expect(h.midi).toEqual([
      [0x80, 36, 0],
      [0x80, 39, 0],
      [0x80, 43, 0],
    ]);
  });

  it("aftertouch goes to every note of the chord", () => {
    const h = stackHarness();
    h.tap("chords");
    h.pad(0, "down");
    h.midi.length = 0;
    h.pad(0, "move", { pressure: 1 });
    expect(h.midi).toEqual([
      [0xa0, 36, 127],
      [0xa0, 40, 127],
      [0xa0, 43, 127],
    ]);
  });

  it("chord set pads play their chords, inversions included", () => {
    const h = stackHarness();
    h.tap("chords");
    step(h, 0, 2);
    step(h, 1, 1);
    step(h, 3, 1);
    h.pad(9);
    expect(onNotes(h)).toEqual([41, 44, 48, 50]); // Dm7b5 in first inversion: F Ab C D
    h.pad(9, "up");
  });

  it("release ends exactly the notes the press sent, however the settings changed", () => {
    const h = stackHarness();
    h.tap("chords");
    h.pad(0); // C major triad (Chromatic)
    h.pad(1);
    h.midi.length = 0;
    step(h, 0, 2); // Minor
    step(h, 2, 3); // Ninth
    step(h, 1, 1); // chord set
    h.tap("display6"); // base + 12
    h.state.shift = true;
    h.tap("keyboard"); // pad mode keyboard
    h.state.shift = false;
    h.pad(0, "up");
    h.pad(1, "up");
    expect(noteEvents(h)).toEqual([
      ["off", 36, 0],
      ["off", 40, 0],
      ["off", 43, 0],
      ["off", 37, 0],
      ["off", 41, 0],
      ["off", 44, 0],
    ]);
  });

  it("a new hit on a held pad ends its old chord first; releaseAll ends them all", () => {
    const h = stackHarness();
    h.tap("chords");
    h.pad(0);
    h.pad(0);
    h.pad(2);
    h.pads.releaseAll();
    const on = new Map<number, number>();
    for (const [kind, note] of noteEvents(h)) {
      on.set(note as number, (on.get(note as number) ?? 0) + (kind === "on" ? 1 : -1));
    }
    expect([...on.values()].every((count) => count === 0)).toBe(true);
    h.midi.length = 0;
    h.pad(0, "up");
    expect(h.midi).toEqual([]);
  });

  it("FIXED VEL replaces the velocity of every note of a chord", () => {
    const h = stackHarness();
    h.tap("chords");
    h.tap("fixedVel");
    h.pad(0, "down", { velocity: 1 });
    expect(noteEvents(h).map((e) => e[2])).toEqual([100, 100, 100]);
  });

  it("NOTE REPEAT is the arpeggiator: the chord's notes one at a time, an off for every on", () => {
    const h = stackHarness({ tempo: 120 });
    h.tap("chords");
    step(h, 0, 2);
    h.press("noteRepeat");
    h.pad(0);
    h.advance(130);
    for (let i = 0; i < 5; i++) h.advance(125);
    h.pad(0, "up");
    h.advance(1000);
    const events = noteEvents(h);
    const ons = events.filter((e) => e[0] === "on").map((e) => e[1]);
    expect(ons.length).toBeGreaterThanOrEqual(6);
    expect(ons.slice(0, 6)).toEqual([36, 39, 43, 36, 39, 43]);
    expect(new Set(ons)).toEqual(new Set([36, 39, 43]));
    expect(events.filter((e) => e[0] === "off").length).toBe(ons.length);
    // balanced: no note is on twice
    const sounding = new Set<unknown>();
    for (const [kind, note] of events) {
      if (kind === "on") {
        expect(sounding.has(note)).toBe(false);
        sounding.add(note);
      } else sounding.delete(note);
    }
    expect(sounding.size).toBe(0);
  });

  it("pad LEDs: root chords bright, the others dim, held pads pressed", () => {
    const h = stackHarness();
    h.tap("chords");
    step(h, 1, 1); // chord set
    const color = h.fl.selectedChannel.color;
    const bright = flColorToPalette(color, "bright");
    const dim = flColorToPalette(color, "dim");
    const roots = Array.from({ length: 16 }, (_, pad) => h.padLed(pad) === bright);
    expect(roots.flatMap((root, pad) => (root ? [pad] : []))).toEqual([0, 7, 8, 15]);
    expect(h.padLed(1)).toBe(dim);
    h.pad(1);
    expect(h.padLed(1)).toBe(flColorToPalette(color, "pressed"));
  });

  it("SHIFT + pad transposes the notes (not the base note), ERASE plays nothing", () => {
    const h = stackHarness();
    h.tap("chords");
    h.state.shift = true;
    h.pad(15); // octave +
    h.state.shift = false;
    expect(h.sentOf("transpose")).toEqual([{ type: "transpose", channel: 0, semitones: 12 }]);
    expect(h.pads.baseNote).toBe(36);
    h.press("erase");
    h.pad(0);
    h.release("erase");
    expect(h.midi).toEqual([]);
    expect(h.sentOf("clearSteps")).toEqual([]);
  });

  it("GROUP A–H pick the bank and display 1–4 do nothing", () => {
    const h = stackHarness();
    h.tap("chords");
    h.tap("display2");
    expect(h.sentOf("clearSteps")).toEqual([]);
    expect(h.pads.baseNote).toBe(36);
  });

  it("renders both screens in both modes, for every scale, with and without a channel", () => {
    for (const channel of [true, false]) {
      const h = stackHarness({ selected: 2 });
      if (!channel) {
        h.fl.apply({
          type: "selectedChannel",
          index: null,
          color: 0,
          volume: 0,
          pan: 0,
          name: "",
          plugin: "",
        });
      }
      h.tap("chords");
      for (let i = 0; i < SCALES.length; i++) {
        step(h, 0, 1);
        expect(() => h.render()).not.toThrow();
      }
      step(h, 1, 1);
      h.touched.add(1);
      h.pads.shiftBase(1000);
      expect(() => h.render()).not.toThrow();
      h.pads.shiftBase(-1000);
      expect(() => h.render()).not.toThrow();
    }
  });
});

describe("scale and chord settings are persisted with the page state", () => {
  it("saves under pages.chords shortly after a turn and loads again", () => {
    const pinsPath = tempPins();
    const first = stackHarness({ pinsPath });
    first.tap("chords");
    step(first, 0, 5);
    step(first, 2, 2);
    step(first, 3, 1);
    first.advance(500);
    const saved = JSON.parse(readFileSync(pinsPath, "utf8")) as { pages: { chords: unknown } };
    expect(saved.pages.chords).toEqual({ scale: 5, mode: "harmonizer", type: 4, position: 1 });
    const second = stackHarness({ pinsPath });
    expect(second.pads.harmony.persisted.save()).toEqual(saved.pages.chords);
    second.tap("chords");
    second.pad(0);
    expect(onNotes(second)).toEqual([39, 43, 46, 48]); // Cm7 of C Dorian, first inversion
  });

  it("closing the page writes a turn that was still waiting", () => {
    const pinsPath = tempPins();
    const first = stackHarness({ pinsPath });
    first.tap("keyboard");
    step(first, 0, 3);
    first.tap("keyboard"); // leaves the page
    expect(
      (JSON.parse(readFileSync(pinsPath, "utf8")) as { pages: { chords: { scale: number } } }).pages
        .chords.scale,
    ).toBe(3);
  });

  it("starts with Chromatic when the saved values are bad", () => {
    const pinsPath = tempPins();
    writeFileSync(
      pinsPath,
      JSON.stringify({ pages: { chords: { scale: 40, mode: 7, type: "x", position: 99 } } }),
    );
    const h = stackHarness({ pinsPath });
    expect(h.pads.harmony.persisted.save()).toEqual({
      scale: 0,
      mode: "harmonizer",
      type: 2,
      position: 0,
    });
  });
});
