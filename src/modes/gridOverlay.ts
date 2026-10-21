// GRID overlay (hold SHIFT + FOLLOW; display button 1 is its pin tab). Pads 1–16 are FL's snap values
// (Maschine's grid page); a press sets that snap mode (SET_SNAP). The pad LEDs are white: the
// current snap bright, the others dim. Left screen: the current snap's name, big. Right screen: a
// 4×4 grid of the names that mirrors the pads.
//
// The pads belong to this page even while SHIFT is still held from opening it (`usesShiftPads`):
// the SHIFT + pad actions of the stack stay out of the way.
//
// NOT VERIFIED (docs/sysex.md): the numbers. The stub's `midi.Snap_*` lists Bar, Events and Markers
// with the same values as 1/6, 1/3 and 1/2 bar (14, 16, 17); mk3d uses 14, 16 and 17 for those three
// and leaves the bar fractions out.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import { paletteWhite } from "../hw/palette.js";
import { clear, fitText, font, theme } from "../render/widgets.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import type { Mode, ModeContext } from "./mode.js";
import { GRID_RECT, drawFooter, drawPadGrid, drawPinTab, type PadCell } from "./padGrid.js";

export interface SnapValue {
  /** FL's snap mode number (`midi.Snap_*`). */
  mode: number;
  name: string;
}

/** Pad 1 first (bottom-left); the grid on the right screen shows them the same way. */
export const SNAP_VALUES: readonly SnapValue[] = [
  { mode: 0, name: "Line" },
  { mode: 1, name: "Cell" },
  { mode: 3, name: "None" },
  { mode: 4, name: "1/6 step" },
  { mode: 5, name: "1/4 step" },
  { mode: 6, name: "1/3 step" },
  { mode: 7, name: "1/2 step" },
  { mode: 8, name: "Step" },
  { mode: 9, name: "1/6 beat" },
  { mode: 10, name: "1/4 beat" },
  { mode: 11, name: "1/3 beat" },
  { mode: 12, name: "1/2 beat" },
  { mode: 13, name: "Beat" },
  { mode: 14, name: "Bar" },
  { mode: 16, name: "Events" },
  { mode: 17, name: "Markers" },
];

/** The name of a snap mode; `Snap 15` for one that is not on the pads. */
export const snapName = (mode: number): string =>
  SNAP_VALUES.find((value) => value.mode === mode)?.name ?? `Snap ${mode}`;

export class GridOverlay implements Mode {
  readonly name = "grid";

  enter(): void {
    // Nothing to ask FL for: UI_STATE reports the snap mode whenever it changes.
  }

  /** The pads are the snap values even while SHIFT is held. */
  usesShiftPads(): boolean {
    return true;
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    switch (event.type) {
      case "pad": {
        // Down sets the snap; move and up are ours too so no pad plays a note under the page.
        const value = event.phase === "down" ? SNAP_VALUES[event.pad] : undefined;
        if (value) mc.send({ type: "setSnap", mode: value.mode });
        return true;
      }
      case "button":
        // Display buttons never reach the page underneath.
        return DISPLAY_BUTTONS.some((id) => id === event.id);
      default:
        return false;
    }
  }

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const snap = mc.fl.uiState.snap;
    clear(left, FULL);
    drawPinTab(left, "GRID", mc.pinned ?? false);
    left.textAlign = "left";
    left.textBaseline = "top";
    left.fillStyle = theme.dimText;
    left.font = font(15);
    left.fillText("Snap", 24, 64);
    left.fillStyle = theme.accent;
    left.font = font(56, "bold");
    left.fillText(fitText(left, snapName(snap), FULL.width - 40), 22, 84);
    left.fillStyle = theme.dimText;
    left.font = font(15);
    left.fillText("FL's grid: the pads pick the snap", 24, 168);

    clear(right, FULL);
    drawPinTab(right, "", false);
    const cells: PadCell[] = SNAP_VALUES.map((value) => ({
      name: value.name,
      color: theme.text,
      current: value.mode === snap,
    }));
    drawPadGrid(right, GRID_RECT, cells);
    drawFooter(right, `snap ${snap}`);
  }

  leds(leds: LedState, mc: ModeContext): void {
    const snap = mc.fl.uiState.snap;
    SNAP_VALUES.slice(0, PAD_COUNT).forEach((value, pad) => {
      leds.setPad(pad, paletteWhite(value.mode === snap ? "bright" : "dim"));
    });
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
  }
}
