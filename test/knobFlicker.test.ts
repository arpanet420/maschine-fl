import { describe, expect, it } from "vitest";
import { KnobFlickerFilter } from "../src/hw/input.js";

const run = (deltas: number[]) => {
  const filter = new KnobFlickerFilter();
  return deltas.map((delta) => filter.filter(delta));
};

describe("KnobFlickerFilter", () => {
  it("passes a turn at once", () => {
    expect(run([3, 2, 1])).toEqual([3, 2, 1]);
    expect(run([-1, -4])).toEqual([-1, -4]);
  });

  it("turns nothing while a knob flips between two counts", () => {
    expect(run([5, -1, 1, -1, 1, -1, 1])).toEqual([5, 0, 0, 0, 0, 0, 0]);
  });

  it("a real turn back moves once there are two counts", () => {
    expect(run([5, -1, -1, -1])).toEqual([5, 0, -2, -1]);
    expect(run([5, -3])).toEqual([5, -3]);
  });

  it("back and forth on the same spot only moves what goes past it", () => {
    expect(run([5, -1, 3])).toEqual([5, 0, 2]);
  });

  it("a big turn back and on keeps going", () => {
    expect(run([1, -2, 1, 1])).toEqual([1, -2, 0, 2]);
  });
});
