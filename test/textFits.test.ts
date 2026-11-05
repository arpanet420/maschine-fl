import { describe, expect, it } from "vitest";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { drawBand } from "../src/modes/draw.js";
import { READOUT_RECT, drawActionReadout } from "../src/modes/quickEdit.js";
import type { KnobProps } from "../src/render/widgets.js";

const LONG = "W".repeat(32);

/** The horizontal extent of every text drawn on `ctx` while `draw` runs. */
function textExtents(ctx: SKRSContext2D, draw: () => void): { left: number; right: number }[] {
  const extents: { left: number; right: number }[] = [];
  const real = ctx.fillText.bind(ctx);
  ctx.fillText = (text: string, x: number, y: number) => {
    const width = ctx.measureText(text).width;
    const left =
      ctx.textAlign === "center" ? x - width / 2 : ctx.textAlign === "right" ? x - width : x;
    extents.push({ left, right: left + width });
    real(text, x, y);
  };
  draw();
  return extents;
}

describe("long names stay on the screen", () => {
  it("the band of a touched knob cuts a long name and a long value to its width", () => {
    const ctx = createCanvas(480, 272).getContext("2d");
    const rect = { x: 0, y: 200, width: 240, height: 60 };
    const props = { valueText: LONG } as unknown as KnobProps;
    const extents = textExtents(ctx, () => {
      drawBand(ctx, rect, { name: LONG, props });
    });
    expect(extents).toHaveLength(2);
    for (const { left, right } of extents) {
      expect(left).toBeGreaterThanOrEqual(rect.x);
      expect(right).toBeLessThanOrEqual(rect.x + rect.width);
    }
  });

  it("the action card cuts a long title, source and detail to its width", () => {
    const ctx = createCanvas(480, 272).getContext("2d");
    const extents = textExtents(ctx, () => {
      drawActionReadout(ctx, { title: LONG, detail: LONG, small: "3 / 12", source: LONG });
    });
    expect(extents).toHaveLength(4);
    for (const { left, right } of extents) {
      expect(left).toBeGreaterThanOrEqual(READOUT_RECT.x);
      expect(right).toBeLessThanOrEqual(READOUT_RECT.x + READOUT_RECT.width);
    }
  });

  it("the small undo position does not run into the source line", () => {
    const ctx = createCanvas(480, 272).getContext("2d");
    const extents = textExtents(ctx, () => {
      drawActionReadout(ctx, { title: "UNDO", detail: "", small: "3 / 12", source: LONG });
    });
    const [source, small] = extents;
    expect(source!.right).toBeLessThanOrEqual(small!.left);
  });
});
