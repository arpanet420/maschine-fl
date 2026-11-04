import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL_NOTE_CHANNEL, NOTE_CHANNEL } from "../src/fl/protocol.js";
import {
  ARP_PRESETS,
  ARP_RHYTHMS,
  ARP_TYPES,
  DEFAULT_ARP_SETTINGS,
  SEQUENCE_MAX,
  buildSteps,
  matchesPreset,
  type ArpHeld,
  type ArpType,
} from "../src/modes/arpeggiator.js";
import { REPEAT_RATES } from "../src/modes/repeatScheduler.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempPins = () => {
  const dir = mkdtempSync(join(tmpdir(), "mk3d-arp-"));
  dirs.push(dir);
  return join(dir, "pages.json");
};

/** Note events as [kind, channel, note, velocity]. */
const notes = (h: StackHarness) =>
  h.midi
    .filter((bytes) => [0x80, 0x90].includes((bytes[0] ?? 0) & 0xf0))
    .map((bytes) => [
      ((bytes[0] ?? 0) & 0xf0) === 0x90 ? "on" : "off",
      (bytes[0] ?? 0) & 0x0f,
      bytes[1],
      bytes[2],
    ]);
const ons = (h: StackHarness) => notes(h).filter((n) => n[0] === "on");
/** The notes that went on, in order. */
const played = (h: StackHarness) => ons(h).map((n) => n[2]);

/** Every on has an off, and no note is on twice. */
function expectBalanced(h: StackHarness): void {
  const on = new Set<unknown>();
  for (const [kind, , note] of notes(h)) {
    if (kind === "on") {
      expect(on.has(note)).toBe(false);
      on.add(note);
    } else {
      expect(on.has(note)).toBe(true);
      on.delete(note);
    }
  }
  expect([...on]).toEqual([]);
}

const settings = (h: StackHarness) => h.pages.noteRepeat.arp.settings;
/** Time to the first slot, then each one (1/16 at 120 BPM: 125 ms). */
const slots = (h: StackHarness, count: number) => {
  h.advance(130);
  for (let i = 1; i < count; i++) h.advance(125);
};
/** KEYBOARD with the arp open, base 36: pad n is note 36 + n. Pads go down together. */
const keys = (pads: number[], extra: Partial<ReturnType<typeof settings>> = {}) => {
  const h = stackHarness();
  h.press("noteRepeat");
  Object.assign(settings(h), { type: "up" }, extra);
  for (const pad of pads) h.pad(pad);
  return h;
};

const held = (...sets: number[][]): ArpHeld[] =>
  sets.map((set, pad) => ({ pad, notes: set, velocity: 64 }));
const sequence = (heldPads: ArpHeld[], type: ArpType, octaves = 1) =>
  buildSteps(heldPads, type, octaves).map((step) => step.map((n) => n.note));

describe("arp sequences", () => {
  const chord = held([40], [36], [43]); // pressed E, C, G
  it("Up and Down order the notes", () => {
    expect(sequence(chord, "up")).toEqual([[36], [40], [43]]);
    expect(sequence(chord, "down")).toEqual([[43], [40], [36]]);
  });

  it("Up/Down and Down/Up do not repeat the ends", () => {
    expect(sequence(chord, "upDown")).toEqual([[36], [40], [43], [40]]);
    expect(sequence(chord, "downUp")).toEqual([[43], [40], [36], [40]]);
    expect(sequence(held([36], [40]), "upDown")).toEqual([[36], [40]]);
    expect(sequence(held([36]), "upDown")).toEqual([[36]]);
    expect(sequence(held([36]), "downUp")).toEqual([[36]]);
  });

  it("Played keeps the press order, and a chord's own notes ascend", () => {
    expect(sequence(chord, "played")).toEqual([[40], [36], [43]]);
    expect(sequence(held([43, 36, 40], [30]), "played")).toEqual([[36], [40], [43], [30]]);
  });

  it("Chord plays every note together, an octave up each round", () => {
    expect(sequence(chord, "chord")).toEqual([[36, 40, 43]]);
    expect(sequence(chord, "chord", 2)).toEqual([
      [36, 40, 43],
      [48, 52, 55],
    ]);
  });

  it("Octaves extend the sequence, clamped to 127 without duplicates", () => {
    expect(sequence(held([36], [40]), "up", 2)).toEqual([[36], [40], [48], [52]]);
    expect(sequence(held([36], [40]), "down", 2)).toEqual([[52], [48], [40], [36]]);
    expect(sequence(held([36], [40]), "upDown", 3)).toEqual([
      [36],
      [40],
      [48],
      [52],
      [60],
      [64],
      [60],
      [52],
      [48],
      [40],
    ]);
    expect(sequence(held([120], [126]), "up", 4)).toEqual([[120], [126], [127]]);
    expect(sequence(held([120, 126]), "chord", 2)).toEqual([[120, 126], [127]]);
  });

  it("clamps Octaves to 1–4 and gives nothing for no pads", () => {
    expect(sequence(held([36]), "up", 9)).toHaveLength(4);
    expect(sequence(held([36]), "up", 0)).toHaveLength(1);
    expect(sequence([], "up")).toEqual([]);
  });

  it("a note two pads share is in the set once", () => {
    expect(sequence(held([36, 40], [40, 43]), "up")).toEqual([[36], [40], [43]]);
  });
});

