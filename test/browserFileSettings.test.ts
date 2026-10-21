import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL_NOTE_CHANNEL, NOTE_CHANNEL } from "../src/fl/protocol.js";
import { DEFAULT_PAD_CONFIG, PadProcessor } from "../src/hw/pads.js";
import { BrowserPage, UNKNOWN_TEXT } from "../src/modes/browserPage.js";
import { PadSettings } from "../src/modes/padSettings.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempPins = () => {
  const dir = mkdtempSync(join(tmpdir(), "mk3d-browser-"));
  dirs.push(dir);
  return join(dir, "pages.json");
};

/** Note ons as [MIDI channel, note, velocity]. */
const ons = (h: StackHarness) =>
  h.midi.filter((b) => ((b[0] ?? 0) & 0xf0) === 0x90).map((b) => [(b[0] ?? 0) & 0x0f, b[1], b[2]]);

const names = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `Preset ${from + i + 1}`);

describe("BROWSER", () => {
  it("is a main page: its button opens it, the same button goes home", () => {
    const h = stackHarness();
    h.tap("browser");
    expect(h.stack.main).toBe("browser");
    h.tap("browser");
    expect(h.stack.main).toBe("channel");
    h.tap("browser");
    expect(h.light("browser")).toBe("bright");
  });

  it("watches the presets only while it is shown (VIEW flag 2)", () => {
    const h = stackHarness({ selected: 17 });
    expect(h.views.every((v) => !v.presets)).toBe(true);
    h.tap("browser");
    expect(h.views.at(-1)).toMatchObject({ presets: true, meters: false, channelOffset: 16 });
    h.tap("mixer");
    expect(h.views.at(-1)).toMatchObject({ presets: false, meters: true });
    h.tap("browser");
    expect(h.views.at(-1)?.presets).toBe(true);
    h.tap("channel");
    expect(h.views.at(-1)?.presets).toBe(false);
    h.tap("plugIn");
    expect(h.views.at(-1)?.presets).toBe(false);
  });

  it("keeps the flag when an overlay is held over it", () => {
    const h = stackHarness();
    h.tap("browser");
    h.press("pattern");
    expect(h.views.at(-1)).toMatchObject({ presets: true, patternOffset: 0 });
    h.release("pattern");
    expect(h.views.at(-1)?.presets).toBe(true);
  });

  it("sends the VIEW again when the selected channel changes", () => {
    const h = stackHarness({ channels: 40 });
    h.tap("browser");
    const before = h.views.length;
    h.select(20);
    expect(h.views.length).toBe(before + 1);
    expect(h.views.at(-1)).toMatchObject({ presets: true, channelOffset: 16 });
  });

  it("steps with display 5 PREV and display 6 NEXT", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.tap("display6");
    h.tap("display5");
    h.tap("display5");
    expect(h.sentOf("presetStep")).toEqual([
      { type: "presetStep", dir: "next" },
      { type: "presetStep", dir: "prev" },
      { type: "presetStep", dir: "prev" },
    ]);
  });

  it("turns the cursor one preset per 4D detent without loading anything", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.turn(1);
    h.turn(3);
    h.turn(-2);
    const list = h.pages.browser.listing(h.mc);
    expect(list).toMatchObject({ cursor: 19, loaded: 17, top: 15 });
    expect(h.sentOf("presetStep")).toEqual([]);
    expect(h.sentOf("presetLoad")).toEqual([]);
  });

  it("starts the cursor on the loaded preset and stops it at both ends of the bank", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 17, loaded: 17 });
    h.presets(300, 1, names(0, 8), 0);
    h.turn(-5);
    expect(h.pages.browser.listing(h.mc).cursor).toBe(0);
    h.presets(3, 1, ["A", "B", "C"], 0);
    h.turn(9);
    expect(h.pages.browser.listing(h.mc).cursor).toBe(2);
  });

  it("scrolls the list to keep the cursor visible", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(0, 8), 0);
    const top = () => h.pages.browser.listing(h.mc).top;
    expect(top()).toBe(14);
    h.turn(4); // cursor 21: the last row of 15…21
    expect(top()).toBe(15);
    h.turn(-9); // cursor 12: above the list
    expect(top()).toBe(12);
    h.turn(2);
    expect(top()).toBe(12); // inside: no scrolling
  });

  it("asks FL for the names when the list scrolls beyond the ones it has", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 0, names(0, 8), 0);
    h.turn(-1);
    h.turn(6); // cursor 6: rows 0–6 and the name below are in the window
    expect(h.sentOf("presetWindow")).toEqual([]);
    h.turn(1); // cursor 7: rows 1–7, the name below (8) is not
    expect(h.sentOf("presetWindow")).toEqual([{ type: "presetWindow", offset: 1 }]);
    h.presets(300, 0, names(1, 9), 1);
    expect(h.pages.browser.rows(h.mc).map(([, name]) => name)).toEqual(names(1, 8));
    h.turn(3); // cursor 10: beyond the window
    expect(h.sentOf("presetWindow").at(-1)).toEqual({ type: "presetWindow", offset: 4 });
  });

  it("asks for the window above when the cursor goes up, and not at the ends of the bank", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 299, names(292, 300), 292);
    h.turn(5);
    h.turn(1);
    expect(h.sentOf("presetWindow")).toEqual([]);
    h.turn(-7); // cursor 292: the row above (291) is not in the window
    expect(h.sentOf("presetWindow")).toEqual([{ type: "presetWindow", offset: 291 }]);
  });

  it("does not ask again once FL's window covers the list", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.turn(5);
    expect(h.sentOf("presetWindow")).toEqual([{ type: "presetWindow", offset: 16 }]);
    h.presets(300, 17, names(16, 24), 16);
    expect(h.sentOf("presetWindow")).toHaveLength(1);
  });

  it("remembers the names FL sent, so scrolling back needs no new window", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.turn(10); // cursor 27
    h.presets(300, 17, names(21, 29), 21);
    const asked = h.sentOf("presetWindow").length;
    h.turn(-10);
    expect(h.sentOf("presetWindow")).toHaveLength(asked);
    expect(h.pages.browser.rows(h.mc).map(([, name]) => name)).toEqual(names(17, 24));
  });

  it("shows a blank name for rows FL has not sent yet", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.turn(8);
    const rows = h.pages.browser.listing(h.mc).rows;
    expect(rows.at(-1)).toMatchObject({ index: 25, name: "", cursor: true, loaded: false });
    h.render();
  });

  it("loads the cursor's preset on a 4D push and shows the read-out", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.push();
    h.push(false);
    expect(h.sentOf("presetLoad")).toEqual([]); // the cursor is on the loaded preset
    h.turn(2);
    h.push();
    h.push(false);
    expect(h.sentOf("presetLoad")).toEqual([{ type: "presetLoad", index: 19 }]);
    expect(h.stack.quickEdit.actionReadout(h.mc)).toEqual({
      title: "LOADED",
      detail: "Preset 20",
      small: "",
      source: "BROWSER",
    });
    expect(h.log.at(-1)).toContain("Preset 20");
    // until FL reports it, the page already counts the preset as loaded
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 19, loaded: 19 });
    h.presets(300, 19, names(16, 24), 16);
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 19, loaded: 19 });
  });

  it("steps from the preset it is loading when PREV / NEXT come faster than FL answers", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.tap("display6");
    h.tap("display6");
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 19, loaded: 19 });
    h.tap("display5");
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 18, loaded: 18 });
    expect(h.sentOf("presetStep").map((c) => c.dir)).toEqual(["next", "next", "prev"]);
  });

  it("moves the cursor with PREV / NEXT and shows the read-out", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.turn(4); // the cursor goes away from the loaded preset ...
    h.tap("display6"); // ... NEXT loads the one after the loaded preset and the cursor follows
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 18, loaded: 18 });
    expect(h.stack.quickEdit.actionReadout(h.mc)).toMatchObject({
      title: "LOADED",
      detail: "Preset 19",
    });
    h.presets(300, 18, names(15, 23), 15);
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 18, loaded: 18 });
  });

  it("wraps PREV / NEXT around the ends of the bank, as FL does", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 299, names(292, 300), 292);
    h.tap("display6");
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 0, loaded: 0 });
    h.presets(300, 0, names(0, 8), 0);
    h.tap("display5");
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 299, loaded: 299 });
  });

  it("forgets a stale guess of what is loaded after a while", () => {
    const h = stackHarness();
    const clock = { ms: 0 };
    const page = new BrowserPage(() => clock.ms);
    const mc = { ...h.mc, reportAction: () => {} };
    page.enter(mc);
    h.presets(300, 17, names(14, 22), 14);
    page.onEvent({ type: "button", id: "display6", pressed: true }, mc);
    expect(page.listing(mc).loaded).toBe(18);
    clock.ms = 2000; // FL never got there
    expect(page.listing(mc).loaded).toBe(17);
  });

  it("scrolls the cursor with knob 8, one detent per 120 counts", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.knob(7, 100);
    expect(h.pages.browser.listing(h.mc).cursor).toBe(17);
    h.knob(7, 30);
    expect(h.pages.browser.listing(h.mc).cursor).toBe(18);
    h.knob(7, -370);
    expect(h.pages.browser.listing(h.mc).cursor).toBe(15);
    h.knob(6, 600); // the other knobs are not the page's
    expect(h.pages.browser.listing(h.mc).cursor).toBe(15);
    expect(h.sentOf("presetLoad")).toEqual([]);
  });

  it("scrolls with knob 5 too, and display 8 LOAD loads the cursor's preset", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.tap("display8");
    expect(h.sentOf("presetLoad")).toEqual([]); // the cursor is on the loaded preset
    h.knob(4, 240);
    expect(h.pages.browser.listing(h.mc).cursor).toBe(19);
    h.tap("display8");
    expect(h.sentOf("presetLoad")).toEqual([{ type: "presetLoad", index: 19 }]);
  });

  it("moves the cursor with 4D tilt up and down, and leaves left and right alone", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.tilt("down");
    h.tilt("down", false);
    h.tilt("down");
    h.tilt("up");
    expect(h.pages.browser.listing(h.mc).cursor).toBe(18);
    const left = { type: "nav", action: "tilt", direction: "left", pressed: true } as const;
    expect(h.pages.browser.onEvent(left, h.mc)).toBe(false);
  });

  it("drops the cursor when the channel changes", () => {
    const h = stackHarness({ channels: 40 });
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    h.turn(5);
    expect(h.pages.browser.listing(h.mc).cursor).toBe(22);
    h.select(3);
    h.presets(100, 5, names(2, 10), 2);
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 5, loaded: 5 });
  });

  it("tells cursor and loaded rows apart (they can be the same row)", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    expect(h.pages.browser.listing(h.mc).rows.filter((r) => r.cursor && r.loaded)).toHaveLength(1);
    h.turn(2);
    const rows = h.pages.browser.listing(h.mc).rows;
    expect(rows.filter((r) => r.cursor).map((r) => r.index)).toEqual([19]);
    expect(rows.filter((r) => r.loaded).map((r) => r.index)).toEqual([17]);
    expect(rows.find((r) => r.cursor)?.name).toBe("Preset 20");
  });

  it("with an unknown current preset: no loaded row, the explanation, PREV / NEXT step from FL's", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, null, names(0, 8), 0);
    const list = h.pages.browser.listing(h.mc);
    expect(list).toMatchObject({ loaded: null, cursor: 0, top: 0 });
    expect(list.rows.some((r) => r.loaded)).toBe(false);
    expect(UNKNOWN_TEXT).toBe("Current preset unknown — PREV/NEXT steps from FL's current one");
    h.render();
    h.turn(2);
    expect(h.pages.browser.listing(h.mc).cursor).toBe(2);
    h.tap("display6");
    expect(h.sentOf("presetStep")).toEqual([{ type: "presetStep", dir: "next" }]);
    expect(h.stack.quickEdit.actionReadout(h.mc)).toBeUndefined(); // nothing is known to be loaded
    // the cursor follows FL once it says where it is
    h.presets(300, 5, names(2, 10), 2);
    expect(h.pages.browser.listing(h.mc)).toMatchObject({ cursor: 5, loaded: 5 });
  });

  it("sends a push anyway while the current preset is unknown, without a read-out", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, null, names(0, 8), 0);
    h.turn(2);
    h.push();
    expect(h.sentOf("presetLoad")).toEqual([{ type: "presetLoad", index: 2 }]);
    expect(h.stack.quickEdit.actionReadout(h.mc)).toBeUndefined();
  });

  it("lights the 4D tilt up and down while there are presets", () => {
    const h = stackHarness();
    h.tap("browser");
    const nav = () => {
      const leds = h.ledState();
      return [59, 60, 61, 62].map((i) => leds.buttonLeds[i]);
    };
    expect(nav()).toEqual([0, 0, 0, 0]);
    h.presets(300, 17, names(14, 22), 14);
    const [up, left, right, down] = nav();
    expect(up).toBeGreaterThan(0);
    expect(down).toBe(up);
    expect([left, right]).toEqual([0, 0]);
  });

  it("does not step on other pages", () => {
    const h = stackHarness();
    h.turn(1);
    h.tap("display6");
    expect(h.sentOf("presetStep")).toEqual([]);
  });

  it("steps nothing without a selected channel", () => {
    const h = stackHarness();
    h.tap("browser");
    h.fl.apply({
      type: "selectedChannel",
      index: null,
      color: 0,
      volume: 0,
      pan: 0,
      name: "",
      plugin: "",
    });
    h.turn(1);
    expect(h.sentOf("presetStep")).toEqual([]);
  });

  it("lists up to 7 names around the current one", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 17, names(14, 22), 14);
    const rows = h.pages.browser.rows(h.mc);
    expect(rows).toHaveLength(7);
    expect(rows.map(([index]) => index)).toEqual([14, 15, 16, 17, 18, 19, 20]);
    expect(rows[3]).toEqual([17, "Preset 18"]);
    expect(h.pages.browser.state(h.mc)).toEqual({ kind: "presets", count: 300, current: 17 });
  });

  it("keeps the current preset inside the list at the ends of the bank", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, 0, names(0, 8), 0);
    expect(h.pages.browser.rows(h.mc).map(([i]) => i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    h.presets(300, 299, names(292, 300), 292);
    expect(h.pages.browser.rows(h.mc).map(([i]) => i)).toEqual([293, 294, 295, 296, 297, 298, 299]);
    h.presets(3, 1, ["A", "B", "C"], 0);
    expect(h.pages.browser.rows(h.mc)).toEqual([
      [0, "A"],
      [1, "B"],
      [2, "C"],
    ]);
  });

  it("lists from the first name when the current preset is unknown", () => {
    const h = stackHarness();
    h.tap("browser");
    h.presets(300, null, names(0, 8), 0);
    expect(h.pages.browser.state(h.mc)).toEqual({ kind: "presets", count: 300, current: null });
    expect(h.pages.browser.rows(h.mc)[0]).toEqual([0, "Preset 1"]);
  });

  it("says so when there are no presets, no plugin or no channel", () => {
    const h = stackHarness();
    h.tap("browser");
    expect(h.pages.browser.state(h.mc)).toEqual({ kind: "reading" });
    h.presets(0, null, [], 0);
    expect(h.pages.browser.state(h.mc)).toEqual({ kind: "none", text: "No presets for Sampler" });
    const selected = h.fl.selectedChannel;
    h.fl.apply({ type: "selectedChannel", ...selected, plugin: "" });
    expect(h.pages.browser.state(h.mc)).toEqual({
      kind: "none",
      text: "No presets for this channel",
    });
    h.fl.apply({ type: "selectedChannel", ...selected, index: null });
    expect(h.pages.browser.state(h.mc)).toEqual({ kind: "none", text: "No channel selected" });
  });

  it("draws the list, the notice and the reading state without throwing", () => {
    const h = stackHarness();
    h.tap("browser");
    h.render();
    h.presets(300, 17, names(14, 22), 14);
    h.render();
    h.presets(300, null, names(0, 8), 0);
    h.render();
    h.presets(0, null, [], 0);
    h.render();
  });

  it("lights display 5 and 6 only when there are presets to step through", () => {
    const h = stackHarness();
    h.tap("browser");
    expect(h.light("display5")).toBe("off");
    h.presets(300, 17, names(14, 22), 14);
    expect(h.light("display5")).toBe("dim");
    expect(h.light("display6")).toBe("dim");
    expect(h.light("display1")).toBe("bright"); // the PRESETS source tab
    expect(h.light("display4")).toBe("off");
    h.presets(0, null, [], 0);
    expect(h.light("display6")).toBe("off");
  });

  it("leaves the pads to the pad mode (they play, to audition)", () => {
    const h = stackHarness();
    h.tap("browser");
    h.pad(0);
    expect(ons(h)).toEqual([[NOTE_CHANNEL, 36, 64]]);
  });

  it("does not take GROUP A-H: they still pick the bank", () => {
    const h = stackHarness({ channels: 40 });
    h.tap("browser");
    h.tap("groupB");
    expect(h.sentOf("selectChannel")).toEqual([{ type: "selectChannel", index: 16 }]);
  });
});

