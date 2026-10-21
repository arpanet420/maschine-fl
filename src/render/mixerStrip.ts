// One mixer strip in FL's look (docs/design.md, "Mixer strip"): a `panel` card in a 120 px column
// with the track's color bar, mute LED, name, stereo peak meter, fader and the knob's value at the
// bottom. The tab bar above the strips carries the display-button labels.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { Rect } from "../hw/display.js";
import { TAB_HEIGHT, clear, drawTabs, fitText, font, theme } from "./widgets.js";

type Ctx = SKRSContext2D;

/** FL's normalized volume at 0 dB (docs/sysex.md: `norm` volume, 0.8 = 0 dB). */
export const FADER_ZERO_DB = 0.8;
/** The meter shows −60 dB … 0 dB below the fader's 0 dB tick and 0 … +6 dB above it. */
export const METER_MIN_DB = -60;
export const METER_MAX_DB = 6;

/** Gutter between a column's edge and its card. */
const GUTTER = 4;
/** Card layout, from the top of the card. */
const COLOR_BAR = 4;
const LED_CENTER = 18;
const LED_RADIUS = 6;
const BODY_TOP = 32;
/** The knob row at the bottom of the card: what the knob does, and its value. */
const KNOB_ROW = 44;
/** Room above and below the fader's travel, for half of the cap. */
const TRAVEL_MARGIN = 6;

const NAME_X = 10;
const METER_X = [22, 34] as const;
const METER_WIDTH = 10;
const SCALE_RIGHT = 62;
const FADER_X = 86;
const CAP_WIDTH = 30;
const CAP_HEIGHT = 12;
const CELL = 3;
const GAP = 1;

/** Meter height (0–1 of the fader's travel) of a peak level in dB; 0 dB sits at the fader's tick. */
export function dbToFraction(db: number): number {
  if (db <= METER_MIN_DB) return 0;
  if (db >= METER_MAX_DB) return 1;
  return db < 0
    ? (FADER_ZERO_DB * (db - METER_MIN_DB)) / -METER_MIN_DB
    : FADER_ZERO_DB + ((1 - FADER_ZERO_DB) * db) / METER_MAX_DB;
}

export function fractionToDb(fraction: number): number {
  if (fraction <= FADER_ZERO_DB) return METER_MIN_DB + (fraction / FADER_ZERO_DB) * -METER_MIN_DB;
  return ((fraction - FADER_ZERO_DB) / (1 - FADER_ZERO_DB)) * METER_MAX_DB;
}

/** Meter height for FL's linear peak (0–1, 1 = 0 dB). */
export function peakFraction(peak: number): number {
  return peak <= 0 ? 0 : dbToFraction(20 * Math.log10(peak));
}

/** The meter's color at a height: green, then yellow from −18 dB, orange from −6 dB. */
function meterColor(fraction: number): string {
  const db = fractionToDb(fraction);
  return db >= -6 ? theme.meterHigh : db >= -18 ? theme.meterMid : theme.meterLow;
}

