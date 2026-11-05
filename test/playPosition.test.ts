import { describe, expect, it } from "vitest";
import { demoFlState } from "../src/tools/demoState.js";
import { PlayPosition } from "../src/playPosition.js";

describe("PlayPosition", () => {
  const playing = () => {
    const now = { ms: 1000 };
    const fl = demoFlState({ clock: () => now.ms });
    fl.apply({
      type: "transport",
      state: { ...fl.transport, playing: true },
      tempo: fl.tempo,
      swing: fl.swing,
    });
    return { fl, position: new PlayPosition(() => now.ms) };
  };

  it("counts ticks by the project's PPQ", () => {
    const { fl, position } = playing();
    fl.apply({ type: "songPos", bar: 1, step: 2, tick: 120, ppq: 960 }); // half a step at 240 a step
    expect(fl.ppq).toBe(960);
    expect(position.at(fl)?.position).toBeCloseTo(1.5);
  });

  it("uses 96 until FL says otherwise", () => {
    const { fl, position } = playing();
    fl.apply({ type: "songPos", bar: 1, step: 2, tick: 12 });
    expect(fl.ppq).toBe(96);
    expect(position.at(fl)?.position).toBeCloseTo(1.5);
  });
});
