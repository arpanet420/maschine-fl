import { describe, expect, it } from "vitest";
import {
  auParamHelper,
  auPosition,
  AuRanges,
  auTextValue,
  parseAuParams,
  type AuParam,
} from "../src/fl/auParams.js";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("Audio Unit ranges", () => {
  it("parses the helper's lines, an unreadable parameter keeping its place", () => {
    expect(parseAuParams("Output\t0\t200\n\t0\t0\nDepth #1\t-100\t100\n")).toEqual([
      { name: "Output", min: 0, max: 200 },
      { name: "", min: 0, max: 0 },
      { name: "Depth #1", min: -100, max: 100 },
    ]);
  });

  it("reads only FL's text for an Audio Unit as a value", () => {
    expect(auTextValue("90.00 ")).toBe(90);
    expect(auTextValue("-12,50 ")).toBe(-12.5);
    for (const text of ["90.00", "90.0 ", "On", "90.00 dB", ""]) {
      expect(auTextValue(text)).toBeUndefined();
    }
  });

  it("gives the position FL's own 0–1 would: linear over the range", () => {
    const output = { name: "Output", min: 0, max: 200 };
    expect(auPosition({ name: "Output", valueText: "90.00 " }, output)).toBe(0.45);
    const depth = { name: "Depth #1", min: -100, max: 100 };
    expect(auPosition({ name: "Depth #1", valueText: "0.00 " }, depth)).toBe(0.5);
    expect(auPosition({ name: "Depth #1", valueText: "150.00 " }, depth)).toBe(1);
  });

  it("gives none on a name or text that doesn't fit, or an empty range", () => {
    const output = { name: "Output", min: 0, max: 200 };
    expect(auPosition({ name: "Volume", valueText: "90.00 " }, output)).toBeUndefined();
    expect(auPosition({ name: "Output", valueText: "90 %" }, output)).toBeUndefined();
    expect(auPosition({ name: "Output", valueText: "90.00 " }, undefined)).toBeUndefined();
    const flat = { name: "Output", min: 1, max: 1 };
    expect(auPosition({ name: "Output", valueText: "1.00 " }, flat)).toBeUndefined();
  });

  it("compares no more of the name than the FL script sends", () => {
    const name = "A very long parameter name that FL would keep";
    const au = { name, min: 0, max: 1 };
    expect(auPosition({ name: name.slice(0, 32), valueText: "0.50 " }, au)).toBe(0.5);
  });

  it("reads a plug-in once, in the background, and says when it's ready", async () => {
    const reads: string[] = [];
    const params: AuParam[] = [{ name: "Output", min: 0, max: 200 }];
    const ranges = new AuRanges((plugin) => {
      reads.push(plugin);
      return Promise.resolve(params);
    });
    let ready = 0;
    expect(ranges.params("Repro-1", () => ready++)).toBeUndefined();
    expect(ranges.params("Repro-1", () => ready++)).toBeUndefined();
    await flush();
    expect(reads).toEqual(["Repro-1"]);
    expect(ready).toBe(1);
    expect(ranges.params("Repro-1", () => ready++)).toBe(params);
    await flush();
    expect(ready).toBe(1);
  });

  it("logs a failed read, doesn't retry it and goes on with the next plug-in", async () => {
    const lines: string[] = [];
    const reads: string[] = [];
    const ranges = new AuRanges(
      (plugin) => {
        reads.push(plugin);
        return plugin === "Bad"
          ? Promise.reject(new Error("it crashed"))
          : Promise.resolve([{ name: "Output", min: 0, max: 1 }]);
      },
      (line) => lines.push(line),
    );
    let ready = 0;
    ranges.params("Bad", () => ready++);
    ranges.params("Good", () => ready++);
    await flush();
    await flush();
    expect(lines).toEqual([
      'Audio Unit ranges: "Bad": it crashed',
      'Audio Unit ranges: "Good": 1 parameters',
    ]);
    expect(ready).toBe(1);
    ranges.params("Bad", () => ready++);
    await flush();
    expect(reads).toEqual(["Bad", "Good"]);
  });

  it("has nothing to read on Windows", async () => {
    await expect(auParamHelper("win32")("Repro-1")).resolves.toEqual([]);
  });
});
