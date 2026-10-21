import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { FlState } from "../src/fl/flState.js";
import type { ChannelEntry, FlCommand } from "../src/fl/sysex.js";
import type { HwEvent } from "../src/hw/events.js";
import type { ButtonId } from "../src/hw/ids.js";
import { LedState } from "../src/hw/leds.js";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from "../src/hw/display.js";
import { ChannelMode, trackText } from "../src/modes/channelMode.js";
import type { ModeContext } from "../src/modes/mode.js";

const RED = 0xff0000;
/** theme.panelRaised: the column of a touched knob. */
const RAISED = [0x36, 0x44, 0x4f];
const BLUE = 0x0000ff;

function entry(i: number, patch: Partial<ChannelEntry> = {}): ChannelEntry {
  return {
    selected: false,
    muted: false,
    solo: false,
    color: i % 2 ? BLUE : RED,
    name: `Ch ${i + 1}`,
    ...patch,
  };
}

interface Options {
  total?: number;
  selected?: number | null;
  muted?: number[];
  soloed?: number[];
}

function setup({ total = 20, selected = 2, muted = [], soloed = [] }: Options = {}) {
  const fl = new FlState();
  fl.apply({ type: "hello", version: 2 });
  const window = (offset: number) =>
    Array.from({ length: Math.min(16, total - offset) }, (_, i) =>
      entry(offset + i, {
        muted: muted.includes(offset + i),
        solo: soloed.includes(offset + i),
        selected: offset + i === selected,
      }),
    );
  fl.apply({ type: "channels", total, offset: 0, entries: window(0) });
  fl.apply({
    type: "selectedChannel",
    index: selected,
    color: RED,
    volume: 0.5,
    pan: 0,
    name: "Snare",
    plugin: "",
  });
  fl.apply({
    type: "channelDetail",
    index: selected,
    pitch: 0,
    pitchRange: 2,
    cutoff: 0.5,
    resonance: 0.25,
    mixerTrack: 1,
    channelType: 0,
  });
  fl.apply({
    type: "mixer",
    total: 10,
    offset: 0,
    entries: [
      {
        selected: false,
        muted: false,
        solo: false,
        armed: false,
        color: 0,
        volume: 0.8,
        pan: 0,
        name: "Master",
      },
      {
        selected: false,
        muted: false,
        solo: false,
        armed: false,
        color: 0,
        volume: 0.8,
        pan: 0,
        name: "Drums",
      },
    ],
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
  const mode = new ChannelMode(() => state.time);
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
  return { fl, mode, mc, sent, entered, state, touchedKnobs, press, release, turn, event, leds };
}

const valueOf = (command: FlCommand | undefined) =>
  command?.type === "setChannel" ? command.value : NaN;

describe("ChannelMode window", () => {
  it("sends a VIEW on enter at the page of the selected channel", () => {
    const { entered } = setup();
    expect(entered).toEqual([
      {
        type: "view",
        channelOffset: 0,
        mixerOffset: 0,
        patternOffset: 0,
        stepOffset: 0,
        meters: false,
        presets: false,
        patternGrid: false,
        params: [0, 1, 2, 3, 4, 5, 6, 7],
      },
    ]);
    expect(setup({ selected: 17 }).entered[0]).toMatchObject({ channelOffset: 16 });
  });

  it("pages with the arrow buttons and stops at the ends", () => {
    const { press, sent } = setup();
    press("arrowLeft");
    expect(sent).toEqual([]);
    press("arrowRight");
    expect(sent).toMatchObject([{ type: "view", channelOffset: 16 }]);
    press("arrowRight");
    expect(sent).toHaveLength(1);
    press("arrowLeft");
    expect(sent[1]).toMatchObject({ type: "view", channelOffset: 0 });
  });

  it("follows a selection made in FL, but not a page the user chose", () => {
    const { fl, mc, mode, sent, press } = setup();
    fl.apply({
      type: "selectedChannel",
      index: 18,
      color: RED,
      volume: 0,
      pan: 0,
      name: "X",
      plugin: "",
    });
    mode.onFlChange?.("selectedChannel", mc);
    expect(sent).toMatchObject([{ type: "view", channelOffset: 16 }]);

    sent.length = 0;
    press("arrowLeft");
    // The same channel reports again (e.g. its volume changed): stay on the page the user chose.
    fl.apply({
      type: "selectedChannel",
      index: 18,
      color: RED,
      volume: 0.3,
      pan: 0,
      name: "X",
      plugin: "",
    });
    mode.onFlChange?.("selectedChannel", mc);
    expect(sent).toHaveLength(1);
  });
});

describe("ChannelMode selection", () => {
  it("selects with the 4D encoder and clamps at both ends", () => {
    const { sent, event } = setup({ selected: 0 });
    const turn = (delta: number) => event({ type: "nav", action: "turn", delta });
    turn(-1);
    expect(sent).toEqual([]);
    turn(1);
    expect(sent).toEqual([{ type: "selectChannel", index: 1 }]);
    turn(1); // FL has not reported yet: continue from our own selection
    expect(sent[1]).toEqual({ type: "selectChannel", index: 2 });
    turn(100);
    expect(sent[2]).toEqual({ type: "selectChannel", index: 19 });
  });

  it("moves the window when the selection leaves it", () => {
    const { sent, event, state } = setup({ selected: 15 });
    event({ type: "nav", action: "turn", delta: 1 });
    expect(sent).toMatchObject([
      { type: "selectChannel", index: 16 },
      { type: "view", channelOffset: 16 },
    ]);
    state.time += 1000;
    sent.length = 0;
    event({ type: "nav", action: "turn", delta: -1 }); // FL still says 15
    expect(sent).toMatchObject([
      { type: "selectChannel", index: 14 },
      { type: "view", channelOffset: 0 },
    ]);
  });

  it("uses tilt up/down as previous/next and push as show editor", () => {
    const { sent, event } = setup({ selected: 5 });
    event({ type: "nav", action: "tilt", direction: "down", pressed: true });
    event({ type: "nav", action: "tilt", direction: "down", pressed: false });
    expect(sent).toEqual([{ type: "selectChannel", index: 6 }]);
    expect(event({ type: "nav", action: "tilt", direction: "left", pressed: true })).toBe(false);
    event({ type: "nav", action: "tilt", direction: "up", pressed: true });
    expect(sent[1]).toEqual({ type: "selectChannel", index: 5 });
    event({ type: "nav", action: "push", pressed: true });
    expect(sent[2]).toEqual({ type: "showEditor", index: 5 });
  });

  it("leaves the group buttons to the page stack (they pick channel banks)", () => {
    const { sent, press, release, state } = setup();
    for (const id of ["groupA", "groupC", "groupH"] as const) {
      expect(press(id)).toBe(false);
      expect(release(id)).toBe(false);
    }
    state.shift = true;
    expect(press("groupA")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("toggles mute and solo of the selected channel with display 1 and 2, from FL's flags", () => {
    const { fl, sent, press, leds } = setup({ muted: [2] });
    press("display1");
    expect(sent[0]).toEqual({ type: "setChannel", index: 2, what: "mute", value: 0 });
    press("display2");
    expect(sent[1]).toEqual({ type: "setChannel", index: 2, what: "solo", value: 1 });
    // The solo flag is FL's: nothing lights until FL reports it.
    expect(leds().buttonLeds[14]).toBe(16);
    fl.apply({
      type: "channels",
      total: 20,
      offset: 0,
      entries: Array.from({ length: 16 }, (_, i) => entry(i, { solo: i === 2, selected: i === 2 })),
    });
    expect(leds().buttonLeds[14]).toBe(63); // display2 bright
    press("display2");
    expect(sent[2]).toEqual({ type: "setChannel", index: 2, what: "solo", value: 0 });
  });

  it("shows solo set in FL (or cleared by FL) on the Solo tab and display 2", () => {
    const { fl, leds, mode, mc } = setup({ soloed: [2] });
    expect(leds().buttonLeds[14]).toBe(63);
    const frame = (soloed: number[]) => ({
      type: "channels" as const,
      total: 20,
      offset: 0,
      entries: Array.from({ length: 16 }, (_, i) => entry(i, { solo: soloed.includes(i) })),
    });
    fl.apply(frame([5])); // solo moved to another channel, say by FL itself
    expect(leds().buttonLeds[14]).toBe(16);
    mode.onFlChange("selectedChannel", mc);
    fl.apply(frame([2]));
    expect(leds().buttonLeds[14]).toBe(63);
  });
});

describe("ChannelMode knobs", () => {
  it("changes volume by 1/1200 per count", () => {
    const { sent, turn } = setup();
    expect(turn(4, 120)).toBe(true);
    expect(sent[0]).toMatchObject({ type: "setChannel", index: 2, what: "volume" });
    expect(valueOf(sent[0])).toBeCloseTo(0.6, 6);
    turn(4, -60);
    expect(valueOf(sent[1])).toBeCloseTo(0.55, 6);
  });

  it("turns finer with Shift", () => {
    const { sent, turn, state } = setup();
    state.shift = true;
    turn(4, 120);
    expect(valueOf(sent[0])).toBeCloseTo(0.51, 6);
  });

  it("clamps to 0…1 and sends nothing once at the limit", () => {
    const { sent, turn, state } = setup();
    turn(4, 5000);
    expect(valueOf(sent[0])).toBe(1);
    turn(4, 100);
    expect(sent).toHaveLength(1);
    state.time += 10;
    turn(4, -9000);
    expect(valueOf(sent[1])).toBe(0);
  });

  it("sends pan and pitch as (x + 1) / 2 around their centre", () => {
    const { sent, turn } = setup();
    turn(5, 120);
    expect(sent[0]).toMatchObject({ what: "pan" });
    expect(valueOf(sent[0])).toBeCloseTo(0.6, 6); // pan +0.2
    turn(6, -120);
    expect(sent[1]).toMatchObject({ what: "pitch" });
    expect(valueOf(sent[1])).toBeCloseTo(0.4, 6);
  });

  it("keeps its own value while FL catches up, then follows FL again", () => {
    const { fl, sent, turn, state } = setup();
    turn(4, 120);
    state.time += 50;
    turn(4, 120); // FL still reports 0.5
    expect(valueOf(sent[1])).toBeCloseTo(0.7, 6);
    state.time += 400;
    fl.apply({
      type: "selectedChannel",
      index: 2,
      color: RED,
      volume: 0.3,
      pan: 0,
      name: "Snare",
      plugin: "",
    });
    turn(4, 120);
    expect(valueOf(sent[2])).toBeCloseTo(0.4, 6);
  });

  it("steps the mixer track once per 30 counts within 0…mixerTotal-1", () => {
    const { sent, turn } = setup();
    turn(7, 29);
    expect(sent).toEqual([]);
    turn(7, 1);
    expect(sent).toEqual([{ type: "setChannelTrack", index: 2, track: 2 }]);
    turn(7, 95); // 3 steps, 5 left over
    expect(sent[1]).toEqual({ type: "setChannelTrack", index: 2, track: 5 });
    turn(7, 3000);
    expect(sent[2]).toEqual({ type: "setChannelTrack", index: 2, track: 9 });
    turn(7, 3000);
    expect(sent).toHaveLength(3);
    turn(7, -3000);
    expect(sent[3]).toEqual({ type: "setChannelTrack", index: 2, track: 0 });
  });

  it("leaves unused knobs and display 5–8 alone and does nothing without a selected channel", () => {
    const { turn, press, sent } = setup();
    expect([1, 2, 3].map((knob) => turn(knob, 100))).toEqual([false, false, false]);
    expect(
      ["display5", "display6", "display7", "display8"].map((id) => press(id as ButtonId)),
    ).toEqual([false, false, false, false]);
    expect(sent).toEqual([]);
    const none = setup({ selected: null });
    none.turn(4, 100);
    expect(none.sent).toEqual([]);
    none.turn(0, 100);
    expect(none.sent).toMatchObject([{ type: "selectChannel", index: 0 }]);
  });

  it("selects the previous/next channel with knob 1, one per 40 counts", () => {
    const { sent, turn } = setup({ selected: 5 });
    expect(turn(0, 39)).toBe(true);
    expect(sent).toEqual([]);
    turn(0, 1);
    expect(sent).toEqual([{ type: "selectChannel", index: 6 }]);
    turn(0, 95); // 2 steps, 15 left over
    expect(sent[1]).toEqual({ type: "selectChannel", index: 8 });
    turn(0, 25); // 15 + 25 = 40
    expect(sent[2]).toEqual({ type: "selectChannel", index: 9 });
    turn(0, -40);
    expect(sent[3]).toEqual({ type: "selectChannel", index: 8 });
    turn(0, 10);
    turn(0, -10); // reversing drops the remainder
    expect(sent).toHaveLength(4);
  });

  it("selects slowly with small turns and clamps at the ends", () => {
    const first = setup({ selected: 0 });
    first.turn(0, -400);
    expect(first.sent).toEqual([]);
    const slow = setup({ selected: 0 });
    for (let i = 0; i < 40; i++) slow.turn(0, 1);
    expect(slow.sent).toEqual([{ type: "selectChannel", index: 1 }]);
    slow.turn(0, 4000);
    expect(slow.sent[1]).toEqual({ type: "selectChannel", index: 19 });
  });

  it("shows the editor with display 3", () => {
    const { sent, press } = setup();
    press("display3");
    expect(sent).toEqual([{ type: "showEditor", index: 2 }]);
  });

  it("ignores knob turns while FL still shows the previous channel", () => {
    const { sent, turn, event } = setup();
    event({ type: "nav", action: "turn", delta: 1 });
    sent.length = 0;
    turn(4, 100);
    expect(sent).toEqual([]);
  });
});

describe("ChannelMode LEDs", () => {
  it("leaves the group button LEDs alone (the page stack lights the banks)", () => {
    const led = new LedState();
    for (let byte = 30; byte < 38; byte++) led.buttonLeds[byte] = 99;
    const { mode, mc } = setup({ selected: 2 });
    mode.leds(led, mc);
    expect(Array.from(led.buttonLeds.slice(30, 38))).toEqual(Array(8).fill(99));
  });

  it("lights display 1 for a muted channel", () => {
    expect(setup({ muted: [2] }).leds().buttonLeds[13]).toBe(63);
    expect(setup({ muted: [] }).leds().buttonLeds[13]).toBe(16);
    expect(setup({ selected: null }).leds().buttonLeds[13]).toBe(0);
  });

  it("dims mute, solo and editor and turns unused display buttons off", () => {
    const { leds } = setup();
    // display1…8 are bytes 13…20
    const display = () => Array.from(leds().buttonLeds.slice(13, 21));
    expect(display()).toEqual([16, 16, 16, 0, 0, 0, 0, 0]);
    expect(Array.from(setup({ selected: null }).leds().buttonLeds.slice(13, 16))).toEqual([
      0, 0, 0,
    ]);
  });
});

describe("trackText", () => {
  it("names Master, known tracks and the rest", () => {
    const { fl } = setup();
    expect(trackText(fl, 0)).toBe("Master");
    expect(trackText(fl, 1)).toBe("Drums");
    expect(trackText(fl, 7)).toBe("Insert 7");
  });
});

describe("ChannelMode render", () => {
  const draw = (setupResult: ReturnType<typeof setup>) => {
    const left = createCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT).getContext("2d");
    const right = createCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT).getContext("2d");
    setupResult.mode.render(left, right, setupResult.mc);
    return { left, right };
  };
  const lit = (ctx: ReturnType<typeof draw>["left"]) =>
    ctx.getImageData(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT).data.some((v, i) => i % 4 !== 3 && v > 0);

  it("draws an empty state", () => {
    const empty = setup({ total: 0, selected: null });
    expect(() => draw(empty)).not.toThrow();
    const unconnected = { ...empty, mc: { ...empty.mc, fl: new FlState() } };
    expect(() => draw(unconnected)).not.toThrow();
  });

  it("draws a populated state with touched knobs, mute and solo", () => {
    const populated = setup({ muted: [2] });
    populated.press("display2");
    for (let knob = 0; knob < 8; knob++) {
      populated.touchedKnobs.clear();
      populated.touchedKnobs.add(knob);
      const { left, right } = draw(populated);
      expect(lit(left)).toBe(true);
      expect(lit(right)).toBe(true);
    }
  });

  it("highlights the column of a touched knob on the screen it belongs to", () => {
    const touched = setup();
    const panel = (ctx: ReturnType<typeof draw>["left"], x: number) =>
      Array.from(ctx.getImageData(x, DISPLAY_HEIGHT - 4, 1, 1).data.slice(0, 3));
    touched.touchedKnobs.add(5); // knob 6 = the right screen's second column
    const right = draw(touched).right;
    expect(panel(right, 180)).toEqual(RAISED);
    expect(panel(right, 60)).not.toEqual(RAISED);
    touched.touchedKnobs.clear();
    touched.touchedKnobs.add(0);
    const left = draw(touched).left;
    expect(panel(left, 60)).toEqual(RAISED);
    expect(panel(left, 180)).not.toEqual(RAISED);
  });

  it("draws the last page and a sampler channel", () => {
    const last = setup({ selected: 17 });
    last.press("arrowRight");
    expect(() => draw(last)).not.toThrow();
  });

  it("resume resends the VIEW and keeps showing FL's solo flag", () => {
    const { sent, leds, mode, mc } = setup({ soloed: [2] });
    sent.length = 0;
    mode.resume(mc);
    expect(sent).toEqual([mode.view()]);
    expect(sent[0]).toMatchObject({ type: "view", channelOffset: 0, patternOffset: 0 });
    expect(leds().buttonLeds[14]).toBe(63); // solo still on
  });
});
