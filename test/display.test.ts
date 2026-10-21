import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDisplayTransfer,
  FULL_SCREEN,
  type Rect,
  type ScreenIndex,
} from "../src/hw/display.js";
import { changedRect, extract565, rgbaTo565 } from "../src/render/rgb565.js";
import { Screens } from "../src/render/screens.js";
import {
  drawFader,
  drawHeader,
  drawKnobRow,
  drawList,
  drawTransport,
} from "../src/render/widgets.js";

describe("buildDisplayTransfer", () => {
  it("lays out header, pixel command, pixels, blit and end", () => {
    const rect: Rect = { x: 2, y: 3, width: 4, height: 2 };
    const pixels = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const t = buildDisplayTransfer(1, rect, pixels);
    expect(Array.from(t.subarray(0, 16))).toEqual([
      0x84, 0, 1, 0x60, 0, 0, 0, 0, 0, 2, 0, 3, 0, 4, 0, 2,
    ]);
    expect(Array.from(t.subarray(16, 20))).toEqual([0, 0, 0, 4]); // 8 pixels = 4 pairs
    expect(Array.from(t.subarray(20, 36))).toEqual(Array.from(pixels));
    expect(Array.from(t.subarray(36))).toEqual([0x03, 0, 0, 0, 0x40, 0, 0, 0]);
  });

  it("is 261 148 bytes for a full screen", () => {
    const t = buildDisplayTransfer(0, FULL_SCREEN, new Uint8Array(480 * 272 * 2));
    expect(t.length).toBe(261_148);
    expect(Array.from(t.subarray(16, 20))).toEqual([0, 0x00, 0xff, 0x00]); // 65 280 pairs
  });

  it("rejects odd pixel counts, off-screen rects and wrong pixel lengths", () => {
    const screen: ScreenIndex = 0;
    expect(() =>
      buildDisplayTransfer(screen, { x: 0, y: 0, width: 3, height: 1 }, new Uint8Array(6)),
    ).toThrow();
    expect(() =>
      buildDisplayTransfer(screen, { x: 478, y: 0, width: 4, height: 1 }, new Uint8Array(8)),
    ).toThrow();
    expect(() =>
      buildDisplayTransfer(screen, { x: 0, y: 0, width: 2, height: 1 }, new Uint8Array(2)),
    ).toThrow();
  });
});

describe("RGB565", () => {
  it("packs pure colors and writes them big-endian by default", () => {
    const rgba = Uint8Array.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const frame = rgbaTo565(rgba);
    expect(Array.from(frame)).toEqual([0xf800, 0x07e0, 0x001f, 0xffff]);
    const rect = { x: 0, y: 0, width: 4, height: 1 };
    expect(Array.from(extract565(frame, 4, rect))).toEqual([
      0xf8, 0, 0x07, 0xe0, 0, 0x1f, 0xff, 0xff,
    ]);
    expect(Array.from(extract565(frame, 4, rect, true)).slice(0, 2)).toEqual([0, 0xf8]);
  });

  it("cuts a sub-rectangle row by row", () => {
    const frame = Uint16Array.from({ length: 16 }, (_, i) => i); // 4×4
    const bytes = extract565(frame, 4, { x: 1, y: 2, width: 2, height: 2 });
    expect(Array.from(bytes)).toEqual([0, 9, 0, 10, 0, 13, 0, 14]);
  });
});

describe("changedRect", () => {
  it("covers everything without a previous frame and nothing when equal", () => {
    const frame = new Uint16Array(8 * 4);
    expect(changedRect(undefined, frame, 8, 4)).toEqual({ x: 0, y: 0, width: 8, height: 4 });
    expect(changedRect(frame, Uint16Array.from(frame), 8, 4)).toBeUndefined();
  });

  it("bounds changed pixels and widens to an even x and width", () => {
    const before = new Uint16Array(8 * 4);
    const after = Uint16Array.from(before);
    after[1 * 8 + 3] = 1;
    after[2 * 8 + 4] = 1;
    expect(changedRect(before, after, 8, 4)).toEqual({ x: 2, y: 1, width: 4, height: 2 });
    const edge = Uint16Array.from(before);
    edge[7] = 1;
    expect(changedRect(before, edge, 8, 4)).toEqual({ x: 6, y: 0, width: 2, height: 1 });
  });
});

