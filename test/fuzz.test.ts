// Random input through the real pages and decoders, with fixed seeds so a failure repeats. This finds logic
// errors: a throw, a note left sounding, a bad byte, a command that doesn't encode, text off the screen. It
// runs on a fake FL and no USB timing, so it says nothing about how FL or the MK3 really behave.
import { readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { decodeCommand, decodeSysex, encodeCommand } from "../src/fl/sysex.js";
import { FlState } from "../src/fl/flState.js";
import { BUTTONS, type ButtonId } from "../src/hw/ids.js";
import { InputParser } from "../src/hw/input.js";
import { COLOR_LEDS, MONO_LEDS, NAV_LEDS } from "../src/hw/leds.js";
import { stackHarness } from "../src/tools/stackHarness.js";

const RUNS = 12;
const STEPS = 150;

interface Vector {
  direction: string;
  hex: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/sysex-vectors.json", import.meta.url), "utf8"),
) as Vector[];
const bytesOf = (hex: string): number[] =>
  (hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16));
const fromFl = vectors.filter((v) => v.direction === "fromFl").map((v) => bytesOf(v.hex));

/** mulberry32: small, and the same numbers everywhere. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONO_BYTES = new Set<number>(Object.values(MONO_LEDS));
const COLOR_BYTES = new Set<number>([...Object.values(COLOR_LEDS), ...Object.values(NAV_LEDS)]);
const MONO_VALUES = new Set([0, 16, 63]);
const TOP_PALETTE_INDEX = 71;

function runPages(seed: number): void {
  const r = random(seed);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  const channels = pick([1, 2, 8, 16, 24, 130]);
  const h = stackHarness({
    channels,
    selected: int(channels),
    patternLength: pick([1, 16, 32, 64, 256, 512]),
    patternCount: pick([1, 3, 20]),
    random: r,
    tempo: pick([120, 60, 999, 10]),
    ppq: pick([96, 96, 960, 24]),
  });
  const { fl } = h;
  fl.on("change", (section) => {
    if (section === "connection" && !fl.connected) h.stack.releasePads();
    if (section === "connection" && fl.connected) h.stack.enter(h.mc);
    else if (fl.connected) h.stack.onFlChange(section, h.mc);
  });

  const heldPads = new Set<number>();
  const heldButtons = new Set<ButtonId>();
  const sounding = new Set<string>();
  let midiRead = 0;
  let sentRead = 0;
  const deviceLost = () => {
    h.pads.releaseAll();
    h.stack.releasePads();
    h.strip.release(h.mc);
    heldPads.clear();
  };

  const button = (id: ButtonId, pressed: boolean) => {
    if (id === "shift") h.state.shift = pressed;
    else h.stack.onEvent({ type: "button", id, pressed }, h.mc);
  };
  const actions: readonly [number, () => void][] = [
    [
      20,
      () => {
        const id = pick(BUTTONS);
        if (["play", "stop", "rec", "tap"].includes(id)) return;
        const pressed = !heldButtons.has(id);
        if (pressed) heldButtons.add(id);
        else heldButtons.delete(id);
        button(id, pressed);
      },
    ],
    [
      8,
      () => {
        const id = pick([...heldButtons]);
        if (id === undefined) return;
        heldButtons.delete(id);
        button(id, false);
      },
    ],
    [
      25,
      () => {
        const pad = int(16);
        if (heldPads.delete(pad)) h.pad(pad, "up", { pressure: 0, velocity: 0 });
        else {
          heldPads.add(pad);
          h.pad(pad, "down", { pressure: r(), velocity: r() });
        }
      },
    ],
    [
      15,
      () =>
        h.stack.onEvent(
          { type: "encoder", index: int(8), delta: pick([-500, -40, -1, 1, 40, 500]) },
          h.mc,
        ),
    ],
    [8, () => h.turn(pick([-4, -1, 1, 4]))],
    [3, () => h.push(r() < 0.5)],
    [3, () => h.tilt(pick(["up", "down", "left", "right"]), r() < 0.6)],
    [4, () => h.stripAt(r(), r() < 0.7)],
    [
      12,
      () => {
        const frame = [...pick(fromFl)];
        for (let i = int(4); i > 0; i--) {
          const at = 5 + int(Math.max(1, frame.length - 6));
          if (at < frame.length - 1) frame[at] = pick([0, 1, 63, 64, 127, int(128)]);
        }
        const message = decodeSysex(frame);
        if (message && message.type !== "unknown") fl.apply(message);
      },
    ],
    [10, () => h.advance(pick([1, 16, 50, 400, 5000]))],
    [3, () => h.select(int(channels))],
    [3, () => h.playing(r() < 0.6)],
    [4, () => h.songPos(1 + int(40), 1 + int(16), int(24))],
    [2, () => h.meter(pick([16, 12, 14, 6, 24, 20, 1, 3, 256]), pick([4, 3, 6, 7, 5, 1, 127]))],
    [1, deviceLost],
  ];
  const total = actions.reduce((sum, [weight]) => sum + weight, 0);

  const checkOutput = () => {
    for (; midiRead < h.midi.length; midiRead++) {
      const bytes = h.midi[midiRead] ?? [];
      const status = bytes[0] ?? 0;
      expect(status).toBeGreaterThanOrEqual(0x80);
      expect(status).toBeLessThanOrEqual(0xef);
      for (const byte of bytes.slice(1)) {
        expect(Number.isInteger(byte) && byte >= 0 && byte <= 127).toBe(true);
      }
      const kind = status & 0xf0;
      const key = `${status & 0x0f}:${bytes[1]}`;
      if (kind === 0x90 && (bytes[2] ?? 0) > 0) sounding.add(key);
      else if (kind === 0x80 || kind === 0x90) sounding.delete(key);
    }
    for (; sentRead < h.sent.length; sentRead++) {
      const command = h.sent[sentRead];
      if (command) encodeCommand(command);
    }
    for (const view of h.views) encodeCommand(view);
    h.views.length = 0;
  };
  const checkLeds = () => {
    const leds = h.ledState();
    leds.buttonLeds.forEach((value, byte) => {
      if (byte > 0 && MONO_BYTES.has(byte)) expect(MONO_VALUES.has(value)).toBe(true);
      if (byte > 0 && COLOR_BYTES.has(byte)) expect(value).toBeLessThanOrEqual(TOP_PALETTE_INDEX);
    });
    leds.padLeds.forEach((value, byte) => {
      if (byte > 0) expect(value).toBeLessThanOrEqual(TOP_PALETTE_INDEX);
    });
  };
  const checkText = () => {
    const left = createCanvas(480, 272).getContext("2d");
    const right = createCanvas(480, 272).getContext("2d");
    for (const ctx of [left, right]) {
      const original = ctx.fillText.bind(ctx);
      ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
        original(text, x, y, maxWidth);
        const m = ctx.getTransform();
        if (m.b !== 0 || m.c !== 0) return; // rotated track names
        const width = Math.min(ctx.measureText(text).width, maxWidth ?? Infinity);
        const align = ctx.textAlign;
        const start = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
        expect(start + m.e, `"${text}" starts off the screen`).toBeGreaterThanOrEqual(-1);
        expect(start + m.e + width, `"${text}" runs off the screen`).toBeLessThanOrEqual(481);
      };
    }
    h.stack.render(left, right, h.mc);
  };

  for (let step = 0; step < STEPS; step++) {
    let roll = int(total);
    for (const [weight, action] of actions) {
      roll -= weight;
      if (roll < 0) {
        action();
        break;
      }
    }
    checkOutput();
    checkLeds();
    if (fl.connected && r() < 0.15) checkText();
    if (!fl.connected && r() < 0.3) fl.apply({ type: "hello", version: 2 });
  }

  // The device goes away with everything held: nothing may sound any more, whatever page was on top.
  deviceLost();
  h.advance(60000);
  checkOutput();
  expect([...sounding]).toEqual([]);
}

describe("random input", () => {
  it("goes through the pages without a throw, a bad byte or a hanging note", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      try {
        runPages(seed);
      } catch (error) {
        throw new Error(`seed ${seed}: ${String(error)}`, { cause: error });
      }
    }
  });

  it("garbage doesn't get past the SysEx decoders", () => {
    const r = random(12345);
    const int = (n: number) => Math.floor(r() * n);
    const state = new FlState();
    for (let i = 0; i < 20000; i++) {
      const frame = [0xf0, 0x7d, 0x4d, 0x33, int(128)];
      for (let j = int(40); j > 0; j--) frame.push(int(128));
      if (r() < 0.9) frame.push(0xf7);
      const message = decodeSysex(frame);
      if (message && message.type !== "unknown") state.apply(message);
      const command = decodeCommand(frame);
      if (command) encodeCommand(command);
    }
  });

  it("garbage doesn't get past the HID parser, and every event is in range", () => {
    const r = random(54321);
    const int = (n: number) => Math.floor(r() * n);
    const parser = new InputParser();
    for (let i = 0; i < 20000; i++) {
      const id = r() < 0.5 ? 1 : r() < 0.9 ? 2 : int(256);
      const size = id === 1 ? 42 : id === 2 ? 64 : int(70);
      const report = new Uint8Array(size);
      report[0] = id;
      for (let j = 1; j < size; j++) report[j] = r() < 0.5 ? 0 : int(256);
      if (r() < 0.02) parser.deviceLost();
      for (const event of parser.parse(report)) {
        if (event.type === "pad") {
          expect(event.pad).toBeGreaterThanOrEqual(0);
          expect(event.pad).toBeLessThan(16);
        }
        if (event.type === "encoder") {
          expect(event.index).toBeGreaterThanOrEqual(0);
          expect(event.index).toBeLessThan(8);
        }
      }
    }
  });
});
