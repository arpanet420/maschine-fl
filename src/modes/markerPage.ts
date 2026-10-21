// What the SCENE overlay stands on (docs/workflow.md; ARRANGER used it before it became the pattern
// overview): FL has no scenes, so a playlist marker stands for a scene or section. The pads are the
// markers of the current bank of 16 (pad 1 = the first marker of the bank, colors from a fixed
// rotation, the marker the song position is in bright, the others dim, empty pads off), display 7
// and 8 (`<<` `>>`) page between the banks, a pad press asks the page what to do (`padPressed`:
// SCENE jumps at the next bar), and the right screen shows the markers' names as a 4×4 grid that
// mirrors the pads.
//
// FL's script lists the markers by name (`getMarkerName(i)` until it is empty, so the count and the
// names are reliable) and finds their times by scanning (only while FL is stopped); the times of a
// scan that disagrees with the name count are unknown (`ticks` null: no bar, no jump). They go out as MARKERS;
// opening SCENE asks for a fresh scan (REQUEST_MARKERS). The marker the song is in comes from
// SONG_POS and the project's PPQ: the last marker whose tick is at or before the position.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlState } from "../fl/flState.js";
import type { SongPosition } from "../fl/sysex.js";
import type { Rect } from "../hw/display.js";
import type { HwEvent } from "../hw/events.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import { LED_OFF, type LedVariant } from "../hw/palette.js";
import { TAB_HEIGHT, clear, drawTabs, font, theme } from "../render/widgets.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL, drawWrapped } from "./draw.js";
import { flColorToCss, flColorToPalette } from "./format.js";
import type { Mode, ModeContext, ModeName } from "./mode.js";
import { drawPadGrid, type PadCell } from "./padGrid.js";

/** Markers per bank: one per pad. */
export const MARKER_BANK = PAD_COUNT;
/** Display 7 and 8 (0-based 6 and 7): the previous and next bank. */
const PREVIOUS_BANK = 6;
const NEXT_BANK = 7;
/** SONG_POS has 16 steps per bar of 4 beats (the STEP page's assumption). */
const STEPS_PER_BAR = 16;
const BEATS_PER_BAR = 4;
/** A song position this close (in beats) to a marker counts as being at it. */
const AT_MARKER = 1e-3;

/** The rotation of colors the markers take, by index (FL's step colors and their neighbors). */
export const MARKER_COLORS: readonly number[] = [
  0xe0707a, 0xfb9244, 0xeec54e, 0x4ae4a8, 0x5aa9e6, 0xa678de,
];

export const NO_MARKERS_TEXT = "No markers — ADD MKR sets one at the play position";

// ── Markers and the song position ───────────────────────────────────────────────

/** SONG_POS in beats from the start (bar 1, step 1), with FL's ticks per quarter note. */
export function positionBeats(pos: SongPosition, ppq: number): number {
  return (
    ((pos.bar - 1) * STEPS_PER_BAR + (pos.step - 1)) / (STEPS_PER_BAR / BEATS_PER_BAR) +
    pos.tick / ppq
  );
}

/** The marker's position in beats, undefined while the script has not sent it or could not tell. */
export function markerBeats(fl: FlState, index: number): number | undefined {
  const ticks = fl.markers.get(index)?.ticks;
  return ticks === undefined || ticks === null ? undefined : ticks / fl.ppq;
}

/** The marker's bar (1-based). */
export const markerBar = (beats: number): number =>
  Math.floor(beats / BEATS_PER_BAR + AT_MARKER) + 1;

export const markerName = (fl: FlState, index: number): string =>
  fl.markers.get(index)?.name || `Marker ${index + 1}`;

export const markerColor = (index: number): number =>
  MARKER_COLORS[index % MARKER_COLORS.length] ?? 0xfb9244;

/** The marker the song position is in: the last one at or before it; −1 before the first. */
export function currentMarker(fl: FlState): number {
  const beats = positionBeats(fl.songPos, fl.ppq);
  let found = -1;
  for (let i = 0; i < fl.markerTotal; i++) {
    const at = markerBeats(fl, i);
    if (at === undefined || at > beats + AT_MARKER) break;
    found = i;
  }
  return found;
}

