import { describe, expect, it } from "vitest";
import { LED_OFF, paletteWhite } from "../src/hw/palette.js";
import { FLASH_MS } from "../src/modes/quickEdit.js";
import { shiftActionOf } from "../src/modes/shiftPads.js";
import { stackHarness } from "../src/tools/stackHarness.js";

const DIM = paletteWhite("dim");
const BRIGHT = paletteWhite("bright");

/** Maschine's pad numbers (1 = bottom-left) → 0-based pads. */
const pad = (n: number) => n - 1;

describe("SHIFT + pad: the action row", () => {
  it("maps Maschine's pads: 1 undo, 2 redo, 5/6 quantize, 9 clear, 11/12 copy/paste, 13–16 transpose", () => {
    const row = Array.from({ length: 16 }, (_, i) => shiftActionOf(i));
    expect(row).toEqual([
      "undo",
      "redo",
      undefined,
      undefined,
      "quantize",
      "quantizeStarts",
      undefined,
      undefined,
      "clear",
      undefined,
      "copy",
      "paste",
      "semitoneDown",
      "semitoneUp",
      "octaveDown",
      "octaveUp",
    ]);
  });

  it("sends the UI actions and CLEAR_STEPS for the selected channel", () => {
    const h = stackHarness({ selected: 3 });
    h.state.shift = true;
    for (const n of [1, 2, 5, 6, 9, 11, 12]) h.pad(pad(n));
    expect(h.sent).toEqual([
      { type: "ui", action: "undo" },
      { type: "ui", action: "redo" },
      { type: "ui", action: "quantize" },
      { type: "ui", action: "quantizeStarts" },
      { type: "clearSteps", channel: 3 },
      { type: "ui", action: "copy" },
      { type: "ui", action: "paste" },
    ]);
  });

  it("pads FL has no equivalent for do nothing: 3, 4, 7, 8 and 10", () => {
    const h = stackHarness();
    h.state.shift = true;
    for (const n of [3, 4, 7, 8, 10]) {
      h.pad(pad(n));
      h.pad(pad(n), "up");
    }
    expect(h.sent).toEqual([]);
    expect(h.midi).toEqual([]);
  });

  it("the pads don't play while SHIFT is held, not their move and release either", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.pad(0);
    h.pad(0, "move");
    h.pad(0, "up");
    h.pad(7);
    h.pad(7, "up");
    expect(h.midi).toEqual([]);
  });

  it("a pad held before SHIFT still ends its note", () => {
    const h = stackHarness();
    h.pad(4); // plays a note
    expect(h.midi).toHaveLength(1);
    h.state.shift = true;
    h.pad(4, "up");
    expect(h.midi).toHaveLength(2);
    expect(h.midi[1]?.[0]).toBe(0x80); // note off
  });

  it("after SHIFT is let go the pads play again, and a pad hit under SHIFT does not play on", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.pad(0);
    h.state.shift = false;
    h.pad(0, "up"); // the stack took this pad's down: its up is its own
    expect(h.midi).toEqual([]);
    h.pad(0);
    expect(h.midi).toHaveLength(1);
  });

  it("the action takes the pad before a page that uses the pads (STEP, PATTERN)", () => {
    const h = stackHarness();
    h.tap("step");
    h.state.shift = true;
    h.pad(0);
    expect(h.sentOf("setStep")).toEqual([]);
    expect(h.sent).toEqual([{ type: "ui", action: "undo" }]);
    h.state.shift = false;
    h.press("pattern");
    h.state.shift = true;
    h.pad(1);
    expect(h.sentOf("selectPattern")).toEqual([]);
  });

  it("only FL being connected makes it act", () => {
    const h = stackHarness();
    h.fl.reset();
    h.state.shift = true;
    h.pad(0);
    expect(h.sent).toEqual([]);
  });
});

