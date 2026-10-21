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
const CMD_BLIT = 0x03;
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
 * on `screen`. The device counts pixels in pairs, so width × height must be even.
 */
export function buildDisplayTransfer(
  screen: ScreenIndex,
  rect: Rect,
  pixels: Uint8Array,
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

  const out = new Uint8Array(HEADER_LENGTH + COMMAND_LENGTH + pixels.length + 2 * COMMAND_LENGTH);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0x84);
  view.setUint8(2, screen);
  view.setUint8(3, 0x60);
  view.setUint16(8, x);
  view.setUint16(10, y);
  view.setUint16(12, width);
  view.setUint16(14, height);
  // Pixel-data command: 0x00 followed by a 24-bit big-endian count of pixel pairs.
  view.setUint32(HEADER_LENGTH, pixelCount / 2);
  view.setUint8(HEADER_LENGTH, 0x00);
  out.set(pixels, HEADER_LENGTH + COMMAND_LENGTH);
  const tail = HEADER_LENGTH + COMMAND_LENGTH + pixels.length;
  view.setUint8(tail, CMD_BLIT);
  view.setUint8(tail + COMMAND_LENGTH, CMD_END);
  return out;
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
    const transfer = buildDisplayTransfer(screen, rect, pixels);
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