/** The last marker strictly before the song position, undefined if there is none. */
export function previousMarker(fl: FlState): number | undefined {
  const beats = positionBeats(fl.songPos, fl.ppq);
  let found: number | undefined;
  for (let i = 0; i < fl.markerTotal; i++) {
    const at = markerBeats(fl, i);
    if (at === undefined || at >= beats - AT_MARKER) break;
    found = i;
  }
  return found;
}

/** The first marker strictly after the song position, undefined if there is none. */
export function nextMarker(fl: FlState): number | undefined {
  const beats = positionBeats(fl.songPos, fl.ppq);
  for (let i = 0; i < fl.markerTotal; i++) {
    const at = markerBeats(fl, i);
    if (at !== undefined && at > beats + AT_MARKER) return i;
  }
  return undefined;
}

/** `12.3`: the bar and the 16th step in it. */
export const positionText = (pos: SongPosition): string => `${pos.bar}.${pos.step}`;

// ── Banks ────────────────────────────────────────────────────────────────────

export const markerBankOf = (index: number): number => Math.floor(Math.max(0, index) / MARKER_BANK);

/** The last bank that has a marker (0 without markers). */
export const lastMarkerBank = (fl: FlState): number =>
  Math.max(0, Math.floor((fl.markerTotal - 1) / MARKER_BANK));

/** `1–16 of 20`, or nothing without markers. */
export function markerWindowText(fl: FlState, bank: number): string {
  const first = bank * MARKER_BANK;
  const shown = Math.min(MARKER_BANK, Math.max(0, fl.markerTotal - first));
  return shown > 0 ? `${first + 1}–${first + shown} of ${fl.markerTotal}` : "";
}

// ── Drawing ──────────────────────────────────────────────────────────────────

/** The grid of a bank in `rect` (pad 1 bottom-left); `queued` = the marker with a jump waiting. */
export function drawMarkerGrid(
  ctx: SKRSContext2D,
  rect: Rect,
  fl: FlState,
  bank: number,
  queued?: number,
): void {
  const current = currentMarker(fl);
  const cells: Array<PadCell | undefined> = [];
  for (let pad = 0; pad < PAD_COUNT; pad++) {
    const index = bank * MARKER_BANK + pad;
    if (index >= fl.markerTotal || !fl.markers.has(index)) {
      cells.push(undefined);
      continue;
    }
    // A marker whose time the script could not work out still has its name.
    const beats = markerBeats(fl, index);
    cells.push({
      tag: beats === undefined ? "Bar ?" : `Bar ${markerBar(beats)}`,
      name: markerName(fl, index),
      color: flColorToCss(markerColor(index)),
      current: index === current,
      queued: index === queued,
    });
  }
  drawPadGrid(ctx, rect, cells);
}

/** The notice that stands where the grid would be, without markers. */
export function drawNoMarkers(ctx: SKRSContext2D, rect: Rect): void {
  ctx.fillStyle = theme.dimText;
  ctx.font = font(20);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  drawWrapped(ctx, NO_MARKERS_TEXT, rect.x + 20, rect.y + 20, rect.width - 40, 28, 4);
}

// ── The shared page ────────────────────────────────────────────────────────

export abstract class MarkerPadsPage implements Mode {
  abstract readonly name: ModeName;
  protected bank = 0;
  /** After a jump of our own: the marker to show the bank of once FL reports it. */
  private following: number | undefined;

  enter(mc: ModeContext): void {
    this.following = undefined;
    this.bank = this.clampBank(markerBankOf(currentMarker(mc.fl)), mc.fl);
    mc.send({ type: "requestMarkers" });
  }

