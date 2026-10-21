// Drawing building blocks for the MK3 screens. Each widget draws inside the rect it is given.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { Rect } from "../hw/display.js";
import { FALLBACK_FAMILY, fontFamily } from "./fonts.js";

type Ctx = SKRSContext2D;

/** Colors from docs/design.md: FL Studio's theme on the MK3 screens. */
export const theme = {
  /** Gutters and bars set into the panel. */
  background: "#1b2229",
  panel: "#2b3640",
  /** Tabs and the touched/selected row. */
  panelRaised: "#36444f",
  line: "#161c22",
  text: "#d3cfc9",
  dimText: "#8d98a2",
  /** FL's `Highlight`: what is current. */
  accent: "#fb9244",
  /** FL's `Selected`: selected fader cap, touched knob. */
  selected: "#4ae4a8",
  ledOn: "#78d008",
  ledOff: "#27331c",
  /** FL's `Option`: record, solo. */
  option: "#e85028",
  meterLow: "#a0dc40",
  meterMid: "#eec54e",
  meterHigh: "#fd7830",
  meterEmpty: "#20292f",
  faderCap: "#9aa3aa",
  faderSlot: "#141a1f",
  knobBody: "#222b32",
  knobRim: "#3a4650",
  stepOffA: "#3a4752",
  stepOffB: "#2f3b45",
  stepOnA: "#e0707a",
  stepOnB: "#9fb4c0",
  /** Transport state: green play, red record (the same as `ledOn` and `option`). */
  play: "#78d008",
  record: "#e85028",
};

/** A canvas font string: Barlow (SemiBold for bold) from FL's bundle, else Helvetica Neue. */
export const font = (size: number, weight: "normal" | "bold" = "normal") => {
  const bold = weight === "bold";
  const family = fontFamily(bold);
  return family === FALLBACK_FAMILY
    ? `${bold ? "bold " : ""}${size}px "${family}"`
    : `${size}px "${family}"`;
};

/** Shorten text with an ellipsis until it fits maxWidth. */
export function fitText(ctx: Ctx, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end--;
  return `${text.slice(0, end)}…`;
}

