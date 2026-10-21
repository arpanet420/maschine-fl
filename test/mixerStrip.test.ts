import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import {
  drawMixerStrip,
  luminance,
  mix,
  tintColor,
  type StripProps,
} from "../src/render/mixerStrip.js";
import { theme } from "../src/render/widgets.js";

const CARD = { x: 4, y: 24, width: 112, height: 232 };
const base: StripProps = {
  name: "Insert 1",
  color: "#e0707a",
  selected: false,
  muted: false,
  solo: false,
  armed: false,
  volume: 0.7,
  meter: [0, 0],
  hold: [0, 0],
  knobLabel: "VOL",
  valueText: "70%",
};

const hex = (data: Uint8ClampedArray) =>
  `#${[...data.slice(0, 3)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
/** [name band, body, knob row] pixels of a drawn strip. */
function sample(props: Partial<StripProps>) {
  const ctx = createCanvas(480, 272).getContext("2d");
  drawMixerStrip(ctx, CARD, { ...base, ...props });
  const at = (x: number, y: number) => hex(ctx.getImageData(x, y, 1, 1).data);
  return {
    band: at(CARD.x + 3, CARD.y + 60),
    body: at(CARD.x + 100, CARD.y + 10),
    knobRow: at(CARD.x + 4, CARD.y + CARD.height - 30),
    bar: at(CARD.x + 60, CARD.y + 1),
  };
}

describe("mix / tintColor", () => {
  it("blends linearly and clamps", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#102030", "#ffffff", 2)).toBe("#ffffff");
    expect(tintColor("#e0707a", 0)).toBe(theme.panel);
    expect(tintColor("#e0707a", 1)).toBe("#e0707a");
  });

  it("measures luminance", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1);
  });
});

describe("drawMixerStrip: track color", () => {
  it("tints the body ~32 % and the name band ~60 %, keeps the bar full and the knob row plain", () => {
    const s = sample({});
    expect(s.body).toBe(tintColor(base.color, 0.32));
    expect(s.band).toBe(tintColor(base.color, 0.6));
    expect(s.bar).toBe(base.color);
    expect(s.knobRow).toBe(theme.panel);
  });

  it("keeps the slate look for FL's default color", () => {
    const s = sample({ uncolored: true });
    expect(s.body).toBe(theme.panel);
    expect(s.band).toBe(theme.panel);
  });

  it("tints the selected strip stronger", () => {
    const s = sample({ selected: true });
    expect(s.body).toBe(tintColor(base.color, 0.45));
  });

  it("dims the tint of a muted track", () => {
    const s = sample({ muted: true });
    expect(s.body).toBe(tintColor(base.color, 0.16));
    expect(s.band).toBe(tintColor(base.color, 0.3));
  });
});
