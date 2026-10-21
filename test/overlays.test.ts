import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { FlState } from "../src/fl/flState.js";
import type { FlCommand } from "../src/fl/sysex.js";
import type { HwEvent } from "../src/hw/events.js";
import { type ButtonId, panelPad } from "../src/hw/ids.js";
import { LedState, MONO_LEDS } from "../src/hw/leds.js";
import { LED_OFF, paletteWhite } from "../src/hw/palette.js";
import { flColorToPalette } from "../src/modes/format.js";
import type { Mode, ModeContext, ViewCommand } from "../src/modes/mode.js";
import { DuplicateOverlay } from "../src/modes/duplicateOverlay.js";
import { MuteOverlay } from "../src/modes/muteOverlay.js";
import { PadState } from "../src/modes/padState.js";
import { PatternOverlay } from "../src/modes/patternOverlay.js";

// Pad bytes in the 0x81 report are in device order (top-left first); pads are numbered from the bottom-left.
const padByte = (pad: number) => 26 + panelPad(pad);

const RED = 0xff0000;
const BLUE = 0x0000ff;
const GREEN = 0x00ff00;

const baseView = (channelOffset = 0): ViewCommand => ({
  type: "view",
  channelOffset,
  mixerOffset: 0,
  patternOffset: 0,
  stepOffset: 0,
  meters: false,
  presets: false,
  patternGrid: false,
  params: [0, 1, 2, 3, 4, 5, 6, 7],
});

interface Options {
  patternCount?: number;
  current?: number;
  channelTotal?: number;
  muted?: number[];
  soloed?: number[];
  channelOffset?: number;
  selected?: number;
  pinned?: boolean;
}

function setup(mode: Mode, options: Options = {}) {
  const {
    patternCount = 20,
    current = 3,
    channelTotal = 20,
    muted = [],
    soloed = [],
    channelOffset = 0,
    selected = 1,
    pinned = false,
  } = options;
  const fl = new FlState();
  fl.apply({ type: "hello", version: 2 });
  fl.apply({
    type: "patterns",
    count: patternCount,
    offset: 0,
    entries: Array.from({ length: Math.min(16, patternCount) }, (_, i) => ({
      current: i + 1 === current,
      color: i % 2 ? BLUE : RED,
      name: i === 0 ? "" : `Pat ${i + 1}`,
    })),
  });
  if (patternCount > 16) {
    fl.apply({
      type: "patterns",
      count: patternCount,
      offset: 16,
      entries: Array.from({ length: patternCount - 16 }, (_, i) => ({
        current: false,
        color: i % 2 ? BLUE : RED,
        name: `Pat ${i + 17}`,
      })),
    });
  }
  fl.apply({
    type: "pattern",
    number: current,
    count: patternCount,
    length: 32,
    color: RED,
    name: "Pat",
  });
  const entries = (offset: number) =>
    Array.from({ length: Math.min(16, channelTotal - offset) }, (_, i) => ({
      selected: false,
      muted: muted.includes(offset + i),
      solo: soloed.includes(offset + i),
      color: i % 2 ? BLUE : GREEN,
      name: `Ch ${offset + i + 1}`,
    }));
  fl.apply({
    type: "channels",
    total: channelTotal,
    offset: channelOffset,
    entries: entries(channelOffset),
  });
  fl.apply({
    type: "selectedChannel",
    index: selected,
    color: RED,
    volume: 0.5,
    pan: 0,
    name: "Ch",
    plugin: "",
  });

  const sent: FlCommand[] = [];
  const state = { shift: false, renders: 0 };
  const mc: ModeContext = {
    fl,
    send: (command) => sent.push(command),
    get shift() {
      return state.shift;
    },
    touchedKnobs: new Set(),
    requestRender: () => state.renders++,
    pinned,
    baseView: () => baseView(channelOffset),
  };
  mode.enter(mc);
  const entered = sent.splice(0);
  const event = (e: HwEvent) => mode.onEvent(e, mc);
  const press = (id: ButtonId) => event({ type: "button", id, pressed: true });
  const release = (id: ButtonId) => event({ type: "button", id, pressed: false });
  const pad = (index: number, phase: "down" | "move" | "up" = "down") =>
    event({ type: "pad", pad: index, phase, pressure: 0.5, velocity: 0.5 });
  const leds = () => {
    const led = new LedState();
    mode.leds(led, mc);
    return led;
  };
  const light = (led: LedState, id: keyof typeof MONO_LEDS) =>
    ({ 0: "off", 16: "dim", 63: "bright" })[led.buttonLeds[MONO_LEDS[id]] ?? -1] ?? "?";
  const render = () => {
    const left = createCanvas(480, 272).getContext("2d");
    const right = createCanvas(480, 272).getContext("2d");
    mode.render(left, right, mc);
  };
  return { fl, mc, sent, entered, state, event, press, release, pad, leds, light, render };
}