/** The overlay on an arpeggiating Type (the panel starts on Repeat); a saved state decides by itself. */
const arpHarness = (options?: Parameters<typeof stackHarness>[0]) => {
  const h = stackHarness(options);
  if (!options?.pinsPath) settings(h).type = "up";
  return h;
};

describe("ARP overlay", () => {
  it("starts as plain Note Repeat in KEYBOARD: the held keys repeat together", () => {
    const h = stackHarness();
    h.press("noteRepeat");
    expect(settings(h).type).toBe("repeat");
    h.pad(0);
    h.pad(2);
    slots(h, 2);
    // The second key joins on the next slot, and then both repeat together.
    expect(played(h)).toEqual([36, 36, 38, 36, 38]);
    h.knob(3, 200);
    expect(settings(h).octaves).toBe(1); // Octaves does nothing while it only repeats
    h.pad(0, "up");
    h.pad(2, "up");
    h.advance(200);
    expectBalanced(h);
  });

  it("restores a saved Type only from a state that knows Repeat", () => {
    const h = stackHarness();
    h.pages.noteRepeat.persisted.load({ arp: { type: "down", rate: 1 } });
    expect(settings(h)).toMatchObject({ type: "repeat", rate: 1 });
    h.pages.noteRepeat.persisted.load({ arp: { type: "down", typeVersion: 2 } });
    expect(settings(h).type).toBe("down");
    expect(h.pages.noteRepeat.persisted.save()).toMatchObject({
      arp: { type: "down", typeVersion: 2 },
    });
  });

  it("a key let go while the first note waits for its slot still plays that note", () => {
    const h = stackHarness();
    h.playing(true);
    h.songPos(1, 1, 15); // 0.625 of a 1/16
    h.press("noteRepeat");
    h.pad(0); // the note waits for 0.25 beat, 47 ms away
    expect(played(h)).toEqual([]);
    h.pad(0, "up");
    h.advance(60);
    expect(played(h)).toEqual([36]);
    h.advance(1000);
    expect(played(h)).toEqual([36]);
    expectBalanced(h);
    expect(h.pages.noteRepeat.repeating).toBe(false);
    h.pad(0); // and it starts again
    h.advance(60);
    expect(played(h).length).toBeGreaterThan(1);
  });

  it("is NOTE REPEAT with the pin tab ARP in KEYBOARD", () => {
    const h = arpHarness();
    h.press("noteRepeat");
    expect(h.stack.top?.page.id).toBe("noteRepeat");
    expect(h.pages.noteRepeat.arpeggiates).toBe(true);
    h.tap("display1");
    h.release("noteRepeat");
    expect(h.stack.top?.page.id).toBe("noteRepeat");
    expect(h.stack.isPinned("noteRepeat")).toBe(true);
    expect(h.light("noteRepeat")).toBe("bright");
  });

  it("is the arpeggiator in KEYBOARD and CHORDS, Note Repeat in PAD MODE", () => {
    const h = arpHarness();
    for (const [mode, arp] of [
      ["keyboard", true],
      ["chords", true],
      ["channels", false],
    ] as const) {
      h.pads.mode = mode;
      expect(h.pages.noteRepeat.arpeggiates).toBe(arp);
    }
  });

  it("PAD MODE repeats the pad as before (and its display 6 is a note value)", () => {
    const h = arpHarness({ selected: 0 });
    h.pads.mode = "channels";
    h.press("noteRepeat");
    h.tap("display6");
    expect(h.pages.noteRepeat.settings.rate).toBe(1);
    expect(h.pages.noteRepeat.arp.engine.holding).toBe(false);
    h.pad(3, "down", { velocity: 1 });
    h.advance(260);
    expect(ons(h).every((n) => n[1] === CHANNEL_NOTE_CHANNEL && n[2] === 3)).toBe(true);
    expect(ons(h).length).toBeGreaterThanOrEqual(2);
  });

  describe("KEYBOARD", () => {
    it("plays the held pads' notes one at a time, the first at the press", () => {
      const h = keys([0, 2, 4]);
      expect(ons(h)).toEqual([["on", NOTE_CHANNEL, 36, 64]]);
      slots(h, 5);
      expect(played(h)).toEqual([36, 38, 40, 36, 38, 40]);
      h.pad(0, "up");
      h.pad(2, "up");
      h.pad(4, "up");
      h.advance(500);
      expectBalanced(h);
      expect(h.pages.noteRepeat.repeating).toBe(false);
    });

    it("follows the base note and the scale", () => {
      const h = arpHarness();
      h.pads.shiftBase(12);
      h.pads.harmony.scale = 2; // Minor: pad 2 = the third
      h.press("noteRepeat");
      h.pad(0);
      h.pad(2);
      slots(h, 1);
      expect(played(h)).toEqual([48, 51]);
    });

    it("sends no single note and no aftertouch for the pads", () => {
      const h = keys([1]);
      h.pad(1, "move", { pressure: 0.9 });
      h.pad(1, "up");
      expect(h.midi.filter((bytes) => ((bytes[0] ?? 0) & 0xf0) === 0xa0)).toEqual([]);
      expect(ons(h)).toHaveLength(1);
      expectBalanced(h);
    });

    it("a pad added or released changes the sequence from the next step, without a restart", () => {
      const h = keys([0, 2]);
      h.advance(130); // 38
      h.pad(4); // joins: 40
      h.advance(125);
      expect(played(h)).toEqual([36, 38, 40]);
      h.pad(2, "up");
      h.advance(125); // the sequence is [36, 40] now, the next step index is 3 % 2 = 1
      h.advance(125);
      expect(played(h).slice(3)).toEqual([40, 36]);
      h.pad(0, "up");
      h.pad(4, "up");
      h.advance(500);
      expectBalanced(h);
    });

    it("keeps the grid: the steps sit on the 125 ms grid whatever is pressed", () => {
      const h = keys([0]);
      h.advance(60);
      h.pad(2); // 60 ms, not on the grid: no note now
      expect(ons(h)).toHaveLength(1);
      h.advance(70); // 130: the slot at 125
      expect(played(h)).toEqual([36, 38]);
    });

    it("Down order", () => {
      const h = keys([0, 2, 4], { type: "down" });
      slots(h, 4);
      // the press played the first pad alone, then the set descends from step 1
      expect(played(h)).toEqual([36, 38, 36, 40, 38]);
    });

    it("Up/Down goes up and back without repeating the ends", () => {
      const h = keys([0, 2, 4, 6], { type: "upDown" });
      slots(h, 6);
      expect(played(h)).toEqual([36, 38, 40, 42, 40, 38, 36]);
    });

    it("Played order is the press order", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      settings(h).type = "played";
      h.pad(4);
      h.pad(0);
      h.pad(2);
      slots(h, 4);
      expect(played(h)).toEqual([40, 36, 38, 40, 36]); // the press played pad 5 alone
    });

    it("Octaves 2 adds the octave above", () => {
      const h = keys([0, 2], { octaves: 2 });
      slots(h, 4);
      expect(played(h)).toEqual([36, 38, 48, 50, 36]);
    });

    it("Chord plays all the notes of a step at once, each with its own off", () => {
      const h = keys([0, 2, 4], { type: "chord" });
      slots(h, 2);
      expect(played(h)).toEqual([36, 36, 38, 40, 36, 38, 40]); // the press plays pad 1 alone
      h.advance(40); // 295 ms: the first two steps are over (4 notes), the third plays
      expect(notes(h).filter((n) => n[0] === "off")).toHaveLength(4);
      h.pad(0, "up");
      h.pad(2, "up");
      h.pad(4, "up");
      h.advance(500);
      expectBalanced(h);
    });

    it("Random never repeats a note straight away", () => {
      let seed = 0.123;
      const random = () => (seed = (seed * 9301 + 0.49297) % 1);
      const h = arpHarness({ random });
      h.press("noteRepeat");
      settings(h).type = "random";
      h.pad(0);
      h.pad(2);
      h.pad(4);
      slots(h, 40);
      const all = played(h);
      expect(all.length).toBeGreaterThan(30);
      for (let i = 1; i < all.length; i++) expect(all[i]).not.toBe(all[i - 1]);
      expect(new Set(all.slice(1))).toEqual(new Set([36, 38, 40]));
      h.release("noteRepeat");
      expectBalanced(h);
    });

    it("Random with one note repeats it", () => {
      const h = keys([3], { type: "random" });
      slots(h, 2);
      expect(played(h)).toEqual([39, 39, 39]);
    });

    it("the velocity is the hit of the pad that owns the note", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      h.pad(0, "down", { velocity: 0.5 });
      h.pad(2, "down", { velocity: 1 });
      h.pad(4, "down", { velocity: 0 });
      slots(h, 3);
      expect(ons(h).map((n) => [n[2], n[3]])).toEqual([
        [36, 64],
        [38, 127],
        [40, 1],
        [36, 64],
      ]);
    });

    it("FIXED VEL wins", () => {
      const h = arpHarness();
      h.tap("fixedVel");
      h.press("noteRepeat");
      h.pad(0, "down", { velocity: 0.1 });
      h.pad(2, "down", { velocity: 1 });
      slots(h, 3);
      expect(ons(h).length).toBeGreaterThanOrEqual(3);
      expect(ons(h).every((n) => n[3] === 100)).toBe(true);
    });

    it("SHIFT + pad and ERASE + pad never arpeggiate", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      h.state.shift = true;
      h.pad(0);
      h.advance(500);
      h.pad(0, "up");
      h.state.shift = false;
      h.press("erase");
      h.pad(2);
      h.advance(500);
      h.pad(2, "up");
      expect(h.midi).toEqual([]);
    });
  });

  describe("CHORDS", () => {
    const minor = () => {
      const h = arpHarness();
      h.pads.mode = "chords";
      h.pads.harmony.scale = 2; // Minor, harmonizer, Triad: pad 0 = C minor
      h.press("noteRepeat");
      return h;
    };

    it("plays every note of the held pad's chord", () => {
      const h = minor();
      h.pad(0);
      slots(h, 6);
      expect(played(h)).toEqual([36, 39, 43, 36, 39, 43, 36]);
    });

    it("mixes the chords of several pads in one ascending set", () => {
      const h = minor();
      h.pad(0); // C Eb G
      h.pad(4); // G Bb D (G is shared)
      expect(sequenceNotes(h)).toEqual([36, 39, 43, 46, 50]);
      h.pad(0, "up");
      h.pad(4, "up");
      h.advance(500);
      expectBalanced(h);
    });

    it("Chord type plays the whole chord on every step", () => {
      const h = minor();
      settings(h).type = "chord";
      h.pad(0);
      slots(h, 2);
      expect(played(h)).toEqual([36, 39, 43, 36, 39, 43, 36, 39, 43]);
    });

    it("a chord latched at the press is kept when the settings change under it", () => {
      const h = minor();
      h.pad(0);
      h.pads.harmony.scale = 1;
      h.pads.shiftBase(5);
      slots(h, 4);
      expect(new Set(played(h))).toEqual(new Set([36, 39, 43]));
    });
  });

  describe("HOLD", () => {
    it("keeps released notes playing; the next press after all were released starts a new set", () => {
      const h = keys([0, 2]);
      h.tap("display3");
      expect(h.pages.noteRepeat.arp.engine.holding).toBe(true);
      h.pad(0, "up");
      h.pad(2, "up");
      slots(h, 4);
      expect(played(h)).toEqual([36, 38, 36, 38, 36]);
      h.pad(4);
      h.pad(6);
      h.advance(125);
      h.advance(125);
      expect(played(h).slice(-2)).toEqual([40, 42]);
      expect(sequenceNotes(h)).toEqual([40, 42]);
      h.release("noteRepeat");
      expectBalanced(h);
    });

    it("a pad pressed while another is still down joins the set", () => {
      const h = keys([0]);
      h.tap("display3");
      h.pad(2);
      h.pad(0, "up");
      expect(sequenceNotes(h)).toEqual([36, 38]);
      h.pad(2, "up");
      expect(sequenceNotes(h)).toEqual([36, 38]);
    });

    it("HOLD off stops the held set with an off for every on", () => {
      const h = keys([0, 2]);
      h.tap("display3");
      h.pad(0, "up");
      h.pad(2, "up");
      h.advance(130);
      h.tap("display3");
      expectBalanced(h);
      const count = h.midi.length;
      h.advance(1000);
      expect(h.midi).toHaveLength(count);
      expect(h.pages.noteRepeat.repeating).toBe(false);
      expect(h.time.timerCount).toBe(0);
    });

    it("HOLD off keeps the pads that are still down", () => {
      const h = keys([0, 2]);
      h.tap("display3");
      h.pad(2, "up");
      h.tap("display3");
      expect(sequenceNotes(h)).toEqual([36]);
      slots(h, 2);
      expect(played(h).slice(-1)).toEqual([36]);
      h.pad(0, "up");
      h.advance(300);
      expectBalanced(h);
      expect(h.pages.noteRepeat.repeating).toBe(false);
    });

    it("closing the overlay stops everything, HOLD included", () => {
      const h = keys([0, 2]);
      h.tap("display3");
      h.pad(0, "up");
      h.pad(2, "up");
      slots(h, 2);
      h.release("noteRepeat");
      expect(h.stack.top).toBeUndefined();
      expectBalanced(h);
      const count = h.midi.length;
      h.advance(1000);
      expect(h.midi).toHaveLength(count);
      expect(h.time.timerCount).toBe(0);
    });

    it("a pinned overlay keeps the held arpeggio after the pads are released", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      h.tap("display1");
      h.tap("display3");
      h.release("noteRepeat");
      h.pad(0);
      h.pad(0, "up");
      slots(h, 3);
      expect(played(h)).toEqual([36, 36, 36, 36]);
      h.tap("display1"); // unpin: closes
      expectBalanced(h);
    });

    it("is saved and loaded", () => {
      const pinsPath = tempPins();
      const first = arpHarness({ pinsPath });
      first.press("noteRepeat");
      first.tap("display3");
      first.release("noteRepeat");
      const second = arpHarness({ pinsPath });
      expect(second.pages.noteRepeat.arp.engine.holding).toBe(true);
      second.press("noteRepeat");
      expect(second.light("display3")).toBe("bright");
    });
  });

  describe("stopping", () => {
    it("closing the overlay with pads down ends the notes", () => {
      const h = keys([0, 2]);
      slots(h, 2);
      h.release("noteRepeat");
      expectBalanced(h);
      const count = h.midi.length;
      h.pad(0, "up");
      h.advance(1000);
      expect(h.midi).toHaveLength(count);
    });

    it("a lost device ends the notes", () => {
      const h = keys([0, 2, 4]);
      slots(h, 2);
      h.pads.releaseAll();
      h.stack.releasePads();
      expectBalanced(h);
      h.advance(1000);
      expect(h.time.timerCount).toBe(0);
    });

    it("a settings change never leaves a note on", () => {
      const h = keys([0, 2, 4]);
      slots(h, 2);
      h.knob(1, 120); // rate
      h.knob(0, 120); // type
      h.knob(3, 200); // octaves
      h.knob(4, 600); // gate
      h.knob(5, 600); // swing
      slots(h, 6);
      h.pad(0, "up");
      h.pad(2, "up");
      h.pad(4, "up");
      h.advance(1000);
      expectBalanced(h);
    });

    it("keeps no note on with a full gate and swing", () => {
      const h = keys([0, 2]);
      h.knob(4, 5000);
      h.knob(5, 5000);
      expect(settings(h).gate).toBe(1);
      h.advance(1500);
      h.release("noteRepeat");
      h.advance(500);
      expectBalanced(h);
    });

    it("the pad mode changing while open stops the arp and Note Repeat plays on", () => {
      const h = arpHarness({ selected: 0 });
      h.press("noteRepeat");
      h.pad(0);
      h.advance(130);
      h.state.shift = true;
      h.tap("padMode"); // SHIFT + PAD MODE: set the mode without the page
      h.state.shift = false;
      expect(h.pads.mode).toBe("channels");
      h.render();
      expectBalanced(h);
      const count = h.midi.length;
      h.advance(500);
      expect(h.midi).toHaveLength(count);
      h.pad(0, "up");
      h.pad(1);
      h.advance(130);
      expect(
        ons(h)
          .slice(-2)
          .map((n) => n[1]),
      ).toEqual([CHANNEL_NOTE_CHANNEL, CHANNEL_NOTE_CHANNEL]);
      h.pad(1, "up");
      h.advance(500);
      expectBalanced(h);
    });
  });

  describe("tempo and transport", () => {
    it("follows FL's tempo", () => {
      const h = arpHarness({ tempo: 60 });
      h.press("noteRepeat");
      h.pad(0);
      h.advance(240);
      expect(ons(h)).toHaveLength(1);
      h.advance(20); // 1/16 at 60 BPM: 250 ms
      expect(ons(h)).toHaveLength(2);
    });

    it("aligns to FL's grid while it plays", () => {
      const h = arpHarness({ tempo: 120 });
      h.playing(true);
      h.songPos(1, 1, 0);
      h.advance(30);
      h.press("noteRepeat");
      h.pad(0);
      h.advance(80);
      expect(ons(h)).toHaveLength(1);
      h.advance(20);
      expect(ons(h)).toHaveLength(2);
    });
  });

  describe("controls", () => {
    it("starts at Repeat, 1/16, 1 octave, gate 50 %, swing 0", () => {
      const h = stackHarness();
      expect(settings(h)).toEqual(DEFAULT_ARP_SETTINGS);
      expect(settings(h)).toMatchObject({
        type: "repeat",
        rate: 2,
        octaves: 1,
        gate: 0.5,
        swing: 0,
      });
      expect(h.pages.noteRepeat.settings).toEqual({ rate: 2, gate: 0.5, swing: 0 });
    });

    it("page 1: Type, Rate, Unit, Octaves, Gate, Swing, Sequence, Dynamic", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      h.knob(0, 60);
      expect(settings(h).type).toBe("up");
      h.knob(0, 60);
      expect(settings(h).type).toBe("down");
      h.knob(0, 99999);
      expect(settings(h).type).toBe("chord");
      h.knob(0, -99999);
      expect(settings(h).type).toBe("repeat");
      h.knob(0, 120);
      expect(settings(h).type).toBe("up");
      h.knob(1, 120); // the note value, from 1/16
      expect(REPEAT_RATES[settings(h).rate]?.label).toBe("1/32");
      h.knob(2, 240); // the unit
      expect(REPEAT_RATES[settings(h).rate]?.label).toBe("1/32T");
      h.knob(3, 200);
      expect(settings(h).octaves).toBe(2);
      h.knob(3, 99999);
      expect(settings(h).octaves).toBe(4);
      h.knob(3, -99999);
      expect(settings(h).octaves).toBe(1);
      h.knob(4, 120);
      expect(settings(h).gate).toBeCloseTo(0.5 + 0.1 * 0.9, 6);
      h.knob(4, 99999);
      expect(settings(h).gate).toBe(1);
      h.knob(5, 120);
      expect(settings(h).swing).toBeCloseTo(0.05, 6);
      h.knob(5, 99999);
      expect(settings(h).swing).toBe(0.5);
      h.knob(6, 120);
      expect(settings(h).sequence).toBe(1);
      h.knob(7, -99999);
      expect(settings(h).dynamic).toBeCloseTo(0.1, 6);
      // Note Repeat's own settings stay as they were
      expect(h.pages.noteRepeat.settings).toEqual({ rate: 2, gate: 0.5, swing: 0 });
    });

    it("the arrows pick page 2: Retrigger, Repeat, Offset, Inversion, Min. and Max. Key", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      expect(h.light("arrowRight")).toBe("dim");
      h.tap("arrowRight");
      expect(h.light("arrowLeft")).toBe("dim");
      expect(h.light("arrowRight")).toBe("off");
      h.knob(0, 240);
      expect(settings(h).retrigger).toBe(2);
      h.knob(1, 120);
      expect(settings(h).stepRepeat).toBe(2);
      h.knob(2, 360);
      expect(settings(h).offset).toBe(3);
      h.knob(3, 200);
      expect(settings(h).inversion).toBe(1);
      h.knob(4, 400);
      expect(settings(h).minKey).toBe(10);
      h.knob(5, -400);
      expect(settings(h).maxKey).toBe(117);
      h.knob(4, 99999); // the keys cannot cross
      expect(settings(h).minKey).toBe(10);
      expect(() => h.render()).not.toThrow();
      h.tap("arrowLeft");
      h.knob(0, 60);
      expect(settings(h).type).toBe("up");
    });

    it("LOCK and GATE RESET are display 2 and 4", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      h.knob(4, 300);
      h.tap("display4");
      expect(settings(h).gate).toBe(1);
      h.tap("display2");
      expect(h.light("display2")).toBe("bright");
      expect(h.pages.noteRepeat.locksPads()).toBe(true);
      h.tap("display2");
      expect(h.pages.noteRepeat.locksPads()).toBe(false);
    });

    it("the rate changes the interval of a running arp", () => {
      const h = keys([0]);
      h.knob(1, -120); // from 1/16 to 1/8: 250 ms
      h.advance(255);
      h.advance(250);
      expect(ons(h)).toHaveLength(3);
    });

    it("two quick touches reset a knob's setting", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      h.knob(3, 200);
      h.touchKnob(3);
      expect(settings(h).octaves).toBe(2);
      h.touchKnob(3);
      expect(settings(h).octaves).toBe(1);
    });
  });

  describe("shaping the round", () => {
    const after = (h: StackHarness, count: number) => {
      const before = played(h).length;
      slots(h, count);
      return played(h).slice(before);
    };
    const octave = held([36, 40, 43]);

    it("Repeat plays each step that many slots", () => {
      expect(after(keys([0, 2], { stepRepeat: 2 }), 7)).toEqual([36, 38, 38, 36, 36, 38, 38]);
    });

    it("Offset starts the round later", () => {
      expect(after(keys([0, 2, 4], { offset: 1 }), 5)).toEqual([40, 36, 38, 40, 36]);
    });

    it("Retrigger starts the round over", () => {
      expect(after(keys([0, 2, 4], { retrigger: 2 }), 6)).toEqual([38, 36, 38, 36, 38, 36]);
    });

    it("Sequence rests on some slots", () => {
      const h = keys([0], { sequence: 1 }); // x.x.
      const before = played(h).length;
      const counts = [0, 1, 2, 3].map(() => {
        slots(h, 1);
        return played(h).length - before;
      });
      expect(counts).toEqual([0, 1, 1, 2]);
      expect(ARP_RHYTHMS).toHaveLength(SEQUENCE_MAX);
    });

    it("Dynamic scales the velocity", () => {
      const velocity = (h: StackHarness) => Number(ons(h).at(-1)?.[3] ?? 0);
      const soft = keys([0], { dynamic: 0.5 });
      const full = keys([0]);
      slots(soft, 2);
      slots(full, 2);
      expect(velocity(soft)).toBe(Math.round(velocity(full) * 0.5));
    });

    it("Inversion adds passes an octave up, each starting one note later", () => {
      const notesOf = (inversion: number) =>
        buildSteps(octave, "up", 1, { inversion }).flatMap((step) => step.map((n) => n.note));
      expect(notesOf(0)).toEqual([36, 40, 43]);
      expect(notesOf(1)).toEqual([36, 40, 43, 52, 55, 48]);
    });

    it("Min. and Max. Key leave notes out", () => {
      const steps = buildSteps(octave, "up", 1, { minKey: 37, maxKey: 42 });
      expect(steps.flatMap((step) => step.map((n) => n.note))).toEqual([40]);
      expect(buildSteps(octave, "up", 1, { minKey: 50 })).toEqual([]);
    });
  });

  describe("presets", () => {
    const [up, down, upDown, random] = ARP_PRESETS;
    it("display 5–8 set Type, Rate, Octaves and Gate at once", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      h.knob(5, 300);
      const swing = settings(h).swing;
      h.tap("display7");
      expect(settings(h)).toMatchObject({ type: "upDown", rate: 1, octaves: 2, gate: 0.6 });
      h.tap("display8");
      expect(settings(h)).toMatchObject({ type: "random", rate: 5, octaves: 2, gate: 0.4 });
      h.tap("display6");
      expect(settings(h)).toMatchObject({ type: "down", rate: 2, octaves: 1, gate: 0.5 });
      h.tap("display5");
      expect(settings(h)).toMatchObject({ type: "up", rate: 2, octaves: 1, gate: 0.5 });
      expect(settings(h).swing).toBe(swing);
      expect([up, down, upDown, random].map((p) => p?.label)).toEqual([
        "UP 16TH",
        "DOWN 16TH",
        "UP/DN 8TH",
        "RANDOM 16T",
      ]);
    });

    it("the LED of the preset equal to the settings is bright", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      const leds = () => (["display5", "display6", "display7", "display8"] as const).map(h.light);
      expect(leds()).toEqual(["bright", "dim", "dim", "dim"]);
      h.tap("display7");
      expect(leds()).toEqual(["dim", "dim", "bright", "dim"]);
      h.knob(4, 600); // gate moves away
      expect(leds()).toEqual(["dim", "dim", "dim", "dim"]);
      h.tap("display8");
      expect(leds()).toEqual(["dim", "dim", "dim", "bright"]);
      h.knob(0, -99999);
      expect(leds()).toEqual(["dim", "dim", "dim", "dim"]);
    });

    it("matchesPreset compares the four settings", () => {
      const base = { ...DEFAULT_ARP_SETTINGS, type: "up", rate: 2, gate: 0.5, swing: 0.3 } as const;
      expect(matchesPreset(base, ARP_PRESETS[0]!)).toBe(true);
      expect(matchesPreset({ ...base, octaves: 2 }, ARP_PRESETS[0]!)).toBe(false);
      expect(matchesPreset({ ...base, gate: 0.55 }, ARP_PRESETS[0]!)).toBe(false);
    });

    it("a preset changes the running arp", () => {
      const h = keys([0, 2]);
      h.tap("display7"); // Up/Down, 1/8, 2 octaves: 250 ms
      h.advance(260);
      h.advance(250);
      expect(ons(h).length).toBe(3);
      h.pad(0, "up");
      h.pad(2, "up");
      h.advance(1000);
      expectBalanced(h);
    });
  });

  describe("LEDs", () => {
    it("lights the button bright while open, display 1 with the pin, display 3 with HOLD", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      expect(h.light("noteRepeat")).toBe("bright");
      expect(h.light("display1")).toBe("dim");
      expect(h.light("display3")).toBe("dim");
      h.tap("display1");
      h.tap("display3");
      expect(h.light("display1")).toBe("bright");
      expect(h.light("display3")).toBe("bright");
    });

    it("a pad flashes when its note plays and a latched pad is lit", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      const idle = h.padLed(0);
      const idleOther = h.padLed(2);
      h.pad(0);
      h.pad(2);
      const flash = h.padLed(0);
      expect(flash).not.toBe(idle);
      expect(h.padLed(2)).toBe(idleOther);
      h.advance(70); // the gate is over
      expect(h.padLed(0)).toBe(idle);
      h.advance(60); // pad 2's step
      expect(h.padLed(2)).not.toBe(idleOther);
      expect(h.padLed(0)).toBe(idle);
      h.tap("display3");
      h.pad(0, "up");
      h.pad(2, "up");
      h.advance(500);
      // both are latched: lit between the flashes
      const lit = (pad: number) => h.padLed(pad);
      const states = new Set<number>();
      for (let i = 0; i < 10; i++) {
        h.advance(30);
        states.add(lit(0));
      }
      expect(states.size).toBeGreaterThan(1);
      h.tap("display3"); // HOLD off
      h.advance(10);
      expect(h.padLed(0)).toBe(idle);
      expect(h.padLed(2)).toBe(idleOther);
    });
  });

  describe("persistence", () => {
    it("the arp settings are saved with the page stack and loaded again", () => {
      const pinsPath = tempPins();
      const first = arpHarness({ pinsPath });
      first.press("noteRepeat");
      first.tap("display8");
      first.knob(5, 1200 * 0.2);
      first.advance(1000);
      const saved = JSON.parse(readFileSync(pinsPath, "utf8")) as {
        pages: { noteRepeat: { rate: number; arp: Record<string, unknown> } };
      };
      expect(saved.pages.noteRepeat.rate).toBe(2); // Note Repeat's own
      expect(saved.pages.noteRepeat.arp).toMatchObject({
        type: "random",
        rate: 5,
        octaves: 2,
        hold: false,
      });
      const second = arpHarness({ pinsPath });
      expect(settings(second)).toMatchObject({ type: "random", rate: 5, octaves: 2 });
      expect(settings(second).gate).toBeCloseTo(0.4, 9);
      expect(settings(second).swing).toBeCloseTo(0.1, 9);
      expect(second.pages.noteRepeat.settings).toEqual({ rate: 2, gate: 0.5, swing: 0 });
    });

    it("saves a knob turn when the overlay closes before the pause is over", () => {
      const pinsPath = tempPins();
      const first = arpHarness({ pinsPath });
      first.press("noteRepeat");
      first.knob(4, 1200 * 0.2);
      first.release("noteRepeat");
      const second = arpHarness({ pinsPath });
      expect(settings(second).gate).toBeCloseTo(0.5 + 0.2 * 0.9, 6);
    });

    it("loads an old file with no arp part and ignores damaged values", () => {
      const h = stackHarness();
      h.pages.noteRepeat.persisted.load({ rate: 3, gate: 0.7, swing: 0.1 });
      expect(settings(h)).toEqual(DEFAULT_ARP_SETTINGS);
      h.pages.noteRepeat.persisted.load({
        arp: {
          type: "sideways",
          rate: "fast",
          octaves: 12,
          gate: 7,
          swing: -1,
          hold: "yes",
          sequence: 99,
          dynamic: 0,
          minKey: -4,
        },
      });
      expect(settings(h)).toEqual({
        ...DEFAULT_ARP_SETTINGS,
        octaves: 4,
        gate: 1,
        sequence: SEQUENCE_MAX,
        dynamic: 0.1,
      });
      expect(h.pages.noteRepeat.arp.engine.holding).toBe(false);
    });

    it("every Type is known", () => {
      expect(ARP_TYPES.map((t) => t.label)).toEqual([
        "Repeat",
        "Up",
        "Down",
        "Up/Down",
        "Down/Up",
        "Played",
        "Random",
        "Chord",
      ]);
    });
  });

  describe("screens", () => {
    it("draws both screens with and without notes", () => {
      const h = arpHarness();
      h.press("noteRepeat");
      expect(() => h.render()).not.toThrow();
      h.pad(0);
      h.pad(2);
      h.touched.add(3);
      expect(() => h.render()).not.toThrow();
    });

    it("shows many notes without throwing (4 octaves of a chord)", () => {
      const h = arpHarness();
      h.pads.mode = "chords";
      h.press("noteRepeat");
      h.knob(3, 99999);
      for (let pad = 0; pad < 16; pad++) h.pad(pad);
      expect(() => h.render()).not.toThrow();
    });
  });
});

/** The notes of the arp's current round, as the right screen lists them. */
function sequenceNotes(h: StackHarness): number[] {
  return h.pages.noteRepeat.arp.engine.view().notes;
}
