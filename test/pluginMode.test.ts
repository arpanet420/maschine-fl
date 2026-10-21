import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import { FlState } from "../src/fl/flState.js";
import type { FlCommand, FlMessage } from "../src/fl/sysex.js";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from "../src/hw/display.js";
import type { ButtonId } from "../src/hw/ids.js";
import { LedState } from "../src/hw/leds.js";
import { PluginMode } from "../src/modes/pluginMode.js";
import { FlParamPages } from "../src/modes/pluginPages.js";
import type { PageSource } from "../src/modes/pluginPages.js";
import { NksPageSource } from "../src/nks/nksPages.js";
import type { NksPage, NksSlot } from "../src/nks/types.js";
import type { ModeContext } from "../src/modes/mode.js";

const RED = 0xff0000;

/** Page 1: main (index 3 is unnamed), page 2: VCC, page 3: mixed prefixes, pages 4–11: no prefix. */
// Pages are contiguous: page 3 = 200–203 and 300–303, page 11 has only 360–363.
const NAMES: Array<[number, string]> = [
  ...[0, 1, 2, 4, 5, 6, 7, 8].map((i): [number, string] => [i, `main: Param ${i}`]),
  ...Array.from({ length: 8 }, (_, i): [number, string] => [100 + i, `VCC: Voice ${i}`]),
  [200, "Filter: Cutoff"],
  [201, "Filter: Reso"],
  [202, "Osc: Wave"],
  [203, "Env: Attack"],
  ...Array.from({ length: 64 }, (_, i): [number, string] => [300 + i, `Knob ${i}`]),
];
const PAGE1 = [0, 1, 2, 4, 5, 6, 7, 8];
const PAGE2 = [100, 101, 102, 103, 104, 105, 106, 107];
const PAGE_COUNT = 11;

const nameMessages = (names: Array<[number, string]>): FlMessage[] => {
  // Like the FL script: frames of 8 consecutive indexes, unnamed ones empty.
  const frames = new Map<number, string[]>();
  for (const [index, name] of names) {
    const first = Math.floor(index / 8) * 8;
    const frame = frames.get(first) ?? Array.from({ length: 8 }, () => "");
    frame[index - first] = name;
    frames.set(first, frame);
  }
  return [...frames].map(([offset, list]) => ({ type: "paramNames", offset, names: list }));
};

function plugin(channel: number | null, name: string): FlMessage {
  return channel === null
    ? { type: "plugin", channel: null, valid: false, paramCount: 0, name: "" }
    : { type: "plugin", channel, valid: true, paramCount: 364, name };
}

function selected(index: number, name: string): FlMessage {
  return { type: "selectedChannel", index, color: RED, volume: 0.5, pan: 0, name, plugin: "" };
}

/** FL reporting watched parameters: value 0.5 and text "<index> dB" for each. */
const report = (...indexes: number[]): FlMessage => ({
  type: "pluginParams",
  params: indexes.map((index) => ({
    index,
    value: 0.5,
    name: NAMES.find(([i]) => i === index)?.[1] ?? "",
    valueText: `${index} dB`,
  })),
});

function setup({ withPlugin = true, source }: { withPlugin?: boolean; source?: PageSource } = {}) {
  const fl = new FlState();
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
  const mode = new PluginMode(() => state.time, source);
  const feed = (...messages: FlMessage[]) => {
    for (const message of messages) {
      fl.apply(message);
      if (message.type === "plugin" || message.type === "paramNames") {
        mode.onFlChange?.(message.type === "plugin" ? "plugin" : "paramNames", mc);
      } else if (message.type === "selectedChannel") mode.onFlChange?.("selectedChannel", mc);
    }
  };

  fl.apply({ type: "hello", version: 2 });
  fl.apply({
    type: "channels",
    total: 3,
    offset: 0,
    entries: [0, 1, 2].map((i) => ({
      selected: i === 2,
      muted: false,
      solo: false,
      color: RED,
      name: `Ch ${i}`,
    })),
  });
  fl.apply(selected(2, "Lead"));
  if (withPlugin) {
    fl.apply(plugin(2, "Diva"));
    for (const message of nameMessages(NAMES)) fl.apply(message);
    fl.apply(report(...PAGE1));
  }
  mode.enter(mc);
  const entered = sent.splice(0);

  const press = (id: ButtonId) => mode.onEvent({ type: "button", id, pressed: true }, mc);
  const turn = (index: number, delta: number) =>
    mode.onEvent({ type: "encoder", index, delta }, mc);
  const leds = () => {
    const led = new LedState();
    mode.leds(led, mc);
    return led;
  };
  // display1…8 are bytes 13…20
  const displayLeds = () => Array.from(leds().buttonLeds.slice(13, 21));
  const draw = () => {
    const left = createCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT).getContext("2d");
    const right = createCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT).getContext("2d");
    const texts = { left: [] as string[], right: [] as string[] };
    for (const [ctx, list] of [
      [left, texts.left],
      [right, texts.right],
    ] as const) {
      const original = ctx.fillText.bind(ctx);
      ctx.fillText = ((text: string, x: number, y: number) => {
        list.push(text);
        original(text, x, y);
      }) as typeof ctx.fillText;
    }
    mode.render(left, right, mc);
    return { left, right, texts };
  };
  return {
    fl,
    mode,
    mc,
    sent,
    entered,
    state,
    touchedKnobs,
    feed,
    press,
    turn,
    leds,
    displayLeds,
    draw,
  };
}

