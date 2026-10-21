// The MK3's indexed LED palette (docs/protocol.md, "LED palette").
// Index 0 = off, 4 + 4·color + variant for 16 colors × 4 variants, 68–71 = white levels.

export const LED_OFF = 0;

export const COLOR_NAMES = [
  "red",
  "orange",
  "light orange",
  "warm yellow",
  "yellow",
  "lime",
  "green",
  "mint",
  "cyan",
  "turquoise",
  "blue",
  "plum",
  "violet",
  "purple",
  "magenta",
  "fuchsia",
] as const;

// Hue (degrees) of each color's bright variant, from the reference palette table (cabl, MIT).
// Approximate; recalibrate against the real pads with `ledtest palette` if colors look off.
const COLOR_HUES = [
  0, 7.5, 22.6, 52.7, 97.4, 103.1, 120, 131.3, 173.2, 217.4, 240, 249.4, 264.5, 329.9, 344.9, 356.2,
];

/**
 * dim = the reference's "dim flash" step; the true dim step (`faint`) is too faint to read in
 * daylight, so only use it as a second shade next to `dim` (the STEP page's alternating groups).
 */
export type LedVariant = "faint" | "dim" | "bright" | "pressed";
const VARIANT_OFFSET: Record<LedVariant, number> = { faint: 0, dim: 1, bright: 2, pressed: 3 };
const WHITE_INDEX: Record<LedVariant, number> = { faint: 68, dim: 69, bright: 70, pressed: 71 };

export function paletteColor(color: number, variant: LedVariant = "bright"): number {
  const c = ((Math.round(color) % 16) + 16) % 16;
  return 4 + 4 * c + VARIANT_OFFSET[variant];
}

export function paletteWhite(variant: LedVariant = "bright"): number {
  return WHITE_INDEX[variant];
}

function hsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

/**
 * Nearest palette entry for an RGB color (0–255 each), chosen by hue so that muted FL colors
 * still map to a clear pad color. Brightness comes from `variant`, not from the input.
 */
export function rgbToPalette(
  r: number,
  g: number,
  b: number,
  variant: LedVariant = "bright",
): number {
  const { h, s, v } = hsv(r, g, b);
  if (v < 0.04) return LED_OFF;
  if (s < 0.2) return paletteWhite(variant);
  return paletteColor(nearestHue(h), variant);
}

/** The palette color nearest to a hue (degrees). */
function nearestHue(hue: number): number {
  let best = 0;
  let bestDistance = Infinity;
  COLOR_HUES.forEach((h, i) => {
    const raw = Math.abs((((hue - h) % 360) + 360) % 360);
    const distance = Math.min(raw, 360 - raw);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  });
  return best;
}

/**
 * A color that stands out next to palette entry `index`: the opposite hue, or FL's orange for
 * white and off. For marks on top of colored pads, such as the STEP page's play head.
 */
export function contrastPalette(index: number, variant: LedVariant = "bright"): number {
  if (index < 4 || index >= 68) return paletteColor(nearestHue(25), variant);
  const hue = COLOR_HUES[Math.floor((index - 4) / 4)] ?? 0;
  return paletteColor(nearestHue(hue + 180), variant);
}

/** Readable name of a palette index, for logs and tests. */
export function paletteName(index: number): string {
  if (index < 4) return "off";
  if (index >= 68) return `white ${index - 67}`;
  const color = COLOR_NAMES[Math.floor((index - 4) / 4)] ?? "?";
  const variant = ["faint", "dim", "bright", "pressed"][(index - 4) % 4];
  return `${color} ${variant}`;
}