describe("Screens", () => {
  function fakeSink() {
    const sent: Array<{ screen: ScreenIndex; rect: Rect; bytes: number }> = [];
    return {
      sent,
      sink: {
        send: async (screen: ScreenIndex, rect: Rect, pixels: Uint8Array) => {
          sent.push({ screen, rect, bytes: pixels.length });
        },
      },
    };
  }

  it("sends both screens fully first, then only the changed area, then nothing", async () => {
    const { sent, sink } = fakeSink();
    const screens = new Screens(sink);
    await screens.flush();
    expect(sent.map((s) => s.rect)).toEqual([FULL_SCREEN, FULL_SCREEN]);
    screens.right.ctx.fillStyle = "#fff";
    screens.right.ctx.fillRect(10, 20, 30, 5);
    await screens.flush();
    expect(sent[2]).toEqual({
      screen: 1,
      rect: { x: 10, y: 20, width: 30, height: 5 },
      bytes: 300,
    });
    await screens.flush();
    expect(sent).toHaveLength(3);
    screens.invalidate();
    await screens.flush();
    expect(sent.slice(3).map((s) => s.rect)).toEqual([FULL_SCREEN, FULL_SCREEN]);
  });

  it("sends a full frame when most of the screen changed, or when partial updates are off", async () => {
    const { sent, sink } = fakeSink();
    const screens = new Screens(sink, { partialUpdates: false });
    await screens.flush();
    screens.left.ctx.fillStyle = "#fff";
    screens.left.ctx.fillRect(0, 0, 4, 4);
    await screens.flush();
    expect(sent[2]?.rect).toEqual(FULL_SCREEN);
  });

  it("renders every widget and writes PNGs", async () => {
    const { sink } = fakeSink();
    const screens = new Screens(sink);
    const ctx = screens.left.ctx;
    drawHeader(
      ctx,
      { x: 0, y: 0, width: 480, height: 48 },
      {
        title: "Mixer",
        page: "1/4",
        tabs: ["Volume", "Pan", "Sends", "FX"],
        activeTab: 0,
      },
    );
    drawKnobRow(ctx, { x: 0, y: 182, width: 480, height: 90 }, [
      { label: "Cutoff", valueText: "1.2 kHz", value: 0.4 },
      { label: "Pan", valueText: "C", value: 0.5, bipolar: true, touched: true },
      undefined,
      { label: "Mode", valueText: "Poly" },
    ]);
    drawList(
      screens.right.ctx,
      { x: 0, y: 0, width: 480, height: 200 },
      {
        items: [
          { text: "Kick", color: "#e04040" },
          { text: "Snare", detail: "Ch 2" },
        ],
        selected: 1,
      },
    );
    drawFader(
      screens.right.ctx,
      { x: 0, y: 0, width: 60, height: 200 },
      {
        label: "Master",
        value: 0.8,
        peak: 0.97,
        valueText: "0.0 dB",
      },
    );
    drawTransport(
      screens.right.ctx,
      { x: 0, y: 240, width: 480, height: 32 },
      {
        playing: true,
        recording: false,
        bpm: 128,
        position: "3:2:1",
        pattern: "Pattern 1",
      },
    );
    const dir = await mkdtemp(join(tmpdir(), "mk3d-"));
    const files = await screens.writePngs(dir);
    expect(files).toHaveLength(3);
    for (const file of files) expect((await stat(file)).size).toBeGreaterThan(1000);
  });
});
