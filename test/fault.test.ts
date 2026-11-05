import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { FAULT_SHOW_MS, FaultReporter } from "../src/fault.js";

describe("FaultReporter", () => {
  const setup = () => {
    const lines: string[] = [];
    const time = { now: 0 };
    return {
      lines,
      time,
      faults: new FaultReporter(
        (l) => lines.push(l),
        () => time.now,
      ),
    };
  };

  it("gives the fallback when the task throws, and logs what failed", () => {
    const { faults, lines } = setup();
    expect(
      faults.guard(
        "pad",
        () => {
          throw new Error("boom");
        },
        false,
      ),
    ).toBe(false);
    expect(lines[0]).toContain("pad: boom");
    expect(faults.guard("pad", () => true, false)).toBe(true);
  });

  it("logs the same fault once while it repeats", () => {
    const { faults, lines, time } = setup();
    for (let i = 0; i < 10; i++) {
      faults.report("screen", new Error("boom"));
      time.now += 50;
    }
    expect(lines).toHaveLength(1);
    time.now += FAULT_SHOW_MS;
    faults.report("screen", new Error("boom"));
    expect(lines).toHaveLength(2);
  });

  it("asks for a draw when a fault appears, not on every repeat of it", () => {
    let draws = 0;
    const faults = new FaultReporter(
      () => undefined,
      () => 0,
      () => draws++,
    );
    faults.report("screen", new Error("boom"));
    expect(draws).toBe(1);
    faults.report("screen", new Error("boom"));
    expect(draws).toBe(1);
    faults.report("screen", new Error("other"));
    expect(draws).toBe(2);
  });

  it("is on the screen for a while", () => {
    const { faults, time } = setup();
    faults.report("screen", new Error("boom"));
    expect(faults.shown).toBe("screen: boom");
    const canvas = createCanvas(480, 272);
    const ctx = canvas.getContext("2d");
    faults.draw(ctx);
    const pixel = ctx.getImageData(470, 260, 1, 1).data;
    expect(pixel[0]).toBe(0xb3);
    time.now = FAULT_SHOW_MS + 1;
    expect(faults.shown).toBeUndefined();
  });
});
