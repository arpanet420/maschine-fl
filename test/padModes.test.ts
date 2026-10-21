import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import { FlState } from "../src/fl/flState.js";
import { midiBytes } from "../src/fl/midiPorts.js";
import type { ChannelEntry, FlCommand } from "../src/fl/sysex.js";
import type { HwEvent, PadEvent } from "../src/hw/events.js";
import { type ButtonId, panelPad } from "../src/hw/ids.js";
import { COLOR_LEDS, LedState, MONO_LEDS } from "../src/hw/leds.js";
import { LED_OFF, paletteColor, paletteWhite } from "../src/hw/palette.js";
import { ChannelMode } from "../src/modes/channelMode.js";
import { flColorToPalette } from "../src/modes/format.js";
import { KeyboardPage } from "../src/modes/keyboardPage.js";
import { MixerMode } from "../src/modes/mixerMode.js";
import type { ModeContext, ViewCommand } from "../src/modes/mode.js";
import { MuteOverlay } from "../src/modes/muteOverlay.js";
import { PadModePage } from "../src/modes/padModePage.js";
import { PadState, isC, noteName } from "../src/modes/padState.js";
import { PageStack } from "../src/modes/pageStack.js";
import { SelectOverlay } from "../src/modes/selectOverlay.js";
import { SoloOverlay } from "../src/modes/soloOverlay.js";

const RED = 0xff0000;
const BLUE = 0x0000ff;
const GREEN = 0x00ff00;
const padByte = (pad: number) => 26 + panelPad(pad);

interface Options {
  total?: number;
  selected?: number | null;
  muted?: number[];
  soloed?: number[];
  pinsPath?: string;
  /** Windows FL has reported: first channel of each (default: the selected channel's bank). */
  windows?: number[];
}

const entry = (i: number, patch: Partial<ChannelEntry> = {}): ChannelEntry => ({
  selected: false,
  muted: false,
  solo: false,
  color: i % 2 ? BLUE : GREEN,
  name: `Ch ${i + 1}`,
  ...patch,
});

/** The real pages and stack, a FlState with `total` channels and what main.ts does with pads. */
function harness({
  total = 40,
  selected = 2,
  muted = [],
  soloed = [],
  pinsPath,
  windows,
}: Options = {}) {
  const fl = new FlState();
  fl.apply({ type: "hello", version: 2 });
  const midi: number[][] = [];
  const pads = new PadState((bytes) => midi.push(bytes));
  const pages = {
    channel: new ChannelMode(),
    mixer: new MixerMode(),
    mute: new MuteOverlay(pads),
    select: new SelectOverlay(pads),
    solo: new SoloOverlay(pads),
    padMode: new PadModePage(pads),
    keyboard: new KeyboardPage(pads),
  };
  const stack = new PageStack({ pages, pads, pinsPath });
  /** Everything sent except VIEWs (those are in `views`). */
  const sent: FlCommand[] = [];
  const views: ViewCommand[] = [];
  /** SHOW_WINDOW / SHOW_EDITOR a page button sent to bring up FL's window (not in `sent`). */
  const windowCommands: FlCommand[] = [];
  const state = { shift: false, renders: 0 };
  const mc: ModeContext = {
    fl,
    send: (command) => {
      if (command.type === "view") views.push(command);
      else if (command.type === "showWindow" || command.type === "showEditor")
        windowCommands.push(command);
      else sent.push(command);
      if (command.type === "selectChannel") select(command.index); // FL answers at once
    },
    get shift() {
      return state.shift;
    },
    touchedKnobs: new Set(),
    requestRender: () => state.renders++,
  };

  const channelWindow = (first: number) => {
    fl.apply({
      type: "channels",
      total,
      offset: first,
      entries: Array.from({ length: Math.min(16, total - first) }, (_, i) =>
        entry(first + i, {
          muted: muted.includes(first + i),
          solo: soloed.includes(first + i),
        }),
      ),
    });
  };
  const select = (index: number) => {
    fl.apply({
      type: "selectedChannel",
      index,
      color: index % 2 ? BLUE : GREEN,
      volume: 0.5,
      pan: 0,
      name: `Ch ${index + 1}`,
      plugin: "",
    });
    stack.onFlChange("selectedChannel", mc);
  };
  for (const first of windows ?? [selected === null ? 0 : Math.floor(selected / 16) * 16]) {
    channelWindow(first);
  }
  if (selected !== null) select(selected);
  fl.apply({
    type: "mixer",
    total: 10,
    offset: 0,
    entries: Array.from({ length: 8 }, (_, i) => ({
      selected: i === 1,
      muted: false,
      solo: false,
      armed: false,
      color: i % 2 ? BLUE : RED,
      volume: 0.8,
      pan: 0,
      name: `T${i}`,
    })),
  });
  fl.apply({ type: "selectedTrack", index: 1 });
  stack.enter(mc);
  sent.length = 0;
  views.length = 0;
  midi.length = 0;

  const selects = () => sent.filter((c) => c.type === "selectChannel");
  const button = (id: ButtonId, pressed: boolean) =>
    stack.onEvent({ type: "button", id, pressed }, mc);
  const press = (id: ButtonId) => button(id, true);
  const release = (id: ButtonId) => button(id, false);
  const tap = (id: ButtonId) => {
    press(id);
    release(id);
  };
  /** A pad event the way main.ts routes it: pages first, else the global pad handler. */
  const pad = (
    index: number,
    phase: PadEvent["phase"] = "down",
    velocity = 0.5,
    pressure = 0.5,
  ) => {
    const event: HwEvent = { type: "pad", pad: index, phase, pressure, velocity };
    if (!stack.onEvent(event, mc)) pads.handlePad(event, mc);
  };
  const ledState = () => {
    const leds = new LedState();
    pads.leds(leds, fl); // the global fallback first, as in main.ts
    stack.leds(leds, mc);
    return leds;
  };
  const light = (id: keyof typeof MONO_LEDS) => {
    const value = ledState().buttonLeds[MONO_LEDS[id]];
    return value === 0 ? "off" : value === 16 ? "dim" : value === 63 ? "bright" : `?${value}`;
  };
  const groups = () =>
    (["groupA", "groupB", "groupC", "groupD", "groupE", "groupF", "groupG", "groupH"] as const).map(
      (id) => ledState().buttonLeds[COLOR_LEDS[id]],
    );
  const render = () => {
    const left = createCanvas(480, 272).getContext("2d");
    const right = createCanvas(480, 272).getContext("2d");
    stack.render(left, right, mc);
  };
  return {
    fl,
    pads,
    stack,
    mc,
    sent,
    views,
    selects,
    midi,
    state,
    press,
    release,
    tap,
    pad,
    ledState,
    light,
    groups,
    render,
    select,
    channelWindow,
  };
}

