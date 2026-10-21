import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import { decodeCommand, encodeCommand, decodeSysex, encodeFlMessage } from "../src/fl/sysex.js";
import { paletteWhite } from "../src/hw/palette.js";
import { flColorToPalette, lengthText, positionStepsText } from "../src/modes/format.js";
import { HOLD_MS } from "../src/modes/pageStack.js";
import { defaultRange, markerSection, sanitize } from "../src/modes/loopOverlay.js";
import { MARKER_COLORS } from "../src/modes/markerPage.js";
import { PATTERN_COLORS, stepCommonLength } from "../src/modes/patternOverlay.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempPins = () => {
  const dir = mkdtempSync(join(tmpdir(), "mk3d-loop-"));
  dirs.push(dir);
  return join(dir, "pages.json");
};

const BAR = 384; // ticks at PPQ 96
const STEP = 24;
/** Markers every 4 bars from bar 1. */
const sections = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ticks: i * 4 * BAR, name: `Part ${i + 1}` }));

/** SHIFT + RESTART held until the LOOP overlay is open. */
function openLoop(h: StackHarness): void {
  h.state.shift = true;
  h.press("restart");
  h.advance(HOLD_MS);
}

const drawnText = (h: StackHarness) => {
  const left = createCanvas(480, 272).getContext("2d");
  const right = createCanvas(480, 272).getContext("2d");
  const result = { left: [] as string[], right: [] as string[] };
  for (const [ctx, into] of [
    [left, result.left],
    [right, result.right],
  ] as const) {
    const original = ctx.fillText.bind(ctx);
    ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      into.push(text);
      original(text, x, y, maxWidth);
    };
  }
  h.stack.render(left, right, h.mc);
  return result;
};

describe("text", () => {
  it("writes lengths and positions in bars and steps", () => {
    expect(lengthText(32)).toBe("2 bars");
    expect(lengthText(16)).toBe("1 bar");
    expect(lengthText(20)).toBe("1 bar 4 steps");
    expect(lengthText(6)).toBe("6 steps");
    expect(lengthText(1)).toBe("1 step");
    expect(positionStepsText(64)).toBe("bar 5");
    expect(positionStepsText(66)).toBe("5.3");
  });
});

describe("wire format of the new messages", () => {
  it("encodes SET_PATTERN_LENGTH with a u7 pattern and a u14 length", () => {
    expect(encodeCommand({ type: "setPatternLength", pattern: 3, length: 32 })).toEqual([
      0xf0, 0x7d, 0x4d, 0x33, 0x5f, 3, 0, 32, 0xf7,
    ]);
  });

  it("round-trips LOOP_STATE and FEATURES", () => {
    for (const message of [
      { type: "loopState", active: true, start: 1536, end: 3072 },
      { type: "features", patternLength: true, loop: true, browser: true, picker: false },
    ] as const) {
      expect(decodeSysex(encodeFlMessage(message))).toEqual(message);
    }
  });
});

describe("FlState: loop and features", () => {
  it("keeps LOOP_STATE and FEATURES and tells the sections only when they change", () => {
    const h = stackHarness();
    const sections: string[] = [];
    h.fl.on("change", (section) => sections.push(section));
    expect(h.fl.loop).toEqual({ active: false, start: 0, end: 0 });
    expect(h.fl.missing).toEqual({
      patternLength: false,
      loop: false,
      browser: false,
      picker: false,
    });
    h.loopState(true, 96, 192);
    h.loopState(true, 96, 192);
    h.features({ loop: true });
    h.features({ loop: true });
    expect(sections).toEqual(["loop", "features"]);
    expect(h.fl.loop).toEqual({ active: true, start: 96, end: 192 });
    expect(h.fl.missing).toEqual({
      patternLength: false,
      loop: true,
      browser: false,
      picker: false,
    });
    h.fl.apply({ type: "hello", version: 2 }); // a new script run forgets both
    expect(h.fl.loop.active).toBe(false);
    expect(h.fl.missing.loop).toBe(false);
  });
});