export function clear(ctx: Ctx, rect: Rect, color = theme.panel): void {
  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

/** Columns per screen: one for each display button above it and each knob below it. */
export const SCREEN_COLUMNS = 4;
/** Height of the tab strip along the top edge (labels for the display buttons). */
export const TAB_HEIGHT = 20;

/** Splits a rect into `count` equal columns. */
export function columns(rect: Rect, count: number): Rect[] {
  const width = rect.width / count;
  return Array.from({ length: count }, (_, i) => ({
    x: Math.round(rect.x + i * width),
    y: rect.y,
    width: Math.round(width),
    height: rect.height,
  }));
}

export interface TabsProps {
  /** Up to 4 labels, one above each display button of this screen; empty = no function. */
  tabs: readonly string[];
  /** Tabs that are on (the current page, or Mute and Solo, which can be on together). */
  active?: readonly number[];
  /** Underline of the active tab; FL's orange unless given. */
  color?: string;
  /** Tabs whose button does nothing right now: drawn faint. */
  disabled?: readonly number[];
}

/** The labels of the 4 display buttons above this screen, as tabs along the top of `rect`. */
export function drawTabs(ctx: Ctx, rect: Rect, props: TabsProps): void {
  const color = props.color ?? theme.accent;
  columns({ ...rect, height: TAB_HEIGHT }, SCREEN_COLUMNS).forEach((cell, i) => {
    clear(ctx, cell, theme.panelRaised);
    const inset = i > 0 ? 1 : 0;
    if (inset) {
      ctx.fillStyle = theme.line;
      ctx.fillRect(cell.x, cell.y, 1, cell.height);
    }
    const label = props.tabs[i];
    if (!label) return;
    const active = props.active?.includes(i) ?? false;
    if (active) {
      ctx.fillStyle = color;
      ctx.fillRect(cell.x + inset, cell.y + cell.height - 3, cell.width - inset, 3);
    }
    ctx.fillStyle = active ? theme.text : theme.dimText;
    ctx.font = font(14, active ? "bold" : "normal");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (props.disabled?.includes(i)) ctx.globalAlpha = 0.35;
    ctx.fillText(
      fitText(ctx, label, cell.width - 12),
      cell.x + cell.width / 2,
      cell.y + (cell.height - 3) / 2,
    );
    ctx.globalAlpha = 1;
  });
}

export interface HeaderProps {
  title: string;
  /** e.g. "2/5" or a section name, drawn right-aligned */
  page?: string;
  color?: string;
  /** Up to 4 labels, one above each display button, with `activeTab` highlighted. */
  tabs?: string[];
  activeTab?: number;
  /** For tabs that can be on together (e.g. Mute and Solo). */
  activeTabs?: readonly number[];
}

export function drawHeader(ctx: Ctx, rect: Rect, props: HeaderProps): void {
  clear(ctx, rect);
  const color = props.color ?? theme.accent;
  const tabsHeight = props.tabs ? TAB_HEIGHT : 0;
  if (props.tabs) {
    const active = [
      ...(props.activeTabs ?? []),
      ...(props.activeTab === undefined ? [] : [props.activeTab]),
    ];
    drawTabs(ctx, rect, { tabs: props.tabs, active, color });
  }
  const top = rect.y + tabsHeight;
  const height = rect.height - tabsHeight;
  ctx.fillStyle = theme.line;
  ctx.fillRect(rect.x, rect.y + rect.height - 1, rect.width, 1);
  ctx.textBaseline = "middle";
  ctx.font = font(18, "bold");
  ctx.textAlign = "right";
  const pageWidth = props.page ? ctx.measureText(props.page).width + 12 : 0;
  if (props.page) {
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText(props.page, rect.x + rect.width - 8, top + height / 2);
  }
  ctx.font = font(18, "bold");
  ctx.textAlign = "left";
  ctx.fillStyle = theme.text;
  ctx.fillText(
    fitText(ctx, props.title, rect.width - 16 - pageWidth),
    rect.x + 8,
    top + height / 2,
  );
}

export interface KnobProps {
  label: string;
  valueText: string;
  /** 0–1; undefined draws no arc (e.g. a stepped or text-only parameter) */
  value?: number;
  /** Fill from the middle, for pan-like parameters. */
  bipolar?: boolean;
  /** Arc color; FL's orange unless given (a touched knob is always mint). */
  color?: string;
  /** Finger on the knob: highlight and show the full name. */
  touched?: boolean;
}

const ARC_START = Math.PI * 0.75;
const ARC_SWEEP = Math.PI * 1.5;
/** Room kept above and below the dial for the label and the value. */
const KNOB_TEXT_SPACE = 48;
const ARC_WIDTH = 4;

export function drawKnob(ctx: Ctx, rect: Rect, props: KnobProps): void {
  clear(ctx, rect, props.touched ? theme.panelRaised : theme.panel);
  const color = props.touched ? theme.selected : (props.color ?? theme.accent);
  const cx = rect.x + rect.width / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = props.touched ? theme.text : theme.dimText;
  ctx.font = font(13, props.touched ? "bold" : "normal");
  ctx.fillText(fitText(ctx, props.label, rect.width - 8), cx, rect.y + 4);

  const radius = Math.min(rect.width * 0.3, (rect.height - KNOB_TEXT_SPACE) / 2);
  const cy = rect.y + 22 + radius + 4;
  if (props.value !== undefined && radius > 6) {
    const value = Math.min(1, Math.max(0, props.value));
    // the arc runs on the outside, the body sits inside it
    const arcRadius = radius - ARC_WIDTH / 2;
    ctx.lineWidth = ARC_WIDTH;
    ctx.lineCap = "round";
    ctx.strokeStyle = theme.line;
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, ARC_START, ARC_START + ARC_SWEEP);
    ctx.stroke();
    const from = props.bipolar ? ARC_START + ARC_SWEEP / 2 : ARC_START;
    const to = ARC_START + ARC_SWEEP * value;
    if (Math.abs(to - from) > 0.001) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, arcRadius, Math.min(from, to), Math.max(from, to));
      ctx.stroke();
    }
    const bodyRadius = radius - ARC_WIDTH - 3;
    if (bodyRadius > 3) {
      ctx.fillStyle = theme.knobBody;
      ctx.strokeStyle = theme.knobRim;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, bodyRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // pointer toward the value
      ctx.strokeStyle = props.touched ? theme.selected : theme.text;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(to) * bodyRadius * 0.3, cy + Math.sin(to) * bodyRadius * 0.3);
      ctx.lineTo(cx + Math.cos(to) * bodyRadius * 0.85, cy + Math.sin(to) * bodyRadius * 0.85);
      ctx.stroke();
    }
  }

  ctx.fillStyle = theme.text;
  ctx.font = font(15, "bold");
  ctx.textBaseline = "bottom";
  ctx.fillText(fitText(ctx, props.valueText, rect.width - 8), cx, rect.y + rect.height - 4);
}

