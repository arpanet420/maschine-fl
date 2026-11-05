// The colours a COLOR knob steps through: patterns, channels and mixer tracks.
import type { KnobProps } from "../render/widgets.js";
import { flColorToCss } from "./format.js";

/** Knob counts per colour step. */
export const COLOR_DETENT_COUNTS = 120;

/** `0xRRGGBB`, around FL's own step and channel colours. */
export const NAMED_COLORS: ReadonlyArray<{ name: string; color: number }> = [
  { name: "Red", color: 0xe0505a },
  { name: "Orange", color: 0xfb9244 },
  { name: "Yellow", color: 0xeec54e },
  { name: "Lime", color: 0xa0dc40 },
  { name: "Mint", color: 0x4ae4a8 },
  { name: "Cyan", color: 0x4ac8e0 },
  { name: "Blue", color: 0x5aa9e6 },
  { name: "Indigo", color: 0x7a7ae6 },
  { name: "Purple", color: 0xa678de },
  { name: "Magenta", color: 0xd070c8 },
  { name: "Pink", color: 0xe0707a },
  { name: "Grey", color: 0x9aa3aa },
];

/** `detents` on from `current`, wrapping. A colour that isn't on the list starts at the end it turns towards. */
export function nextNamedColor(current: number, detents: number): number {
  const now = current & 0xffffff;
  const at = NAMED_COLORS.findIndex((c) => c.color === now);
  const size = NAMED_COLORS.length;
  const next = at < 0 ? (detents > 0 ? detents - 1 : size + detents) : at + detents;
  return NAMED_COLORS[((next % size) + size) % size]?.color ?? now;
}

/** The knob that sets a colour. */
export function colorKnob(current: number, touched: boolean): KnobProps {
  const now = current & 0xffffff;
  const entry = NAMED_COLORS.find((c) => c.color === now);
  return {
    label: "COLOR",
    valueText: entry?.name ?? "Custom",
    value: entry ? NAMED_COLORS.indexOf(entry) / (NAMED_COLORS.length - 1) : 0,
    color: flColorToCss(now),
    touched,
  };
}
