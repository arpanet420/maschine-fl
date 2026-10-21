import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL_NOTE_CHANNEL } from "../src/fl/protocol.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempPins = () => {
  const dir = mkdtempSync(join(tmpdir(), "mk3d-noterepeat-"));
  dirs.push(dir);
  return join(dir, "pages.json");
};

/** NOTE REPEAT in PAD MODE (in KEYBOARD and CHORDS the overlay is the arpeggiator: test/arp.test.ts). */
const repeatHarness = (options: Parameters<typeof stackHarness>[0] = {}) => {
  const h = stackHarness(options);
  h.pads.mode = "channels";
  return h;
};

/** Note events as [kind, channel, note, velocity]. */
const notes = (h: StackHarness) =>
  h.midi
    .filter((bytes) => [0x80, 0x90].includes((bytes[0] ?? 0) & 0xf0))
    .map((bytes) => [
      (bytes[0] ?? 0) & 0xf0 ? (((bytes[0] ?? 0) & 0xf0) === 0x90 ? "on" : "off") : "",
      (bytes[0] ?? 0) & 0x0f,
      bytes[1],
      bytes[2],
    ]);
const ons = (h: StackHarness) => notes(h).filter((n) => n[0] === "on");

/** Every on has an off, and no pad's note is on twice. */
function expectBalanced(h: StackHarness): void {
  const on = new Set<string>();
  for (const [kind, channel, note] of notes(h)) {
    const key = `${String(channel)}:${String(note)}`;
    if (kind === "on") {
      expect(on.has(key)).toBe(false);
      on.add(key);
    } else {
      expect(on.has(key)).toBe(true);
      on.delete(key);
    }
  }
  expect([...on]).toEqual([]);
}