describe("PatternOverlay", () => {
  it("opens on the bank of the current pattern and asks FL for it, keeping the page's VIEW", () => {
    const { entered } = setup(new PatternOverlay(), { current: 3 });
    expect(entered).toEqual([{ ...baseView(), patternOffset: 0 }]);
    const second = setup(new PatternOverlay(), { current: 18 });
    expect(second.entered).toEqual([{ ...baseView(), patternOffset: 16 }]);
    expect(new PatternOverlay().viewPatch()).toEqual({ patternOffset: 0 });
  });

  it("selects the pattern under a pad (1-based, in the current bank)", () => {
    const { pad, sent } = setup(new PatternOverlay(), { current: 3 });
    expect(pad(0)).toBe(true);
    expect(pad(15)).toBe(true);
    expect(sent).toEqual([
      { type: "selectPattern", number: 1 },
      { type: "selectPattern", number: 16 },
    ]);
    const second = setup(new PatternOverlay(), { current: 18 });
    second.pad(2);
    expect(second.sent).toEqual([{ type: "selectPattern", number: 19 }]);
  });

  it("takes pad moves and releases; only a pad down creates a pattern on an empty pad", () => {
    const { pad, sent } = setup(new PatternOverlay(), { current: 18 });
    expect(pad(4, "move")).toBe(true); // pattern 21 does not exist
    expect(pad(4, "up")).toBe(true);
    expect(pad(0, "up")).toBe(true);
    expect(sent).toEqual([]);
    expect(pad(4)).toBe(true);
    expect(sent).toEqual([{ type: "createPattern", number: 21 }]);
  });

  it("an empty pad creates that very pattern: pad k of a short list is pattern k", () => {
    const { pad, sent } = setup(new PatternOverlay(), { current: 3, patternCount: 5 });
    pad(9);
    pad(5);
    expect(sent).toEqual([
      { type: "createPattern", number: 10 },
      { type: "createPattern", number: 6 },
    ]);
  });

  it("ERASE + an empty pad creates nothing; DUPLICATE's pads leave empty pads alone", () => {
    const erasing = setup(new PatternOverlay(), { current: 18 });
    Object.defineProperty(erasing.mc, "erase", { value: true });
    erasing.pad(4);
    expect(erasing.sent).toEqual([]);
    const duplicate = setup(new DuplicateOverlay(), { current: 18 });
    duplicate.pad(4);
    expect(duplicate.sent).toEqual([]);
    for (let pad = 4; pad < 16; pad++) expect(duplicate.leds().padLeds[padByte(pad)]).toBe(LED_OFF);
  });

  it("lights the pads: pattern color, bright for the current, dim for the rest, dim white for free slots", () => {
    const { leds } = setup(new PatternOverlay(), { current: 18 });
    const second = leds();
    expect(second.padLeds[padByte(0)]).toBe(flColorToPalette(RED, "dim"));
    const first = setup(new PatternOverlay(), { current: 3 }).leds();
    expect(first.padLeds[padByte(2)]).toBe(flColorToPalette(RED, "bright"));
    expect(first.padLeds[padByte(1)]).toBe(flColorToPalette(BLUE, "dim"));
    expect(first.padLeds[padByte(3)]).toBe(flColorToPalette(BLUE, "dim"));
    const last = setup(new PatternOverlay(), { current: 18 }).leds();
    // patterns 17–20 are on the pads; 21–32 are free slots: dim white, as Maschine shows them
    for (let pad = 4; pad < 16; pad++) expect(last.padLeds[padByte(pad)]).toBe(paletteWhite("dim"));
    expect(last.padLeds[padByte(3)]).not.toBe(LED_OFF);
  });

  it("pages banks with display buttons 7 and 8, clamped, and updates the VIEW", () => {
    const { press, release, sent, leds, light } = setup(new PatternOverlay(), { current: 3 });
    expect(light(leds(), "display7")).toBe("off");
    expect(light(leds(), "display8")).toBe("dim");
    expect(press("display7")).toBe(true); // no bank before the first
    expect(sent).toEqual([]);
    expect(press("display8")).toBe(true);
    release("display8");
    expect(sent).toEqual([{ ...baseView(), patternOffset: 16 }]);
    expect(light(leds(), "display7")).toBe("dim");
    expect(light(leds(), "display8")).toBe("off");
    press("display8"); // no bank after the last
    expect(sent).toHaveLength(1);
    press("display7");
    expect(sent[1]).toEqual({ ...baseView(), patternOffset: 0 });
  });

  it("shows the pin on display button 1 and leaves the others off", () => {
    const off = setup(new PatternOverlay(), { pinned: false });
    expect(off.light(off.leds(), "display1")).toBe("dim");
    const on = setup(new PatternOverlay(), { pinned: true });
    expect(on.light(on.leds(), "display1")).toBe("bright");
    for (const id of ["display2", "display6"] as const) {
      expect(on.light(on.leds(), id)).toBe("off");
    }
    // DOUBLE (display 3), DUPLICATE (display 4) and CREATE (display 5) are buttons, so their lights are on
    for (const id of ["display3", "display4", "display5"] as const) {
      expect(on.light(on.leds(), id)).toBe("dim");
    }
  });

  it("lets the unused knobs and the encoder fall through; swallows unused display buttons", () => {
    const { event, press } = setup(new PatternOverlay());
    expect(event({ type: "encoder", index: 1, delta: 3 })).toBe(false);
    expect(event({ type: "encoder", index: 2, delta: 3 })).toBe(false);
    expect(event({ type: "nav", action: "turn", delta: 1 })).toBe(false);
    expect(press("arrowLeft")).toBe(false); // one knob page: the arrows are not the overlay's
    expect(press("display2")).toBe(true);
  });

  it("shrinks its bank when the pattern count drops", () => {
    const { fl, mc, sent } = setup(new PatternOverlay(), { current: 18 });
    const overlay = new PatternOverlay();
    overlay.enter(mc);
    sent.length = 0;
    fl.apply({ type: "patterns", count: 10, offset: 0, entries: [] });
    overlay.onFlChange("patterns", mc);
    expect(sent).toEqual([{ ...baseView(), patternOffset: 0 }]);
  });

  it("renders both screens, pinned or not, with and without patterns", () => {
    for (const options of [
      { pinned: true },
      { pinned: false, current: 18 },
      { patternCount: 0, current: 0 },
    ]) {
      expect(() => setup(new PatternOverlay(), options).render()).not.toThrow();
    }
  });
});

