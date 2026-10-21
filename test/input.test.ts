import { describe, expect, it } from "vitest";
import { panelPad } from "../src/hw/ids.js";
import { InputParser, wrappedDelta } from "../src/hw/input.js";
import { controlsReport, padsReport } from "./reports.js";

describe("wrappedDelta", () => {
  it("handles plain steps and wrap-around in both directions", () => {
    expect(wrappedDelta(3, 5, 16)).toBe(2);
    expect(wrappedDelta(5, 3, 16)).toBe(-2);
    expect(wrappedDelta(15, 0, 16)).toBe(1);
    expect(wrappedDelta(0, 15, 16)).toBe(-1);
    expect(wrappedDelta(4090, 10, 4096)).toBe(16);
    expect(wrappedDelta(10, 4090, 4096)).toBe(-16);
  });
});

describe("InputParser: controls report", () => {
  it("reports buttons held and jacks plugged on the first report", () => {
    const parser = new InputParser();
    const events = parser.parse(
      controlsReport({
        bits: [
          [6, 0x20],
          [1, 0x02],
        ],
      }),
    );
    expect(events).toContainEqual({ type: "button", id: "play", pressed: true });
    expect(events).toContainEqual({ type: "jack", jack: "pedal", connected: true });
    expect(events).toHaveLength(2);
  });

  it("emits press and release for buttons, nav and knob touches", () => {
    const parser = new InputParser();
    parser.parse(controlsReport());
    expect(parser.parse(controlsReport({ bits: [[6, 0x40]] }))).toEqual([
      { type: "button", id: "rec", pressed: true },
    ]);
    expect(parser.parse(controlsReport())).toEqual([{ type: "button", id: "rec", pressed: false }]);
    expect(
      parser.parse(
        controlsReport({
          bits: [
            [1, 0x01],
            [1, 0x10],
            [10, 0x80],
            [9, 0x80],
          ],
        }),
      ),
    ).toEqual([
      { type: "nav", action: "push", pressed: true },
      { type: "nav", action: "tilt", direction: "down", pressed: true },
      { type: "nav", action: "touch", touched: true },
      { type: "encoderTouch", index: 0, touched: true },
    ]);
  });

  it("maps group and display buttons to their panel names", () => {
    const parser = new InputParser();
    parser.parse(controlsReport());
    const events = parser.parse(
      controlsReport({
        bits: [
          [2, 0x80],
          [1, 0x80],
          [9, 0x01],
        ],
      }),
    );
    expect(events).toEqual([
      { type: "button", id: "display8", pressed: true },
      { type: "button", id: "groupH", pressed: true },
      { type: "button", id: "display1", pressed: true },
    ]);
  });

  it("turns knob values into wrapped deltas, only after a baseline", () => {
    const parser = new InputParser();
    expect(parser.parse(controlsReport({ knobs: [100, 0, 0, 0, 0, 0, 0, 992] }))).toEqual([]);
    // 992 -> 12 is the real wrap seen on knob 1 at Checkpoint 1.
    expect(parser.parse(controlsReport({ knobs: [103, 0, 0, 0, 0, 0, 0, 12] }))).toEqual([
      { type: "encoder", index: 0, delta: 3 },
      { type: "encoder", index: 7, delta: 20 },
    ]);
  });

  it("turns the 4D encoder nibble into steps across the wrap", () => {
    const parser = new InputParser();
    parser.parse(controlsReport({ wheel: 15 }));
    expect(parser.parse(controlsReport({ wheel: 1 }))).toEqual([
      { type: "nav", action: "turn", delta: 2 },
    ]);
    expect(parser.parse(controlsReport({ wheel: 0 }))).toEqual([
      { type: "nav", action: "turn", delta: -1 },
    ]);
  });

  it("reports touch strip position and release", () => {
    const parser = new InputParser();
    parser.parse(controlsReport());
    expect(parser.parse(controlsReport({ strip: 512 }))).toEqual([
      { type: "strip", position: 0.5, touched: true },
    ]);
    expect(parser.parse(controlsReport({ strip: 0 }))).toEqual([
      { type: "strip", position: 0, touched: false },
    ]);
  });
});

describe("panelPad", () => {
  it("flips the pad rows between device order (top-left first) and Maschine order (bottom-left first)", () => {
    expect(panelPad(0)).toBe(12);
    expect(panelPad(3)).toBe(15);
    expect(panelPad(12)).toBe(0);
    expect(panelPad(15)).toBe(3);
  });

  it("is its own inverse", () => {
    for (let pad = 0; pad < 16; pad++) expect(panelPad(panelPad(pad))).toBe(pad);
  });
});