const NOTE_ON_1 = (note: number, velocity: number) => [0x90, note, velocity];
const NOTE_OFF_1 = (note: number) => [0x80, note, 0];

describe("pad notes in keyboard mode", () => {
  it("plays base + pad on MIDI channel 1, with velocity, aftertouch and note off", () => {
    const { pad, midi, pads } = harness();
    expect(pads.mode).toBe("keyboard");
    pad(0, "down", 1);
    pad(5, "down", 0.5);
    expect(midi).toEqual([NOTE_ON_1(36, 127), NOTE_ON_1(41, 64)]);
    midi.length = 0;
    pad(5, "move", 0.5, 0.5);
    pad(5, "move", 0.5, 0.5); // same pressure: nothing new
    pad(5, "move", 0.5, 1);
    pad(5, "up");
    expect(midi).toEqual([[0xa0, 41, 64], [0xa0, 41, 127], NOTE_OFF_1(41)]);
  });

  it("follows the base note, 0…112 so that pad 16 stays within 127", () => {
    const { pads, pad, midi } = harness();
    expect(pads.baseNote).toBe(36);
    expect(pads.shiftBase(-12)).toBe(true);
    expect(pads.shiftBase(1000)).toBe(true);
    expect(pads.baseNote).toBe(112);
    expect(pads.shiftBase(1)).toBe(false);
    pad(15);
    expect(midi).toEqual([NOTE_ON_1(127, 64)]);
    expect(pads.shiftBase(-1000)).toBe(true);
    expect(pads.baseNote).toBe(0);
    expect(pads.shiftBase(-1)).toBe(false);
  });
});

