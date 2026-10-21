import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelPad } from "../src/hw/ids.js";
import { LedSender, LedState } from "../src/hw/leds.js";
import {
  LED_OFF,
  paletteColor,
  paletteName,
  paletteWhite,
  rgbToPalette,
} from "../src/hw/palette.js";

describe("palette", () => {
  it("builds indices from color and variant", () => {
    expect(paletteColor(0, "bright")).toBe(6);
    expect(paletteColor(10, "dim")).toBe(45);
    expect(paletteColor(15, "pressed")).toBe(67);
    expect(paletteWhite("bright")).toBe(70);
    expect(paletteName(46)).toBe("blue bright");
    expect(paletteName(0)).toBe("off");
  });

  it("maps RGB by hue, ignoring how dark the input is", () => {
    expect(paletteName(rgbToPalette(255, 0, 0))).toBe("red bright");
    expect(paletteName(rgbToPalette(0, 200, 0))).toBe("green bright");
    expect(paletteName(rgbToPalette(0, 0, 255))).toBe("blue bright");
    expect(paletteName(rgbToPalette(0, 60, 60))).toBe("cyan bright");
    expect(paletteName(rgbToPalette(255, 225, 0, "dim"))).toBe("warm yellow dim");
  });

  it("maps greys to white and near-black to off", () => {
    expect(rgbToPalette(128, 128, 140)).toBe(paletteWhite("bright"));
    expect(rgbToPalette(5, 5, 5)).toBe(LED_OFF);
  });
});

describe("LedState", () => {
  it("writes button light levels, colors, nav, pads and strip at their bytes", () => {
    const leds = new LedState();
    leds.setLight("play", "bright");
    leds.setLight("shift", "dim");
    leds.setLight("mixer", "bright");
    leds.setLight("browser", "dim");
    leds.setButtonColor("groupA", 6);
    leds.setNav("down", 38);
    leds.setPad(0, 46);
    leds.setPad(15, 30);
    leds.setStrip(24, 6);
    const [buttons, pads] = leds.reports();
    expect(buttons?.[0]).toBe(0x80);
    expect(buttons?.length).toBe(63);
    expect(buttons?.[42]).toBe(63);
    expect(buttons?.[45]).toBe(16);
    expect(buttons?.[4]).toBe(63);
    expect(buttons?.[5]).toBe(16);
    expect(buttons?.[30]).toBe(6);
    expect(buttons?.[62]).toBe(38);
    expect(pads?.[0]).toBe(0x81);
    expect(pads?.length).toBe(42);
    // Pad 0 is the bottom-left pad; the report is in device order, top-left first.
    expect(pads?.[26 + panelPad(0)]).toBe(46);
    expect(pads?.[26 + panelPad(15)]).toBe(30);
    expect(pads?.[26 + 12]).toBe(46);
    expect(pads?.[26 + 3]).toBe(30);
    expect(pads?.[25]).toBe(6);
  });

  it("rejects out-of-range pads, strip segments and raw bytes", () => {
    const leds = new LedState();
    expect(() => leds.setPad(16, 1)).toThrow(RangeError);
    expect(() => leds.setStrip(25, 1)).toThrow(RangeError);
    expect(() => leds.setRaw(0x80, 0, 1)).toThrow(RangeError);
  });
});

describe("LedSender", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const state = new LedState();
    const sent: number[][] = [];
    const sender = new LedSender(
      state,
      async (r) => void sent.push(Array.from(r)),
      16,
      () => Date.now(),
    );
    return { state, sent, sender };
  }

  it("sends both reports once, then only the one that changed", async () => {
    const { state, sent, sender } = setup();
    await sender.flush();
    expect(sent.map((r) => r[0])).toEqual([0x80, 0x81]);
    state.setPad(3, 10);
    await sender.flush();
    expect(sent.map((r) => r[0])).toEqual([0x80, 0x81, 0x81]);
    await sender.flush();
    expect(sent).toHaveLength(3);
  });

  it("coalesces rapid updates into one write per interval", async () => {
    const { state, sent, sender } = setup();
    await sender.flush();
    sent.length = 0;
    for (let i = 0; i < 10; i++) {
      state.setPad(0, i + 4);
      sender.update();
    }
    await vi.advanceTimersByTimeAsync(16);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[26 + panelPad(0)]).toBe(13);
  });

  it("resends everything after resendAll, and retries a failed write", async () => {
    const state = new LedState();
    let connected = false;
    const sent: number[] = [];
    const sender = new LedSender(state, async (r) => {
      if (!connected) throw new Error("not connected");
      sent.push(r[0] ?? 0);
    });
    await sender.flush();
    expect(sent).toEqual([]);
    connected = true;
    sender.resendAll();
    await vi.advanceTimersByTimeAsync(16);
    expect(sent).toEqual([0x80, 0x81]);
  });
});