describe("SHIFT + RESTART: tap and hold", () => {
  it("opens the LOOP overlay after the hold time and closes it on release", () => {
    const h = stackHarness();
    h.state.shift = true;
    expect(h.press("restart")).toBe(true);
    h.advance(HOLD_MS - 1);
    expect(h.stack.top).toBeUndefined();
    h.advance(1);
    expect(h.stack.top?.page.id).toBe("loop");
    expect(h.sentOf("requestLoop")).toHaveLength(1);
    h.release("restart");
    expect(h.stack.top).toBeUndefined();
  });

  it("leaves a plain RESTART to the caller, with and without a connected FL", () => {
    const h = stackHarness();
    expect(h.press("restart")).toBe(false); // no SHIFT: main.ts restarts
    expect(h.release("restart")).toBe(false);
    expect(h.time.timerCount).toBe(0);
    h.state.shift = true;
    h.fl.apply({ type: "goodbye" });
    expect(h.press("restart")).toBe(false);
    expect(h.release("restart")).toBe(false);
  });

  it("does not touch REC", () => {
    const h = stackHarness();
    expect(h.press("rec")).toBe(false);
    h.advance(HOLD_MS * 2);
    expect(h.stack.top).toBeUndefined();
    h.state.shift = true;
    expect(h.press("rec")).toBe(false);
  });

  it("pins like any overlay: display 1 keeps it open after the release", () => {
    const pins = tempPins();
    const h = stackHarness({ pinsPath: pins });
    openLoop(h);
    h.tap("display1");
    h.release("restart");
    expect(h.stack.top?.page.id).toBe("loop");
    expect(h.stack.isPinned("loop")).toBe(true);
    expect(JSON.parse(readFileSync(pins, "utf8")).pinned.loop).toBe(true);
  });

  it("a tap toggles the loop with the remembered range and does not open the page", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("restart");
    h.advance(100);
    h.release("restart");
    h.advance(HOLD_MS * 2);
    expect(h.stack.top).toBeUndefined();
    // default: the first four bars
    expect(h.sentOf("setLoop")).toEqual([{ type: "setLoop", start: 0, end: 4 * BAR }]);
    expect(h.log).toContain("loop on: bar 1 – bar 5");
    // FL answers: the loop is active; the next tap clears it
    h.loopState(true, 0, 4 * BAR);
    h.advance(1000);
    h.press("restart");
    h.release("restart");
    expect(h.sentOf("setLoop")[1]).toEqual({ type: "setLoop", start: 0, end: 0 });
    expect(h.log).toContain("loop off: bar 1 – bar 5");
  });

  it("switches on again with the range it saw switched off, saved with the page state", () => {
    const pins = tempPins();
    let h = stackHarness({ pinsPath: pins });
    h.state.shift = true;
    h.loopState(true, 8 * BAR, 12 * BAR); // set in FL by hand
    h.press("restart");
    h.release("restart");
    expect(h.sentOf("setLoop")[0]).toEqual({ type: "setLoop", start: 0, end: 0 });
    h.loopState(false, 0, 0);
    h.advance(1000);
    h.press("restart");
    h.release("restart");
    expect(h.sentOf("setLoop")[1]).toEqual({ type: "setLoop", start: 8 * BAR, end: 12 * BAR });
    // a new mk3d has it back
    h = stackHarness({ pinsPath: pins });
    h.state.shift = true;
    h.press("restart");
    h.release("restart");
    expect(h.sentOf("setLoop")).toEqual([{ type: "setLoop", start: 8 * BAR, end: 12 * BAR }]);
  });

  it("defaults to the current marker's section when there are markers", () => {
    const h = stackHarness({ markers: sections(3) });
    h.songPos(6, 1); // in the second marker (bars 5–8)
    h.state.shift = true;
    h.press("restart");
    h.release("restart");
    expect(h.sentOf("setLoop")).toEqual([{ type: "setLoop", start: 4 * BAR, end: 8 * BAR }]);
  });

  it("says so and sends nothing when this FL has no selectionSet", () => {
    const h = stackHarness();
    h.features({ loop: true });
    h.state.shift = true;
    h.press("restart");
    h.release("restart");
    expect(h.sentOf("setLoop")).toEqual([]);
    expect(h.log).toContain("loop: not available in this FL version");
    openLoop(h);
    expect(drawnText(h).left).toContain("Not available in this FL version");
    h.knob(0, 120);
    h.tap("display2");
    expect(h.sentOf("setLoop")).toEqual([]);
  });

  it("a hold timer does not outlive the device", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("restart");
    h.stack.releasePads();
    expect(h.time.timerCount).toBe(0);
  });

  it("RESTART's own LED is the caller's: the stack leaves it alone", () => {
    const h = stackHarness();
    expect(h.stack.top).toBeUndefined();
    expect(h.light("restart")).toBe("off");
  });
});