describe("SHIFT + pad: once per press", () => {
  it("an action runs on the pad's down only, not on its re-reports while held", () => {
    const h = stackHarness({ selected: 1 });
    h.state.shift = true;
    h.pad(pad(1)); // undo
    for (let i = 0; i < 20; i++) h.pad(pad(1), "move"); // pressure re-reports, ~40 Hz while held
    h.pad(pad(1), "up");
    expect(h.sentOf("ui")).toEqual([{ type: "ui", action: "undo" }]);
    expect(h.log.filter((line) => line === "→ FL undo")).toHaveLength(1);
  });

  it("holds for each of the actions: clear, copy, paste, quantize and transpose", () => {
    const h = stackHarness({ selected: 1 });
    h.state.shift = true;
    for (const n of [5, 9, 11, 12, 16]) {
      h.pad(pad(n));
      h.pad(pad(n), "move");
      h.pad(pad(n), "move");
      h.pad(pad(n), "up");
    }
    expect(h.sent).toEqual([
      { type: "ui", action: "quantize" },
      { type: "clearSteps", channel: 1 },
      { type: "ui", action: "copy" },
      { type: "ui", action: "paste" },
      { type: "transpose", channel: 1, semitones: 12 }, // one octave, not three
    ]);
    expect(h.pads.baseNote).toBe(36); // the KEYBOARD base note is not moved
  });

  it("each new press is a new action", () => {
    const h = stackHarness();
    h.state.shift = true;
    for (let i = 0; i < 3; i++) {
      h.pad(pad(2));
      h.pad(pad(2), "up");
    }
    expect(h.sentOf("ui")).toHaveLength(3);
  });

  it("letting SHIFT go while the pad is held ends the action without running another", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.pad(pad(2));
    h.state.shift = false;
    h.pad(pad(2), "move");
    h.pad(pad(2), "up");
    expect(h.sentOf("ui")).toHaveLength(1);
    expect(h.midi).toEqual([]);
  });
});

