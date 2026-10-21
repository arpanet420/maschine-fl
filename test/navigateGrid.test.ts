import { describe, expect, it } from "vitest";
import { paletteWhite } from "../src/hw/palette.js";
import { SNAP_VALUES, snapName } from "../src/modes/gridOverlay.js";
import { stackHarness } from "../src/tools/stackHarness.js";

const DIM = paletteWhite("dim");
const BRIGHT = paletteWhite("bright");

describe("NAVIGATE (SHIFT + VARIATION)", () => {
  it("opens while held, closes on release, pins with display button 1", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("variation");
    expect(h.stack.top?.page.id).toBe("navigate");
    expect(h.light("variation")).toBe("bright");
    h.state.shift = false;
    h.release("variation");
    expect(h.stack.top).toBeUndefined();
    h.state.shift = true;
    h.press("variation");
    h.press("display1"); // the pin tab
    h.release("display1");
    h.release("variation");
    expect(h.stack.top?.page.id).toBe("navigate");
    expect(h.stack.isPinned("navigate")).toBe(true);
    expect(h.light("display1")).toBe("bright");
  });

  it("VARIATION alone stays unbuilt: its LED is off, a press opens nothing", () => {
    const h = stackHarness();
    expect(h.light("variation")).toBe("off");
    h.tap("variation");
    expect(h.stack.top).toBeUndefined();
    expect(h.light("variation")).toBe("off");
  });

  it("display 2–6 show the windows (SHOW_WINDOW 0–4), display 7 opens the plug-in editor", () => {
    const h = stackHarness({ selected: 4 });
    h.state.shift = true;
    h.press("variation");
    h.state.shift = false;
    for (const id of ["display2", "display3", "display4", "display5", "display6"] as const) {
      h.tap(id);
    }
    h.tap("display7");
    expect(h.sent).toEqual([
      { type: "showWindow", window: 0 },
      { type: "showWindow", window: 1 },
      { type: "showWindow", window: 2 },
      { type: "showWindow", window: 3 },
      { type: "showWindow", window: 4 },
      { type: "showEditor", index: 4 },
    ]);
  });

  it("display 1 pins, display 8 does nothing, and no display button reaches the page below", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("variation");
    h.tap("display8");
    expect(h.sent).toEqual([]);
  });

  it("PLUGIN does nothing without a selected channel", () => {
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
    h.press("variation");
    h.tap("display7");
    expect(h.sent).toEqual([]);
    expect(h.light("display7")).toBe("off");
  });

  it("LEDs: bright = focused, dim = shown, off = hidden", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("variation");
    // the default demo: rack focused, rack and playlist shown
    expect([2, 3, 4, 5, 6].map((n) => h.light(`display${n}` as "display2"))).toEqual([
      "off", // mixer hidden
      "bright", // rack focused
      "dim", // playlist shown
      "off", // piano hidden
      "off", // browser hidden
    ]);
    expect(h.light("display7")).toBe("dim"); // a channel is selected, no plug-in window has the focus
    h.ui({ visible: [true, true, true, true, false], focused: 3 });
    expect([2, 3, 4, 5, 6].map((n) => h.light(`display${n}` as "display2"))).toEqual([
      "dim",
      "dim",
      "dim",
      "bright",
      "off",
    ]);
    h.ui({ focused: 5 });
    expect(h.light("display7")).toBe("bright");
    expect(h.light("display5")).toBe("dim"); // the piano roll is shown, not focused
    h.ui({ focused: 127 });
    expect([2, 3, 4, 5, 6].some((n) => h.light(`display${n}` as "display2") === "bright")).toBe(
      false,
    );
  });

  it("the 4D tilt moves in FL and the push is enter; the page below does not see them", () => {
    const h = stackHarness({ selected: 2 });
    h.state.shift = true;
    h.press("variation");
    h.tilt("left");
    h.tilt("right");
    h.tilt("up");
    h.tilt("down");
    h.push();
    expect(h.sent).toEqual([
      { type: "ui", action: "left" },
      { type: "ui", action: "right" },
      { type: "ui", action: "up" },
      { type: "ui", action: "down" },
      { type: "ui", action: "enter" },
    ]);
  });

  it("releases of the tilt and the push do nothing, and the turn still goes to the page below", () => {
    const h = stackHarness({ selected: 2 });
    h.state.shift = true;
    h.press("variation");
    h.tilt("up", false);
    h.push(false);
    expect(h.sent).toEqual([]);
    h.turn(1);
    expect(h.sentOf("selectChannel")).toEqual([{ type: "selectChannel", index: 3 }]);
  });

  it("with a quick-edit mode on the turn goes to the quick edit", () => {
    const h = stackHarness();
    h.tap("tempo");
    h.state.shift = true;
    h.press("variation");
    h.turn(1);
    expect(h.sentOf("setTempo")).toHaveLength(1);
  });

  it("draws both screens in every state without throwing", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("variation");
    h.render();
    h.ui({ visible: [true, true, true, true, true], focused: 4 });
    h.render();
    h.ui({ focused: 5 });
    h.render();
    h.ui({ visible: [false, false, false, false, false], focused: 127 });
    h.render();
  });
});