describe("InputParser: pads report", () => {
  it("reads the event type from the high nibble of each entry", () => {
    const parser = new InputParser();
    expect(parser.parse(padsReport([{ pad: 3, kind: "on", value: 2000 }]))).toEqual([
      {
        type: "pad",
        pad: panelPad(3),
        phase: "down",
        pressure: 2000 / 4095,
        velocity: parser.pads.velocityFor(2000),
      },
    ]);
    expect(parser.parse(padsReport([{ pad: 3, kind: "pressure", value: 900 }]))).toEqual([
      { type: "pad", pad: panelPad(3), phase: "move", pressure: 900 / 4095 },
    ]);
    expect(parser.parse(padsReport([{ pad: 3, kind: "off", value: 0 }]))).toEqual([
      { type: "pad", pad: panelPad(3), phase: "up", pressure: 0 },
    ]);
  });

  it("treats type nibbles 0 and 1 as on and 2 and 3 as off", () => {
    const parser = new InputParser();
    for (const [on, off] of [
      [0, 2],
      [1, 3],
    ] as const) {
      const down = parser.parse(padsReport([{ pad: 5, kind: on, value: 1000 }]));
      expect(down.map((e) => e.type === "pad" && e.phase)).toEqual(["down"]);
      const up = parser.parse(padsReport([{ pad: 5, kind: off, value: 0 }]));
      expect(up.map((e) => e.type === "pad" && e.phase)).toEqual(["up"]);
    }
  });

  it("handles several entries in one report, in order", () => {
    const parser = new InputParser();
    const events = parser.parse(
      padsReport([
        { pad: 0, kind: "on", value: 2000 },
        { pad: 7, kind: "on", value: 1500 },
        { pad: 0, kind: "pressure", value: 2100 },
        { pad: 7, kind: "off", value: 0 },
      ]),
    );
    expect(events.map((e) => e.type === "pad" && [e.pad, e.phase])).toEqual([
      [panelPad(0), "down"],
      [panelPad(7), "down"],
      [panelPad(0), "move"],
      [panelPad(7), "up"],
    ]);
  });

  it("stops at the terminator and ignores stale bytes after it", () => {
    const parser = new InputParser();
    // Stale 0x15 bytes would read as pad 0x15 (skipped) and then more entries if not ignored.
    const events = parser.parse(padsReport([{ pad: 3, kind: "on", value: 2000 }], 0x05));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "pad", pad: panelPad(3), phase: "down" });
  });

  it("ignores entries after an all-zero entry", () => {
    const parser = new InputParser();
    const report = padsReport([
      { pad: 1, kind: "on", value: 1000 },
      { pad: 0, kind: 0, value: 0 }, // terminator
      { pad: 2, kind: "on", value: 1000 },
    ]);
    const events = parser.parse(report);
    expect(events.map((e) => e.type === "pad" && e.pad)).toEqual([panelPad(1)]);
  });

  it("reads [0, 0, v] as an ON for device pad 0 (top-left) with value v", () => {
    const parser = new InputParser();
    const report = new Uint8Array(64);
    report[0] = 0x02;
    report[3] = 90;
    expect(parser.parse(report)).toEqual([
      {
        type: "pad",
        pad: panelPad(0),
        phase: "down",
        pressure: 90 / 4095,
        velocity: parser.pads.velocityFor(90),
      },
    ]);
  });

  it("skips entries with an unknown type nibble or a pad number of 16 and up", () => {
    const parser = new InputParser();
    const events = parser.parse(
      padsReport([
        { pad: 4, kind: 5, value: 1000 },
        { pad: 16, kind: "on", value: 1000 },
        { pad: 200, kind: "on", value: 1000 },
        { pad: 6, kind: "on", value: 1000 },
      ]),
    );
    expect(events.map((e) => e.type === "pad" && e.pad)).toEqual([panelPad(6)]);
  });

  it("ignores unknown report IDs", () => {
    const parser = new InputParser();
    expect(parser.parse(Uint8Array.from([0x20, 1, 2, 3]))).toEqual([]);
    expect(parser.parse(Uint8Array.from([0x40, 1, 2, 3]))).toEqual([]);
  });
});
