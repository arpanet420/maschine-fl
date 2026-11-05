import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { colorKnob, NAMED_COLORS, nextNamedColor } from "../src/modes/namedColors.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";

const color = (index: number): number => NAMED_COLORS.at(index)?.color ?? -1;

const drawnText = (h: StackHarness) => {
  const left = createCanvas(480, 272).getContext("2d");
  const right = createCanvas(480, 272).getContext("2d");
  const texts: string[] = [];
  for (const ctx of [left, right]) {
    const original = ctx.fillText.bind(ctx);
    ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      texts.push(text);
      original(text, x, y, maxWidth);
    };
  }
  h.stack.render(left, right, h.mc);
  return texts;
};

describe("named colours", () => {
  it("steps and wraps both ways", () => {
    expect(nextNamedColor(color(2), 1)).toBe(color(3));
    expect(nextNamedColor(color(0), -1)).toBe(color(-1));
    expect(nextNamedColor(color(-1), 1)).toBe(color(0));
  });

  it("starts a colour that isn't on the list at the end it turns towards", () => {
    expect(nextNamedColor(0x123456, 1)).toBe(color(0));
    expect(nextNamedColor(0x123456, -1)).toBe(color(-1));
  });

  it("ignores FL's top byte", () => {
    expect(nextNamedColor((0xff000000 | color(2)) >> 0, 1)).toBe(color(3));
    expect(colorKnob((0xff000000 | color(2)) >> 0, false).valueText).toBe(NAMED_COLORS[2]?.name);
  });

  it("names a colour that isn't on the list Custom", () => {
    expect(colorKnob(0x123456, false)).toMatchObject({ label: "COLOR", valueText: "Custom" });
  });
});

describe("SELECT's COLOR knob", () => {
  it("colours the selected channel, building on its own turns", () => {
    const h = stackHarness({ selected: 2 });
    h.fl.apply({ ...h.fl.selectedChannel, type: "selectedChannel", color: color(2) });
    h.press("select");
    expect(drawnText(h)).toContain(NAMED_COLORS[2]?.name);
    h.knob(0, 60);
    expect(h.sentOf("setChannelColor")).toEqual([]);
    h.knob(0, 60);
    expect(h.sentOf("setChannelColor")).toEqual([
      { type: "setChannelColor", index: 2, color: color(3) },
    ]);
    expect(drawnText(h)).toContain(NAMED_COLORS[3]?.name);
    h.knob(0, 240);
    expect(h.sentOf("setChannelColor").at(-1)?.color).toBe(color(5));
  });

  it("goes back to FL's colour when FL doesn't take it", () => {
    const h = stackHarness({ selected: 2 });
    h.fl.apply({ ...h.fl.selectedChannel, type: "selectedChannel", color: color(2) });
    h.press("select");
    h.knob(0, 120);
    h.advance(1000);
    expect(drawnText(h)).toContain(NAMED_COLORS[2]?.name);
  });

  it("leaves the other knobs alone", () => {
    const h = stackHarness({ selected: 2 });
    h.press("select");
    h.knob(1, 240);
    expect(h.sentOf("setChannelColor")).toEqual([]);
    expect(h.sentOf("setChannel")).toEqual([]);
  });

  it("does nothing with no channel selected", () => {
    const h = stackHarness({ selected: 2 });
    h.fl.apply({ ...h.fl.selectedChannel, type: "selectedChannel", index: null });
    h.press("select");
    h.knob(0, 120);
    expect(h.sentOf("setChannelColor")).toEqual([]);
  });
});

describe("MIXER: holding GROUP A–H", () => {
  const mixer = () => {
    const h = stackHarness({ selected: 2 });
    h.tap("mixer");
    h.sent.length = 0;
    return h;
  };

  it("makes that strip's knob the track's colour until the button comes up", () => {
    const h = mixer();
    h.press("groupC");
    expect(drawnText(h)).toContain("COLOR");
    h.knob(2, 120);
    const [first] = h.sentOf("setTrackColor");
    expect(first).toMatchObject({ type: "setTrackColor", index: 2 });
    expect(h.sentOf("setTrack")).toEqual([]);
    h.release("groupC");
    expect(drawnText(h)).not.toContain("COLOR");
    h.knob(2, 120);
    expect(h.sentOf("setTrackColor")).toHaveLength(1);
    expect(h.sentOf("setTrack")).toHaveLength(1);
  });

  it("still selects the track", () => {
    const h = mixer();
    h.press("groupC");
    expect(h.sentOf("selectTrack")).toEqual([{ type: "selectTrack", index: 2 }]);
  });

  it("does nothing on the other knobs while held", () => {
    const h = mixer();
    h.press("groupC");
    h.knob(0, 120);
    expect(h.sentOf("setTrackColor")).toEqual([]);
    expect(h.sentOf("setTrack")).toEqual([]);
  });

  it("stays mute and solo with those held", () => {
    const h = mixer();
    h.press("mute");
    h.press("groupC");
    expect(drawnText(h)).not.toContain("COLOR");
    h.knob(2, 120);
    expect(h.sentOf("setTrackColor")).toEqual([]);
    expect(h.sentOf("setTrack").some((c) => c.what === "mute")).toBe(true);
  });

  it("forgets the hold when a page on top took the release", () => {
    const h = mixer();
    h.press("groupC");
    h.press("select");
    h.release("groupC");
    h.release("select");
    h.knob(2, 120);
    expect(h.sentOf("setTrackColor")).toEqual([]);
  });

  it("doesn't reset the volume on a double touch while held", () => {
    const h = mixer();
    h.press("groupC");
    h.touchKnob(2);
    h.touchKnob(2);
    expect(h.sentOf("setTrack")).toEqual([]);
  });
});
