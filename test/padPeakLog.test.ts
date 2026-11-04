import { describe, expect, it } from "vitest";
import { PadPeakLog } from "../src/hw/padPeakLog.js";

describe("--log-pads peak", () => {
  it("logs the hit and the peak of the next 3 reports", () => {
    const lines: string[] = [];
    const log = new PadPeakLog((line) => lines.push(line));
    log.onPad(2, "down", 0.25);
    log.onPad(2, "move", 0.5);
    log.onPad(2, "move", 0.4);
    expect(lines).toEqual([]);
    log.onPad(2, "move", 0.3);
    expect(lines).toEqual(["pad 3 hit value 1024, peak of the next reports 2048 (+100 %)"]);
    log.onPad(2, "move", 0.9);
    log.onPad(2, "up", 0);
    expect(lines).toHaveLength(1);
  });

  it("a release ends the run early, and a release alone logs nothing", () => {
    const lines: string[] = [];
    const log = new PadPeakLog((line) => lines.push(line));
    log.onPad(0, "up", 0);
    expect(lines).toEqual([]);
    log.onPad(0, "down", 0.5);
    log.onPad(0, "up", 0);
    expect(lines).toEqual(["pad 1 hit value 2048, peak of the next reports 2048 (+0 %)"]);
  });
});
