import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import { flColorToPalette } from "../src/modes/format.js";
import {
  MARKER_COLORS,
  currentMarker,
  markerBar,
  markerBeats,
  markerName,
  nextMarker,
  positionBeats,
  previousMarker,
} from "../src/modes/markerPage.js";
import { demoFlState } from "../src/tools/demoState.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempPins = () => {
  const dir = mkdtempSync(join(tmpdir(), "mk3d-arranger-"));
  dirs.push(dir);
  return join(dir, "pages.json");
};

/** `n` markers, one every 4 bars from bar 1 (PPQ 96: a bar is 384 ticks). */
const markersEvery4Bars = (n: number, ppq = 96) =>
  Array.from({ length: n }, (_, i) => ({ ticks: i * 16 * ppq, name: `Part ${i + 1}` }));

const bright = (index: number) => flColorToPalette(MARKER_COLORS[index % 6] ?? 0, "bright");
const dim = (index: number) => flColorToPalette(MARKER_COLORS[index % 6] ?? 0, "dim");
const pressed = (index: number) => flColorToPalette(MARKER_COLORS[index % 6] ?? 0, "pressed");

/** What a page draws: every fillText on both screens, in order. */
function drawnText(h: StackHarness): { left: string[]; right: string[] } {
  const left = createCanvas(480, 272).getContext("2d");
  const right = createCanvas(480, 272).getContext("2d");
  const record = (ctx: typeof left, into: string[]) => {
    const original = ctx.fillText.bind(ctx);
    ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      into.push(text);
      original(text, x, y, maxWidth);
    };
  };
  const result = { left: [] as string[], right: [] as string[] };
  record(left, result.left);
  record(right, result.right);
  h.stack.render(left, right, h.mc);
  return result;
}

const jumps = (h: StackHarness) => h.sentOf("jumpMarker");

describe("markers and the song position", () => {
  it("finds the marker the song is in, with FL's PPQ", () => {
    for (const ppq of [96, 480]) {
      const fl = demoFlState({ markers: markersEvery4Bars(4, ppq), ppq });
      const at = (bar: number, step = 1, tick = 0) => {
        fl.apply({ type: "songPos", bar, step, tick });
        return currentMarker(fl);
      };
      expect(at(1)).toBe(0);
      expect(at(4, 16, ppq / 4 - 1)).toBe(0); // the last tick before bar 5
      expect(at(5)).toBe(1);
      expect(at(8, 3)).toBe(1);
      expect(at(9)).toBe(2);
      expect(at(40)).toBe(3);
    }
  });

  it("is before the first marker when the first one is later, and none without markers", () => {
    const fl = demoFlState({ markers: [{ ticks: 384, name: "Verse" }] });
    expect(currentMarker(fl)).toBe(-1); // song position 1.1, marker at bar 2
    fl.apply({ type: "songPos", bar: 2, step: 1, tick: 0 });
    expect(currentMarker(fl)).toBe(0);
    expect(currentMarker(demoFlState())).toBe(-1);
  });

  it("works out beats from bar, step and tick, and a marker's bar from its tick", () => {
    expect(positionBeats({ bar: 1, step: 1, tick: 0 }, 96)).toBe(0);
    expect(positionBeats({ bar: 2, step: 5, tick: 12 }, 96)).toBe(4 + 1 + 0.125);
    expect(positionBeats({ bar: 1, step: 1, tick: 120 }, 480)).toBe(0.25);
    expect(markerBar(0)).toBe(1);
    expect(markerBar(4)).toBe(2);
    expect(markerBar(3.99)).toBe(1);
  });

  it("has no time for a marker the script could not place, and stops looking past it", () => {
    const fl = demoFlState({
      markers: [
        { ticks: 0, name: "Intro" },
        { ticks: null, name: "Verse" },
        { ticks: 1536, name: "Drop" },
      ],
    });
    expect(markerBeats(fl, 0)).toBe(0);
    expect(markerBeats(fl, 1)).toBeUndefined();
    expect(markerBeats(fl, 2)).toBe(16);
    expect(markerName(fl, 1)).toBe("Verse");
    fl.apply({ type: "songPos", bar: 9, step: 1, tick: 0 });
    expect(currentMarker(fl)).toBe(0); // the unknown time ends the search: nothing is invented
    expect(nextMarker(fl)).toBeUndefined();
  });

  it("finds the marker before and after the song position, strictly", () => {
    const fl = demoFlState({ markers: markersEvery4Bars(3) });
    fl.apply({ type: "songPos", bar: 5, step: 1, tick: 0 });
    expect(previousMarker(fl)).toBe(0); // marker 1 is here, not before
    expect(nextMarker(fl)).toBe(2);
    fl.apply({ type: "songPos", bar: 6, step: 1, tick: 0 });
    expect(previousMarker(fl)).toBe(1);
    fl.apply({ type: "songPos", bar: 20, step: 1, tick: 0 });
    expect(nextMarker(fl)).toBeUndefined();
    fl.apply({ type: "songPos", bar: 1, step: 1, tick: 0 });
    expect(previousMarker(fl)).toBeUndefined();
  });
});

