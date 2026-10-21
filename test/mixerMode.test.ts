import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { FlState } from "../src/fl/flState.js";
import type { FlCommand, MixerEntry } from "../src/fl/sysex.js";
import type { HwEvent } from "../src/hw/events.js";
import type { ButtonId } from "../src/hw/ids.js";
import { COLOR_LEDS, LedState, MONO_LEDS } from "../src/hw/leds.js";
import { LED_OFF } from "../src/hw/palette.js";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from "../src/hw/display.js";
import { flColorToPalette } from "../src/modes/format.js";
import { MixerMode } from "../src/modes/mixerMode.js";
import type { Mode, ModeContext } from "../src/modes/mode.js";
import { PageStack } from "../src/modes/pageStack.js";
import { PENDING_MS } from "../src/modes/knob.js";

const RED = 0xff0000;
const BLUE = 0x0000ff;
const GROUPS = [
  "groupA",
  "groupB",
  "groupC",
  "groupD",
  "groupE",
  "groupF",
  "groupG",
  "groupH",
] as const;
const DISPLAYS = [
  "display1",
  "display2",
  "display3",
  "display4",
  "display5",
  "display6",
  "display7",
  "display8",
] as const;

function entry(track: number, patch: Partial<MixerEntry> = {}): MixerEntry {
  return {
    selected: false,
    muted: false,
    solo: false,
    armed: false,
    color: track % 2 ? BLUE : RED,
    volume: 0.5,
    pan: 0,
    name: track === 0 ? "Master" : `Insert ${track}`,
    ...patch,
  };
}

/** The window FL would report for the bank that starts at `offset`. */
function applyMixer(
  fl: FlState,
  total: number,
  offset: number,
  patch: (track: number) => Partial<MixerEntry> = () => ({}),
) {
  const entries = Array.from({ length: Math.min(8, total - offset) }, (_, i) =>
    entry(offset + i, patch(offset + i)),
  );
  fl.apply({ type: "mixer", total, offset, entries });
}

interface Options {
  total?: number;
  selected?: number;
  patch?: (track: number) => Partial<MixerEntry>;
}

function setup({ total = 20, selected = 0, patch }: Options = {}) {
  const fl = new FlState();
  fl.apply({ type: "hello", version: 2 });
  applyMixer(fl, total, 0, patch);
  fl.apply({ type: "selectedTrack", index: selected });
  fl.apply({
    type: "selectedChannel",
    index: 17,
    color: RED,
    volume: 0.5,
    pan: 0,
    name: "Snare",
    plugin: "",
  });
  const sent: FlCommand[] = [];
  const state = { shift: false, time: 1000, renders: 0 };
  const touchedKnobs = new Set<number>();
  const mc: ModeContext = {
    fl,
    send: (command) => sent.push(command),
    get shift() {
      return state.shift;
    },
    touchedKnobs,
    requestRender: () => state.renders++,
  };
  const mode = new MixerMode(() => state.time);
  mode.enter(mc);
  const entered = sent.splice(0);
  const press = (id: ButtonId) => mode.onEvent({ type: "button", id, pressed: true }, mc);
  const release = (id: ButtonId) => mode.onEvent({ type: "button", id, pressed: false }, mc);
  const turn = (index: number, delta: number) =>
    mode.onEvent({ type: "encoder", index, delta }, mc);
  const event = (e: HwEvent) => mode.onEvent(e, mc);
  const leds = () => {
    const led = new LedState();
    mode.leds(led, mc);
    return led;
  };
  const light = (id: keyof typeof MONO_LEDS) => {
    const value = leds().buttonLeds[MONO_LEDS[id]];
    return value === 0 ? "off" : value === 16 ? "dim" : value === 63 ? "bright" : `?${value}`;
  };
  return {
    fl,
    mode,
    mc,
    sent,
    entered,
    state,
    touchedKnobs,
    press,
    release,
    turn,
    event,
    leds,
    light,
  };
}

const valueOf = (command: FlCommand | undefined) =>
  command?.type === "setTrack" ? command.value : NaN;
/** Commands with their value rounded to 6 digits, so float noise does not matter. */
const rounded = (command: FlCommand | undefined) =>
  command?.type === "setTrack"
    ? { ...command, value: Math.round(command.value * 1e6) / 1e6 }
    : command;