describe("the LOOP overlay", () => {
  it("knob 1 moves the loop by bars and keeps its length, SHIFT by steps", () => {
    const h = stackHarness();
    h.loopState(true, 4 * BAR, 8 * BAR);
    openLoop(h);
    h.state.shift = false; // opening it takes SHIFT; release it for bars
    h.knob(0, 120);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 5 * BAR, end: 9 * BAR });
    h.knob(0, -240);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 3 * BAR, end: 7 * BAR });
    h.state.shift = true;
    h.knob(0, 120);
    expect(h.sentOf("setLoop").at(-1)).toEqual({
      type: "setLoop",
      start: 3 * BAR + STEP,
      end: 7 * BAR + STEP,
    });
  });

  it("knob 2 sets the length; the loop stays at least a step and starts at bar 1 or later", () => {
    const h = stackHarness();
    h.loopState(true, 0, 4 * BAR);
    openLoop(h);
    h.state.shift = false;
    h.knob(1, 240);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 0, end: 6 * BAR });
    h.knob(1, -120 * 10);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 0, end: STEP });
    h.knob(0, -1200);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 0, end: STEP });
  });

  it("accumulates turns below a detent and keeps its own values until FL answers", () => {
    const h = stackHarness();
    h.loopState(true, 0, 4 * BAR);
    openLoop(h);
    h.state.shift = false;
    h.knob(0, 60);
    expect(h.sentOf("setLoop")).toHaveLength(0);
    h.knob(0, 60);
    expect(h.sentOf("setLoop")).toHaveLength(1);
    // FL has not answered: the next turn builds on ours, not on the old state
    h.knob(0, 120);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 2 * BAR, end: 6 * BAR });
    // once FL answers with something else, that wins after the pending time
    h.advance(1000);
    h.loopState(true, 10 * BAR, 12 * BAR);
    h.knob(0, 120);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 11 * BAR, end: 13 * BAR });
  });

  it("4D turn moves the whole loop; tilt picks the start or the end", () => {
    const h = stackHarness();
    h.loopState(true, 4 * BAR, 8 * BAR);
    openLoop(h);
    h.state.shift = false;
    h.turn(1);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 5 * BAR, end: 9 * BAR });
    h.advance(1000);
    h.loopState(true, 5 * BAR, 9 * BAR);
    h.tilt("left"); // PREV: the start
    h.turn(-1);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 4 * BAR, end: 9 * BAR });
    h.tilt("left", false);
    h.advance(1000);
    h.loopState(true, 4 * BAR, 9 * BAR);
    h.tilt("right"); // NEXT: the end
    h.turn(2);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 4 * BAR, end: 11 * BAR });
    h.advance(1000);
    h.loopState(true, 4 * BAR, 11 * BAR);
    h.tilt("right"); // the same again: the whole loop
    h.turn(1);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 5 * BAR, end: 12 * BAR });
    h.state.shift = true;
    h.advance(1000);
    h.loopState(true, 5 * BAR, 12 * BAR);
    h.turn(1);
    expect(h.sentOf("setLoop").at(-1)).toEqual({
      type: "setLoop",
      start: 5 * BAR + STEP,
      end: 12 * BAR + STEP,
    });
  });

  it("display 2 toggles the loop and display 3 clears it and forgets the range", () => {
    const h = stackHarness();
    h.loopState(true, 4 * BAR, 8 * BAR);
    openLoop(h);
    h.tap("display2");
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 0, end: 0 });
    h.advance(1000);
    h.loopState(false, 0, 0);
    h.tap("display2"); // on again with the remembered range
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 4 * BAR, end: 8 * BAR });
    h.advance(1000);
    h.loopState(true, 4 * BAR, 8 * BAR);
    h.tap("display3"); // CLEAR
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 0, end: 0 });
    h.advance(1000);
    h.loopState(false, 0, 0);
    h.tap("display2"); // the range is forgotten: the first four bars
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 0, end: 4 * BAR });
  });

  it("the pads set the loop to a marker's section, the last one to four bars", () => {
    const h = stackHarness({ markers: sections(3) });
    openLoop(h); // SHIFT still down: the pads are the page's
    h.pad(1);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 4 * BAR, end: 8 * BAR });
    h.pad(2);
    expect(h.sentOf("setLoop").at(-1)).toEqual({ type: "setLoop", start: 8 * BAR, end: 12 * BAR });
    expect(h.midi).toEqual([]); // no pad played a note
    h.pad(3); // no marker there
    expect(h.sentOf("setLoop")).toHaveLength(2);
  });

  it("lights the looped marker's pad bright and the others dim; ON/OFF follows the loop", () => {
    const h = stackHarness({ markers: sections(3) });
    openLoop(h);
    expect(h.padLed(1)).toBe(flColorToPalette(MARKER_COLORS[1] ?? 0, "dim"));
    h.loopState(true, 4 * BAR, 8 * BAR);
    expect(h.padLed(1)).toBe(flColorToPalette(MARKER_COLORS[1] ?? 0, "bright"));
    expect(h.padLed(0)).toBe(flColorToPalette(MARKER_COLORS[0] ?? 0, "dim"));
    expect(h.padLed(5)).toBe(0);
    expect(h.light("display2")).toBe("bright");
    h.loopState(false, 0, 0);
    expect(h.light("display2")).toBe("dim");
    expect(h.light("display3")).toBe("dim");
  });

  it("draws the range big, its length, and the ruler without markers", () => {
    const h = stackHarness();
    h.loopState(true, 4 * BAR, 8 * BAR);
    openLoop(h);
    const text = drawnText(h);
    expect(text.left).toContain("bar 5 – bar 9");
    expect(text.left).toContain("4 bars");
    expect(text.left).toContain("Start");
    expect(text.left).toContain("Length");
    expect(text.right).toContain("Bars");
  });

  it("draws the marker grid with markers", () => {
    const h = stackHarness({ markers: sections(3) });
    h.loopState(true, 4 * BAR, 8 * BAR);
    openLoop(h);
    const text = drawnText(h);
    expect(text.right).toContain("Part 2");
    expect(text.right).toContain("Bar 5");
  });

  it("works out sections, defaults and sane ranges", () => {
    const h = stackHarness({
      markers: [...sections(2), { ticks: null as unknown as number, name: "?" }],
    });
    expect(markerSection(h.fl, 0)).toEqual({ start: 0, end: 64 });
    expect(markerSection(h.fl, 1)).toEqual({ start: 64, end: 128 });
    expect(defaultRange(stackHarness().fl)).toEqual({ start: 0, end: 64 });
    expect(sanitize(-5, -3)).toEqual({ start: 0, end: 1 });
    expect(sanitize(10, 10)).toEqual({ start: 10, end: 11 });
    expect(sanitize(0, 99999)).toEqual({ start: 0, end: 4096 });
  });
});

