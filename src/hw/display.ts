// Sends pixels to the MK3's two 480×272 screens over the vendor-specific bulk interface.
// Transfer format: docs/protocol.md, "Displays".
import { usb } from "usb";
import { MK3_PRODUCT_ID, NI_VENDOR_ID } from "./usbIds.js";

export const DISPLAY_WIDTH = 480;
export const DISPLAY_HEIGHT = 272;
const DISPLAY_INTERFACE = 5;
const DISPLAY_ENDPOINT = 4;
const HEADER_LENGTH = 16;
const COMMAND_LENGTH = 4;
const CMD_PIXELS = 0x00;
const CMD_REPEAT = 0x01;
const CMD_BLIT = 0x03;
/** A pair repeated this many times or more goes as CMD_REPEAT: it saves more than the command costs. */
const MIN_RUN = 4;
const CMD_END = 0x40;

export type ScreenIndex = 0 | 1;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_SCREEN: Rect = { x: 0, y: 0, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };

/**
 * One bulk transfer that draws `pixels` (RGB565, 2 bytes per pixel, row by row) into `rect`
 * on `screen`. The device counts pixels in pairs, so width × height must be even. Pairs repeated
 * in a row go as one repeat command (our screens are mostly flat); `raw` sends every pixel.
 */
export function buildDisplayTransfer(
  screen: ScreenIndex,
  rect: Rect,
  pixels: Uint8Array,
  options: { raw?: boolean } = {},
): Uint8Array<ArrayBuffer> {
  const { x, y, width, height } = rect;
  const pixelCount = width * height;
  if (pixelCount % 2 !== 0) throw new RangeError("width × height must be even");
  if (x < 0 || y < 0 || x + width > DISPLAY_WIDTH || y + height > DISPLAY_HEIGHT) {
    throw new RangeError(`rect ${x},${y} ${width}×${height} is off screen`);
  }
  if (pixels.length !== pixelCount * 2) {
    throw new RangeError(`expected ${pixelCount * 2} pixel bytes, got ${pixels.length}`);
  }

  // Runs only make it shorter, so one pixel command is the most this can take.
  const out = new Uint8Array(HEADER_LENGTH + COMMAND_LENGTH + pixels.length + 2 * COMMAND_LENGTH);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0x84);
  view.setUint8(2, screen);
  view.setUint8(3, 0x60);
  view.setUint16(8, x);
  view.setUint16(10, y);
  view.setUint16(12, width);
  view.setUint16(14, height);
  const tail = options.raw
    ? writePixels(view, out, HEADER_LENGTH, pixels, 0, pixelCount / 2)
    : writeRuns(view, out, pixels, pixelCount / 2);
  view.setUint8(tail, CMD_BLIT);
  view.setUint8(tail + COMMAND_LENGTH, CMD_END);
  return out.slice(0, tail + 2 * COMMAND_LENGTH);
}

/** A command: its byte, then a 24-bit big-endian count of pixel pairs. */
function writeCommand(view: DataView, at: number, command: number, pairs: number): void {
  view.setUint32(at, pairs);
  view.setUint8(at, command);
}

function writePixels(
  view: DataView,
  out: Uint8Array,
  at: number,
  pixels: Uint8Array,
  firstPair: number,
  pairs: number,
): number {
  writeCommand(view, at, CMD_PIXELS, pairs);
  out.set(pixels.subarray(firstPair * 4, (firstPair + pairs) * 4), at + COMMAND_LENGTH);
  return at + COMMAND_LENGTH + pairs * 4;
}

function writeRuns(view: DataView, out: Uint8Array, pixels: Uint8Array, pairs: number): number {
  const source = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  let at = HEADER_LENGTH;
  let literalFrom = 0;
  let pair = 0;
  while (pair < pairs) {
    const value = source.getUint32(pair * 4);
    let end = pair + 1;
    while (end < pairs && source.getUint32(end * 4) === value) end++;
    if (end - pair < MIN_RUN) {
      pair = end;
      continue;
    }
    if (pair > literalFrom)
      at = writePixels(view, out, at, pixels, literalFrom, pair - literalFrom);
    writeCommand(view, at, CMD_REPEAT, end - pair);
    view.setUint32(at + COMMAND_LENGTH, value);
    at += 2 * COMMAND_LENGTH;
    pair = end;
    literalFrom = end;
  }
  if (pairs > literalFrom)
    at = writePixels(view, out, at, pixels, literalFrom, pairs - literalFrom);
  return at;
}

type UsbDevice = Awaited<ReturnType<typeof usb.getDevices>>[number];

/**
 * Owns interface 5. Opens lazily and reopens after a failed transfer (e.g. a replug).
 * Operations run one at a time: a transfer cut off midway leaves the MK3's screen controller
 * waiting for the rest of the frame, and only a power cycle recovers it (docs/protocol.md).
 */
export class Mk3Display {
  private device: UsbDevice | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  get isOpen(): boolean {
    return this.device !== undefined;
  }

  open(): Promise<void> {
    return this.serialize(() => this.openNow());
  }

  send(screen: ScreenIndex, rect: Rect, pixels: Uint8Array): Promise<void> {
    const transfer = buildDisplayTransfer(screen, rect, pixels, {
      raw: process.env.MK3D_DISPLAY_RAW === "1",
    });
    return this.serialize(async () => {
      await this.openNow();
      try {
        await this.device!.transferOut(DISPLAY_ENDPOINT, transfer);
      } catch (err) {
        await this.closeNow();
        throw err;
      }
    });
  }

  /** Waits for any transfer in flight, then releases the interface. */
  close(): Promise<void> {
    return this.serialize(() => this.closeNow());
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async openNow(): Promise<void> {
    if (this.device) return;
    const device = (await usb.getDevices()).find(
      (d) => d.vendorId === NI_VENDOR_ID && d.productId === MK3_PRODUCT_ID,
    );
    if (!device) throw new Error("Maschine MK3 not found");
    await device.open();
    try {
      await device.claimInterface(DISPLAY_INTERFACE);
    } catch (err) {
      await device.close().catch(() => undefined);
      throw err;
    }
    this.device = device;
  }

  private async closeNow(): Promise<void> {
    const device = this.device;
    this.device = undefined;
    if (!device) return;
    // The native binding can throw synchronously as well as reject.
    try {
      await device.releaseInterface(DISPLAY_INTERFACE);
    } catch {
      // Already released or unplugged.
    }
    try {
      await device.close();
    } catch {
      // Already closed or unplugged.
    }
  }
}