describe("MixerMode: VIEW and banks", () => {
  it("sends a VIEW on enter at the bank of the selected track, with meters on", () => {
    expect(setup().entered).toEqual([
      {
        type: "view",
        channelOffset: 16, // the page of the selected channel (17) stays reported
        mixerOffset: 0,
        patternOffset: 0,
        stepOffset: 0,
        meters: true,
        presets: false,
        patternGrid: false,
        params: [],
      },
    ]);
    expect(setup({ selected: 9 }).entered[0]).toMatchObject({ mixerOffset: 8, meters: true });
    expect(setup({ selected: 19 }).entered[0]).toMatchObject({ mixerOffset: 16 });
  });

  it("claims MUTE and SOLO, and nothing else", () => {
    const { mode } = setup();
    expect(mode.claimsPageButton("mute")).toBe(true);
    expect(mode.claimsPageButton("solo")).toBe(true);
    expect(mode.claimsPageButton("pattern")).toBe(false);
    expect(mode.claimsPageButton("display1")).toBe(false);
  });

  it("pages with the arrows and stops at the ends", () => {
    const { press, sent } = setup();
    press("arrowLeft");
    expect(sent).toEqual([]);
    press("arrowRight");
    expect(sent).toMatchObject([{ type: "view", mixerOffset: 8, meters: true }]);
    press("arrowRight");
    expect(sent[1]).toMatchObject({ mixerOffset: 16 });
    press("arrowRight");
    expect(sent).toHaveLength(2);
    press("arrowLeft");
    expect(sent[2]).toMatchObject({ mixerOffset: 8 });
  });

  it("follows a selection made in FL, but not a bank the user chose", () => {
    const { fl, mc, mode, sent, press } = setup();
    fl.apply({ type: "selectedTrack", index: 10 });
    mode.onFlChange("selectedTrack", mc);
    expect(sent).toMatchObject([{ type: "view", mixerOffset: 8 }]);
    sent.length = 0;
    press("arrowLeft");
    sent.length = 0;
    // FL reports the same selection again: the bank the user paged to stays
    mode.onFlChange("selectedTrack", mc);
    expect(sent).toEqual([]);
  });

  it("resends its VIEW without changing state on resume", () => {
    const { mode, mc, sent, press } = setup();
    press("arrowRight");
    sent.length = 0;
    mode.resume(mc);
    expect(sent).toMatchObject([{ type: "view", mixerOffset: 8 }]);
  });

  it("clamps the bank when the mixer gets shorter", () => {
    const { fl, mc, mode, sent, press } = setup();
    press("arrowRight");
    press("arrowRight");
    sent.length = 0;
    applyMixer(fl, 10, 0);
    mode.onFlChange("mixer", mc);
    expect(sent).toMatchObject([{ type: "view", mixerOffset: 8 }]);
  });
});

describe("MixerMode: knobs", () => {
  it("sets the volume of the track under the knob, from the bank's first track", () => {
    const { turn, sent, press, fl } = setup();
    turn(2, 120);
    expect(sent.map(rounded)).toEqual([{ type: "setTrack", index: 2, what: "volume", value: 0.6 }]);
    press("arrowRight");
    sent.length = 0;
    applyMixer(fl, 20, 8);
    turn(0, -120);
    expect(sent.map(rounded)).toEqual([{ type: "setTrack", index: 8, what: "volume", value: 0.4 }]);
  });

  it("divides a turn by 10 with Shift and clamps to 0…1", () => {
    const { turn, sent, state } = setup();
    state.shift = true;
    turn(1, 120);
    expect(valueOf(sent[0])).toBeCloseTo(0.51, 10);
    state.shift = false;
    state.time += 1000;
    turn(1, 100000);
    expect(valueOf(sent.at(-1))).toBe(1);
    turn(1, 1);
    expect(sent).toHaveLength(2);
  });

  it("keeps its own value for a moment, so a fast turn does not jump back", () => {
    const { turn, sent, state } = setup();
    turn(0, 120);
    state.time += 100;
    turn(0, 120); // FL still reports 0.5: the turn goes on from 0.6
    expect(valueOf(sent[1])).toBeCloseTo(0.7, 10);
    state.time += PENDING_MS;
    turn(0, 120); // FL's value is back in charge
    expect(valueOf(sent[2])).toBeCloseTo(0.6, 10);
  });

  it("does nothing for a strip past the last track, or before FL reported it", () => {
    const { turn, sent, fl, mc, press } = setup({ total: 11 });
    press("arrowRight");
    sent.length = 0;
    turn(3, 100); // track 11 does not exist
    expect(sent).toEqual([]);
    turn(0, 100); // track 8 exists but FL has not sent bank 1 yet... its data is missing
    expect(sent).toEqual([]);
    applyMixer(fl, 11, 8);
    turn(0, 120);
    expect(sent).toMatchObject([{ type: "setTrack", index: 8, what: "volume" }]);
    expect(mc.fl.mixerTotal).toBe(11);
  });

  it("toggles volume and pan for all knobs with a push of the 4D encoder", () => {
    const { turn, sent, event, state, fl } = setup({ patch: (t) => ({ pan: t === 1 ? -0.5 : 0 }) });
    expect(event({ type: "nav", action: "push", pressed: true })).toBe(true);
    expect(event({ type: "nav", action: "push", pressed: false })).toBe(true);
    turn(1, 120);
    // pan −0.5 is 0.25 on the wire; +0.1 of it
    expect(sent.map(rounded)).toEqual([{ type: "setTrack", index: 1, what: "pan", value: 0.35 }]);
    state.time += 1000;
    turn(0, -60); // centre is 0.5 on the wire
    expect(rounded(sent[1])).toEqual({ type: "setTrack", index: 0, what: "pan", value: 0.45 });
    event({ type: "nav", action: "push", pressed: true });
    state.time += 1000;
    turn(1, 120);
    expect(sent[2]).toMatchObject({ what: "volume" });
    expect(fl.mixer.get(1)?.pan).toBe(-0.5);
  });
});