describe("FILE", () => {
  it("is a latched tool page", () => {
    const h = stackHarness();
    expect(h.light("file")).toBe("dim");
    h.tap("file");
    expect(h.stack.top?.page.id).toBe("file");
    expect(h.light("file")).toBe("bright");
    expect(h.light("display1")).toBe("bright");
    h.tap("file");
    expect(h.stack.top).toBeUndefined();
  });

  it("SAVE, NEW VER, UNDO and REDO send their actions and show the SHIFT read-outs", () => {
    const h = stackHarness();
    h.tap("file");
    h.tap("display2");
    expect(h.sentOf("ui")).toEqual([{ type: "ui", action: "save" }]);
    expect(h.stack.quickEdit.actionReadout(h.mc)?.title).toBe("SAVED");
    h.tap("display3");
    expect(h.sentOf("ui").at(-1)).toEqual({ type: "ui", action: "saveNew" });
    expect(h.stack.quickEdit.actionReadout(h.mc)?.title).toBe("NEW VERSION");
    h.tap("display5");
    expect(h.sentOf("ui").at(-1)).toEqual({ type: "ui", action: "undo" });
    h.undoState(4, 12, "MK3: clear steps");
    expect(h.stack.quickEdit.actionReadout(h.mc)).toEqual({
      title: "UNDO",
      detail: "MK3: clear steps",
      small: "4 / 12",
      source: "FILE",
    });
    h.tap("display6");
    expect(h.sentOf("ui").at(-1)).toEqual({ type: "ui", action: "redo" });
    expect(h.stack.quickEdit.actionReadout(h.mc)?.title).toBe("REDO");
    expect(h.log).toEqual(["→ FL save project", "→ FL save new version", "→ FL undo", "→ FL redo"]);
  });

  it("does nothing on the buttons without a function", () => {
    const h = stackHarness();
    h.tap("file");
    h.sent.length = 0;
    for (const id of ["display4", "display7", "display8"] as const) h.tap(id);
    expect(h.sent).toEqual([]);
  });

  it("lights the display buttons that do something", () => {
    const h = stackHarness();
    h.tap("file");
    expect(
      ["display2", "display3", "display5", "display6"].map((id) => h.light(id as "display2")),
    ).toEqual(["dim", "dim", "dim", "dim"]);
    expect(h.light("display4")).toBe("off");
    expect(h.light("display7")).toBe("off");
  });

  it("draws both screens (undo state, the last action) without throwing", () => {
    const h = stackHarness();
    h.tap("file");
    h.render();
    h.undoState(4, 12, "MK3: a rather long undo hint that has to wrap onto lines");
    h.tap("display3");
    h.render();
  });

  it("SHIFT + FILE saves the project without a page and shows SAVED", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.press("file");
    h.release("file");
    expect(h.stack.top).toBeUndefined();
    expect(h.sentOf("ui")).toEqual([{ type: "ui", action: "save" }]);
    expect(h.stack.quickEdit.actionReadout(h.mc)).toEqual({
      title: "SAVED",
      detail: "",
      small: "",
      source: "SHIFT + FILE",
    });
    expect(h.log).toContain("→ FL save project");
    h.render();
  });

  it("SHIFT + FILE works over any page, and the page underneath stays", () => {
    const h = stackHarness();
    h.tap("mixer");
    h.state.shift = true;
    h.tap("file");
    expect(h.stack.main).toBe("mixer");
    expect(h.sentOf("ui")).toEqual([{ type: "ui", action: "save" }]);
  });
});