describe("pad notes in PAD MODE (channels)", () => {
  const channelOn = (index: number, velocity: number) => [0x91, index, velocity];

  it("plays the channel by its group-local index on MIDI channel 2 and selects it", () => {
    const { pad, midi, sent, pads, fl } = harness({ selected: 2 });
    pads.mode = "channels";
    pad(0, "down", 1);
    pad(3, "down", 0.5);
    expect(midi).toEqual([channelOn(0, 127), channelOn(3, 64)]);
    // pad 1 (channel 0) and pad 4 (channel 3) were not selected; channel 2 was not hit
    expect(sent).toEqual([
      { type: "selectChannel", index: 0 },
      { type: "selectChannel", index: 3 },
    ]);
    expect(fl.selectedChannel.index).toBe(3);
    sent.length = 0;
    pad(3, "down"); // already selected: no second select
    expect(sent).toEqual([]);
  });

  it("uses the current bank: the selected channel's group of 16", () => {
    const { pad, midi, sent, pads } = harness({ selected: 20 });
    pads.mode = "channels";
    pad(1);
    expect(midi).toEqual([channelOn(17, 64)]);
    expect(sent).toEqual([{ type: "selectChannel", index: 17 }]);
  });

  it("plays nothing for pads past the last channel or channels a note cannot carry", () => {
    const { pad, midi, sent, pads } = harness({ total: 20, selected: 17 });
    pads.mode = "channels";
    pad(4); // channel 21 of 20
    pad(4, "up");
    expect(midi).toEqual([]);
    expect(sent).toEqual([]);
    const big = harness({ total: 200, selected: 130, windows: [128] });
    big.pads.mode = "channels";
    big.pad(0); // channel 128: note 128 does not exist
    big.pad(15);
    expect(big.midi).toEqual([]);
    const edge = harness({ total: 200, selected: 112, windows: [112] });
    edge.pads.mode = "channels";
    edge.pad(15); // channel 127 is the last that fits
    expect(edge.midi).toEqual([channelOn(127, 64)]);
  });

  it("aftertouch and note off go to the channel note", () => {
    const { pad, midi, pads } = harness();
    pads.mode = "channels";
    pad(2);
    midi.length = 0;
    pad(2, "move", 0.5, 1);
    pad(2, "up");
    expect(midi).toEqual([
      [0xa1, 2, 127],
      [0x81, 2, 0],
    ]);
  });
});

describe("held pads keep their target", () => {
  it("a keyboard pad released after the mode and the base changed", () => {
    const { pad, midi, pads } = harness();
    pad(3);
    pads.mode = "channels";
    pads.shiftBase(12);
    pad(3, "move", 0.5, 1);
    pad(3, "up");
    expect(midi).toEqual([NOTE_ON_1(39, 64), [0xa0, 39, 127], NOTE_OFF_1(39)]);
  });

  it("a channel pad released after the mode changed to keyboard", () => {
    const { pad, midi, pads } = harness({ selected: 2 });
    pads.mode = "channels";
    pad(5);
    pads.mode = "keyboard";
    pad(5, "move", 0.5, 1);
    pad(5, "up");
    expect(midi).toEqual([
      [0x91, 5, 64],
      [0xa1, 5, 127],
      [0x81, 5, 0],
    ]);
  });

  it("a channel pad released after the bank changed", () => {
    const { pad, midi, pads, select, sent } = harness({ selected: 2, windows: [0, 16] });
    pads.mode = "channels";
    pad(4); // channel 4 of bank A
    select(20); // bank B now
    sent.length = 0;
    pad(4); // a second hit, now channel 20 (index 4 within bank B)
    pad(4, "up");
    pad(4, "up");
    expect(midi.map((m) => m.join(","))).toEqual(
      // the second down ends the first hit's note before it starts the new one
      ["145,4,64", "129,4,0", "145,20,64", "129,20,0"],
    );
  });

  it("two pads held across a mode change each end where they began", () => {
    const { pad, midi, pads } = harness({ selected: 2 });
    pad(0); // keyboard note 36
    pads.mode = "channels";
    pad(1); // channel 1
    pads.mode = "keyboard";
    pad(1, "up");
    pad(0, "up");
    expect(midi).toEqual([NOTE_ON_1(36, 64), [0x91, 1, 64], [0x81, 1, 0], NOTE_OFF_1(36)]);
  });

  it("releaseAll ends every held note and a later up sends nothing", () => {
    const { pad, midi, pads } = harness();
    pad(0);
    pads.mode = "channels";
    pad(1);
    midi.length = 0;
    pads.releaseAll();
    pad(0, "up");
    pad(1, "up");
    expect(midi).toEqual([NOTE_OFF_1(36), [0x81, 1, 0]]);
  });
});

describe("midiBytes for channel notes", () => {
  it("are on MIDI channel 2 with the index as the note", () => {
    expect(midiBytes.channelNoteOn(5, 100)).toEqual([0x91, 5, 100]);
    expect(midiBytes.channelNoteOn(5, 0)).toEqual([0x91, 5, 1]);
    expect(midiBytes.channelNoteOff(127)).toEqual([0x81, 127, 0]);
    expect(midiBytes.channelPressure(5, 90)).toEqual([0xa1, 5, 90]);
    expect(midiBytes.noteOn(36, 64)[0]).toBe(0x90);
  });
});