describe("MixerMode: 4D encoder", () => {
  it("turns the volume of the selected track, by 1/100 per detent", () => {
    const { event, sent, state } = setup({ selected: 3 });
    event({ type: "nav", action: "turn", delta: 5 });
    expect(sent[0]).toMatchObject({ type: "setTrack", index: 3, what: "volume" });
    expect(valueOf(sent[0])).toBeCloseTo(0.55, 10);
    state.time += 1000;
    state.shift = true;
    event({ type: "nav", action: "turn", delta: -5 });
    expect(valueOf(sent[1])).toBeCloseTo(0.495, 10);
  });

  it("turns the pan in pan mode", () => {
    const { event, sent } = setup({ selected: 3 });
    event({ type: "nav", action: "push", pressed: true });
    event({ type: "nav", action: "turn", delta: -10 });
    expect(sent[0]).toMatchObject({ type: "setTrack", index: 3, what: "pan" });
    expect(valueOf(sent[0])).toBeCloseTo(0.4, 10);
  });

  it("selects the previous and next track with the tilt, moving the bank when needed", () => {
    const { event, sent } = setup({ selected: 7 });
    const tilt = (direction: "left" | "right", pressed = true) =>
      event({ type: "nav", action: "tilt", direction, pressed });
    expect(tilt("right")).toBe(true);
    expect(sent).toEqual([
      { type: "selectTrack", index: 8 },
      {
        type: "view",
        channelOffset: 16,
        mixerOffset: 8,
        patternOffset: 0,
        stepOffset: 0,
        meters: true,
        presets: false,
        patternGrid: false,
        params: [],
      },
    ]);
    sent.length = 0;
    tilt("right"); // FL has not confirmed yet: go on from our own selection
    expect(sent).toEqual([{ type: "selectTrack", index: 9 }]);
    sent.length = 0;
    tilt("right", false);
    expect(sent).toEqual([]);
    tilt("left");
    tilt("left");
    expect(sent[0]).toEqual({ type: "selectTrack", index: 8 });
    expect(sent[1]).toEqual({ type: "selectTrack", index: 7 });
    expect(sent[2]).toMatchObject({ type: "view", mixerOffset: 0 });
    // up and down are not ours
    expect(event({ type: "nav", action: "tilt", direction: "up", pressed: true })).toBe(false);
  });

  it("clamps the tilt at the first and last track", () => {
    const first = setup({ selected: 0 });
    first.event({ type: "nav", action: "tilt", direction: "left", pressed: true });
    expect(first.sent).toEqual([]);
    const last = setup({ selected: 19 });
    last.event({ type: "nav", action: "tilt", direction: "right", pressed: true });
    expect(last.sent).toEqual([]);
  });
});