const view = (params: number[], channelOffset = 0): FlCommand => ({
  type: "view",
  channelOffset,
  mixerOffset: 0,
  patternOffset: 0,
  stepOffset: 0,
  meters: false,
  presets: false,
  patternGrid: false,
  params,
});

describe("FlParamPages", () => {
  it("skips unnamed parameters and takes the next 8 named ones per page", () => {
    const { fl } = setup();
    const pages = new FlParamPages().pages(fl);
    expect(pages).toHaveLength(PAGE_COUNT);
    expect(pages[0]?.params).toEqual(PAGE1);
    expect(pages[1]?.params).toEqual(PAGE2);
    expect(pages[2]?.params).toEqual([200, 201, 202, 203, 300, 301, 302, 303]);
    expect(pages[3]?.params).toEqual([304, 305, 306, 307, 308, 309, 310, 311]);
    expect(pages[10]?.params).toEqual([
      360,
      361,
      362,
      363,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("names a page after the prefix its parameters share, else Page n", () => {
    const { fl } = setup();
    const pages = new FlParamPages().pages(fl);
    expect(pages.map((p) => p.name)).toEqual([
      "main",
      "VCC",
      "Page 3", // Filter / Osc / Env
      "Page 4",
      "Page 5",
      "Page 6",
      "Page 7",
      "Page 8",
      "Page 9",
      "Page 10",
      "Page 11",
    ]);
    expect(pages[0]?.prefix).toBe("main");
    expect(pages[2]?.prefix).toBeUndefined();
  });

  it("gives no pages without names", () => {
    expect(new FlParamPages().pages(new FlState())).toEqual([]);
  });
});

describe("PluginMode pages and VIEW", () => {
  it("sends a VIEW with the first page's parameters on enter", () => {
    expect(setup().entered).toEqual([view(PAGE1)]);
    const none = setup({ withPlugin: false });
    expect(none.entered).toEqual([view([])]);
  });

  it("keeps the channel window offset of Channel mode", () => {
    const { feed, sent } = setup();
    feed(selected(17, "Far"));
    expect(sent).toEqual([view([], 16)]); // no plugin on channel 17 yet
    feed(plugin(17, "Diva"));
    expect(sent).toHaveLength(1);
  });

  it("jumps to a page with display 1–8 within the bank", () => {
    const { press, sent } = setup();
    press("display2");
    expect(sent).toEqual([view(PAGE2)]);
    press("display2"); // already there
    expect(sent).toHaveLength(1);
    press("display1");
    expect(sent[1]).toEqual(view(PAGE1));
    press("display3");
    expect(sent[2]).toEqual(view([200, 201, 202, 203, 300, 301, 302, 303]));
    press("display8"); // page 8
    expect(sent[3]).toEqual(view([336, 337, 338, 339, 340, 341, 342, 343]));
  });

  it("pages with the arrows and the bank follows", () => {
    const { press, sent, displayLeds } = setup();
    press("arrowLeft"); // already on page 1
    expect(sent).toEqual([]);
    for (let i = 0; i < 8; i++) press("arrowRight"); // page 9 = bank 2, slot 1
    expect(sent).toHaveLength(8);
    expect(sent[7]).toEqual(view([344, 345, 346, 347, 348, 349, 350, 351]));
    expect(displayLeds()).toEqual([63, 16, 16, 0, 0, 0, 0, 0]);
    press("display3"); // page 11
    expect(sent[8]).toEqual(view([360, 361, 362, 363]));
    press("arrowRight");
    expect(sent).toHaveLength(9);
    press("arrowLeft");
    expect(sent[9]).toEqual(view([352, 353, 354, 355, 356, 357, 358, 359]));
  });

  it("goes back to page 1 when the plugin name or the channel changes", () => {
    const { press, feed, sent, fl } = setup();
    press("display2");
    sent.length = 0;
    feed(plugin(2, "Diva")); // same plugin: stay
    expect(sent).toEqual([]);
    feed(plugin(2, "Hive"));
    // FL clears the names with the plugin; the new ones follow.
    expect(fl.paramNames.size).toBe(0);
    expect(sent).toEqual([view([])]);
    feed(
      ...nameMessages([
        [5, "A: One"],
        [6, "A: Two"],
      ]),
    );
    expect(sent.at(-1)).toEqual(view([5, 6]));
    // Another channel with a plugin of the same name.
    press("arrowRight");
    feed(selected(1, "Bass"), plugin(1, "Hive"), ...nameMessages([[9, "B: One"]]));
    expect(sent.at(-1)).toEqual(view([9]));
    expect(setup().fl.paramNames.size).toBeGreaterThan(0);
  });

  it("resets to page 1 when the plugin changes, not when it merely reports again", () => {
    const { press, feed, sent, displayLeds } = setup();
    press("display2");
    feed(plugin(2, "Diva"), report(...PAGE2));
    expect(displayLeds()[1]).toBe(63);
    feed(plugin(2, "Hive"), ...nameMessages(NAMES));
    expect(displayLeds()[0]).toBe(63);
    expect(sent.at(-1)).toEqual(view(PAGE1));
  });

  it("follows the names as they arrive", () => {
    const { feed, sent, fl } = setup({ withPlugin: false });
    sent.length = 0;
    feed(plugin(2, "Diva"));
    expect(sent).toEqual([]); // still nothing to watch
    feed(
      ...nameMessages([
        [0, "main: A"],
        [1, "main: B"],
      ]),
    );
    expect(sent.at(-1)).toEqual(view([0, 1]));
    expect(new FlParamPages().pages(fl)).toHaveLength(1);
    const before = sent.length;
    feed(...nameMessages([[500, "x: y"]])); // page 1 unchanged → it still gets its extra name
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)).toEqual(view([0, 1, 500]));
    feed(...nameMessages([[500, "x: y"]])); // identical: no new VIEW
    expect(sent.length).toBe(before + 1);
  });
});

describe("PluginMode knobs", () => {
  const setParam = (command: FlCommand | undefined) =>
    command?.type === "setParam" ? command : undefined;

  it("sends setParam for the knob's parameter, 1/1200 of the range per count", () => {
    const { turn, sent } = setup();
    expect(turn(0, 120)).toBe(true);
    expect(setParam(sent[0])?.param).toBe(0);
    expect(setParam(sent[0])?.value).toBeCloseTo(0.6, 6);
    turn(7, -60);
    expect(setParam(sent[1])?.param).toBe(8); // knob 8 = the page's eighth parameter
    expect(setParam(sent[1])?.value).toBeCloseTo(0.45, 6);
    turn(3, 12);
    expect(setParam(sent[2])?.param).toBe(4); // index 3 is unnamed and skipped
  });

  it("turns finer with Shift and clamps to 0…1", () => {
    const { turn, sent, state } = setup();
    state.shift = true;
    turn(1, 120);
    expect(setParam(sent[0])?.value).toBeCloseTo(0.51, 6);
    state.shift = false;
    turn(2, 5000);
    expect(setParam(sent[1])?.value).toBe(1);
    turn(2, 100); // pending value is already 1
    expect(sent).toHaveLength(2);
    turn(5, -9000);
    expect(setParam(sent[2])?.value).toBe(0);
  });

  it("keeps its own value for 300 ms while FL catches up, then follows FL", () => {
    const { turn, sent, state, feed } = setup();
    turn(0, 120);
    state.time += 50;
    turn(0, 120); // FL still says 0.5
    expect(setParam(sent[1])?.value).toBeCloseTo(0.7, 6);
    state.time += 400;
    feed({
      type: "pluginParams",
      params: [{ index: 0, value: 0.3, name: "main: Param 0", valueText: "x" }],
    });
    turn(0, 120);
    expect(setParam(sent[2])?.value).toBeCloseTo(0.4, 6);
  });

  it("drops a turn until FL has reported the parameter", () => {
    const { turn, sent, press } = setup();
    press("display2"); // page 2: FL has not sent its values
    expect(turn(0, 100)).toBe(true);
    expect(sent.filter((c) => c.type === "setParam")).toEqual([]);
  });

  it("leaves knobs without a parameter alone", () => {
    const { turn, press, sent } = setup();
    for (let i = 0; i < 10; i++) press("arrowRight"); // page 11: 4 parameters
    sent.length = 0;
    expect(turn(6, 100)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("does nothing without a plugin", () => {
    const none = setup({ withPlugin: false });
    none.turn(0, 100);
    expect(none.sent).toEqual([]);
    const gone = setup();
    gone.feed(plugin(null, ""));
    gone.sent.length = 0;
    gone.turn(0, 100);
    expect(gone.sent).toEqual([]);
  });
});

describe("PluginMode LEDs", () => {
  it("dims the display buttons that have a page and lights the current one", () => {
    const { displayLeds, press } = setup();
    expect(displayLeds()).toEqual([63, 16, 16, 16, 16, 16, 16, 16]);
    press("display2");
    expect(displayLeds()).toEqual([16, 63, 16, 16, 16, 16, 16, 16]);
    press("arrowRight");
    press("arrowRight");
    press("display8");
    expect(displayLeds()).toEqual([16, 16, 16, 16, 16, 16, 16, 63]);
  });

  it("lights the arrows when there is a page in that direction", () => {
    const { leds, press } = setup();
    // arrowLeft off, arrowRight dim on page 1
    expect(arrowLeds(leds())).toEqual([0, 16]);
    press("arrowRight");
    expect(arrowLeds(leds())).toEqual([16, 16]);
    for (let i = 0; i < 9; i++) press("arrowRight");
    expect(arrowLeds(leds())).toEqual([16, 0]);
  });

  it("turns every display button and the Mute LED off without a plugin, and leaves GROUP A–H", () => {
    const { displayLeds, leds } = setup({ withPlugin: false });
    expect(displayLeds()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(arrowLeds(leds())).toEqual([0, 0]);
    expect(leds().buttonLeds[58]).toBe(0); // Mute
    // GROUP A–H are the channel banks, lit by the page stack
    const led = new LedState();
    for (let byte = 30; byte < 38; byte++) led.buttonLeds[byte] = 99;
    const probe = setup({ withPlugin: false });
    probe.mode.leds(led, probe.mc);
    expect(Array.from(led.buttonLeds.slice(30, 38))).toEqual(Array(8).fill(99));
  });
});

/** Arrow left and right in LedState's button bytes. */
function arrowLeds(led: LedState): number[] {
  const probe = new LedState();
  probe.setLight("arrowLeft", "bright");
  probe.setLight("arrowRight", "bright");
  const positions = Array.from(probe.buttonLeds).flatMap((v, i) => (v === 63 ? [i] : []));
  return positions.map((i) => led.buttonLeds[i] ?? -1);
}

describe("PluginMode render", () => {
  const lit = (ctx: SKRSContext2D) =>
    ctx.getImageData(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT).data.some((v, i) => i % 4 !== 3 && v > 0);

  it("draws tabs, knob labels without the prefix, values and the page info", () => {
    const { draw } = setup();
    const { texts } = draw();
    expect(texts.left).toEqual(expect.arrayContaining(["main", "VCC", "Page 3", "Page 4"]));
    expect(texts.right).toEqual(expect.arrayContaining(["Page 5", "Page 8"]));
    // Knobs 1–4 on the left, 5–8 on the right; labels drop the "main: " prefix.
    expect(texts.left).toEqual(
      expect.arrayContaining(["Param 0", "Param 1", "Param 2", "Param 4"]),
    );
    expect(texts.left).not.toContain("Param 5");
    expect(texts.right).toEqual(
      expect.arrayContaining(["Param 5", "Param 6", "Param 7", "Param 8"]),
    );
    expect(texts.right).toEqual(expect.arrayContaining(["5 dB", "8 dB"]));
    expect(texts.left).toEqual(expect.arrayContaining(["0 dB", "4 dB"]));
    expect(texts.left).toEqual(expect.arrayContaining(["Diva", "Lead", "page 1 / 11"]));
    expect(texts.right).toContain("main"); // the page name in the middle
  });

  it("shows the bank of the current page", () => {
    const { draw, press } = setup();
    for (let i = 0; i < 8; i++) press("arrowRight"); // page 9
    const { texts } = draw();
    expect(texts.left).toEqual(expect.arrayContaining(["Page 9", "Page 10", "Page 11"]));
    expect(texts.left).not.toContain("main");
    expect(texts.left).toContain("page 9 / 11");
  });

  it("shows the full name and value large on the screen of the touched knob", () => {
    const { draw, touchedKnobs } = setup();
    touchedKnobs.add(5); // right screen, second column
    const { texts } = draw();
    expect(texts.right).toEqual(expect.arrayContaining(["main: Param 6", "6 dB"]));
    expect(texts.left).not.toContain("main: Param 6");
    touchedKnobs.clear();
    touchedKnobs.add(1);
    const second = draw().texts;
    expect(second.left).toContain("main: Param 1");
    expect(second.right).not.toContain("main: Param 1");
  });

  it("says there is no plugin on both screens", () => {
    const { draw, feed } = setup();
    feed(plugin(null, ""));
    const { texts, left, right } = draw();
    expect(texts.left).toContain("No plugin on Lead");
    expect(texts.right).toContain("No plugin on Lead");
    expect(lit(left)).toBe(true);
    expect(lit(right)).toBe(true);
    const nothing = setup({ withPlugin: false });
    expect(nothing.draw().texts.left).toContain("No plugin on Lead");
  });

  it("draws every knob touched, without names and without a channel", () => {
    const full = setup();
    for (let knob = 0; knob < 8; knob++) {
      full.touchedKnobs.clear();
      full.touchedKnobs.add(knob);
      const { left, right } = full.draw();
      expect(lit(left)).toBe(true);
      expect(lit(right)).toBe(true);
    }
    full.press("display3"); // a page with empty columns
    expect(() => full.draw()).not.toThrow();
    const bare = setup({ withPlugin: false });
    bare.feed({
      type: "selectedChannel",
      index: null,
      color: 0,
      volume: 0,
      pan: 0,
      name: "",
      plugin: "",
    });
    expect(bare.draw().texts.left).toContain("No channel selected");
    const emptyPlugin = setup({ withPlugin: false });
    emptyPlugin.feed(plugin(2, "Diva"));
    expect(emptyPlugin.draw().texts.left).toContain("No parameters");
  });
});

// ── NKS pages ────────────────────────────────────────────────────────────────

const nksSlot = (id: number | undefined, name: string, section?: string): NksSlot => ({
  id,
  name: id === undefined ? "" : name,
  ...(section !== undefined ? { section } : {}),
});

/** Page 1 uses the parameters of PAGE1 with sections Main (1–2), Mix (3–5), Out (6–8). */
const NKS_MAPPING: NksPage[] = [
  PAGE1.map((id, i) =>
    nksSlot(
      id,
      `Level ${"ABCDEFGH"[i]}`,
      ({ 0: "Main", 2: "Mix", 5: "Out" } as const)[i as 0 | 2 | 5],
    ),
  ),
  PAGE2.map((id, i) => nksSlot(id, `Voice ${i}`, i === 0 ? "VCC" : undefined)),
];

function nksSetup(product: { logo?: string; color?: string } = {}) {
  const lookup = {
    ready: true,
    lookup: () => ({
      via: "vst2" as const,
      product: {
        vendor: "u-he",
        name: "Diva",
        plids: [],
        defaultMapping: NKS_MAPPING,
        presets: 1,
        mappings: 1,
        ...product,
      },
    }),
  };
  return setup({ source: new NksPageSource(lookup, new FlParamPages(), () => {}) });
}

describe("PluginMode with NKS pages", () => {
  it("sends the page's parameters in the VIEW and turns the right ones", () => {
    const { entered, sent, turn, press, feed } = nksSetup();
    expect(entered).toEqual([view(PAGE1)]);
    turn(3, 120);
    expect(sent[0]).toMatchObject({ type: "setParam", param: 4 });
    press("display2");
    expect(sent.at(-1)).toEqual(view(PAGE2));
    feed(report(...PAGE2));
    turn(0, 120);
    expect(sent.at(-1)).toMatchObject({ type: "setParam", param: 100 });
  });

  it("labels knobs with the NKS names and keeps FL's full name on touch", () => {
    const { draw, touchedKnobs } = nksSetup();
    const { texts } = draw();
    expect(texts.left).toEqual(expect.arrayContaining(["Level A", "Level D", "Main"]));
    expect(texts.right).toEqual(expect.arrayContaining(["Level E", "Level H"]));
    expect(texts.left).not.toContain("Param 0");
    touchedKnobs.add(1);
    expect(draw().texts.left).toContain("main: Param 1");
  });

  it("draws the section row on each screen only for its own controls", () => {
    const { draw } = nksSetup();
    const { texts } = draw();
    // left: MAIN over knobs 1–2, MIX over 3–4; right: MIX carried over from slot 3, OUT at slot 6
    expect(texts.left).toEqual(expect.arrayContaining(["MAIN", "MIX"]));
    expect(texts.left).not.toContain("OUT");
    expect(texts.right).toEqual(expect.arrayContaining(["MIX", "OUT"]));
    expect(texts.right).not.toContain("MAIN");
  });

  it("repeats a section that continues onto the right screen, dimmed", () => {
    const { draw, press } = nksSetup();
    press("display2"); // VCC starts at slot 1 only
    const { texts, left, right } = draw();
    expect(texts.left).toContain("VCC");
    expect(texts.right).toContain("VCC");
    // the carried label's line is dimmed (half alpha), the label that starts here is not
    const red = (ctx: SKRSContext2D) => ctx.getImageData(10, 160, 1, 1).data[0] ?? 0;
    expect(red(left)).toBe(0xfb); // FL orange: the page has no product color
    expect(red(right)).toBeGreaterThan(100);
    expect(red(right)).toBeLessThan(160);
  });

  it("shrinks the middle area by the section row and survives touching every knob", () => {
    const { draw, touchedKnobs } = nksSetup();
    for (let knob = 0; knob < 8; knob++) {
      touchedKnobs.clear();
      touchedKnobs.add(knob);
      expect(() => draw()).not.toThrow();
    }
  });

  it("uses the product's color for the section row and FL's orange for the active tab", () => {
    const { draw } = nksSetup({ color: "#00ff00" });
    const { left } = draw();
    const rows = (y: number) => left.getImageData(0, y, 480, 1).data;
    const has = (data: Uint8ClampedArray, r: number, g: number, b: number) =>
      Array.from({ length: data.length / 4 }).some(
        (_, i) => data[i * 4] === r && data[i * 4 + 1] === g && data[i * 4 + 2] === b,
      );
    // section line: bottom of the section row, right above the knob row (y 162)
    expect(has(rows(162 - 3 + 1), 0, 255, 0)).toBe(true);
    // the active tab is underlined in FL's orange, not the channel's color (RED)
    expect(has(rows(18), 0xfb, 0x92, 0x44)).toBe(true);
    expect(has(rows(18), 0xff, 0, 0)).toBe(false);
  });

  it("draws the logo once it has loaded, and never waits or fails without one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk3d-logo-"));
    try {
      const png = path.join(dir, "MST_logo.png");
      const art = createCanvas(40, 20);
      const artCtx = art.getContext("2d");
      artCtx.fillStyle = "#fff";
      artCtx.fillRect(0, 0, 40, 20);
      fs.writeFileSync(png, art.toBuffer("image/png"));

      const withLogo = nksSetup({ logo: png });
      const white = (ctx: SKRSContext2D) =>
        Array.from(ctx.getImageData(400, 80, 1, 1).data.slice(0, 3));
      expect(white(withLogo.draw().left)).toEqual([0x2b, 0x36, 0x40]); // not loaded yet: no wait
      expect(withLogo.state.renders).toBe(0);
      await vi.waitFor(() => expect(withLogo.state.renders).toBeGreaterThan(0));
      const { left, texts } = withLogo.draw();
      expect(white(left)).toEqual([255, 255, 255]);
      expect(texts.left).toContain("Diva"); // the name still fits beside it

      const missing = nksSetup({ logo: path.join(dir, "nope.png") });
      expect(() => missing.draw()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(() => missing.draw()).not.toThrow();
      expect(missing.state.renders).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds the pages when the source changes", () => {
    let names = ["First"];
    const source: PageSource = {
      pages: () =>
        names.map((name) => ({
          name,
          params: [0, 1, 2, 4, 5, 6, 7, 8],
        })),
    };
    const { mode, mc, draw } = setup({ source });
    expect(draw().texts.left).toContain("First");
    names = ["First", "Second"];
    expect(draw().texts.left).not.toContain("Second"); // cached until told
    mode.sourceChanged();
    mode.onFlChange?.("plugin", mc);
    expect(draw().texts.left).toContain("Second");
  });
});

describe("PluginMode.resume", () => {
  it("resends the VIEW it already sent, keeping the page", () => {
    const { mode, mc, sent, entered, press } = setup();
    press("display2");
    sent.length = 0;
    mode.resume(mc);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(mode.view(mc));
    expect(entered).toHaveLength(1);
  });
});