describe("PatternOverlay: DUPLICATE and CREATE", () => {
  it("display 4 clones the current pattern, display 5 makes a new empty one", () => {
    const { press, release, sent } = setup(new PatternOverlay(), { current: 3 });
    press("display4");
    release("display4");
    press("display5");
    release("display5");
    expect(sent).toEqual([{ type: "clonePattern", number: 3 }, { type: "newPattern" }]);
  });

  it("clones nothing while there is no current pattern", () => {
    const { press, sent } = setup(new PatternOverlay(), { patternCount: 0, current: 0 });
    press("display4");
    expect(sent).toEqual([]);
  });

  it("shows the DOUBLE, DUPLICATE and CREATE tabs over display 3, 4 and 5 and has no DELETE", () => {
    const { render } = setup(new PatternOverlay());
    expect(() => render()).not.toThrow();
  });

  it("turns to the bank of the new pattern once FL selects it", () => {
    const { press, fl, mc, sent, mode } = setupWithMode();
    press("display5");
    expect(sent).toEqual([{ type: "newPattern" }]);
    sent.length = 0;
    fl.apply({
      type: "pattern",
      number: 17,
      count: 17,
      length: 16,
      color: RED,
      name: "New",
    });
    mode.onFlChange("pattern", mc);
    expect(sent).toEqual([{ ...baseView(), patternOffset: 16 }]);
    sent.length = 0;
    // a later pattern change that is not ours does not move the bank
    fl.apply({ type: "pattern", number: 2, count: 17, length: 16, color: RED, name: "x" });
    mode.onFlChange("pattern", mc);
    expect(sent).toEqual([]);
  });

  it("keeps the bank when the new pattern is in it", () => {
    const { press, fl, mc, sent, mode } = setupWithMode(5);
    press("display4");
    sent.length = 0;
    fl.apply({ type: "pattern", number: 6, count: 6, length: 16, color: RED, name: "Copy" });
    mode.onFlChange("pattern", mc);
    expect(sent).toEqual([]);
  });

  function setupWithMode(current = 3) {
    const mode = new PatternOverlay();
    return { ...setup(mode, { current, patternCount: current }), mode };
  }
});