describe("SETTINGS", () => {
  it("is a latched tool page", () => {
    const h = stackHarness();
    h.tap("settings");
    expect(h.stack.top?.page.id).toBe("settings");
    expect(h.light("settings")).toBe("bright");
    h.tap("settings");
    expect(h.stack.top).toBeUndefined();
  });

  it("knob 1 sets the full-scale hit, knob 2 the curve, knob 3 the fixed velocity", () => {
    const h = stackHarness();
    h.tap("settings");
    expect(h.padSettings.fullScale).toBe(DEFAULT_PAD_CONFIG.fullScale);
    h.knob(0, -300); // 1200 counts = the whole range
    expect(h.padSettings.fullScale).toBeCloseTo(3600 - 0.25 * (4095 - 300), 5);
    h.knob(1, 120);
    expect(h.padSettings.exponent).toBeCloseTo(0.6 + 0.1 * (2 - 0.25), 5);
    expect(h.padSettings.fixedVelocity).toBe(100);
    h.knob(2, -600);
    expect(h.padSettings.fixedVelocity).toBe(37);
    h.knob(2, 100000);
    expect(h.padSettings.fixedVelocity).toBe(127);
    h.knob(2, -100000);
    expect(h.padSettings.fixedVelocity).toBe(1);
    h.knob(0, -100000);
    expect(h.padSettings.fullScale).toBe(300);
    h.knob(1, 100000);
    expect(h.padSettings.exponent).toBe(2);
  });

  it("SHIFT makes the knobs fine, and a slow turn adds up on the fixed velocity", () => {
    const h = stackHarness();
    h.tap("settings");
    h.state.shift = true;
    h.knob(0, 120);
    expect(h.padSettings.fullScale).toBeCloseTo(3600 + 0.01 * (4095 - 300), 5);
    h.state.shift = false;
    for (let i = 0; i < 10; i++) h.knob(2, -8); // 8 counts is 0.84 of a velocity step
    expect(h.padSettings.fixedVelocity).toBe(92);
  });

  it("changes the very config the pad processor reads", () => {
    const h = stackHarness();
    const processor = new PadProcessor(h.padSettings.config);
    const soft = processor.velocityFor(500);
    h.tap("settings");
    h.knob(0, 600); // a higher full scale: the same hit is softer
    expect(processor.velocityFor(500)).toBeLessThan(soft);
    expect(processor.velocityFor(h.padSettings.fullScale)).toBe(1);
    h.knob(1, 1200);
    expect(processor.config.exponent).toBe(h.padSettings.exponent);
  });

  it("ignores the other knobs and the display buttons", () => {
    const h = stackHarness();
    h.tap("settings");
    expect(h.knob(3, 100)).toBe(false);
    h.tap("display4");
  });

  it("saves the settings with the state file and loads them back", () => {
    const pinsPath = tempPins();
    const h = stackHarness({ pinsPath });
    h.tap("settings");
    h.knob(0, -120);
    h.knob(1, -60);
    h.knob(2, -600);
    h.advance(500);
    const saved = JSON.parse(readFileSync(pinsPath, "utf8")) as {
      pages: { settings: Record<string, unknown> };
    };
    expect(saved.pages.settings).toEqual({
      fullScale: h.padSettings.fullScale,
      exponent: h.padSettings.exponent,
      fixedVelocity: 37,
      fixedOn: false,
    });
    const again = stackHarness({ pinsPath });
    expect(again.padSettings.fullScale).toBeCloseTo(h.padSettings.fullScale, 9);
    expect(again.padSettings.exponent).toBeCloseTo(h.padSettings.exponent, 9);
    expect(again.padSettings.fixedVelocity).toBe(37);
  });

  it("writes a change that is still waiting when the page closes", () => {
    const pinsPath = tempPins();
    const h = stackHarness({ pinsPath });
    h.tap("settings");
    h.knob(2, -600);
    h.tap("settings");
    expect(stackHarness({ pinsPath }).padSettings.fixedVelocity).toBe(37);
  });

  it("draws the curve, the knobs and the values without throwing", () => {
    const h = stackHarness();
    h.tap("settings");
    h.render();
    h.touched.add(1);
    h.tap("fixedVel");
    h.render();
  });

  it("start-up values from the command line win over the saved ones", () => {
    const config = { ...DEFAULT_PAD_CONFIG, fullScale: 2000 };
    const settings = new PadSettings(config, { fullScale: true });
    settings.persisted.load({ fullScale: 1000, exponent: 1.2, fixedVelocity: 64, fixedOn: true });
    expect(config.fullScale).toBe(2000);
    expect(config.exponent).toBe(1.2);
    expect(settings.fixedVelocity).toBe(64);
    expect(settings.fixedOn).toBe(true);
  });

  it("clamps and ignores bad saved values", () => {
    const settings = new PadSettings();
    settings.persisted.load({ fullScale: 99999, exponent: -3, fixedVelocity: 0, fixedOn: "yes" });
    expect(settings.fullScale).toBe(4095);
    expect(settings.exponent).toBe(0.25);
    expect(settings.fixedVelocity).toBe(1);
    expect(settings.fixedOn).toBe(false);
    settings.persisted.load(null);
    settings.persisted.load({ fullScale: "x", exponent: NaN });
    expect(settings.fullScale).toBe(4095);
  });
});

