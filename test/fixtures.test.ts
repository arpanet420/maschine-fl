import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PadEvent } from "../src/hw/events.js";
import { panelPad } from "../src/hw/ids.js";
import { InputParser } from "../src/hw/input.js";

function replay(file: string) {
  const parser = new InputParser();
  const lines = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")
    .trim()
    .split("\n");
  return lines.flatMap((line) => {
    const { hex } = JSON.parse(line) as { hex: string };
    return parser.parse(Uint8Array.from(Buffer.from(hex, "hex")));
  });
}

describe("checkpoint1.jsonl: pads hit once each, 1 to 16, soft to hard per row", () => {
  const pads = replay("checkpoint1.jsonl").filter((e): e is PadEvent => e.type === "pad");
  const downs = pads.filter((e) => e.phase === "down");

  it("gives one down and one up per pad, in order", () => {
    // Hit in device order 0 to 15 (top-left first); mk3d numbers pads from the bottom-left.
    const hitOrder = [...Array(16).keys()].map(panelPad);
    expect(downs.map((e) => e.pad)).toEqual(hitOrder);
    expect(pads.filter((e) => e.phase === "up").map((e) => e.pad)).toEqual(hitOrder);
  });

  it("orders velocity soft to hard within the first two rows", () => {
    // Indexed by hit order (device order), not by pad number.
    const velocity = (hit: number) => downs[hit]?.velocity ?? 0;
    // These were deliberate slams; from a medium hit up they all reach full velocity.
    expect(velocity(0)).toBeLessThan(velocity(1));
    expect(velocity(1)).toBeLessThanOrEqual(velocity(2));
    expect(velocity(4)).toBeLessThan(velocity(5));
    expect(velocity(5)).toBeLessThanOrEqual(velocity(6));
    expect(velocity(3)).toBe(1);
    expect(velocity(0)).toBeLessThan(0.2);
  });
});