describe("SHIFT + pad: feedback", () => {
  const card = (h: ReturnType<typeof stackHarness>) => h.stack.quickEdit.actionReadout(h.mc);

  it("shows the action big and the channel under it for clear, paste and quantize", () => {
    const h = stackHarness({ selected: 2 });
    h.state.shift = true;
    h.pad(pad(9));
    expect(card(h)).toEqual({ title: "CLEAR", detail: "Clap", small: "" });
    h.pad(pad(12));
    expect(card(h)).toMatchObject({ title: "PASTE", detail: "Clap" });
    h.pad(pad(5));
    expect(card(h)).toMatchObject({ title: "QUANTIZE", detail: "Clap" });
    h.pad(pad(6));
    expect(card(h)).toMatchObject({ title: "QUANT. STARTS", detail: "Clap" });
  });

  it("copy says how many steps of which channel", () => {
    const h = stackHarness({ selected: 0 });
    h.state.shift = true;
    h.pad(pad(11));
    expect(card(h)).toEqual({ title: "COPY", detail: "64 steps of Kick", small: "" });
  });

  it("undo and redo show FL's undo hint and position / count, as FL's answer arrives", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.pad(pad(1));
    // FL has not answered yet: no history known
    expect(card(h)).toEqual({ title: "UNDO", detail: "", small: "" });
    h.undoState(4, 9, "Pattern 2 cleared");
    expect(card(h)).toEqual({ title: "UNDO", detail: "Pattern 2 cleared", small: "4 / 9" });
    h.pad(pad(2));
    h.undoState(5, 9, "Step added");
    expect(card(h)).toEqual({ title: "REDO", detail: "Step added", small: "5 / 9" });
  });

  it("transpose shows TRANSPOSE, the amount and the channel", () => {
    const h = stackHarness({ selected: 2 });
    h.state.shift = true;
    h.pad(pad(16));
    expect(card(h)).toEqual({ title: "TRANSPOSE", detail: "+12 st", small: "", source: "Clap" });
    h.pad(pad(13));
    expect(card(h)).toMatchObject({ title: "TRANSPOSE", detail: "\u22121 st", source: "Clap" });
    h.pad(pad(15));
    expect(card(h)).toMatchObject({ detail: "\u221212 st" });
    h.pad(pad(14));
    expect(card(h)).toMatchObject({ detail: "+1 st" });
  });

  it("stays for FLASH_MS and each action starts the time again", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.pad(pad(1));
    h.advance(FLASH_MS - 100);
    expect(card(h)).toBeDefined();
    h.pad(pad(2));
    h.advance(FLASH_MS - 100);
    expect(card(h)).toMatchObject({ title: "REDO" });
    h.advance(200);
    expect(card(h)).toBeUndefined();
  });

  it("an action that does nothing shows nothing: no FL equivalent, unavailable", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.pad(pad(3));
    h.pad(pad(10));
    expect(card(h)).toBeUndefined();
    h.fl.reset();
    h.pad(pad(1));
    expect(card(h)).toBeUndefined();
  });

  it("goes when the 4D encoder edits a value or a quick-edit mode changes", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.pad(pad(1));
    h.state.shift = false;
    h.tap("tempo");
    expect(card(h)).toBeUndefined();
    h.state.shift = true;
    h.pad(pad(1));
    h.state.shift = false;
    h.turn(1);
    expect(card(h)).toBeUndefined();
  });

  it("asks for a redraw when it is shown", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.state.renders = 0;
    h.pad(pad(1));
    expect(h.state.renders).toBeGreaterThan(0);
  });

  it("is drawn over the middle of the left screen, over the value read-out", () => {
    const h = stackHarness();
    const before = h.render().left.getImageData(0, 0, 480, 272).data;
    h.state.shift = true;
    h.pad(pad(1));
    h.undoState(2, 3, "Clear");
    const after = h.render().left.getImageData(0, 0, 480, 272).data;
    let top = 272;
    let bottom = 0;
    for (let y = 0; y < 272; y++) {
      for (let x = 0; x < 480; x++) {
        const i = (y * 480 + x) * 4;
        if (before[i] === after[i] && before[i + 1] === after[i + 1]) continue;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    expect(top).toBeGreaterThan(20); // not over the tabs
    expect(bottom).toBeLessThan(272 - 60); // nor the knob labels
  });

  it("logs each action like the transport buttons", () => {
    const h = stackHarness({ selected: 2 });
    h.state.shift = true;
    for (const n of [1, 2, 5, 6, 9, 11, 12, 16]) h.pad(pad(n));
    expect(h.log.filter((line) => line.includes("→ FL") || line.startsWith("SHIFT"))).toEqual([
      "→ FL undo",
      "→ FL redo",
      "→ FL quantize (Clap)",
      "→ FL quantize starts (Clap)",
      "→ FL clear steps (Clap)",
      "→ FL copy steps (64 steps of Clap)",
      "→ FL paste steps (Clap)",
      "→ FL transpose +12 (Clap)",
    ]);
  });
});

describe("SHIFT + pad: transpose", () => {
  const AMOUNTS: Array<[number, number]> = [
    [13, -1],
    [14, 1],
    [15, -12],
    [16, 12],
  ];

  it("13–16 send TRANSPOSE for the selected channel: -1, +1, -12, +12 semitones", () => {
    const h = stackHarness({ selected: 4 });
    h.state.shift = true;
    for (const [n] of AMOUNTS) h.pad(pad(n));
    expect(h.sent).toEqual(
      AMOUNTS.map(([, semitones]) => ({ type: "transpose", channel: 4, semitones })),
    );
  });

  it("works in every pad mode, KEYBOARD, CHORDS and PAD MODE included", () => {
    for (const setup of [
      () => undefined,
      (h: ReturnType<typeof stackHarness>) => {
        h.tap("keyboard");
      },
      (h: ReturnType<typeof stackHarness>) => {
        h.tap("padMode");
        h.release("padMode");
      },
    ]) {
      const h = stackHarness({ selected: 1 });
      setup(h);
      h.state.shift = true;
      for (const [n] of AMOUNTS) h.pad(pad(n));
      expect(h.sentOf("transpose")).toEqual(
        AMOUNTS.map(([, semitones]) => ({ type: "transpose", channel: 1, semitones })),
      );
    }
  });

  it("the KEYBOARD base note is not moved by them", () => {
    const h = stackHarness();
    h.state.shift = true;
    for (const [n] of AMOUNTS) h.pad(pad(n));
    expect(h.pads.baseNote).toBe(36);
  });

  it("does nothing without a selected channel", () => {
    const h = stackHarness();
    h.fl.apply({
      type: "selectedChannel",
      index: null,
      color: 0,
      volume: 0,
      pan: 0,
      name: "",
      plugin: "",
    });
    h.state.shift = true;
    for (const [n] of AMOUNTS) h.pad(pad(n));
    expect(h.sent).toEqual([]);
  });
});