describe("FIXED VEL", () => {
  it("toggles fixed velocity: the LED is bright while on, dim while off", () => {
    const h = stackHarness();
    expect(h.light("fixedVel")).toBe("dim");
    h.tap("fixedVel");
    expect(h.padSettings.fixedOn).toBe(true);
    expect(h.light("fixedVel")).toBe("bright");
    expect(h.stack.quickEdit.actionReadout(h.mc)).toEqual({
      title: "FIXED VEL ON",
      detail: "100",
      small: "",
      source: "PAD VELOCITY",
    });
    h.tap("fixedVel");
    expect(h.padSettings.fixedOn).toBe(false);
    expect(h.light("fixedVel")).toBe("dim");
    expect(h.stack.quickEdit.actionReadout(h.mc)?.title).toBe("FIXED VEL OFF");
  });

  it("SHIFT + FIXED VEL (16 velocities) is not built: LED off, nothing happens", () => {
    const h = stackHarness();
    h.state.shift = true;
    expect(h.light("fixedVel")).toBe("off");
    h.tap("fixedVel");
    expect(h.padSettings.fixedOn).toBe(false);
    expect(h.stack.top).toBeUndefined();
    h.state.shift = false;
    expect(h.light("fixedVel")).toBe("dim");
  });

  it("KEYBOARD pads play the fixed velocity instead of the hit", () => {
    const h = stackHarness();
    h.pad(0, "down", { velocity: 0.2 });
    h.pad(0, "up");
    h.tap("fixedVel");
    h.pad(1, "down", { velocity: 0.2 });
    h.pad(1, "up");
    h.pad(2, "down", { velocity: 1 });
    h.pad(2, "up");
    expect(ons(h)).toEqual([
      [NOTE_CHANNEL, 36, 26],
      [NOTE_CHANNEL, 37, 100],
      [NOTE_CHANNEL, 38, 100],
    ]);
    h.tap("fixedVel");
    h.pad(3, "down", { velocity: 0.2 });
    expect(ons(h).at(-1)).toEqual([NOTE_CHANNEL, 39, 26]);
  });

  it("PAD MODE pads play the fixed velocity too", () => {
    const h = stackHarness();
    h.pads.mode = "channels";
    h.tap("fixedVel");
    h.pad(4, "down", { velocity: 0.1 });
    expect(ons(h)).toEqual([[CHANNEL_NOTE_CHANNEL, 4, 100]]);
  });

  it("uses the value of the SETTINGS knob", () => {
    const h = stackHarness();
    h.tap("fixedVel");
    h.tap("settings");
    h.knob(2, -600);
    h.tap("settings");
    h.pad(0, "down", { velocity: 1 });
    expect(ons(h)).toEqual([[NOTE_CHANNEL, 36, 37]]);
  });

  it("NOTE REPEAT plays the fixed velocity for the first note and every repeat", () => {
    const h = stackHarness();
    h.tap("fixedVel");
    h.press("noteRepeat");
    h.pad(2, "down", { velocity: 0.3, pressure: 0.3 });
    h.pad(2, "move", { pressure: 0.9 });
    h.advance(400);
    h.pad(2, "up");
    const velocities = ons(h).map((n) => n[2]);
    expect(velocities.length).toBeGreaterThanOrEqual(3);
    expect(velocities.every((v) => v === 100)).toBe(true);
  });

  it("NOTE REPEAT without it keeps the hit's velocity and the pressure's", () => {
    const h = stackHarness();
    h.pads.mode = "channels"; // KEYBOARD and CHORDS are the arpeggiator
    h.press("noteRepeat");
    h.pad(2, "down", { velocity: 0.3, pressure: 0.3 });
    h.pad(2, "move", { pressure: 0.9 });
    h.advance(300);
    h.pad(2, "up");
    const velocities = ons(h).map((n) => n[2]);
    expect(velocities[0]).toBe(39);
    expect(velocities.slice(1).every((v) => v === 114)).toBe(true);
  });

  it("NOTE REPEAT in PAD MODE plays the fixed velocity", () => {
    const h = stackHarness();
    h.pads.mode = "channels";
    h.tap("fixedVel");
    h.press("noteRepeat");
    h.pad(0, "down", { velocity: 0.1 });
    h.advance(300);
    h.pad(0, "up");
    const hits = ons(h);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((n) => n[0] === CHANNEL_NOTE_CHANNEL && n[2] === 100)).toBe(true);
  });

  it("is saved with the state and loaded back", () => {
    const pinsPath = tempPins();
    const h = stackHarness({ pinsPath });
    h.tap("fixedVel");
    const again = stackHarness({ pinsPath });
    expect(again.padSettings.fixedOn).toBe(true);
    expect(again.light("fixedVel")).toBe("bright");
    again.tap("fixedVel");
    expect(stackHarness({ pinsPath }).padSettings.fixedOn).toBe(false);
  });
});
