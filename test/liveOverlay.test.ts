import { describe, expect, it } from "vitest";
import { LIVE_BLOCK, MAX_LIVE_BLOCKS } from "../src/fl/protocol.js";
import { flColorToPalette } from "../src/modes/format.js";
import { patternLabel, patternsByColor } from "../src/modes/liveOverlay.js";
import { stackHarness } from "../src/tools/stackHarness.js";

const RED = 0xe0505a;
const BLUE = 0x5aa9e6;

function openLive(options: Parameters<typeof stackHarness>[0] = {}) {
  const h = stackHarness(options);
  h.state.shift = true;
  h.press("scene");
  h.state.shift = false;
  return h;
}

describe("LIVE overlay", () => {
  it("watches scenes, block window 0, as soon as it opens", () => {
    const h = openLive();
    const view = h.views.at(-1);
    expect(view?.liveScenes).toBe(true);
    expect(view?.liveOffset).toBe(0);
  });

  it("a pad press fires that scene (block), and its release releases the same block", () => {
    const h = openLive();
    h.pad(2);
    expect(h.sentOf("triggerLiveClip")).toEqual([
      { type: "triggerLiveClip", block: 2, release: false },
    ]);
    h.pad(2, "move");
    h.pad(2, "up");
    expect(h.sentOf("triggerLiveClip")).toEqual([
      { type: "triggerLiveClip", block: 2, release: false },
      { type: "triggerLiveClip", block: 2, release: true },
    ]);
  });

  it("a release goes to the block that was pressed, even after paging", () => {
    const h = openLive();
    h.pad(0);
    h.tap("display8");
    h.pad(0, "up");
    expect(h.sentOf("triggerLiveClip").at(-1)).toEqual({
      type: "triggerLiveClip",
      block: 0,
      release: true,
    });
  });

  it("a release without a press sends nothing", () => {
    const h = openLive();
    h.pad(3, "up");
    expect(h.sentOf("triggerLiveClip")).toEqual([]);
  });

  it("STOP (display 4) stops every scanned track instead of firing a scene", () => {
    const h = openLive();
    h.tap("display4");
    expect(h.sentOf("triggerLiveClip")).toEqual([
      { type: "triggerLiveClip", block: null, release: false },
    ]);
  });

  it("<< / >> (display 7 / 8) page the scene window; << stops at bank 0", () => {
    const h = openLive();
    h.tap("display8");
    expect(h.views.at(-1)?.liveOffset).toBe(MAX_LIVE_BLOCKS);
    h.pad(0);
    expect(h.sentOf("triggerLiveClip").at(-1)).toEqual({
      type: "triggerLiveClip",
      block: MAX_LIVE_BLOCKS,
      release: false,
    });
    h.tap("display7");
    expect(h.views.at(-1)?.liveOffset).toBe(0);
    h.tap("display7");
    expect(h.views.at(-1)?.liveOffset).toBe(0); // clamped: no bank below 0
  });

  it("a scene pad is the column across tracks: playing bright, idle faint, empty off", () => {
    const h = openLive();
    const { filled, playing } = LIVE_BLOCK;
    h.liveGrid({ scanned: 3 });
    h.liveTrack(1, [
      { status: filled, color: RED },
      { status: 0, color: 0 },
    ]);
    h.liveTrack(2, [
      { status: 0, color: 0 },
      { status: filled | playing, color: BLUE },
    ]);
    h.liveTrack(3, [{ status: filled, color: BLUE }]);
    expect(h.padLed(0)).toBe(flColorToPalette(RED, "faint")); // first filled track's color
    expect(h.padLed(1)).toBe(flColorToPalette(BLUE, "bright"));
    expect(h.padLed(2)).toBe(0);
  });

  it("a scheduled scene flashes brightest/off every 250 ms, playing or stopped, until it starts", () => {
    const h = openLive();
    const { filled, scheduled, playing } = LIVE_BLOCK;
    const idle = h.time.timerCount;
    h.liveGrid({ scanned: 1 });
    h.liveTrack(1, [{ status: filled | scheduled, color: RED }]);
    expect(h.padLed(0)).toBe(flColorToPalette(RED, "pressed")); // stopped: still flashes
    h.advance(250);
    expect(h.padLed(0)).toBe(0);
    h.advance(250);
    expect(h.padLed(0)).toBe(flColorToPalette(RED, "pressed"));
    h.playing(true);
    h.advance(250);
    expect(h.padLed(0)).toBe(0);
    h.liveTrack(1, [{ status: filled | scheduled | playing, color: RED }]); // it started
    expect(h.padLed(0)).toBe(flColorToPalette(RED, "bright"));
    expect(h.time.timerCount).toBe(idle); // the flash timer stopped with nothing queued
  });

  it("the flash timer stops when the overlay closes", () => {
    const h = openLive();
    const idle = h.time.timerCount;
    h.liveGrid({ scanned: 1 });
    h.liveTrack(1, [{ status: LIVE_BLOCK.filled | LIVE_BLOCK.scheduled, color: RED }]);
    expect(h.time.timerCount).toBe(idle + 1);
    h.tap("pattern"); // another page replaces the overlay
    expect(h.time.timerCount).toBe(idle);
  });

  it("drops rows of tracks past `scanned` and ignores rows for another block window", () => {
    const h = openLive();
    h.liveGrid({ scanned: 2 });
    h.liveTrack(2, [{ status: LIVE_BLOCK.filled, color: RED }]);
    expect(h.padLed(0)).toBe(flColorToPalette(RED, "faint"));
    h.liveGrid({ scanned: 1 }); // track 2 is gone
    expect(h.padLed(0)).toBe(0);
    h.liveTrack(1, [{ status: LIVE_BLOCK.filled, color: RED }]);
    h.tap("display8"); // now watching offset 16; the offset-0 row above must not light pad 0
    expect(h.padLed(0)).toBe(0);
  });

  it("names a clip by the one pattern that has its color; shared colors name nothing", () => {
    const h = openLive();
    h.fl.apply({
      type: "patterns",
      count: 4,
      offset: 0,
      entries: [
        { current: true, color: RED, name: "Pattern 1" },
        { current: false, color: BLUE, name: "Drums" },
        { current: false, color: 0x39454c, name: "Pattern 3" },
        { current: false, color: 0x39454c, name: "Pattern 4" },
      ],
    });
    const byColor = patternsByColor(h.fl);
    expect(byColor.get(RED)).toEqual({ number: 1, name: "Pattern 1" });
    expect(byColor.get(BLUE)).toEqual({ number: 2, name: "Drums" });
    expect(byColor.has(0x39454c)).toBe(false);
    expect(patternLabel({ number: 1, name: "Pattern 1" })).toBe("P1");
    expect(patternLabel({ number: 2, name: "Drums" })).toBe("Drums");
  });

  it("renders both screens with tracks, mute/solo and a queued clip without throwing", () => {
    const h = openLive();
    h.liveGrid({ scanned: 3 });
    h.liveTrack(1, [{ status: LIVE_BLOCK.filled | LIVE_BLOCK.playing, color: RED }], {
      name: "Drums",
    });
    h.liveTrack(
      2,
      [
        { status: 0, color: 0 },
        { status: LIVE_BLOCK.filled | LIVE_BLOCK.scheduled, color: BLUE },
      ],
      {
        muted: true,
      },
    );
    h.liveTrack(3, [], { solo: true });
    expect(() => h.render()).not.toThrow();
  });
});