  onFlChange(section: string, mc: ModeContext): void {
    if (section === "markers") {
      const bank = this.clampBank(this.bank, mc.fl);
      if (bank !== this.bank) this.bank = bank;
    }
    if (section === "songPos" || section === "transport" || section === "markers") {
      if (this.following !== undefined && currentMarker(mc.fl) === this.following) {
        this.bank = this.clampBank(markerBankOf(this.following), mc.fl);
        this.following = undefined;
      }
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    switch (event.type) {
      case "pad":
        // Down acts; move and up are ours too, so no pad plays a note under the page. ERASE + pad
        // does nothing: FL's script cannot delete a marker.
        if (event.phase === "down" && !mc.erase) {
          const index = this.markerAt(event.pad, mc.fl);
          if (index !== undefined) this.padPressed(index, mc);
        }
        return true;
      case "button": {
        const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
        if (display < 0) return false;
        // Display buttons never reach a page underneath.
        if (!event.pressed) return true;
        if (display === PREVIOUS_BANK) this.setBank(this.bank - 1, mc);
        else if (display === NEXT_BANK) this.setBank(this.bank + 1, mc);
        else this.displayPressed(display, mc);
        return true;
      }
      default:
        return false;
    }
  }

  /** A pad over marker `index` went down. */
  protected abstract padPressed(index: number, mc: ModeContext): void;

  /** A display button (0–7) other than the bank buttons was pressed. */
  protected abstract displayPressed(display: number, mc: ModeContext): void;

  /** Jump to marker `index` and have the bank follow it when FL reports it. */
  protected jump(index: number, quantized: boolean, mc: ModeContext): void {
    this.following = index;
    mc.send({ type: "jumpMarker", index, quantized });
  }

  // ── Banks and pads ─────────────────────────────────────────────────────────

  protected clampBank(bank: number, fl: FlState): number {
    return Math.min(Math.max(0, bank), lastMarkerBank(fl));
  }

  protected setBank(wanted: number, mc: ModeContext): void {
    const bank = this.clampBank(wanted, mc.fl);
    if (bank === this.bank) return;
    this.bank = bank;
    mc.requestRender();
  }

  protected get bankBack(): boolean {
    return this.bank > 0;
  }

  protected bankForward(fl: FlState): boolean {
    return this.bank < lastMarkerBank(fl);
  }

  /** The marker under a pad, undefined past the last one or while FL has not sent it. */
  protected markerAt(pad: number, fl: FlState): number | undefined {
    const index = this.bank * MARKER_BANK + pad;
    return index < fl.markerTotal && fl.markers.has(index) ? index : undefined;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /** A marker with a jump waiting (SCENE), undefined by default. */
  protected queued(): number | undefined {
    return undefined;
  }

  /** How the pad over marker `index` is lit. */
  protected padVariant(index: number, current: number): LedVariant {
    return index === current ? "bright" : "dim";
  }

  /** The tabs of display 5 and 6 on the right screen; 7 and 8 are the bank buttons. */
  protected abstract rightTabs(mc: ModeContext): readonly [string, string];

  /** Draws the right screen's tab strip with the bank buttons, then clears the rest. */
  protected drawRightTabs(ctx: SKRSContext2D, mc: ModeContext): void {
    clear(ctx, FULL);
    const [five, six] = this.rightTabs(mc);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      {
        tabs: [five, six, this.bankBack ? "<<" : "", this.bankForward(mc.fl) ? ">>" : ""],
      },
    );
  }

  abstract render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void;

  leds(leds: LedState, mc: ModeContext): void {
    const { fl } = mc;
    const current = currentMarker(fl);
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const index = this.markerAt(pad, fl);
      leds.setPad(
        pad,
        index === undefined
          ? LED_OFF
          : flColorToPalette(markerColor(index), this.padVariant(index, current)),
      );
    }
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display7", this.bankBack ? "dim" : "off");
    leds.setLight("display8", this.bankForward(fl) ? "dim" : "off");
    this.displayLeds(leds, mc);
  }

  /** The LEDs of display 1–6. */
  protected abstract displayLeds(leds: LedState, mc: ModeContext): void;
}
