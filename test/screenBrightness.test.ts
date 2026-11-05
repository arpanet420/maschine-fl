import { describe, expect, it } from "vitest";
import { withScreenBrightness } from "../src/hw/device.js";

const REPORT = [0xf8, 0xe0, 0x01, 0x10, 0x01, 0x60, 0x01, 0x14, 0x32, 0x00];

describe("withScreenBrightness", () => {
  it("changes only the backlight byte", () => {
    expect(withScreenBrightness(0xf8, REPORT, 77)).toEqual({
      report: [0xf8, 0xe0, 0x01, 0x10, 0x01, 0x60, 0x01, 0x14, 77, 0x00],
    });
  });

  it("stays in 0–100", () => {
    const value = (level: number) => {
      const result = withScreenBrightness(0xf8, REPORT, level);
      return "report" in result ? result.report[8] : undefined;
    };
    expect(value(250)).toBe(100);
    expect(value(-3)).toBe(0);
  });

  it("refuses a report that does not look like the screen settings", () => {
    expect(withScreenBrightness(0xf8, [0xf8, 1, 2, 3, 4, 5, 6, 7, 8], 50)).toHaveProperty("refused");
    expect(withScreenBrightness(0xf8, [0xf8, 0xe0, 0x01], 50)).toHaveProperty("refused");
  });

  it("refuses an answer with another report's id: the first byte says where a write goes", () => {
    expect(withScreenBrightness(0xf9, REPORT, 50)).toHaveProperty("refused");
    expect(withScreenBrightness(0xf8, [0x80, ...REPORT.slice(1)], 50)).toHaveProperty("refused");
  });
});