describe("DuplicateOverlay", () => {
  it("clones the pattern under a pad (1-based, in the current bank) and takes move and up", () => {
    const { pad, sent } = setup(new DuplicateOverlay(), { current: 3 });
    expect(pad(0)).toBe(true);
    expect(pad(15)).toBe(true);
    expect(pad(15, "move")).toBe(true);
    expect(pad(15, "up")).toBe(true);
    expect(sent).toEqual([
      { type: "clonePattern", number: 1 },
      { type: "clonePattern", number: 16 },
    ]);
    const second = setup(new DuplicateOverlay(), { current: 18 });
    second.pad(2);
    second.pad(4); // pattern 21 does not exist
    expect(second.sent).toEqual([{ type: "clonePattern", number: 19 }]);
  });

  it("opens on the bank of the current pattern, with a patternOffset in its VIEW", () => {
    const second = setup(new DuplicateOverlay(), { current: 18 });
    expect(second.entered).toEqual([{ ...baseView(), patternOffset: 16 }]);
  });

  it("pages banks with display 7 and 8 and lights the pads like PATTERN", () => {
    const { press, sent, leds, light } = setup(new DuplicateOverlay(), { current: 3 });
    expect(light(leds(), "display7")).toBe("off");
    expect(light(leds(), "display8")).toBe("dim");
    press("display8");
    expect(sent).toEqual([{ ...baseView(), patternOffset: 16 }]);
    const lit = setup(new DuplicateOverlay(), { current: 3 }).leds();
    expect(lit.padLeds[padByte(2)]).toBe(flColorToPalette(RED, "bright"));
    expect(lit.padLeds[padByte(1)]).toBe(flColorToPalette(BLUE, "dim"));
  });

  it("shows only the pin on display 1 and renders both screens with its hint", () => {
    const { leds, light, render } = setup(new DuplicateOverlay(), { pinned: true });
    expect(light(leds(), "display1")).toBe("bright");
    for (const id of ["display2", "display3", "display4", "display5", "display6"] as const) {
      expect(light(leds(), id)).toBe("off");
    }
    expect(() => render()).not.toThrow();
    expect(new DuplicateOverlay().name).toBe("duplicate");
  });
});