describe("NOTE REPEAT overlay", () => {
  it("is a hold overlay with a pin tab", () => {
    const h = repeatHarness();
    h.press("noteRepeat");
    expect(h.stack.top?.page.id).toBe("noteRepeat");
    h.release("noteRepeat");
    expect(h.stack.top).toBeUndefined();
    h.press("noteRepeat");
    h.tap("display1");
    h.release("noteRepeat");
    expect(h.stack.top?.page.id).toBe("noteRepeat");
    expect(h.stack.isPinned("noteRepeat")).toBe(true);
    h.press("noteRepeat");
    h.tap("display1"); // unpin while held
    h.release("noteRepeat");
    expect(h.stack.top).toBeUndefined();
  });

  it("lights the NOTE REPEAT button bright while open, dim otherwise", () => {
    const h = repeatHarness();
    expect(h.light("noteRepeat")).toBe("dim");
    h.press("noteRepeat");
    expect(h.light("noteRepeat")).toBe("bright");
    h.release("noteRepeat");
    expect(h.light("noteRepeat")).toBe("dim");
  });

  describe("basics", () => {
    it("repeats a held pad's channel until it is released", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.pad(2, "down", { velocity: 0.5, pressure: 0.5 });
      expect(ons(h)).toEqual([["on", CHANNEL_NOTE_CHANNEL, 2, 64]]); // the hit velocity
      h.pad(2, "move", { pressure: 0.25 });
      h.advance(130); // 1/16 at 120 BPM: a repeat every 125 ms
      h.advance(125);
      expect(ons(h)).toEqual([
        ["on", CHANNEL_NOTE_CHANNEL, 2, 64],
        ["on", CHANNEL_NOTE_CHANNEL, 2, 32], // the pad's pressure
        ["on", CHANNEL_NOTE_CHANNEL, 2, 32],
      ]);
      h.pad(2, "up");
      const count = h.midi.length;
      h.advance(2000);
      expect(h.midi).toHaveLength(count);
      expectBalanced(h);
    });

    it("plays no aftertouch and no single note while repeating", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.pad(0, "down");
      h.pad(0, "move", { pressure: 0.9 });
      expect(h.midi.filter((bytes) => ((bytes[0] ?? 0) & 0xf0) === 0xa0)).toEqual([]);
    });

    it("repeats several held pads in sync", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.pad(0);
      h.advance(40);
      h.pad(1);
      h.advance(100); // 140: the slot at 125 played for both
      const second = ons(h).filter((n) => n[2] === 1);
      expect(second).toHaveLength(2);
      expect(ons(h).filter((n) => n[2] === 0)).toHaveLength(2);
      h.pad(0, "up");
      h.pad(1, "up");
      h.advance(500);
      expectBalanced(h);
    });
  });

  describe("PAD MODE", () => {
    it("repeats the pad's channel (MIDI channel 2, note = channel index) and selects it", () => {
      const h = repeatHarness({ selected: 0 });
      h.pads.mode = "channels";
      h.press("noteRepeat");
      h.pad(3, "down", { velocity: 1 });
      h.advance(130);
      expect(ons(h)).toEqual([
        ["on", CHANNEL_NOTE_CHANNEL, 3, 127],
        ["on", CHANNEL_NOTE_CHANNEL, 3, 64],
      ]);
      expect(h.sentOf("selectChannel")).toEqual([{ type: "selectChannel", index: 3 }]);
      h.pad(3, "up");
      h.advance(500);
      expect(ons(h)).toHaveLength(2);
      expectBalanced(h);
    });

    it("leaves a pad with no channel silent", () => {
      const h = repeatHarness({ channels: 4 });
      h.pads.mode = "channels";
      h.press("noteRepeat");
      h.pad(9);
      h.advance(500);
      expect(h.midi).toEqual([]);
    });
  });

  describe("stopping", () => {
    it("closing the overlay ends the repeats and the note, even with the pad still down", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.pad(0);
      h.advance(130);
      h.release("noteRepeat");
      expect(h.stack.top).toBeUndefined();
      expectBalanced(h);
      const count = h.midi.length;
      h.pad(0, "move", { pressure: 0.7 });
      h.advance(1000);
      h.pad(0, "up");
      h.advance(500);
      expect(h.midi).toHaveLength(count);
      expect(h.pads.isHeld(0)).toBe(false);
    });

    it("unpinning ends the repeats", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.tap("display1");
      h.release("noteRepeat");
      h.pad(0);
      h.advance(130);
      h.tap("display1");
      expect(h.stack.top).toBeUndefined();
      const count = h.midi.length;
      h.advance(500);
      expect(h.midi).toHaveLength(count);
      expectBalanced(h);
    });

    it("another page replacing it ends the repeats, and the STEP page's pads are steps", () => {
      const h = repeatHarness({ selected: 0 });
      h.press("noteRepeat");
      h.tap("display1");
      h.release("noteRepeat");
      h.pad(0);
      h.advance(130);
      h.tap("step");
      expect(h.stack.top?.page.id).toBe("step");
      expectBalanced(h);
      const count = h.midi.length;
      h.pad(1); // a step pad
      h.advance(1000);
      h.pad(1, "up");
      expect(h.midi).toHaveLength(count);
      expect(h.sentOf("setStep").length).toBeGreaterThan(0);
    });

    it("a lost device or FL ends the repeats", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.pad(0);
      h.pad(5);
      h.advance(300);
      h.pads.releaseAll();
      h.stack.releasePads();
      expectBalanced(h);
      const count = h.midi.length;
      h.advance(1000);
      expect(h.midi).toHaveLength(count);
      expect(h.time.timerCount).toBe(0);
    });

    it("keeps no note on with a full gate and swing", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.knob(1, 2000); // gate to 100 %
      h.knob(2, 2000); // swing to 50 %
      h.pad(0);
      h.advance(40);
      h.pad(1);
      h.advance(1000);
      h.release("noteRepeat");
      h.advance(500);
      expectBalanced(h);
    });
  });

  describe("shared pads", () => {
    it("SHIFT + pad runs its action and never repeats", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.state.shift = true;
      h.pad(0);
      h.advance(500);
      h.pad(0, "up");
      expect(h.midi).toEqual([]);
    });

    it("ERASE + pad clears the channel's steps (PAD MODE) and never repeats", () => {
      const h = repeatHarness({ selected: 0 });
      h.pads.mode = "channels";
      h.press("noteRepeat");
      h.press("erase");
      h.pad(2);
      h.advance(500);
      h.pad(2, "up");
      expect(h.midi).toEqual([]);
      expect(h.sentOf("clearSteps")).toEqual([{ type: "clearSteps", channel: 2 }]);
    });

    it("GROUP A–H still pick the bank", () => {
      const h = repeatHarness({ channels: 40 });
      h.pads.mode = "channels";
      h.press("noteRepeat");
      h.tap("groupB");
      expect(h.sentOf("selectChannel").at(-1)).toEqual({ type: "selectChannel", index: 16 });
    });

    it("flashes a repeating pad with each repeat", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      const idle = h.padLed(0);
      h.pad(0);
      const sounding = h.padLed(0);
      expect(sounding).not.toBe(idle);
      h.advance(70); // the gate (50 % of 125 ms) is over
      expect(h.padLed(0)).toBe(idle);
      h.advance(60);
      expect(h.padLed(0)).toBe(sounding);
    });
  });

  describe("settings", () => {
    it("starts at 1/16, gate 50 %, swing 0", () => {
      const h = repeatHarness();
      expect(h.pages.noteRepeat.settings).toEqual({ rate: 2, gate: 0.5, swing: 0 });
    });

    it("display 2–8 pick the rate", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      const ids = [
        "display2",
        "display3",
        "display4",
        "display5",
        "display6",
        "display7",
        "display8",
      ] as const;
      ids.forEach((id, rate) => {
        h.tap(id);
        expect(h.pages.noteRepeat.settings.rate).toBe(rate);
      });
    });

    it("the rate changes the interval of a running repeat", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.pad(0);
      h.tap("display3"); // 1/8: 250 ms
      h.advance(255);
      h.advance(250);
      expect(ons(h)).toHaveLength(3);
    });

    it("knob 1 steps through the rates, knob 2 sets the gate, knob 3 the swing", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      const { settings } = h.pages.noteRepeat;
      h.knob(0, 60);
      expect(settings.rate).toBe(2); // half a step: not yet
      h.knob(0, 60);
      expect(settings.rate).toBe(3);
      h.knob(0, -360);
      expect(settings.rate).toBe(0);
      h.knob(0, 5000);
      expect(settings.rate).toBe(6);
      h.knob(1, 120);
      expect(settings.gate).toBeCloseTo(0.5 + 0.1 * 0.9, 6);
      h.knob(1, 99999);
      expect(settings.gate).toBe(1);
      h.knob(1, -99999);
      expect(settings.gate).toBeCloseTo(0.1, 6);
      h.knob(2, 120);
      expect(settings.swing).toBeCloseTo(0.05, 6);
      h.knob(2, 99999);
      expect(settings.swing).toBe(0.5);
      h.knob(2, -99999);
      expect(settings.swing).toBe(0);
    });

    it("gate and swing change the timing of the repeats", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.knob(2, 1200 * 0.4); // swing 0.2 → the second repeat at 150 ms
      h.pad(0);
      h.advance(140);
      expect(ons(h)).toHaveLength(1);
      h.advance(15);
      expect(ons(h)).toHaveLength(2);
    });

    it("knobs 4–8 are left to the page underneath", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      h.knob(3, 5000);
      h.knob(7, 5000);
      expect(h.pages.noteRepeat.settings).toEqual({ rate: 2, gate: 0.5, swing: 0 });
    });

    it("are saved with the page stack and loaded again", () => {
      const pinsPath = tempPins();
      const first = repeatHarness({ pinsPath });
      first.press("noteRepeat");
      first.tap("display7"); // 1/16T
      first.knob(1, 1200 * 0.2); // gate
      first.knob(2, 1200 * 0.2); // swing
      first.advance(1000); // the knob turns are written after a pause
      const saved = JSON.parse(readFileSync(pinsPath, "utf8")) as {
        pages: { noteRepeat: { rate: number; gate: number; swing: number } };
      };
      expect(saved.pages.noteRepeat.rate).toBe(5);
      const second = repeatHarness({ pinsPath });
      expect(second.pages.noteRepeat.settings.rate).toBe(5);
      expect(second.pages.noteRepeat.settings.gate).toBeCloseTo(
        first.pages.noteRepeat.settings.gate,
        9,
      );
      expect(second.pages.noteRepeat.settings.swing).toBeCloseTo(0.1, 9);
    });

    it("saves a knob turn when the overlay closes before the pause is over", () => {
      const pinsPath = tempPins();
      const first = repeatHarness({ pinsPath });
      first.press("noteRepeat");
      first.knob(1, 1200 * 0.2);
      first.release("noteRepeat");
      const second = repeatHarness({ pinsPath });
      expect(second.pages.noteRepeat.settings.gate).toBeCloseTo(0.5 + 0.2 * 0.9, 6);
    });

    it("ignores a damaged settings file", () => {
      const pinsPath = tempPins();
      const first = repeatHarness({ pinsPath });
      first.press("noteRepeat");
      first.tap("display5");
      first.release("noteRepeat");
      const h = repeatHarness({ pinsPath });
      expect(h.pages.noteRepeat.settings.rate).toBe(3);
      h.pages.noteRepeat.persisted.load({ rate: "fast", gate: 7, swing: -1 });
      expect(h.pages.noteRepeat.settings).toEqual({ rate: 3, gate: 1, swing: 0 });
    });
  });

  describe("tempo and transport", () => {
    it("follows FL's tempo", () => {
      const h = repeatHarness({ tempo: 60 });
      h.press("noteRepeat");
      h.pad(0);
      h.advance(240);
      expect(ons(h)).toHaveLength(1);
      h.advance(20); // 1/16 at 60 BPM: 250 ms
      expect(ons(h)).toHaveLength(2);
      h.transport({ tempo: 240 }); // 62.5 ms
      h.advance(130);
      expect(ons(h).length).toBeGreaterThanOrEqual(4);
    });

    it("aligns to FL's grid while it plays", () => {
      const h = repeatHarness({ tempo: 120 });
      h.playing(true);
      h.songPos(1, 1, 0); // bar 1 now
      h.advance(30);
      h.press("noteRepeat");
      h.pad(0);
      h.advance(80); // 110 ms into the song: the slot at 125 has not played
      expect(ons(h)).toHaveLength(1);
      h.advance(20);
      expect(ons(h)).toHaveLength(2);
    });
  });

  describe("screens", () => {
    it("draws both screens", () => {
      const h = repeatHarness();
      h.press("noteRepeat");
      expect(() => h.render()).not.toThrow();
    });
  });
});