describe("MixerMode: selecting and the MUTE/SOLO holds", () => {
  it("selects track 1–8 of the bank with the display and the group buttons", () => {
    const { press, sent } = setup();
    for (const [i, id] of DISPLAYS.entries()) {
      press(id);
      expect(sent.pop()).toEqual({ type: "selectTrack", index: i });
    }
    for (const [i, id] of GROUPS.entries()) {
      press(id);
      expect(sent.pop()).toEqual({ type: "selectTrack", index: i });
    }
    press("arrowRight");
    sent.length = 0;
    press("groupC");
    expect(sent).toEqual([{ type: "selectTrack", index: 10 }]);
  });

  it("ignores a button past the last track", () => {
    const { press, sent } = setup({ total: 11 });
    press("arrowRight");
    sent.length = 0;
    press("display4"); // track 11
    press("groupH");
    expect(sent).toEqual([]);
  });

  it("toggles mute of a strip with MUTE held, from the display and the group buttons", () => {
    const { press, release, sent, state } = setup({ patch: (t) => ({ muted: t === 2 }) });
    expect(press("mute")).toBe(true);
    press("display1");
    expect(sent.pop()).toEqual({ type: "setTrack", index: 0, what: "mute", value: 1 });
    press("display3");
    expect(sent.pop()).toEqual({ type: "setTrack", index: 2, what: "mute", value: 0 });
    state.time += 1000;
    press("groupB");
    expect(sent.pop()).toEqual({ type: "setTrack", index: 1, what: "mute", value: 1 });
    expect(sent).toEqual([]); // no selection sent
    release("mute");
    press("display1");
    expect(sent).toEqual([{ type: "selectTrack", index: 0 }]);
  });

  it("toggles solo with SOLO held, and a quick second press undoes it before FL answers", () => {
    const { press, release, sent } = setup();
    press("solo");
    press("groupE");
    expect(sent.pop()).toEqual({ type: "setTrack", index: 4, what: "solo", value: 1 });
    press("groupE");
    expect(sent.pop()).toEqual({ type: "setTrack", index: 4, what: "solo", value: 0 });
    release("solo");
    expect(sent).toEqual([]);
  });

  it("lets MUTE win when both are held", () => {
    const { press, sent } = setup();
    press("mute");
    press("solo");
    press("display2");
    expect(sent).toEqual([{ type: "setTrack", index: 1, what: "mute", value: 1 }]);
  });
});

describe("MixerMode: LEDs", () => {
  it("lights display buttons: bright selected, dim others, off past the last track", () => {
    const { light, press, event } = setup({ total: 11, selected: 2 });
    expect(DISPLAYS.map(light)).toEqual([
      "dim",
      "dim",
      "bright",
      "dim",
      "dim",
      "dim",
      "dim",
      "dim",
    ]);
    press("arrowRight");
    expect(DISPLAYS.map(light)).toEqual(["dim", "dim", "dim", "off", "off", "off", "off", "off"]);
    // the tilt selects track 3 (bank 0 again): our own selection counts before FL confirms
    event({ type: "nav", action: "tilt", direction: "right", pressed: true });
    expect(DISPLAYS.map(light)).toEqual([
      "dim",
      "dim",
      "dim",
      "bright",
      "dim",
      "dim",
      "dim",
      "dim",
    ]);
  });

  it("lights the group buttons in the track's color, bright when selected", () => {
    const { leds } = setup({ total: 11, selected: 1 });
    const led = leds();
    const group = (id: (typeof GROUPS)[number]) => led.buttonLeds[COLOR_LEDS[id]];
    expect(group("groupA")).toBe(flColorToPalette(RED, "dim"));
    expect(group("groupB")).toBe(flColorToPalette(BLUE, "bright"));
    expect(group("groupC")).toBe(flColorToPalette(RED, "dim"));
  });

  it("turns display and group buttons off past the last track", () => {
    const { leds, press } = setup({ total: 10 });
    press("arrowRight");
    const led = leds();
    expect(led.buttonLeds[MONO_LEDS.display2]).toBe(16); // track 9
    expect(led.buttonLeds[MONO_LEDS.display3]).toBe(0);
    expect(led.buttonLeds[COLOR_LEDS.groupC]).toBe(LED_OFF);
    expect(led.buttonLeds[COLOR_LEDS.groupH]).toBe(LED_OFF);
  });

  it("lights the arrows when the bank exists", () => {
    const { light, press } = setup();
    expect([light("arrowLeft"), light("arrowRight")]).toEqual(["off", "dim"]);
    press("arrowRight");
    expect([light("arrowLeft"), light("arrowRight")]).toEqual(["dim", "dim"]);
    press("arrowRight");
    expect([light("arrowLeft"), light("arrowRight")]).toEqual(["dim", "off"]);
  });

  it("lights MUTE and SOLO bright while held, dim otherwise", () => {
    const { light, press, release } = setup();
    expect([light("mute"), light("solo")]).toEqual(["dim", "dim"]);
    press("mute");
    expect([light("mute"), light("solo")]).toEqual(["bright", "dim"]);
    release("mute");
    press("solo");
    expect([light("mute"), light("solo")]).toEqual(["dim", "bright"]);
  });

  it("shows the muted or soloed strips bright while MUTE or SOLO is held", () => {
    const { light, press } = setup({ patch: (t) => ({ muted: t === 1, solo: t === 4 }) });
    expect(light("display1")).toBe("bright"); // selected track 0
    press("mute");
    expect(DISPLAYS.slice(0, 3).map(light)).toEqual(["dim", "bright", "dim"]);
    press("solo");
    press("mute"); // still MUTE
    expect(light("display5")).toBe("dim");
  });

  it("turns them off while FL is not connected", () => {
    const { light, fl } = setup();
    fl.reset();
    expect([light("display1"), light("mute"), light("arrowRight")]).toEqual(["off", "off", "off"]);
  });
});