describe("note names the way FL shows them", () => {
  it("note 60 is C5, 36 is C3", () => {
    expect(noteName(60)).toBe("C5");
    expect(noteName(36)).toBe("C3");
    expect(noteName(51)).toBe("D#4");
    expect(`${noteName(36)}–${noteName(51)}`).toBe("C3–D#4");
    expect(noteName(0)).toBe("C0");
    expect(noteName(127)).toBe("G10");
    expect(isC(48)).toBe(true);
    expect(isC(49)).toBe(false);
  });
});

describe("pad LEDs outside overlays and tool pages", () => {
  it("keyboard: the selected channel's color, C notes brighter, held pads pressed", () => {
    const { ledState, pad } = harness({ selected: 2 }); // channel 3 is GREEN (even index)
    const led = ledState();
    // base 36: pad 0 = C3 and pad 12 = C4 are bright, the rest dim
    expect(led.padLeds[padByte(0)]).toBe(flColorToPalette(GREEN, "bright"));
    expect(led.padLeds[padByte(12)]).toBe(flColorToPalette(GREEN, "bright"));
    expect(led.padLeds[padByte(1)]).toBe(flColorToPalette(GREEN, "dim"));
    pad(1);
    expect(ledState().padLeds[padByte(1)]).toBe(flColorToPalette(GREEN, "pressed"));
    pad(1, "up");
    expect(ledState().padLeds[padByte(1)]).toBe(flColorToPalette(GREEN, "dim"));
  });

  it("keyboard without a selected channel uses the default orange", () => {
    const { ledState } = harness({ selected: null });
    expect(ledState().padLeds[padByte(1)]).toBe(paletteColor(1, "dim"));
  });

  it("channels: each pad its channel's color, the selected bright, the rest dim, off past the end", () => {
    const { ledState, pads, pad } = harness({ total: 20, selected: 17 });
    pads.mode = "channels";
    const led = ledState();
    expect(led.padLeds[padByte(1)]).toBe(flColorToPalette(BLUE, "bright")); // channel 18, selected
    expect(led.padLeds[padByte(0)]).toBe(flColorToPalette(GREEN, "dim"));
    expect(led.padLeds[padByte(3)]).toBe(flColorToPalette(BLUE, "dim"));
    for (let p = 4; p < 16; p++) expect(led.padLeds[padByte(p)]).toBe(LED_OFF);
    pad(3);
    expect(ledState().padLeds[padByte(3)]).toBe(flColorToPalette(BLUE, "pressed"));
  });

  it("channels: a pad lights as pressed while FL plays its channel (ACTIVITY), then goes back", () => {
    const { ledState, pads, fl } = harness({ total: 20, selected: 17 });
    pads.mode = "channels";
    fl.apply({ type: "activity", first: 16, active: [true, false, false, true] });
    expect(ledState().padLeds[padByte(0)]).toBe(flColorToPalette(GREEN, "pressed")); // channel 17
    expect(ledState().padLeds[padByte(1)]).toBe(flColorToPalette(BLUE, "bright")); // selected, silent
    expect(ledState().padLeds[padByte(3)]).toBe(flColorToPalette(BLUE, "pressed"));
    fl.apply({ type: "activity", first: 16, active: [false, false, false, false] });
    expect(ledState().padLeds[padByte(0)]).toBe(flColorToPalette(GREEN, "dim"));
    expect(ledState().padLeds[padByte(3)]).toBe(flColorToPalette(BLUE, "dim"));
  });

  it("keyboard: channel activity does not light note pads (no API says which note plays)", () => {
    const { ledState, fl } = harness({ selected: 2 });
    fl.apply({ type: "activity", first: 0, active: [false, false, true] });
    expect(ledState().padLeds[padByte(1)]).toBe(flColorToPalette(GREEN, "dim"));
  });

  it("are off while FL is not connected", () => {
    const { ledState, fl } = harness();
    fl.reset();
    expect(
      ledState()
        .padLeds.slice(26)
        .every((v) => v === LED_OFF),
    ).toBe(true);
  });
});

