// Two canvases, one per MK3 screen, and the logic that sends only what changed.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  FULL_SCREEN,
  type Rect,
  type ScreenIndex,
} from "../hw/display.js";
import { changedRect, extract565, rgbaTo565 } from "./rgb565.js";

/** Where finished frames go: the device, or anything else with the same shape (tests, PNG). */
export interface FrameSink {
  send(screen: ScreenIndex, rect: Rect, pixels: Uint8Array): Promise<void>;
}

export interface ScreensOptions {
  /** Send only the changed bounding box instead of the whole screen. */
  partialUpdates?: boolean;
  /** Above this share of the screen, send the whole frame anyway. */
  fullFrameRatio?: number;
  littleEndian?: boolean;
}

export class Screen {
  readonly canvas: Canvas;
  readonly ctx: SKRSContext2D;
  private lastSent: Uint16Array | undefined;

  constructor(readonly index: ScreenIndex) {
    this.canvas = createCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    this.ctx = this.canvas.getContext("2d");
  }

  frame565(): Uint16Array {
    return rgbaTo565(this.ctx.getImageData(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT).data);
  }

  /** Forget what the device shows, so the next update sends the whole screen. */
  invalidate(): void {
    this.lastSent = undefined;
  }

  pendingUpdate(
    options: ScreensOptions,
  ): { rect: Rect; pixels: Uint8Array; frame: Uint16Array } | undefined {
    const frame = this.frame565();
    let rect = changedRect(this.lastSent, frame, DISPLAY_WIDTH, DISPLAY_HEIGHT);
    if (!rect) return undefined;
    const area = (rect.width * rect.height) / (DISPLAY_WIDTH * DISPLAY_HEIGHT);
    if (!(options.partialUpdates ?? true) || area > (options.fullFrameRatio ?? 0.6)) {
      rect = FULL_SCREEN;
    }
    return { rect, pixels: extract565(frame, DISPLAY_WIDTH, rect, options.littleEndian), frame };
  }

  markSent(frame: Uint16Array): void {
    this.lastSent = frame;
  }
}

export class Screens {
  readonly screens: [Screen, Screen] = [new Screen(0), new Screen(1)];

  constructor(
    private readonly sink: FrameSink,
    private readonly options: ScreensOptions = {},
  ) {}

  get left(): Screen {
    return this.screens[0];
  }

  get right(): Screen {
    return this.screens[1];
  }

  /** Send whatever changed on both screens. Returns the number of pixels sent. */
  async flush(): Promise<number> {
    let sent = 0;
    for (const screen of this.screens) {
      const update = screen.pendingUpdate(this.options);
      if (!update) continue;
      await this.sink.send(screen.index, update.rect, update.pixels);
      screen.markSent(update.frame);
      sent += update.rect.width * update.rect.height;
    }
    return sent;
  }

  invalidate(): void {
    for (const screen of this.screens) screen.invalidate();
  }

  /** Write both screens as PNG files (screen-0.png, screen-1.png), plus a side-by-side view. */
  async writePngs(dir: string, prefix = "screen"): Promise<string[]> {
    await mkdir(dir, { recursive: true });
    const files: string[] = [];
    for (const screen of this.screens) {
      const file = join(dir, `${prefix}-${screen.index}.png`);
      await writeFile(file, await screen.canvas.encode("png"));
      files.push(file);
    }
    const gap = 16;
    const both = createCanvas(DISPLAY_WIDTH * 2 + gap, DISPLAY_HEIGHT);
    const ctx = both.getContext("2d");
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, both.width, both.height);
    ctx.drawImage(this.left.canvas, 0, 0);
    ctx.drawImage(this.right.canvas, DISPLAY_WIDTH + gap, 0);
    const file = join(dir, `${prefix}-both.png`);
    await writeFile(file, await both.encode("png"));
    files.push(file);
    return files;
  }
}