/** Blends two `#rrggbb` colors: `t` = 0 is `a`, 1 is `b`. */
export function mix(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const ch = (css: string, i: number) => Number.parseInt(css.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** `color` blended into the panel color: `amount` (0–1) of the color. */
export const tintColor = (color: string, amount: number, base = theme.panel): string =>
  mix(base, color, amount);

/** Perceived brightness (0–1) of a `#rrggbb` color. */
export function luminance(css: string): number {
  const [r = 0, g = 0, b = 0] = [0, 1, 2].map((i) =>
    Number.parseInt(css.slice(1 + 2 * i, 3 + 2 * i), 16),
  );
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Share of the track color in the card body, the selected strip's body and the name band. */
const TINT_BODY = 0.32;
const TINT_BODY_SELECTED = 0.45;
const TINT_NAME = 0.6;
/** A muted track's tint, relative. */
const TINT_MUTED = 0.5;
/** Width of the name band along the card's left edge. */
export const NAME_BAND = 28;

export interface StripProps {
  name: string;
  /** The track's FL color as CSS. */
  color: string;
  /** FL's default (no) color: the card keeps the plain panel look. */
  uncolored?: boolean;
  selected: boolean;
  muted: boolean;
  solo: boolean;
  armed: boolean;
  /** FL's normalized volume, 0–1 (0.8 = 0 dB). */
  volume: number;
  /** Meter heights (0–1 of the fader's travel). */
  meter: readonly [number, number];
  /** Peak-hold tick heights, same scale. */
  hold: readonly [number, number];
  /** dB ticks beside the meter (the master strip). */
  scale?: boolean;
  /** What the knob does (`VOL`, `PAN`) and its value. */
  knobLabel: string;
  valueText: string;
  /** A finger on this strip's knob: highlight the strip and show the value big. */
  touched?: boolean;
  /** Full name of what the touched knob does, for the big value. */
  touchedName?: string;
}

/** The strip's cards in one screen's 4 columns, below the tab bar. */
export function stripCells(rect: Rect, count: number): Rect[] {
  const width = rect.width / count;
  return Array.from({ length: count }, (_, i) => ({
    x: Math.round(rect.x + i * width) + GUTTER,
    y: rect.y + GUTTER,
    width: Math.round(width) - 2 * GUTTER,
    height: rect.height - 2 * GUTTER,
  }));
}

/** The vertical span the meter and the fader share: a value's height is `bottom - f * (bottom - top)`. */
function travel(card: Rect): { top: number; bottom: number } {
  return {
    top: card.y + BODY_TOP + TRAVEL_MARGIN,
    bottom: card.y + card.height - KNOB_ROW - 2 - TRAVEL_MARGIN,
  };
}

/** The display-button labels as tabs; the selected track's number is boxed in orange. */
export function drawMixerTabs(
  ctx: Ctx,
  rect: Rect,
  labels: ReadonlyArray<string | undefined>,
  selected: number,
): void {
  drawTabs(ctx, { ...rect, height: TAB_HEIGHT }, { tabs: [] });
  const width = rect.width / labels.length;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  labels.forEach((label, i) => {
    if (!label) return;
    const cx = rect.x + (i + 0.5) * width;
    const cy = rect.y + TAB_HEIGHT / 2;
    ctx.font = font(14, i === selected ? "bold" : "normal");
    if (i === selected) {
      const boxWidth = Math.max(24, ctx.measureText(label).width + 12);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(cx - boxWidth / 2, cy - 8, boxWidth, 16, 3);
      ctx.stroke();
    }
    ctx.fillStyle = i === selected ? theme.text : theme.dimText;
    ctx.fillText(label, cx, cy + 0.5);
  });
}

/** An empty panel: the column has no track. */
export function drawEmptyStrip(ctx: Ctx, card: Rect): void {
  clear(ctx, card, theme.panel);
}

export function drawMixerStrip(ctx: Ctx, card: Rect, props: StripProps): void {
  clear(ctx, card, props.touched ? theme.panelRaised : theme.panel);
  ctx.save();
  ctx.beginPath();
  ctx.rect(card.x, card.y, card.width, card.height);
  ctx.clip();
  if (props.touched) {
    ctx.strokeStyle = theme.selected;
    ctx.lineWidth = 2;
    ctx.strokeRect(card.x + 1, card.y + 1, card.width - 2, card.height - 2);
  }

  // The track's color tints the body and the name band; the knob row stays plain.
  if (!props.uncolored) {
    const ground = props.touched ? theme.panelRaised : theme.panel;
    const dim = props.muted ? TINT_MUTED : 1;
    const body = (props.selected ? TINT_BODY_SELECTED : TINT_BODY) * dim;
    const bodyHeight = card.height - KNOB_ROW - 2;
    ctx.fillStyle = tintColor(props.color, body, ground);
    ctx.fillRect(card.x, card.y, card.width, bodyHeight);
    ctx.fillStyle = tintColor(props.color, TINT_NAME * dim, ground);
    ctx.fillRect(card.x, card.y, NAME_BAND, bodyHeight);
  }

  // The track's color, thin, along the top.
  ctx.globalAlpha = props.muted ? 0.45 : 1;
  ctx.fillStyle = props.color;
  ctx.fillRect(card.x, card.y, card.width, COLOR_BAR);
  ctx.globalAlpha = 1;

  drawLeds(ctx, card, props);
  drawName(ctx, card, props);

  const { top, bottom } = travel(card);
  const height = bottom - top;
  props.meter.forEach((level, side) => {
    drawMeter(ctx, card.x + (METER_X[side] ?? 0), bottom, height, level, props.hold[side] ?? 0);
  });
  if (props.scale) drawScale(ctx, card, top, height);
  drawFader(ctx, card, top, bottom, props);

  // Knob row.
  ctx.fillStyle = theme.line;
  ctx.fillRect(card.x, card.y + card.height - KNOB_ROW - 2, card.width, 1);
  const cx = card.x + card.width / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = props.touched ? theme.text : theme.dimText;
  ctx.font = font(12, props.touched ? "bold" : "normal");
  ctx.fillText(props.knobLabel, cx, card.y + card.height - KNOB_ROW + 2);
  ctx.textBaseline = "bottom";
  ctx.fillStyle = theme.text;
  ctx.font = font(18, "bold");
  ctx.fillText(fitText(ctx, props.valueText, card.width - 6), cx, card.y + card.height - 4);

  if (props.touched) {
    // the big value goes on the half of the body the cap is not in
    drawTouched(ctx, card, props, capCenter(top, bottom, props.volume) > (top + bottom) / 2);
  }
  ctx.restore();
}

/** Mute LED (green = playing), solo badge on its left and the armed dot on its right. */
function drawLeds(ctx: Ctx, card: Rect, props: StripProps): void {
  const cx = card.x + card.width / 2;
  const cy = card.y + LED_CENTER;
  ctx.fillStyle = props.muted ? theme.ledOff : theme.ledOn;
  ctx.beginPath();
  ctx.arc(cx, cy, LED_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (props.solo) {
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.roundRect(cx - 34, cy - 7, 14, 14, 3);
    ctx.fill();
    ctx.fillStyle = theme.panel;
    ctx.font = font(12, "bold");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("S", cx - 27, cy + 0.5);
  }
  if (props.armed) {
    ctx.fillStyle = theme.option;
    ctx.beginPath();
    ctx.arc(cx + 27, cy, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The track's name along the left edge, rotated 90° (reads upwards). */
function drawName(ctx: Ctx, card: Rect, props: StripProps): void {
  const { top, bottom } = travel(card);
  ctx.save();
  ctx.translate(card.x + NAME_X, bottom + TRAVEL_MARGIN);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = font(13, props.selected ? "bold" : "normal");
  const light = !props.uncolored && !props.muted && luminance(props.color) > 0.75;
  ctx.fillStyle = light
    ? theme.panel
    : props.selected
      ? theme.text
      : props.uncolored
        ? theme.dimText
        : theme.text;
  ctx.fillText(fitText(ctx, props.name, bottom - top + 2 * TRAVEL_MARGIN - 4), 2, 0);
  ctx.restore();
}

/** A segmented bar filled from `bottom` up to `level`, with a peak-hold tick. */
function drawMeter(
  ctx: Ctx,
  x: number,
  bottom: number,
  height: number,
  level: number,
  hold: number,
): void {
  const cells = Math.floor((height + GAP) / (CELL + GAP));
  const lit = Math.max(0, Math.min(1, level));
  for (let i = 0; i < cells; i++) {
    const fraction = (i * (CELL + GAP) + CELL / 2) / height;
    ctx.fillStyle = lit >= fraction ? meterColor(fraction) : theme.meterEmpty;
    ctx.fillRect(x, bottom - (i + 1) * CELL - i * GAP, METER_WIDTH, CELL);
  }
  const peak = Math.max(0, Math.min(1, hold));
  // Only a tick that has left the bar behind is worth drawing.
  if (peak > lit + (CELL + GAP) / height) {
    ctx.fillStyle = meterColor(peak);
    ctx.fillRect(x, Math.round(bottom - peak * height - 1), METER_WIDTH, 2);
  }
}

/** dB marks beside the master's meter (FL's master strip): unsigned, 0 in the text color. */
function drawScale(ctx: Ctx, card: Rect, top: number, height: number): void {
  const bottom = top + height;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.font = font(10);
  let last = -Infinity;
  for (const db of [6, 3, 0, -6, -12, -24, -36, -48]) {
    const y = Math.round(bottom - dbToFraction(db) * height);
    if (y - last < 11) continue; // no room
    last = y;
    ctx.fillStyle = db === 0 ? theme.text : theme.dimText;
    ctx.fillText(String(Math.abs(db)), card.x + SCALE_RIGHT, y);
  }
}

const capCenter = (top: number, bottom: number, volume: number) =>
  bottom - (bottom - top) * Math.max(0, Math.min(1, volume));

function drawFader(ctx: Ctx, card: Rect, top: number, bottom: number, props: StripProps): void {
  const cx = card.x + FADER_X;
  // the slot, with a mint line along it on the selected track
  ctx.fillStyle = theme.faderSlot;
  ctx.fillRect(cx - 2, top - 2, 4, bottom - top + 4);
  if (props.selected) {
    ctx.fillStyle = theme.selected;
    ctx.fillRect(cx - 0.5, top - 2, 1, bottom - top + 4);
  }
  // 0 dB tick on both sides of the cap
  const zero = Math.round(capCenter(top, bottom, FADER_ZERO_DB));
  ctx.fillStyle = theme.dimText;
  ctx.fillRect(cx - CAP_WIDTH / 2 - 6, zero, 4, 1);
  ctx.fillRect(cx + CAP_WIDTH / 2 + 2, zero, 4, 1);

  const y = Math.round(capCenter(top, bottom, props.volume));
  ctx.fillStyle = props.selected ? theme.selected : theme.faderCap;
  ctx.beginPath();
  ctx.roundRect(cx - CAP_WIDTH / 2, y - CAP_HEIGHT / 2, CAP_WIDTH, CAP_HEIGHT, 3);
  ctx.fill();
  ctx.fillStyle = theme.faderSlot;
  ctx.fillRect(cx - CAP_WIDTH / 2 + 4, y, CAP_WIDTH - 8, 1);
}

/** The touched knob's value, big, at the top of the body (or just above the knob row). */
function drawTouched(ctx: Ctx, card: Rect, props: StripProps, top: boolean): void {
  const height = 50;
  const y = top ? card.y + BODY_TOP + 2 : card.y + card.height - KNOB_ROW - 6 - height;
  // right of the rotated name, which stays readable
  const x = card.x + 19;
  const width = card.width - 19 - 5;
  ctx.fillStyle = theme.background;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = theme.selected;
  ctx.fillRect(x, y, 3, height);
  const cx = x + 3 + (width - 3) / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.dimText;
  ctx.font = font(12);
  ctx.fillText(fitText(ctx, props.touchedName ?? props.knobLabel, width - 12), cx, y + 4);
  ctx.textBaseline = "bottom";
  ctx.fillStyle = theme.text;
  ctx.font = font(28, "bold");
  ctx.fillText(fitText(ctx, props.valueText, width - 12), cx, y + height - 2);
}