describe("GROUP A–H as channel banks", () => {
  it("picks the channel last selected in that bank, else the bank's first", () => {
    const { tap, sent, select } = harness({ total: 40, selected: 2, windows: [0, 16, 32] });
    tap("groupB");
    expect(sent).toEqual([{ type: "selectChannel", index: 16 }]); // nothing remembered
    sent.length = 0;
    select(21); // pick another channel in B, in FL's way
    tap("groupA"); // back to A: channel 3 (index 2) was the last there
    tap("groupB"); // and to B: index 21
    tap("groupC");
    expect(sent).toEqual([
      { type: "selectChannel", index: 2 },
      { type: "selectChannel", index: 21 },
      { type: "selectChannel", index: 32 },
    ]);
  });

  it("ignores banks that do not exist, and Shift changes nothing", () => {
    const { tap, sent, state } = harness({ total: 20 });
    tap("groupC");
    tap("groupH");
    state.shift = true;
    tap("groupB");
    expect(sent).toEqual([{ type: "selectChannel", index: 16 }]);
  });

  it("does nothing when the bank is already the selected channel's", () => {
    const { tap, sent } = harness({ total: 20, selected: 5 });
    tap("groupA");
    expect(sent).toEqual([]);
  });

  it("lights the current bank bright white, other banks dim white, the rest off", () => {
    const { groups, select } = harness({ total: 20, selected: 2 });
    const white = (v: "dim" | "bright") => paletteWhite(v);
    expect(groups()).toEqual([white("bright"), white("dim"), 0, 0, 0, 0, 0, 0]);
    select(17);
    expect(groups()).toEqual([white("dim"), white("bright"), 0, 0, 0, 0, 0, 0]);
  });

  it("works on the Channel page, whose list follows the selection to the new bank", () => {
    const { tap, sent, views, stack } = harness({ total: 40, selected: 2, windows: [0, 16] });
    expect(stack.main).toBe("channel");
    tap("groupB");
    expect(sent).toEqual([{ type: "selectChannel", index: 16 }]);
    expect(views.at(-1)?.channelOffset).toBe(16); // FL confirmed: Channel mode moves its window
  });

  it("the Mixer page keeps its track buttons and their LEDs", () => {
    const { tap, press, sent, stack, groups, fl } = harness({ total: 40, selected: 2 });
    press("mixer");
    expect(stack.main).toBe("mixer");
    sent.length = 0;
    tap("groupC"); // track 3 of the bank, not a channel bank
    expect(sent).toEqual([{ type: "selectTrack", index: 2 }]);
    const led = groups();
    expect(led[2]).toBe(flColorToPalette(RED, "bright")); // the selected track's color
    expect(led[1]).toBe(flColorToPalette(BLUE, "dim"));
    expect(led[2]).not.toBe(paletteWhite("bright"));
    expect(fl.mixerTotal).toBe(10);
  });
});

describe("PAD MODE and KEYBOARD tool pages", () => {
  it("PAD MODE sets the mode and opens its page; pressing it again leaves the page, the mode stays", () => {
    const { tap, press, release, stack, pads } = harness();
    tap("padMode");
    expect(pads.mode).toBe("channels");
    expect(stack.top?.page.id).toBe("padMode");
    press("padMode");
    release("padMode");
    expect(stack.top).toBeUndefined();
    expect(pads.mode).toBe("channels");
  });

  it("KEYBOARD sets the mode and opens its page; each replaces the other", () => {
    const { tap, stack, pads } = harness();
    tap("padMode");
    tap("keyboard");
    expect(pads.mode).toBe("keyboard");
    expect(stack.top?.page.id).toBe("keyboard");
    tap("padMode");
    expect(pads.mode).toBe("channels");
    expect(stack.top?.page.id).toBe("padMode");
  });

  it("leaving a page keeps a mode that SHIFT set while it was open", () => {
    const { tap, press, release, state, stack, pads } = harness();
    tap("padMode"); // channels, page open
    state.shift = true;
    tap("keyboard"); // keyboard mode, PAD MODE page still open
    state.shift = false;
    expect(pads.mode).toBe("keyboard");
    expect(stack.top?.page.id).toBe("padMode");
    press("padMode"); // leaves the page
    release("padMode");
    expect(stack.top).toBeUndefined();
    expect(pads.mode).toBe("keyboard");
  });

  it("SHIFT + the button sets the mode without opening the page", () => {
    const { tap, state, stack, pads } = harness();
    state.shift = true;
    tap("padMode");
    expect(pads.mode).toBe("channels");
    expect(stack.top).toBeUndefined();
    tap("keyboard");
    expect(pads.mode).toBe("keyboard");
    expect(stack.top).toBeUndefined();
  });

  it("LEDs: exactly one of PAD MODE and KEYBOARD is bright, whichever page is open; CHORDS off", () => {
    const { tap, light, state } = harness();
    expect([light("padMode"), light("keyboard"), light("chords")]).toEqual([
      "dim",
      "bright",
      "off",
    ]);
    tap("padMode");
    expect([light("padMode"), light("keyboard")]).toEqual(["bright", "dim"]);
    state.shift = true;
    tap("keyboard"); // mode keyboard while the PAD MODE page stays open
    state.shift = false;
    expect([light("padMode"), light("keyboard")]).toEqual(["dim", "bright"]);
    tap("padMode"); // closes the page (on release) and the mode stays keyboard... but pressing sets nothing
    expect([light("padMode"), light("keyboard"), light("chords")]).toEqual([
      "dim",
      "bright",
      "off",
    ]);
  });

  it("LEDs are off while FL is not connected", () => {
    const { light, fl } = harness();
    fl.reset();
    expect([light("padMode"), light("keyboard")]).toEqual(["off", "off"]);
  });

  it("does not take pads: they fall through and play", () => {
    const { tap, pad, midi, pads } = harness();
    tap("padMode");
    pad(2);
    pad(2, "up");
    expect(pads.mode).toBe("channels");
    expect(midi).toEqual([
      [0x91, 2, 64],
      [0x81, 2, 0],
    ]);
    tap("padMode");
    tap("keyboard");
    midi.length = 0;
    pad(2);
    expect(midi).toEqual([NOTE_ON_1(38, 64)]);
  });

  it("pad LEDs under the pages are the global fallback (held pads stay pressed)", () => {
    const { tap, pad, ledState } = harness({ selected: 2 });
    tap("keyboard");
    pad(1);
    expect(ledState().padLeds[padByte(1)]).toBe(flColorToPalette(GREEN, "pressed"));
    expect(ledState().padLeds[padByte(0)]).toBe(flColorToPalette(GREEN, "bright"));
  });
});