describe("MixerMode: render", () => {
  const draw = (setupResult: ReturnType<typeof setup>) => {
    const left = createCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT).getContext("2d");
    const right = createCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT).getContext("2d");
    setupResult.mode.render(left, right, setupResult.mc);
    return { left, right };
  };
  const pixel = (ctx: ReturnType<typeof draw>["left"], x: number, y: number) => [
    ...ctx.getImageData(x, y, 1, 1).data.slice(0, 3),
  ];

  it("renders both screens without throwing, with data, meters and an empty last bank", () => {
    const s = setup({
      total: 11,
      selected: 10,
      patch: (t) => ({ muted: t % 3 === 1, solo: t === 9, armed: t === 8 }),
    });
    s.fl.apply({
      type: "meters",
      offset: 0,
      peaks: [
        [0.5, 0.5],
        [1, 0.2],
        [0, 0],
      ],
    });
    s.mode.onFlChange("meters", s.mc);
    draw(s);
    s.press("arrowRight");
    s.touchedKnobs.add(1);
    s.touchedKnobs.add(6);
    draw(s);
    s.event({ type: "nav", action: "push", pressed: true });
    draw(s);
  });

  it("renders before FL has reported anything", () => {
    const fl = new FlState();
    const mc: ModeContext = {
      fl,
      send: () => undefined,
      shift: false,
      touchedKnobs: new Set(),
      requestRender: () => undefined,
    };
    const mode = new MixerMode();
    const ctx = createCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT).getContext("2d");
    expect(() => mode.render(ctx, ctx, mc)).not.toThrow();
  });

  it("highlights the column of a touched knob on its own screen", () => {
    const s = setup();
    // empty spot inside strip 5's card (right screen, column 2: x 124…236), beside the LED row
    const [x, y] = [170, 50] as const;
    const quiet = draw(s);
    s.touchedKnobs.add(5);
    const touched = draw(s);
    expect(pixel(touched.right, x, y)).not.toEqual(pixel(quiet.right, x, y));
    expect(pixel(touched.left, x, y)).toEqual(pixel(quiet.left, x, y));
  });
});

describe("MixerMode in the page stack", () => {
  it("opens no MUTE overlay: held MUTE + a display button toggles that strip's mute", () => {
    const mixer = new MixerMode();
    const mute: Mode = {
      name: "mute",
      enter: () => undefined,
      onEvent: () => false,
      render: () => undefined,
      leds: () => undefined,
    };
    const stack = new PageStack({ pages: { mixer, mute } });
    const fl = new FlState();
    fl.apply({ type: "hello", version: 2 });
    applyMixer(fl, 10, 0);
    const sent: FlCommand[] = [];
    const mc: ModeContext = {
      fl,
      send: (command) => sent.push(command),
      shift: false,
      touchedKnobs: new Set(),
      requestRender: () => undefined,
    };
    const button = (id: ButtonId, pressed: boolean) =>
      stack.onEvent({ type: "button", id, pressed }, mc);
    // CHANNEL is not built in this stack; MIXER is
    button("mixer", true);
    button("mixer", false);
    expect(stack.main).toBe("mixer");
    sent.length = 0;
    button("mute", true);
    expect(stack.top).toBeUndefined();
    button("display2", true);
    button("display2", false);
    button("mute", false);
    expect(stack.top).toBeUndefined();
    expect(sent).toEqual([{ type: "setTrack", index: 1, what: "mute", value: 1 }]);
    // released: the display button selects again
    button("display2", true);
    expect(sent[1]).toEqual({ type: "selectTrack", index: 1 });
    // the page's own LEDs for MUTE are not overridden by the page-button row
    const leds = new LedState();
    stack.leds(leds, mc);
    expect(leds.buttonLeds[MONO_LEDS.mute]).toBe(16);
    button("mute", true);
    stack.leds(leds, mc);
    expect(leds.buttonLeds[MONO_LEDS.mute]).toBe(63);
  });
});
