import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paletteWhite } from "../src/hw/palette.js";
import { GridOverlay, SNAP_VALUES, quantizes, snapName } from "../src/modes/gridOverlay.js";
import { stackHarness } from "../src/tools/stackHarness.js";

const DIM = paletteWhite("dim");
const BRIGHT = paletteWhite("bright");

describe("NAVIGATE (VARIATION)", () => {
  it("is open while VARIATION is held", () => {
    const h = stackHarness();
    expect(h.light("variation")).toBe("dim");
    h.press("variation");
    expect(h.stack.top?.page.id).toBe("navigate");
    expect(h.light("variation")).toBe("bright");
    h.release("variation");
    expect(h.stack.top).toBeUndefined();
    expect(h.light("variation")).toBe("dim");
  });

  it("display 1 pins it, and the next press and release of VARIATION closes it", () => {
    const h = stackHarness();
    h.press("variation");
    h.tap("display1");
    expect(h.stack.top?.pinned).toBe(true);
    h.release("variation");
    expect(h.stack.top?.page.id).toBe("navigate");
    h.tap("display3");
    expect(h.sentOf("showWindow")).toHaveLength(1);
    h.tap("variation");
    expect(h.stack.top).toBeUndefined();
  });

  it("display 8 closes all of FL's windows, as does a push on its tile", () => {
    const h = stackHarness({ selected: 4 });
    h.press("variation");
    h.tap("display8");
    expect(h.sent.at(-1)).toEqual({ type: "closeAllWindows" });
    h.push();
    h.push(false);
    expect(h.sentOf("closeAllWindows")).toHaveLength(2);
    h.release("variation");
    expect(h.stack.top).toBeUndefined();
  });

  it("SHIFT + VARIATION does nothing", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.tap("variation");
    expect(h.stack.top).toBeUndefined();
  });

  it("display 2–6 are FL's toolbar order (SHOW_WINDOW 2 3 1 0 4), display 7 the plug-in editor", () => {
    const h = stackHarness({ selected: 4 });
    h.press("variation");
    for (const id of ["display2", "display3", "display4", "display5", "display6"] as const) {
      h.tap(id);
    }
    h.tap("display7");
    expect(h.sent).toEqual([
      { type: "showWindow", window: 2 },
      { type: "showWindow", window: 3 },
      { type: "showWindow", window: 1 },
      { type: "showWindow", window: 0 },
      { type: "showWindow", window: 4 },
      { type: "showEditor", index: 4 },
    ]);
  });

  it("display 1 sends nothing to FL", () => {
    const h = stackHarness();
    h.press("variation");
    h.tap("display1");
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
    h.press("variation");
    h.tap("display7");
    expect(h.sent).toEqual([]);
    expect(h.light("display7")).toBe("off");
  });

  it("LEDs: bright = focused, dim = shown, off = hidden", () => {
    const h = stackHarness();
    h.press("variation");
    // the default demo: rack focused, rack and playlist shown
    expect([2, 3, 4, 5, 6].map((n) => h.light(`display${n}` as "display2"))).toEqual([
      "dim", // playlist shown
      "off", // piano hidden
      "bright", // rack focused
      "off", // mixer hidden
      "off", // browser hidden
    ]);
    expect(h.light("display7")).toBe("dim"); // a channel is selected, no plug-in window has the focus
    h.ui({ visible: [true, true, true, true, false], focused: 3 });
    expect([2, 3, 4, 5, 6].map((n) => h.light(`display${n}` as "display2"))).toEqual([
      "dim",
      "bright",
      "dim",
      "dim",
      "off",
    ]);
    h.ui({ focused: 5 });
    expect(h.light("display7")).toBe("bright");
    expect(h.light("display3")).toBe("dim"); // the piano roll is shown, not focused
    h.ui({ focused: 127 });
    expect([2, 3, 4, 5, 6].some((n) => h.light(`display${n}` as "display2") === "bright")).toBe(
      false,
    );
  });

  it("the 4D encoder moves between the tiles and its push toggles the one it is on", () => {
    const h = stackHarness({ selected: 2 });
    h.press("variation");
    h.push(); // starts on the focused window, the rack
    h.turn(1);
    h.push(); // the mixer
    h.tilt("left");
    h.tilt("left");
    h.push(); // the piano roll
    h.tilt("right");
    h.push(); // the rack
    h.turn(-99);
    h.push(); // stops at the playlist
    h.turn(99);
    h.push(); // stops at Close all
    h.turn(-1);
    h.push(); // the plug-in
    expect(h.sent).toEqual([
      { type: "showWindow", window: 1 },
      { type: "showWindow", window: 0 },
      { type: "showWindow", window: 3 },
      { type: "showWindow", window: 1 },
      { type: "showWindow", window: 2 },
      { type: "closeAllWindows" },
      { type: "showEditor", index: 2 },
    ]);
    expect(() => h.render()).not.toThrow();
  });

  it("a display button moves the cursor too", () => {
    const h = stackHarness({ selected: 2 });
    h.press("variation");
    h.tap("display5"); // the mixer
    h.push();
    expect(h.sent).toEqual([
      { type: "showWindow", window: 0 },
      { type: "showWindow", window: 0 },
    ]);
  });

  it("nothing of the 4D encoder reaches the page below, and no key goes to FL", () => {
    const h = stackHarness({ selected: 2 });
    h.press("variation");
    h.tilt("up");
    h.tilt("down");
    h.tilt("left", false);
    h.push(false);
    h.turn(1);
    expect(h.sent).toEqual([]);
  });

  it("with a quick-edit mode on the turn goes to the quick edit", () => {
    const h = stackHarness();
    h.tap("tempo");
    h.press("variation");
    h.turn(1);
    expect(h.sentOf("setTempo")).toHaveLength(1);
  });

  it("draws both screens in every state without throwing", () => {
    const h = stackHarness();
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
  it("saves the snap SNAP goes back to as soon as it changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mk3d-grid-"));
    try {
      const pinsPath = join(dir, "pages.json");
      const h = stackHarness({ pinsPath });
      h.state.shift = true;
      h.press("follow");
      h.state.shift = false;
      h.ui({ snap: 13 });
      h.pad(0);
      const saved = JSON.parse(readFileSync(pinsPath, "utf8")) as {
        pages: { grid: { lastQuantize: number } };
      };
      expect(saved.pages.grid.lastQuantize).toBe(13);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens while held and pins with display button 1; FOLLOW alone is still the STEP page's", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("follow");
    expect(h.stack.top?.page.id).toBe("grid");
    expect(h.light("follow")).toBe("bright");
    h.state.shift = false;
    h.release("follow");
    expect(h.stack.top).toBeUndefined();
    expect(h.light("follow")).toBe("dim"); // so that it can be found

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
    expect(h.light("display3")).toBe("off");
  });

  describe("SNAP (display 2)", () => {
    const open = (snap: number) => {
      const h = stackHarness();
      h.ui({ snap });
      h.state.shift = true;
      h.press("follow");
      return h;
    };

    it("off sets None, on brings the snap value back", () => {
      const h = open(13);
      expect(h.light("display2")).toBe("bright");
      h.tap("display2");
      expect(h.sentOf("setSnap").map((c) => c.mode)).toEqual([3]);
      h.ui({ snap: 3 });
      expect(h.light("display2")).toBe("dim");
      h.tap("display2");
      expect(h.sentOf("setSnap").map((c) => c.mode)).toEqual([3, 13]);
    });

    it("brings back the value that was set before a pad picked None", () => {
      const h = open(14);
      h.pad(2); // None
      h.pad(2, "up");
      h.ui({ snap: 3 });
      h.tap("display2");
      expect(h.sentOf("setSnap").map((c) => c.mode)).toEqual([3, 14]);
    });

    it("turns on with Step when no value has been seen", () => {
      for (const snap of [0, 1, 3, 16, 17]) {
        const h = open(snap);
        expect(h.light("display2")).toBe("dim");
        h.tap("display2");
        expect(h.sentOf("setSnap").map((c) => c.mode)).toEqual([8]);
      }
    });

    it("counts the step, beat and bar values as quantizing", () => {
      expect(SNAP_VALUES.filter((v) => quantizes(v.mode)).map((v) => v.mode)).toEqual([
        4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
      ]);
    });

    it("keeps the value across a restart, and ignores one that doesn't quantize", () => {
      const grid = new GridOverlay();
      expect(grid.persisted.save()).toEqual({ lastQuantize: 8 });
      grid.persisted.load({ lastQuantize: 13 });
      expect(grid.persisted.save()).toEqual({ lastQuantize: 13 });
      for (const bad of [{ lastQuantize: 3 }, { lastQuantize: "x" }, {}, null]) {
        grid.persisted.load(bad);
        expect(grid.persisted.save()).toEqual({ lastQuantize: 13 });
      }
    });
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