/**
 * The 4 knobs under a screen, one per column. `rect` should span the whole screen width so
 * each column sits right above its knob; `undefined` leaves a column empty.
 */
export function drawKnobRow(
  ctx: Ctx,
  rect: Rect,
  knobs: ReadonlyArray<KnobProps | undefined>,
): void {
  columns(rect, SCREEN_COLUMNS).forEach((cell, i) => {
    const knob = knobs[i];
    if (knob) drawKnob(ctx, cell, knob);
    else clear(ctx, cell);
  });
}

export interface ListItem {
  text: string;
  detail?: string;
  /** The item's identity swatch (e.g. the channel's color). */
  color?: string;
  muted?: boolean;
}

export interface ListProps {
  items: ListItem[];
  selected: number;
  rowHeight?: number;
}

/** Scrolls so the selected row stays visible. */
export function drawList(ctx: Ctx, rect: Rect, props: ListProps): void {
  clear(ctx, rect);
  const rowHeight = props.rowHeight ?? 26;
  const visible = Math.max(1, Math.floor(rect.height / rowHeight));
  const top = Math.min(
    Math.max(0, props.selected - Math.floor(visible / 2)),
    Math.max(0, props.items.length - visible),
  );
  for (let row = 0; row < visible; row++) {
    const index = top + row;
    const item = props.items[index];
    if (!item) break;
    const y = rect.y + row * rowHeight;
    const selected = index === props.selected;
    if (selected) {
      ctx.fillStyle = theme.panelRaised;
      ctx.fillRect(rect.x, y, rect.width, rowHeight);
    }
    ctx.fillStyle = item.color ?? theme.knobRim;
    ctx.globalAlpha = item.muted ? 0.5 : 1;
    ctx.fillRect(rect.x + 8, y + 4, 6, rowHeight - 8);
    ctx.globalAlpha = 1;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    ctx.font = font(14);
    ctx.fillStyle = theme.dimText;
    const detailWidth = item.detail ? ctx.measureText(item.detail).width + 12 : 0;
    if (item.detail) ctx.fillText(item.detail, rect.x + rect.width - 8, y + rowHeight / 2);
    ctx.textAlign = "left";
    ctx.font = font(16, selected ? "bold" : "normal");
    ctx.fillStyle = item.muted ? theme.dimText : theme.text;
    ctx.fillText(
      fitText(ctx, item.text, rect.width - 28 - detailWidth),
      rect.x + 22,
      y + rowHeight / 2,
    );
    if (selected) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(rect.x, y, 3, rowHeight);
    }
  }
}

export interface FaderProps {
  label: string;
  /** 0–1 */
  value: number;
  /** 0–1, the meter level */
  peak?: number;
  valueText?: string;
  /** The track's identity color, drawn as a thin bar under the name. */
  color?: string;
  selected?: boolean;
  muted?: boolean;
}

const METER_CELL = 3;
const METER_GAP = 1;