describe("SCENE", () => {
  it("is an overlay with the pin tab SCENE: dim LED, bright while held", () => {
    const h = stackHarness({ markers: markersEvery4Bars(4) });
    expect(h.light("scene")).toBe("dim");
    h.press("scene");
    expect(h.stack.top?.page.id).toBe("scene");
    expect(h.light("scene")).toBe("bright");
    expect(h.sentOf("requestMarkers")).toHaveLength(1);
    expect(h.sentOf("runProbe")).toHaveLength(0); // the probe is the ARRANGER's alone
    h.release("scene");
    expect(h.stack.top).toBeUndefined();
    expect(h.light("scene")).toBe("dim");
    h.press("scene");
    h.tap("display1"); // pin
    h.release("scene");
    expect(h.stack.top?.page.id).toBe("scene");
    expect(drawnText(h).left).toContain("SCENE");
  });

  it("shows the same pads as ARRANGER over any main page", () => {
    const h = stackHarness({ markers: markersEvery4Bars(20) });
    h.songPos(5, 1);
    h.press("scene");
    expect(h.padLed(1)).toBe(bright(1));
    expect(h.padLed(0)).toBe(dim(0));
    expect(h.padLed(16 - 1)).toBe(dim(15));
    h.tap("display8");
    expect(h.padLed(3)).toBe(dim(19));
    expect(h.padLed(4)).toBe(0);
    h.release("scene");
  });

  it("jumps at the next bar while playing, now while stopped", () => {
    const h = stackHarness({ markers: markersEvery4Bars(8) });
    h.press("scene");
    h.pad(2);
    expect(jumps(h)).toEqual([{ type: "jumpMarker", index: 2, quantized: false }]);
    h.playing(true);
    h.pad(3);
    expect(jumps(h).at(-1)).toEqual({ type: "jumpMarker", index: 3, quantized: true });
    h.release("scene");
  });

  it("jumps at once while playing with NOW on, and keeps NOW saved", () => {
    const pinsPath = tempPins();
    const h = stackHarness({ markers: markersEvery4Bars(8), pinsPath });
    h.playing(true);
    h.press("scene");
    expect(h.light("display2")).toBe("dim");
    h.tap("display2"); // NOW
    expect(h.light("display2")).toBe("bright");
    h.pad(1);
    expect(jumps(h)).toEqual([{ type: "jumpMarker", index: 1, quantized: false }]);
    h.tap("display2"); // back to quantized
    h.pad(1);
    expect(jumps(h).at(-1)).toEqual({ type: "jumpMarker", index: 1, quantized: true });
    h.tap("display2");
    const saved = JSON.parse(readFileSync(pinsPath, "utf8")) as {
      pages?: { scene?: { immediate?: boolean } };
    };
    expect(saved.pages?.scene).toEqual({ immediate: true });
    h.release("scene");

    const again = stackHarness({ markers: markersEvery4Bars(8), pinsPath });
    again.playing(true);
    again.press("scene");
    again.pad(2);
    expect(jumps(again)).toEqual([{ type: "jumpMarker", index: 2, quantized: false }]);
    expect(again.light("display2")).toBe("bright");
  });

  it("flashes the queued pad until the song is in the new marker", () => {
    const h = stackHarness({ markers: markersEvery4Bars(8) });
    h.playing(true);
    h.press("scene");
    h.pad(4);
    expect(h.padLed(4)).toBe(pressed(4));
    h.advance(250);
    expect(h.padLed(4)).toBe(dim(4));
    h.advance(250);
    expect(h.padLed(4)).toBe(pressed(4));
    h.songPos(3, 1); // still in marker 0
    expect(h.padLed(4)).toBe(pressed(4));
    expect(drawnText(h).left).toContain("Queued:");
    h.songPos(17, 1); // the jump happened
    expect(h.padLed(4)).toBe(bright(4));
    h.advance(250);
    expect(h.padLed(4)).toBe(bright(4)); // no flashing any more
    expect(drawnText(h).left).not.toContain("Queued:");
    h.release("scene");
  });

  it("flashes until the bar when the queued marker is the one the song is in", () => {
    const h = stackHarness({ markers: markersEvery4Bars(8) });
    h.playing(true);
    h.songPos(6, 1); // in marker 1
    h.press("scene");
    h.pad(1);
    h.songPos(7, 1);
    expect(h.padLed(1)).toBe(pressed(1));
    h.songPos(5, 1); // the song went back to the marker's start
    expect(h.padLed(1)).toBe(bright(1));
  });

  it("stops flashing when FL stops (the script jumps at once)", () => {
    const h = stackHarness({ markers: markersEvery4Bars(8) });
    h.playing(true);
    h.press("scene");
    h.pad(5);
    expect(h.padLed(5)).toBe(pressed(5));
    h.playing(false);
    expect(h.padLed(5)).toBe(dim(5));
    h.advance(1000);
    expect(h.padLed(5)).toBe(dim(5));
  });

  it("stops flashing when it is closed, with no timer left", () => {
    const h = stackHarness({ markers: markersEvery4Bars(8) });
    h.playing(true);
    h.press("scene");
    h.pad(5);
    const during = h.time.timerCount;
    h.release("scene");
    expect(h.time.timerCount).toBe(during - 1);
  });

  it("pages between banks with display 7 and 8, and shows no notice-only screen when there are markers", () => {
    const h = stackHarness({ markers: markersEvery4Bars(20) });
    h.press("scene");
    expect(h.light("display7")).toBe("off");
    expect(h.light("display8")).toBe("dim");
    h.tap("display8");
    h.pad(0);
    expect(jumps(h)).toEqual([{ type: "jumpMarker", index: 16, quantized: false }]);
    expect(drawnText(h).right).toEqual(expect.arrayContaining(["<<", "Part 17", "17–20 of 20"]));
    h.tap("display7");
    expect(drawnText(h).right).not.toContain("<<");
    h.release("scene");
  });

  it("shows the notice without markers and takes pad presses without sending", () => {
    const h = stackHarness();
    h.press("scene");
    for (let pad = 0; pad < 16; pad++) expect(h.padLed(pad)).toBe(0);
    expect(drawnText(h).right.join(" ")).toContain("No markers");
    h.pad(0);
    expect(jumps(h)).toEqual([]);
    expect(h.midi).toEqual([]);
    h.release("scene");
  });

  it("lists a marker with an unknown time by name with `Bar ?`, and its pad is lit", () => {
    const h = stackHarness({
      markers: [
        { ticks: null, name: "Intro" },
        { ticks: null, name: "Verse" },
      ],
    });
    h.press("scene");
    expect(drawnText(h).right).toEqual(expect.arrayContaining(["Bar ?", "Intro", "Verse"]));
    expect(h.padLed(0)).toBe(dim(0));
    expect(h.padLed(1)).toBe(dim(1));
    expect(h.padLed(2)).toBe(0);
    h.release("scene");
  });

  it("opens LIVE with SHIFT + SCENE instead of the marker overlay", () => {
    const h = stackHarness({ markers: markersEvery4Bars(4) });
    h.state.shift = true;
    h.press("scene");
    expect(h.stack.top?.page.id).toBe("liveClips");
    h.release("scene");
  });
});
