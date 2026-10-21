// What the pad pages draw (PATTERN, MUTE, SELECT, SOLO, PAD MODE, KEYBOARD): a 4×4 grid that
// mirrors the pads. Pad 1 is the bottom-left pad, so the first row of pads is the bottom row of the
// grid.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { Rect } from "../hw/display.js";
import { PAD_COUNT } from "../hw/ids.js";
import { TAB_HEIGHT, clear, drawTabs, fitText, font, theme } from "../render/widgets.js";
import { FULL } from "./draw.js";

const GRID_SIDE = 4;
const GAP = 3;

export interface PadCell {
  /** Pad number shown in the corner (the pattern or channel number); none on the keyboard grid. */
  number?: number;
  /** Text for the corner instead of `number` (a marker's bar: `Bar 17`). */
  tag?: string;
  name: string;
  /** CSS color of the thing the pad stands for. */
  color: string;
  /** The current pattern or the selected channel: outlined in FL's orange. */
  current?: boolean;
  /** A muted channel: dimmed and struck through. */
  muted?: boolean;
  /** A soloed channel: outlined in FL's solo red, with an `S` badge. */
  solo?: boolean;
  /** A jump to this marker is queued for the next bar: outlined in FL's mint. */
  queued?: boolean;
  /** A note to find the keys by (the C notes): bright name over an orange line. */
  marked?: boolean;
}

/** Tab strip of the left screen: only display button 1, the pin tab. */
export function drawPinTab(ctx: SKRSContext2D, label: string, pinned: boolean): void {
  drawTabs(ctx, { ...FULL, height: TAB_HEIGHT }, { tabs: [label], active: pinned ? [0] : [] });
}

/** `1–16 of 20`, or nothing while there is nothing to show. */
export const windowText = (first: number, shown: number, total: number): string =>
  shown > 0 ? `${first + 1}–${first + shown} of ${total}` : "";

/** The grid area of a screen: under the tab strip, over the footer line. */
export const GRID_RECT: Rect = {
  x: 4,
  y: TAB_HEIGHT + 4,
  width: FULL.width - 8,
  height: FULL.height - TAB_HEIGHT - 4 - 26,
};

/**
 * `cells[i]` is pad i + 1; undefined = no object behind the pad. The cell of a pad sits at its
 * place on the panel.
 */
export function drawPadGrid(
  ctx: SKRSContext2D,
  rect: Rect,
  cells: ReadonlyArray<PadCell | undefined>,
): void {
  for (let pad = 0; pad < PAD_COUNT; pad++) drawCell(ctx, padCellRect(rect, pad), cells[pad]);
}

/** Where pad `pad` (0-based, pad 1 bottom-left) sits in a 4×4 grid filling `rect`. */
export function padCellRect(rect: Rect, pad: number): Rect {
  const cellWidth = (rect.width + GAP) / GRID_SIDE - GAP;
  const cellHeight = (rect.height + GAP) / GRID_SIDE - GAP;
  const column = pad % GRID_SIDE;
  const rowFromBottom = Math.floor(pad / GRID_SIDE);
  return {
    x: Math.round(rect.x + column * (cellWidth + GAP)),
    y: Math.round(rect.y + (GRID_SIDE - 1 - rowFromBottom) * (cellHeight + GAP)),
    width: Math.round(cellWidth),
    height: Math.round(cellHeight),
  };
}

function drawCell(ctx: SKRSContext2D, rect: Rect, cell: PadCell | undefined): void {
  if (!cell) {
    clear(ctx, rect, theme.background);
    return;
  }
  clear(ctx, rect, theme.panelRaised);
  const dim = cell.muted ?? false;
  ctx.globalAlpha = dim ? 0.45 : 1;
  ctx.fillStyle = cell.color;
  ctx.fillRect(rect.x, rect.y, 6, rect.height);
  ctx.globalAlpha = 1;
  if (cell.marked) {
    ctx.fillStyle = theme.accent;
    ctx.fillRect(rect.x + 6, rect.y, rect.width - 6, 3);
  }
  if (cell.queued) {
    ctx.strokeStyle = theme.selected;
    ctx.lineWidth = 3;
    ctx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.width - 3, rect.height - 3);
  }
  if (cell.current || cell.solo) {
    ctx.strokeStyle = cell.solo ? theme.option : theme.accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.width - 3, rect.height - 3);
  }
  const left = rect.x + 12;
  const width = rect.width - 18;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const corner = cell.tag ?? (cell.number === undefined ? undefined : String(cell.number));
  if (corner !== undefined) {
    ctx.font = font(13, "bold");
    ctx.fillStyle = cell.current ? theme.accent : theme.dimText;
    ctx.fillText(corner, left, rect.y + 5);
  }
  if (cell.solo) {
    ctx.font = font(13, "bold");
    ctx.fillStyle = theme.option;
    ctx.textAlign = "right";
    ctx.fillText("S", rect.x + rect.width - 7, rect.y + 5);
    ctx.textAlign = "left";
  }
  const strong = cell.current || cell.marked;
  ctx.font = font(corner === undefined ? 20 : 15, strong ? "bold" : "normal");
  ctx.fillStyle = dim ? theme.dimText : cell.marked ? theme.accent : theme.text;
  const name = fitText(ctx, cell.name, width);
  const y = rect.y + rect.height - 21;
  ctx.fillText(name, left, y);
  if (dim) {
    ctx.fillStyle = theme.dimText;
    ctx.fillRect(left, y + 9, ctx.measureText(name).width, 1.5);
  }
}

/** The footer line under the grid. */
export function drawFooter(
  ctx: SKRSContext2D,
  text: string,
  align: CanvasTextAlign = "right",
): void {
  if (!text) return;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.dimText;
  ctx.font = font(13);
  const x = align === "right" ? FULL.width - 8 : align === "left" ? 8 : FULL.width / 2;
  ctx.fillText(text, x, FULL.height - 13);
}