describe("PAD MODE page", () => {
  it("asks FL for the current bank's channel window and follows the bank", () => {
    const { tap, views, select, fl } = harness({ selected: 2, windows: [0, 16] });
    tap("padMode");
    expect(views.at(-1)?.channelOffset).toBe(0);
    views.length = 0;
    select(20);
    expect(views.at(-1)?.channelOffset).toBe(16);
    expect(fl.selectedChannel.index).toBe(20);
  });

  it("display 7 and 8 page the bank like GROUP A–H, their LEDs show where there is a bank", () => {
    const { tap, sent, light, select } = harness({ total: 40, selected: 20, windows: [0, 16, 32] });
    tap("padMode");
    expect([light("display7"), light("display8")]).toEqual(["dim", "dim"]);
    tap("display8");
    expect(sent.filter((c) => c.type === "selectChannel")).toEqual([
      { type: "selectChannel", index: 32 },
    ]);
    select(32);
    expect([light("display7"), light("display8")]).toEqual(["dim", "off"]);
    tap("display7");
    tap("display7");
    expect(sent.filter((c) => c.type === "selectChannel").slice(1)).toEqual([
      { type: "selectChannel", index: 20 }, // bank B again: the channel last selected there
      { type: "selectChannel", index: 0 }, // bank A: nothing remembered, its first channel
    ]);
    select(2);
    expect([light("display7"), light("display8")]).toEqual(["off", "dim"]);
  });

  it("display 1 is the latched page tab (bright); the other display buttons do nothing", () => {
    const { tap, sent, light } = harness();
    tap("padMode");
    sent.length = 0;
    expect(light("display1")).toBe("bright");
    tap("display2");
    tap("display5");
    expect(sent).toEqual([]);
    expect([2, 3, 4, 5, 6].map((n) => light(`display${n}` as "display2"))).toEqual(
      Array(5).fill("off"),
    );
  });

  it("GROUP A–H pick the bank, also with the Mixer underneath", () => {
    const { tap, press, sent } = harness({ total: 40 });
    press("mixer");
    tap("padMode");
    sent.length = 0;
    tap("groupB");
    expect(sent).toEqual([{ type: "selectChannel", index: 16 }]);
  });

  it("renders both screens, with and without channels", () => {
    for (const options of [
      {},
      { total: 0, selected: null },
      { total: 5 },
      { total: 200, selected: 190 },
    ]) {
      const h = harness({ ...options, windows: options.total === 200 ? [176] : undefined });
      h.tap("padMode");
      expect(() => h.render()).not.toThrow();
    }
  });
});