describe("PATTERN: LENGTH on knob 4", () => {
  const open = (h: StackHarness) => h.press("pattern");

  it("one detent is the next common length, SHIFT a step, and the unused knobs fall through", () => {
    const h = stackHarness({ patternLength: 64 });
    open(h);
    h.state.shift = false;
    h.knob(3, 120);
    expect(h.sentOf("setPatternLength")).toEqual([
      { type: "setPatternLength", pattern: 1, length: 128 },
    ]);
    h.advance(1000);
    h.patternInfo({ length: 128 });
    h.knob(3, -120);
    expect(h.sentOf("setPatternLength").at(-1)?.length).toBe(64);
    h.state.shift = true;
    h.advance(1000);
    h.patternInfo({ length: 64 });
    h.knob(3, 120);
    expect(h.sentOf("setPatternLength").at(-1)).toEqual({
      type: "setPatternLength",
      pattern: 1,
      length: 65,
    });
    h.knob(3, -120); // builds on our 65
    expect(h.sentOf("setPatternLength").at(-1)?.length).toBe(64);
    h.state.shift = false;
    h.knob(1, 120); // FL has no pattern position or start offset: these go to the page below
    h.knob(2, 120);
    expect(h.sentOf("setPatternLength")).toHaveLength(4);
    expect(h.sentOf("setPatternColor")).toHaveLength(0);
  });

  it("walks the list 16 32 64 128 256 512, several detents at once", () => {
    const h = stackHarness({ patternLength: 16 });
    open(h);
    h.knob(3, 360); // three detents
    expect(h.sentOf("setPatternLength").map((c) => c.length)).toEqual([128]);
    h.advance(1000);
    h.patternInfo({ length: 128 });
    h.knob(3, -240);
    expect(h.sentOf("setPatternLength").at(-1)?.length).toBe(32);
    expect(stepCommonLength(16, 5)).toBe(512);
    expect(stepCommonLength(512, -5)).toBe(16);
  });

  it("snaps an odd length to the nearest list value in the direction of the turn", () => {
    expect(stepCommonLength(33, 1)).toBe(64);
    expect(stepCommonLength(33, -1)).toBe(32);
    expect(stepCommonLength(33, 2)).toBe(128);
    expect(stepCommonLength(33, -2)).toBe(16);
    expect(stepCommonLength(1, 1)).toBe(16);
    expect(stepCommonLength(17, -1)).toBe(16);
    expect(stepCommonLength(100, 1)).toBe(128);
    expect(stepCommonLength(100, -1)).toBe(64);
  });

  it("stops at both ends of the list, and SHIFT is clamped to 1 … 512 steps", () => {
    const h = stackHarness({ patternLength: 16 });
    open(h);
    h.knob(3, -120);
    expect(h.sentOf("setPatternLength")).toEqual([]); // nothing below 16 bars-wise
    h.patternInfo({ length: 512 });
    h.knob(3, 120);
    expect(h.sentOf("setPatternLength")).toEqual([]);
    h.state.shift = true;
    h.patternInfo({ length: 511 });
    h.advance(1000);
    h.knob(3, 240);
    expect(h.sentOf("setPatternLength").at(-1)?.length).toBe(512);
    h.advance(1000);
    h.patternInfo({ length: 2 });
    h.knob(3, -360);
    expect(h.sentOf("setPatternLength").at(-1)?.length).toBe(1);
    const sent = h.sentOf("setPatternLength").length;
    h.advance(1000);
    h.patternInfo({ length: 1 });
    h.knob(3, -120);
    expect(h.sentOf("setPatternLength")).toHaveLength(sent);
  });

  it("keeps its own value until FL answers", () => {
    const h = stackHarness({ patternLength: 64 });
    open(h);
    h.knob(3, 120);
    h.knob(3, 120); // FL still says 64: builds on 128
    expect(h.sentOf("setPatternLength").map((c) => c.length)).toEqual([128, 256]);
    expect(drawnText(h).left).toContain("16 bars");
    h.advance(1000);
    h.patternInfo({ length: 256 });
    expect(drawnText(h).left).toContain("16 bars");
  });

  it("resizes only patterns 1…127 and only when FL has the function", () => {
    const h = stackHarness({ patternLength: 64 });
    open(h);
    h.patternInfo({ number: 128 });
    h.knob(3, 120);
    expect(h.sentOf("setPatternLength")).toEqual([]);
    expect(drawnText(h).left).toContain("Patterns from 128 up cannot be resized");
    h.patternInfo({ number: 4 });
    h.features({ patternLength: true });
    h.knob(3, 120);
    expect(h.sentOf("setPatternLength")).toEqual([]);
    const text = drawnText(h).left;
    expect(text).toContain("Not available in this FL version");
    expect(text).toContain("n/a");
    h.features({});
    h.knob(3, 120);
    expect(h.sentOf("setPatternLength")).toEqual([
      { type: "setPatternLength", pattern: 4, length: 128 },
    ]);
  });

  it("draws the pattern's length on the knob under the left screen", () => {
    const h = stackHarness({ patternLength: 36 });
    open(h);
    const text = drawnText(h);
    expect(text.left).toContain("LENGTH");
    expect(text.left).toContain("2 bars 4 steps");
    expect(text.left).toContain("COLOR");
    expect(text.right).not.toContain("LENGTH");
  });
});

