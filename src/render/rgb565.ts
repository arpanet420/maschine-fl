import type { Rect } from "../hw/display.js";

/** RGBA (canvas ImageData order) to one RGB565 value per pixel. */
export function rgbaTo565(rgba: Uint8Array | Uint8ClampedArray): Uint16Array {
  const out = new Uint16Array(rgba.length / 4);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] =
      (((rgba[p] ?? 0) & 0xf8) << 8) |
      (((rgba[p + 1] ?? 0) & 0xfc) << 3) |
      ((rgba[p + 2] ?? 0) >> 3);
  }
  return out;
}

/**
 * Bytes for `rect` cut out of a full frame (`frameWidth` pixels wide), 2 bytes per pixel.
 * The MK3 takes big-endian (docs/protocol.md); `littleEndian` exists to diagnose a wrong guess.
 */
export function extract565(
  frame: Uint16Array,
  frameWidth: number,
  rect: Rect,
  littleEndian = false,
): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height * 2);
  const view = new DataView(out.buffer);
  let o = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const row = y * frameWidth;
    for (let x = rect.x; x < rect.x + rect.width; x++, o += 2) {
      view.setUint16(o, frame[row + x] ?? 0, littleEndian);
    }
  }
  return out;
}

/**
 * Bounding box of the pixels that differ between two frames, widened to an even x and width
 * (the device counts pixel pairs). Undefined when nothing changed.
 */
export function changedRect(
  previous: Uint16Array | undefined,
  next: Uint16Array,
  width: number,
  height: number,
): Rect | undefined {
  if (!previous) return { x: 0, y: 0, width, height };
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (previous[row + x] !== next[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined;
  const x = minX & ~1;
  const right = Math.min(width, (maxX + 2) & ~1);
  return { x, y: minY, width: right - x, height: maxY - minY + 1 };
}