describe("KEYBOARD page", () => {
  it("OCT- OCT+ SEMI- SEMI+ on display 5–8 move the base note within 0…112", () => {
    const { tap, pads, sent } = harness();
    tap("keyboard");
    tap("display5");
    expect(pads.baseNote).toBe(24);
    tap("display6");
    tap("display6");
    expect(pads.baseNote).toBe(48);
    tap("display7");
    expect(pads.baseNote).toBe(47);
    tap("display8");
    tap("display8");
    expect(pads.baseNote).toBe(49);
    for (let i = 0; i < 10; i++) tap("display6");
    expect(pads.baseNote).toBe(112);
    for (let i = 0; i < 20; i++) tap("display5");
    expect(pads.baseNote).toBe(0);
    expect(sent.filter((c) => c.type !== "selectChannel")).toEqual([]);
  });

  it("the base note changes the notes the pads play", () => {
    const { tap, pad, midi } = harness();
    tap("keyboard");
    tap("display6"); // +12
    pad(0);
    expect(midi).toEqual([NOTE_ON_1(48, 64)]);
  });

  it("lights display 5–8 only for a step that is possible", () => {
    const { tap, light, pads } = harness();
    tap("keyboard");
    expect([5, 6, 7, 8].map((n) => light(`display${n}` as "display5"))).toEqual(
      Array(4).fill("dim"),
    );
    pads.shiftBase(-1000);
    expect([5, 6, 7, 8].map((n) => light(`display${n}` as "display5"))).toEqual([
      "off",
      "dim",
      "off",
      "dim",
    ]);
    pads.shiftBase(1000);
    expect([5, 6, 7, 8].map((n) => light(`display${n}` as "display5"))).toEqual([
      "dim",
      "off",
      "dim",
      "off",
    ]);
    expect(light("display1")).toBe("bright");
    expect([2, 3, 4].map((n) => light(`display${n}` as "display2"))).toEqual(["off", "off", "off"]);
  });

  it("GROUP A–H pick the bank, and display 1–4 do nothing", () => {
    const { tap, sent } = harness({ total: 40 });
    tap("keyboard");
    tap("groupC");
    tap("display2");
    expect(sent).toEqual([{ type: "selectChannel", index: 32 }]);
  });

  it("renders both screens, including the extremes and no channel", () => {
    for (const options of [{}, { selected: null }, { total: 0, selected: null }]) {
      const h = harness(options);
      h.tap("keyboard");
      h.pads.shiftBase(-1000);
      expect(() => h.render()).not.toThrow();
      h.pads.shiftBase(1000);
      expect(() => h.render()).not.toThrow();
    }
  });
});

describe("SELECT overlay", () => {
  it("a pad selects that channel of the bank", () => {
    const { press, pad, sent } = harness({ total: 40, selected: 20, windows: [0, 16] });
    press("select");
    sent.length = 0;
    pad(5);
    pad(5, "up");
    expect(sent).toEqual([{ type: "selectChannel", index: 21 }]);
  });

  it("takes pads past the last channel and the aftertouch without playing", () => {
    const { press, pad, sent, midi } = harness({ total: 20, selected: 17, windows: [16] });
    press("select");
    pad(10);
    pad(10, "move");
    pad(10, "up");
    expect(sent.filter((c) => c.type === "selectChannel")).toEqual([]);
    expect(midi).toEqual([]);
  });

  it("GROUP A–H pick the bank, with the overlay over the Mixer too", () => {
    const { press, tap, sent, stack } = harness({ total: 40 });
    press("mixer");
    press("select");
    expect(stack.top?.page.id).toBe("select");
    sent.length = 0;
    tap("groupB");
    expect(sent).toEqual([{ type: "selectChannel", index: 16 }]);
  });

  it("lights the selected channel's pad bright, the others dim, and the bank on GROUP", () => {
    const { press, ledState, groups } = harness({ total: 20, selected: 17, windows: [16] });
    press("select");
    const led = ledState();
    expect(led.padLeds[padByte(1)]).toBe(flColorToPalette(BLUE, "bright"));
    expect(led.padLeds[padByte(0)]).toBe(flColorToPalette(GREEN, "dim"));
    expect(led.padLeds[padByte(4)]).toBe(LED_OFF);
    expect(groups().slice(0, 3)).toEqual([paletteWhite("dim"), paletteWhite("bright"), 0]);
  });

  it("pin tab: display 1 pins it (pad does not play)", () => {
    const { press, release, tap, stack } = harness();
    press("select");
    tap("display1");
    release("select");
    expect(stack.top?.page.id).toBe("select");
    expect(stack.isPinned("select")).toBe(true);
  });

  it("renders both screens", () => {
    for (const options of [{}, { selected: null }, { total: 0, selected: null }]) {
      const h = harness(options);
      h.press("select");
      expect(() => h.render()).not.toThrow();
    }
  });
});