describe("SHIFT + pad: the LEDs", () => {
  it("show the row while SHIFT is held: available dim white, the rest off", () => {
    const h = stackHarness({ selected: 1 });
    h.state.shift = true;
    const leds = Array.from({ length: 16 }, (_, i) => h.padLed(i));
    expect(leds).toEqual(
      // pads 1 2 | 3 4 | 5 6 | 7 8 | 9 | 10 | 11 12 | 13 14 15 16
      [DIM, DIM, 0, 0, DIM, DIM, 0, 0, DIM, 0, DIM, DIM, DIM, DIM, DIM, DIM],
    );
  });

  it("the pressed one is bright while it is held", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.pad(pad(2));
    expect(h.padLed(pad(2))).toBe(BRIGHT);
    expect(h.padLed(pad(1))).toBe(DIM);
    h.pad(pad(2), "up");
    expect(h.padLed(pad(2))).toBe(DIM);
  });

  it("without SHIFT the pads show what they always did", () => {
    const h = stackHarness();
    const before = Array.from({ length: 16 }, (_, i) => h.padLed(i));
    expect(before.some((led) => led !== DIM && led !== 0)).toBe(true); // channel colors
    h.state.shift = true;
    h.state.shift = false;
    expect(Array.from({ length: 16 }, (_, i) => h.padLed(i))).toEqual(before);
  });

  it("an action that cannot run is dark: no selected channel", () => {
    const h = stackHarness();
    h.state.shift = true;
    expect(h.padLed(pad(5))).toBe(DIM);
    h.fl.apply({
      type: "selectedChannel",
      index: null,
      color: 0,
      volume: 0,
      pan: 0,
      name: "",
      plugin: "",
    });
    expect(h.padLed(pad(5))).toBe(LED_OFF); // quantize
    expect(h.padLed(pad(9))).toBe(LED_OFF); // clear
    expect(h.padLed(pad(1))).toBe(DIM); // undo does not need a channel
    h.pad(pad(5));
    h.pad(pad(9));
    expect(h.sent).toEqual([]);
    for (const n of [13, 14, 15, 16]) expect(h.padLed(pad(n))).toBe(LED_OFF); // transpose needs one
  });

  it("are off while FL is not connected", () => {
    const h = stackHarness();
    h.fl.reset();
    h.state.shift = true;
    expect(h.padLed(0)).toBe(LED_OFF);
  });
});

describe("SHIFT + pad: pages that use it themselves", () => {
  it("GRID keeps its pads while SHIFT is still down from opening it", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("follow"); // SHIFT + FOLLOW
    expect(h.stack.top?.page.id).toBe("grid");
    h.pad(0); // pad 1 would be undo
    h.pad(0, "up");
    expect(h.sentOf("setSnap")).toEqual([{ type: "setSnap", mode: 0 }]);
    expect(h.sentOf("ui")).toEqual([]);
    // GRID's own LEDs (the current snap, Step, is pad 8: the action row has nothing there)
    expect(h.padLed(7)).toBe(BRIGHT);
  });
});
