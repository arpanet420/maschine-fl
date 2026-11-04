import { describe, expect, it } from "vitest";
import { stackHarness } from "../src/tools/stackHarness.js";

describe("two quick touches of a knob", () => {
  it("MIXER: the volume back to 0 dB", () => {
    const h = stackHarness();
    h.tap("mixer");
    h.touchKnob(0);
    expect(h.sentOf("setTrack")).toEqual([]);
    h.touchKnob(0);
    expect(h.sentOf("setTrack")).toEqual([
      { type: "setTrack", index: 0, what: "volume", value: 0.8 },
    ]);
  });

  it("SETTINGS: the screen back to full", () => {
    const h = stackHarness();
    h.tap("settings");
    h.knob(4, -600);
    expect(h.padSettings.screenBrightness).toBeLessThan(100);
    h.touchKnob(4);
    h.touchKnob(4);
    expect(h.padSettings.screenBrightness).toBe(100);
  });

  it("a page with no default for the knob does nothing", () => {
    const h = stackHarness();
    h.tap("settings");
    h.touchKnob(6);
    h.touchKnob(6);
    expect(h.sent).toEqual([]);
  });
});