describe("GRID (SHIFT + FOLLOW)", () => {
  it("opens while held and pins with display button 1; FOLLOW alone is still the STEP page's", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("follow");
    expect(h.stack.top?.page.id).toBe("grid");
    expect(h.light("follow")).toBe("bright");
    h.state.shift = false;
    h.release("follow");
    expect(h.stack.top).toBeUndefined();
    expect(h.light("follow")).toBe("off");

    h.tap("step");
    expect(h.stack.top?.page.id).toBe("step");
    h.tap("follow"); // the STEP page's FOLLOW
    expect(h.stack.top?.page.id).toBe("step");
  });

  it("pads 1–16 are the snap values and a press sets one", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("follow");
    for (let i = 0; i < 16; i++) {
      h.pad(i);
      h.pad(i, "up");
    }
    expect(h.sentOf("setSnap").map((c) => c.mode)).toEqual([
      0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    ]);
    expect(h.midi).toEqual([]); // no note
  });

  it("names the snap values as FL does", () => {
    expect(SNAP_VALUES.map((v) => v.name)).toEqual([
      "Line",
      "Cell",
      "None",
      "1/6 step",
      "1/4 step",
      "1/3 step",
      "1/2 step",
      "Step",
      "1/6 beat",
      "1/4 beat",
      "1/3 beat",
      "1/2 beat",
      "Beat",
      "Bar",
      "Events",
      "Markers",
    ]);
    expect(snapName(13)).toBe("Beat");
    expect(snapName(15)).toBe("Snap 15");
  });

  it("LEDs: the current snap bright white, the other pads dim white", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("follow");
    const leds = () => Array.from({ length: 16 }, (_, i) => h.padLed(i));
    expect(leds()).toEqual(SNAP_VALUES.map((v) => (v.mode === 8 ? BRIGHT : DIM)));
    h.ui({ snap: 13 });
    expect(leds()).toEqual(SNAP_VALUES.map((v) => (v.mode === 13 ? BRIGHT : DIM)));
    h.ui({ snap: 15 }); // not on the pads
    expect(leds().every((led) => led === DIM)).toBe(true);
  });

  it("the pads are GRID's even with SHIFT held, and the other display buttons are dark", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("follow");
    h.pad(13);
    expect(h.sent).toEqual([{ type: "setSnap", mode: 14 }]);
    expect(h.light("display1")).toBe("dim");
    expect(h.light("display2")).toBe("off");
  });

  it("closes after SHIFT + FOLLOW is released and the pads play again", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("follow");
    h.state.shift = false;
    h.release("follow");
    h.pad(0);
    expect(h.midi).toHaveLength(1);
    expect(h.sentOf("setSnap")).toEqual([]);
  });

  it("draws both screens without throwing, for a snap that is on the pads and one that is not", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("follow");
    h.render();
    h.ui({ snap: 15 });
    h.render();
  });
});
