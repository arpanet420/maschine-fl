// Layout and drawing shared by the modes.
import type { SKRSContext2D } from "@napi-rs/canvas";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, type Rect } from "../hw/display.js";
import type { FlState } from "../fl/flState.js";
import { TAB_HEIGHT, drawTransport, fitText, font, theme } from "../render/widgets.js";
import type { KnobProps } from "../render/widgets.js";

export const FULL: Rect = { x: 0, y: 0, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };
export const HEADER_HEIGHT = 36;
export const TRANSPORT_HEIGHT = 36;
/** Header with the display-button tabs above it. */
export const TABBED_HEADER_HEIGHT = HEADER_HEIGHT + TAB_HEIGHT;

export const TRANSPORT_RECT: Rect = {
  x: 0,
  y: DISPLAY_HEIGHT - TRANSPORT_HEIGHT,
  width: DISPLAY_WIDTH,
  height: TRANSPORT_HEIGHT,
};

export function drawTransportBar(
  ctx: SKRSContext2D,
  fl: FlState,
  rect: Rect = TRANSPORT_RECT,
): void {
  const { bar, step, tick } = fl.songPos;
  drawTransport(ctx, rect, {
    playing: fl.transport.playing,
    recording: fl.transport.recording,
    bpm: fl.tempo,
    position: `${bar}.${step}.${String(tick).padStart(2, "0")}`,
    pattern: fl.transport.metronome ? "Metronome" : undefined,
  });
}

/** Full name and value of the knob being touched. */
export function drawBand(
  ctx: SKRSContext2D,
  rect: { x: number; y: number; width: number; height: number },
  knob: { name: string; props: KnobProps },
): void {
  ctx.fillStyle = theme.panelRaised;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = theme.selected;
  ctx.fillRect(rect.x, rect.y, 3, rect.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.dimText;
  ctx.font = font(14);
  ctx.fillText(knob.name, rect.x + rect.width / 2, rect.y + 5);
  ctx.textBaseline = "bottom";
  ctx.fillStyle = theme.text;
  ctx.font = font(30, "bold");
  ctx.fillText(knob.props.valueText, rect.x + rect.width / 2, rect.y + rect.height - 2);
}

/** Draws `text` word-wrapped into at most `maxLines` lines (the last one is cut with an ellipsis). */
export function drawWrapped(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  lineHeight: number,
  maxLines: number,
): void {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  lines.slice(0, maxLines).forEach((l, i) => {
    ctx.fillText(fitText(ctx, l, width), x, y + i * lineHeight);
  });
}