describe("PATTERN: DOUBLE", () => {
  const open = (h: StackHarness) => h.press("pattern");

  it("encodes DOUBLE_PATTERN and CREATE_PATTERN", () => {
    expect(encodeCommand({ type: "doublePattern", pattern: 3 })).toEqual([
      0xf0, 0x7d, 0x4d, 0x33, 0x63, 3, 0xf7,
    ]);
    expect(encodeCommand({ type: "createPattern", number: 300 })).toEqual([
      0xf0, 0x7d, 0x4d, 0x33, 0x64, 2, 0x2c, 0xf7,
    ]);
  });

  it("display 3 sends DOUBLE_PATTERN for the current pattern and shows the read-out card", () => {
    const h = stackHarness({ patternLength: 16, selected: 0 });
    h.patternInfo({ number: 2 });
    open(h);
    h.tap("display3");
    expect(h.sentOf("doublePattern")).toEqual([{ type: "doublePattern", pattern: 2 }]);
    expect(h.sentOf("clonePattern")).toEqual([]);
    const text = drawnText(h).left;
    expect(text).toContain("DOUBLE");
    expect(text).toContain("16 -> 32 steps");
    expect(text).toContain("notes copied");
    h.patternInfo({ length: 32 });
    expect(drawnText(h).left).toContain("2 bars");
    h.advance(5000);
    expect(drawnText(h).left).not.toContain("notes copied");
  });

  it("DOUBLE_PATTERN has an optional trailing mode byte (1 = only FL's duplicatePatternData)", () => {
    expect(encodeCommand({ type: "doublePattern", pattern: 3, native: true })).toEqual([
      0xf0, 0x7d, 0x4d, 0x33, 0x63, 3, 1, 0xf7,
    ]);
    expect(
      decodeCommand(encodeCommand({ type: "doublePattern", pattern: 3, native: true })),
    ).toEqual({
      type: "doublePattern",
      pattern: 3,
      native: true,
    });
  });

  it("is lit while it can double, dim and inert at 512 steps and for patterns above 127", () => {
    const h = stackHarness({ patternLength: 256 });
    open(h);
    expect(h.light("display3")).toBe("dim");
    h.tap("display3");
    expect(h.sentOf("doublePattern")).toHaveLength(1);
    h.advance(10000);
    h.patternInfo({ length: 512 });
    expect(h.light("display3")).toBe("off");
    h.tap("display3");
    expect(h.sentOf("doublePattern")).toHaveLength(1);
    expect(() => drawnText(h)).not.toThrow();
    h.patternInfo({ length: 16, number: 128 });
    expect(h.light("display3")).toBe("off");
    h.tap("display3");
    expect(h.sentOf("doublePattern")).toHaveLength(1);
  });

  it("keeps DUPLICATE and CREATE where they were", () => {
    const h = stackHarness({ patternLength: 16 });
    open(h);
    h.tap("display4");
    h.tap("display5");
    expect(h.sentOf("clonePattern")).toHaveLength(1);
    expect(h.sentOf("newPattern")).toHaveLength(1);
  });
});

