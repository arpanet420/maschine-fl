// Layout and drawing shared by the modes.
import type { SKRSContext2D } from "@napi-rs/canvas";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, type Rect } from "../hw/display.js";
import type { FlState } from "../fl/flState.js";
import { PORT_TO_FL } from "../fl/protocol.js";
import type { LedState } from "../hw/leds.js";
import { LED_OFF, paletteColor } from "../hw/palette.js";
import { clear, drawHeader, drawTransport, fitText, font, theme } from "../render/widgets.js";
import type { KnobProps } from "../render/widgets.js";

export const FULL: Rect = { x: 0, y: 0, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };
export const HEADER_HEIGHT = 36;
export const TRANSPORT_HEIGHT = 36;

export const TRANSPORT_RECT: Rect = {
  x: 0,
  y: DISPLAY_HEIGHT - TRANSPORT_HEIGHT,
  width: DISPLAY_WIDTH,
  height: TRANSPORT_HEIGHT,
};

/** The screens while FL isn't there. */
export function drawWaiting(left: SKRSContext2D, right: SKRSContext2D): void {
  clear(left, FULL);
  clear(right, FULL);
  drawHeader(left, { ...FULL, height: HEADER_HEIGHT }, { title: "MK3 Bridge" });
  left.textAlign = "center";
  left.textBaseline = "middle";
  left.fillStyle = theme.dimText;
  left.font = font(24, "bold");
  left.fillText("Waiting for FL Studio…", DISPLAY_WIDTH / 2, 130);
  left.font = font(14);
  left.fillText(`Enable "${PORT_TO_FL}" in FL's MIDI Settings`, DISPLAY_WIDTH / 2, 165);
}

/** A 4D arrow that does something on this page: dim orange. */
export const NAV_LIT = paletteColor(1, "dim");

/** The 4D's up and down where they pick the channel: lit where there is a channel to go to. */
export function setChannelNavLeds(leds: LedState, selected: number | null, total: number): void {
  const at = selected ?? -1;
  leds.setNav("up", at > 0 ? NAV_LIT : LED_OFF);
  leds.setNav("down", at + 1 < total ? NAV_LIT : LED_OFF);
}

export function drawTransportBar(
  ctx: SKRSContext2D,
  fl: FlState,
  rect: Rect = TRANSPORT_RECT,
): void {
  const { bar, step, tick } = fl.barPosition;
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
  ctx.fillText(fitText(ctx, knob.name, rect.width - 12), rect.x + rect.width / 2, rect.y + 5);
  ctx.textBaseline = "bottom";
  ctx.fillStyle = theme.text;
  ctx.font = font(30, "bold");
  ctx.fillText(
    fitText(ctx, knob.props.valueText, rect.width - 12),
    rect.x + rect.width / 2,
    rect.y + rect.height - 2,
  );
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