/** A segmented meter bar, filled from the bottom up to `level` (0–1). */
function drawMeter(
  ctx: Ctx,
  x: number,
  top: number,
  width: number,
  height: number,
  level: number,
): void {
  const cells = Math.floor((height + METER_GAP) / (METER_CELL + METER_GAP));
  const lit = Math.round(cells * Math.min(1, Math.max(0, level)));
  for (let i = 0; i < cells; i++) {
    const fraction = i / (cells - 1);
    ctx.fillStyle =
      i >= lit
        ? theme.meterEmpty
        : fraction > 0.85
          ? theme.meterHigh
          : fraction > 0.65
            ? theme.meterMid
            : theme.meterLow;
    ctx.fillRect(x, top + height - (i + 1) * METER_CELL - i * METER_GAP, width, METER_CELL);
  }
}

export function drawFader(ctx: Ctx, rect: Rect, props: FaderProps): void {
  clear(ctx, rect);
  ctx.textAlign = "center";
  ctx.fillStyle = props.muted ? theme.dimText : theme.text;
  ctx.font = font(14, props.selected ? "bold" : "normal");
  ctx.textBaseline = "top";
  const cx = rect.x + rect.width / 2;
  ctx.fillText(fitText(ctx, props.label, rect.width - 6), cx, rect.y + 4);
  if (props.color) {
    ctx.fillStyle = props.color;
    ctx.fillRect(rect.x + 6, rect.y + 22, rect.width - 12, 3);
  }

  const trackTop = rect.y + 32;
  const trackBottom = rect.y + rect.height - 24;
  const trackHeight = trackBottom - trackTop;
  const value = Math.min(1, Math.max(0, props.value));
  const peak = Math.min(1, Math.max(0, props.peak ?? 0));

  drawMeter(ctx, cx + 4, trackTop, 10, trackHeight, peak);
  drawMeter(ctx, cx + 16, trackTop, 10, trackHeight, peak * 0.93);

  const slotX = cx - 22;
  ctx.fillStyle = theme.faderSlot;
  ctx.fillRect(slotX + 8, trackTop, 4, trackHeight);
  const capY = trackBottom - trackHeight * value;
  if (props.selected) {
    ctx.fillStyle = theme.selected;
    ctx.fillRect(slotX + 9, capY, 2, trackBottom - capY);
  }
  ctx.fillStyle = props.muted ? theme.knobRim : props.selected ? theme.selected : theme.faderCap;
  ctx.beginPath();
  ctx.roundRect(slotX, capY - 5, 20, 10, 2);
  ctx.fill();
  ctx.fillStyle = theme.faderSlot;
  ctx.fillRect(slotX + 3, capY - 0.5, 14, 1);

  if (props.valueText) {
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13);
    ctx.textBaseline = "bottom";
    ctx.fillText(fitText(ctx, props.valueText, rect.width - 4), cx, rect.y + rect.height - 4);
  }
}

export interface TransportProps {
  playing: boolean;
  recording: boolean;
  bpm: number;
  position: string;
  pattern?: string;
}

export function drawTransport(ctx: Ctx, rect: Rect, props: TransportProps): void {
  clear(ctx, rect, theme.background);
  const cy = rect.y + rect.height / 2;
  let x = rect.x + 10;
  const size = Math.min(14, rect.height - 8);

  ctx.fillStyle = props.playing ? theme.ledOn : theme.ledOff;
  ctx.beginPath();
  ctx.moveTo(x, cy - size / 2);
  ctx.lineTo(x + size, cy);
  ctx.lineTo(x, cy + size / 2);
  ctx.closePath();
  ctx.fill();
  x += size + 10;

  ctx.fillStyle = props.recording ? theme.option : theme.knobRim;
  ctx.beginPath();
  ctx.arc(x + size / 2, cy, size / 2, 0, Math.PI * 2);
  ctx.fill();
  x += size + 14;

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = theme.text;
  ctx.font = font(17, "bold");
  ctx.fillText(props.position, x, cy);
  x += ctx.measureText(props.position).width + 16;

  ctx.fillStyle = theme.dimText;
  ctx.font = font(16);
  const bpm = `${props.bpm.toFixed(props.bpm % 1 === 0 ? 0 : 2)} BPM`;
  ctx.fillText(bpm, x, cy);
  x += ctx.measureText(bpm).width + 16;

  if (props.pattern) {
    ctx.fillStyle = theme.text;
    ctx.fillText(fitText(ctx, props.pattern, rect.x + rect.width - x - 8), x, cy);
  }
}