describe("SOLO overlay", () => {
  it("a pad toggles the solo of that channel from FL's solo flag", () => {
    const { press, pad, sent } = harness({ soloed: [3] });
    press("solo");
    pad(0);
    pad(3);
    pad(3, "up");
    expect(sent).toEqual([
      { type: "setChannel", index: 0, what: "solo", value: 1 },
      { type: "setChannel", index: 3, what: "solo", value: 0 },
    ]);
  });

  it("works on the bank of the selected channel", () => {
    const { press, pad, sent } = harness({ total: 40, selected: 34, windows: [32] });
    press("solo");
    pad(1);
    expect(sent).toEqual([{ type: "setChannel", index: 33, what: "solo", value: 1 }]);
  });

  it("lights soloed channels bright and the others dim", () => {
    const { press, ledState } = harness({ soloed: [1] });
    press("solo");
    const led = ledState();
    expect(led.padLeds[padByte(1)]).toBe(flColorToPalette(BLUE, "bright"));
    expect(led.padLeds[padByte(0)]).toBe(flColorToPalette(GREEN, "dim"));
    expect(led.padLeds[padByte(2)]).toBe(flColorToPalette(GREEN, "dim"));
  });

  it("GROUP A–H pick the bank", () => {
    const { press, tap, sent } = harness({ total: 40 });
    press("solo");
    sent.length = 0;
    tap("groupC");
    expect(sent).toEqual([{ type: "selectChannel", index: 32 }]);
  });

  it("the Mixer page keeps its claim on SOLO (no overlay, mixer tracks)", () => {
    const { press, release, tap, stack, sent } = harness();
    press("mixer");
    press("solo");
    expect(stack.top).toBeUndefined();
    sent.length = 0;
    tap("display3"); // toggles solo of track 3 while SOLO is held
    release("solo");
    expect(sent).toEqual([{ type: "setTrack", index: 2, what: "solo", value: 1 }]);
  });

  it("renders both screens", () => {
    for (const options of [{ soloed: [0, 2] }, { total: 0, selected: null }, { soloed: [] }]) {
      const h = harness(options);
      h.press("solo");
      expect(() => h.render()).not.toThrow();
    }
  });
});

describe("MUTE overlay with banks", () => {
  it("windows on the current bank and GROUP A–H pick it", () => {
    const { press, tap, pad, sent, select } = harness({ total: 40, selected: 2, windows: [0, 16] });
    press("mute");
    tap("groupB");
    expect(sent.at(-1)).toEqual({ type: "selectChannel", index: 16 });
    sent.length = 0;
    select(16);
    pad(2);
    expect(sent.at(-1)).toEqual({ type: "setChannel", index: 18, what: "mute", value: 1 });
  });
});

describe("pad mode is persisted with the page state", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "mk3d-padmode-"));
    dirs.push(dir);
    return join(dir, "mk3d", "pages.json");
  };

  it("saves the mode when it changes and loads it again", () => {
    const pinsPath = tempFile();
    const first = harness({ pinsPath });
    expect(first.pads.mode).toBe("keyboard");
    first.tap("padMode");
    expect(JSON.parse(readFileSync(pinsPath, "utf8"))).toMatchObject({ padMode: "channels" });
    first.tap("padMode"); // leaving the page does not change the mode
    const second = harness({ pinsPath });
    expect(second.pads.mode).toBe("channels");
    second.state.shift = true;
    second.tap("keyboard");
    expect(JSON.parse(readFileSync(pinsPath, "utf8"))).toMatchObject({ padMode: "keyboard" });
    expect(harness({ pinsPath }).pads.mode).toBe("keyboard");
  });

  it("keeps pin states next to the mode", () => {
    const pinsPath = tempFile();
    const first = harness({ pinsPath });
    first.press("select");
    first.tap("display1"); // pin SELECT
    first.release("select");
    first.state.shift = true;
    first.tap("padMode");
    const saved = JSON.parse(readFileSync(pinsPath, "utf8")) as Record<string, unknown>;
    expect(saved).toEqual({ pinned: { select: true }, padMode: "channels" });
    const second = harness({ pinsPath });
    expect(second.stack.isPinned("select")).toBe(true);
    expect(second.pads.mode).toBe("channels");
  });

  it("ignores a saved mode it does not know and starts with keyboard", () => {
    const pinsPath = tempFile();
    const first = harness({ pinsPath });
    first.tap("padMode");
    const saved = JSON.parse(readFileSync(pinsPath, "utf8")) as Record<string, unknown>;
    saved.padMode = "drums";
    // write it back the same way the stack does
    return import("node:fs").then(({ writeFileSync }) => {
      writeFileSync(pinsPath, JSON.stringify(saved));
      expect(harness({ pinsPath }).pads.mode).toBe("keyboard");
    });
  });

  it("is not saved without a path (tests, no file)", () => {
    const { tap, pads } = harness();
    tap("padMode");
    expect(pads.mode).toBe("channels");
  });
});