describe("PATTERN: free slots", () => {
  it("shows + in the empty cells with their numbers, and lights the pads dim white", () => {
    const h = stackHarness({ patternCount: 6 });
    h.press("pattern");
    const right = drawnText(h).right;
    expect(right.filter((t) => t === "+")).toHaveLength(10);
    expect(right).toContain("7");
    expect(right).toContain("16");
    expect(h.padLed(5)).not.toBe(h.padLed(6));
    expect(h.padLed(6)).toBe(paletteWhite("dim"));
    expect(h.padLed(15)).toBe(paletteWhite("dim"));
  });

  it("a press on a free pad creates that pattern; a pad with a pattern selects it", () => {
    const h = stackHarness({ patternCount: 6 });
    h.press("pattern");
    h.pad(6);
    h.pad(2);
    expect(h.sentOf("createPattern")).toEqual([{ type: "createPattern", number: 7 }]);
    expect(h.sentOf("selectPattern")).toEqual([{ type: "selectPattern", number: 3 }]);
  });
});

describe("PATTERN: COLOR on page 1, next to LENGTH", () => {
  it("shows COLOR (knob 1) and LENGTH (knob 4) together, with no second page", () => {
    const h = stackHarness();
    h.press("pattern");
    const text = drawnText(h).left;
    expect(text).toContain("COLOR");
    expect(text).toContain("LENGTH");
    expect(text).not.toContain("page");
  });

  it("knob 1 cycles FL's colours, in both directions, with wrap-around; knob 4 stays the length", () => {
    const h = stackHarness();
    h.patternInfo({ color: PATTERN_COLORS[2]?.color ?? 0 });
    h.press("pattern");
    h.knob(3, 120);
    expect(h.sentOf("setPatternLength")).toHaveLength(1);
    expect(h.sentOf("setPatternColor")).toEqual([]);
    h.knob(0, 120);
    expect(h.sentOf("setPatternColor")).toEqual([
      { type: "setPatternColor", pattern: 1, color: PATTERN_COLORS[3]?.color },
    ]);
    h.knob(0, -240); // builds on ours: 3 → 1
    expect(h.sentOf("setPatternColor").at(-1)?.color).toBe(PATTERN_COLORS[1]?.color);
    h.advance(1000);
    h.patternInfo({ color: PATTERN_COLORS[0]?.color ?? 0 });
    h.knob(0, -120);
    expect(h.sentOf("setPatternColor").at(-1)?.color).toBe(PATTERN_COLORS.at(-1)?.color);
    expect(drawnText(h).left).toContain("Grey");
  });

  it("a colour that is not on the list is Custom and starts the cycle at its ends", () => {
    const h = stackHarness();
    h.patternInfo({ color: 0x123456 });
    h.press("pattern");
    expect(drawnText(h).left).toContain("Custom");
    h.knob(0, 120);
    expect(h.sentOf("setPatternColor")[0]?.color).toBe(PATTERN_COLORS[0]?.color);
    h.advance(1000);
    h.knob(0, -120);
    expect(h.sentOf("setPatternColor")[1]?.color).toBe(PATTERN_COLORS.at(-1)?.color);
  });
});
