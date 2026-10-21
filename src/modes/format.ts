// Text and color helpers shared by modes and the log.
import { paletteColor, rgbToPalette, type LedVariant } from "../hw/palette.js";
import { theme } from "../render/widgets.js";

export const pct = (value: number) => `${Math.round(value * 100)}%`;

/** −1…1 as "C", "L40" or "R40". */
export const panText = (pan: number) =>
  Math.abs(pan) < 0.01 ? "C" : `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`;

const ORANGE = 1; // palette color for channels without a usable color

const rgb = (color: number) => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff] as const;

/** CSS color for an FL color (`0x--RRGGBB`); the theme accent if it is too dark to see. */
export function flColorToCss(color: number): string {
  const [r, g, b] = rgb(color);
  if (Math.max(r, g, b) < 40) return theme.accent;
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** FL's default track color: unset, black, or the grey FL reports (`39454c`, `5c656a`), nothing saturated. */
export function isDefaultColor(color: number): boolean {
  const [r, g, b] = rgb(color);
  return Math.max(r, g, b) < 40 || Math.max(r, g, b) - Math.min(r, g, b) < 40;
}

/** Palette index for an FL color; orange when the color is black or unset. */
export function flColorToPalette(color: number, variant: LedVariant = "bright"): number {
  return rgbToPalette(...rgb(color), variant) || paletteColor(ORANGE, variant);
}

/** Steps (16th notes) in a bar of 4 beats. */
export const STEPS_PER_BAR = 16;

/** `2 bars`, `1 bar 4 steps`, `6 steps`: a length in steps. */
export function lengthText(steps: number): string {
  const total = Math.max(0, Math.round(steps));
  const bars = Math.floor(total / STEPS_PER_BAR);
  const rest = total % STEPS_PER_BAR;
  const barText = `${bars} bar${bars === 1 ? "" : "s"}`;
  const stepText = `${rest} step${rest === 1 ? "" : "s"}`;
  if (bars === 0) return stepText;
  return rest === 0 ? barText : `${barText} ${stepText}`;
}

/** `bar 5` on a bar line, else `5.3` (bar and 16th step in it), for a position in steps from bar 1. */
export function positionStepsText(steps: number): string {
  const total = Math.round(steps);
  const bar = Math.floor(total / STEPS_PER_BAR) + 1;
  const step = (total % STEPS_PER_BAR) + 1;
  return step === 1 ? `bar ${bar}` : `${bar}.${step}`;
}
