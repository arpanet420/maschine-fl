import { describe, expect, it } from "vitest";
import { PadProcessor, padEntryKind, type PadConfig } from "../src/hw/pads.js";

const config: PadConfig = { fullScale: 4000, exponent: 0.5, minVelocity: 0.1 };

describe("padEntryKind", () => {
  it("maps the device's type nibbles", () => {
    expect([0, 1, 2, 3, 4].map(padEntryKind)).toEqual(["on", "on", "off", "off", "pressure"]);
    expect(padEntryKind(5)).toBeUndefined();
    expect(padEntryKind(15)).toBeUndefined();
  });
});

describe("PadProcessor", () => {
  it("turns an ON into a down with velocity from the hit value", () => {
    const pads = new PadProcessor(config);
    const [down, ...rest] = pads.process(2, "on", 1000);
    expect(rest).toEqual([]);
    expect(down).toEqual({
      type: "pad",
      pad: 2,
      phase: "down",
      pressure: 1000 / 4095,
      velocity: pads.velocityFor(1000),
    });
    expect(down?.velocity).toBeCloseTo(Math.sqrt(0.25));
  });

  it("curves velocity: minimum at 0, full at fullScale, monotonic in between", () => {
    const pads = new PadProcessor(config);
    expect(pads.velocityFor(0)).toBe(0.1);
    expect(pads.velocityFor(4000)).toBe(1);
    expect(pads.velocityFor(4095)).toBe(1);
    let last = 0;
    for (let value = 0; value <= 4095; value += 15) {
      const velocity = pads.velocityFor(value);
      expect(velocity).toBeGreaterThanOrEqual(last);
      last = velocity;
    }
  });

  it("releases only a held pad on OFF", () => {
    const pads = new PadProcessor(config);
    expect(pads.process(1, "off", 0)).toEqual([]);
    pads.process(1, "on", 800);
    expect(pads.process(1, "off", 0)).toEqual([{ type: "pad", pad: 1, phase: "up", pressure: 0 }]);
    expect(pads.process(1, "off", 0)).toEqual([]);
  });

  it("sends aftertouch only while held and only when the value changed", () => {
    const pads = new PadProcessor(config);
    expect(pads.process(1, "pressure", 500)).toEqual([]);
    pads.process(1, "on", 800);
    expect(pads.process(1, "pressure", 800)).toEqual([]); // same as the hit value
    expect(pads.process(1, "pressure", 1500)).toEqual([
      { type: "pad", pad: 1, phase: "move", pressure: 1500 / 4095 },
    ]);
    expect(pads.process(1, "pressure", 1500)).toEqual([]);
    pads.process(1, "off", 0);
    expect(pads.process(1, "pressure", 300)).toEqual([]);
  });

  it("closes the old note when an ON arrives while the pad is held", () => {
    const pads = new PadProcessor(config);
    pads.process(4, "on", 800);
    const events = pads.process(4, "on", 2000);
    expect(events.map((e) => e.phase)).toEqual(["up", "down"]);
    expect(events[1]?.velocity).toBe(pads.velocityFor(2000));
  });

  it("tracks pads independently", () => {
    const pads = new PadProcessor(config);
    pads.process(0, "on", 800);
    expect(pads.process(1, "off", 0)).toEqual([]);
    expect(pads.process(0, "off", 0)).toHaveLength(1);
  });

  it("ignores pads outside 0–15", () => {
    const pads = new PadProcessor(config);
    expect(pads.process(-1, "on", 1000)).toEqual([]);
    expect(pads.process(16, "on", 1000)).toEqual([]);
    expect(pads.process(16, "off", 0)).toEqual([]);
  });
});