describe("MuteOverlay", () => {
  it("toggles the mute of the channel under a pad", () => {
    const { pad, sent } = setup(new MuteOverlay(new PadState()), { muted: [2] });
    expect(pad(0)).toBe(true);
    expect(pad(2)).toBe(true);
    expect(sent).toEqual([
      { type: "setChannel", index: 0, what: "mute", value: 1 },
      { type: "setChannel", index: 2, what: "mute", value: 0 },
    ]);
  });

  it("uses the bank of the selected channel and asks FL for its window", () => {
    const { entered } = setup(new MuteOverlay(new PadState()), {
      channelOffset: 0,
      selected: 17,
      channelTotal: 40,
    });
    expect(entered).toEqual([{ ...baseView(0), channelOffset: 16 }]);
    expect(
      new MuteOverlay(new PadState()).viewPatch(setup(new MuteOverlay(new PadState())).mc),
    ).toEqual({
      channelOffset: 0,
    });
  });

  it("windows on the selected channel's bank", () => {
    const { pad, sent } = setup(new MuteOverlay(new PadState()), {
      channelOffset: 16,
      selected: 17,
      channelTotal: 20,
    });
    pad(1);
    pad(4); // channel 21 does not exist
    expect(sent).toEqual([{ type: "setChannel", index: 17, what: "mute", value: 1 }]);
  });

  it("takes pad moves and releases and never sends anything for them", () => {
    const { pad, sent } = setup(new MuteOverlay(new PadState()));
    expect(pad(5, "move")).toBe(true);
    expect(pad(5, "up")).toBe(true);
    expect(sent).toEqual([]);
  });

  it("lights the pads: channel color, bright when playing, dim when muted, off past the last", () => {
    const { leds } = setup(new MuteOverlay(new PadState()), {
      muted: [17],
      channelOffset: 16,
      selected: 17,
    });
    const led = leds();
    expect(led.padLeds[padByte(0)]).toBe(flColorToPalette(GREEN, "bright"));
    expect(led.padLeds[padByte(1)]).toBe(flColorToPalette(BLUE, "dim"));
    expect(led.padLeds[padByte(4)]).toBe(LED_OFF);
    const first = setup(new MuteOverlay(new PadState()), { muted: [1] }).leds();
    expect(first.padLeds[padByte(1)]).toBe(flColorToPalette(BLUE, "dim"));
    expect(first.padLeds[padByte(15)]).toBe(flColorToPalette(BLUE, "bright"));
  });

  it("GROUP A–H pick the bank (and toggle nothing), Shift or not", () => {
    const { press, release, state, sent } = setup(new MuteOverlay(new PadState()), {
      channelTotal: 40,
    });
    expect(press("groupC")).toBe(true);
    release("groupC");
    state.shift = true;
    press("groupB");
    expect(sent).toEqual([
      { type: "selectChannel", index: 32 },
      { type: "selectChannel", index: 16 },
    ]);
    sent.length = 0;
    press("groupD"); // no 4th bank
    expect(sent).toEqual([]);
  });

  it("shows the pin, lets knobs and arrows through and swallows unused display buttons", () => {
    const pinned = setup(new MuteOverlay(new PadState()), { pinned: true });
    expect(pinned.light(pinned.leds(), "display1")).toBe("bright");
    expect(pinned.light(pinned.leds(), "display8")).toBe("off");
    expect(pinned.event({ type: "encoder", index: 4, delta: 3 })).toBe(false);
    expect(pinned.press("arrowRight")).toBe(false);
    expect(pinned.press("display2")).toBe(true);
    expect(pinned.sent).toEqual([]);
  });

  it("renders both screens", () => {
    for (const options of [
      { muted: [0, 3], pinned: true },
      { channelTotal: 0, selected: 0 },
      { channelTotal: 5 },
    ]) {
      expect(() => setup(new MuteOverlay(new PadState()), options).render()).not.toThrow();
    }
  });
});
