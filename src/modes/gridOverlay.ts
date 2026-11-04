// GRID overlay (hold SHIFT + FOLLOW; display button 1 is its pin tab). Pads 1–16 are FL's snap values
// (Maschine's grid page); a press sets that snap mode (SET_SNAP). The pad LEDs are white: the
// current snap bright, the others dim. Left screen: the current snap's name, big. Right screen: a
// 4×4 grid of the names that mirrors the pads, the ones that don't quantize dim.
//
// Display 2 is INPUT Q. FL has no switch of its own for input quantize: its Global Snap is the switch
// (FL's manual, recording_scores: Step, Beat or Bar quantize, Line, Cell or None don't). Off sets None
// and remembers the snap value, on brings it back.
//
// The pads belong to this page even while SHIFT is still held from opening it (`usesShiftPads`):
// the SHIFT + pad actions of the stack stay out of the way.
//
// NOT VERIFIED (docs/sysex.md): the numbers. The stub's `midi.Snap_*` lists Bar, Events and Markers
// with the same values as 1/6, 1/3 and 1/2 bar (14, 16, 17); mk3d uses 14, 16 and 17 for those three
// and leaves the bar fractions out. The manual doesn't name the step and beat fractions as quantizing
// or Events and Markers at all: `quantizes` counts the fractions and not those two, not tried in FL.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import { paletteWhite } from "../hw/palette.js";
import { TAB_HEIGHT, clear, drawTabs, fitText, font, theme } from "../render/widgets.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import type { Mode, ModeContext } from "./mode.js";
import { GRID_RECT, drawPadGrid, drawPinTab, type PadCell } from "./padGrid.js";

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

const SNAP_NONE = 3;
const SNAP_STEP = 8;

/** Whether FL quantizes recorded notes with this snap mode: the step, beat and bar values. */
export const quantizes = (mode: number): boolean => mode >= 4 && mode <= 14;

export class GridOverlay implements Mode {
  readonly name = "grid";

  /** The snap value INPUT Q brings back. */
  private lastQuantize = SNAP_STEP;

  readonly persisted = {
    save: () => ({ lastQuantize: this.lastQuantize }),
    load: (data: unknown) => {
      const saved = (data as { lastQuantize?: unknown } | null)?.lastQuantize;
      if (typeof saved === "number" && quantizes(saved)) this.lastQuantize = saved;
    },
  };

  enter(): void {
    // Nothing to ask FL for: UI_STATE reports the snap mode whenever it changes.
  }

  /** The pads are the snap values even while SHIFT is held. */
  usesShiftPads(): boolean {
    return true;
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    const snap = mc.fl.uiState.snap;
    if (quantizes(snap)) this.lastQuantize = snap;
    switch (event.type) {
      case "pad": {
        // Down sets the snap; move and up are ours too so no pad plays a note under the page.
        const value = event.phase === "down" ? SNAP_VALUES[event.pad] : undefined;
        if (value) mc.send({ type: "setSnap", mode: value.mode });
        return true;
      }
      case "button":
        if (event.id === "display2") {
          if (event.pressed) {
            mc.send({ type: "setSnap", mode: quantizes(snap) ? SNAP_NONE : this.lastQuantize });
          }
          return true;
        }
        // Display buttons never reach the page underneath.
        return DISPLAY_BUTTONS.some((id) => id === event.id);
      default:
        return false;
    }
  }

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const snap = mc.fl.uiState.snap;
    clear(left, FULL);
    drawTabs(
      left,
      { ...FULL, height: TAB_HEIGHT },
      {
        tabs: ["GRID", "INPUT Q"],
        active: [...(mc.pinned ? [0] : []), ...(quantizes(snap) ? [1] : [])],
      },
    );
    left.textAlign = "left";
    left.textBaseline = "top";
    left.fillStyle = theme.dimText;
    left.font = font(15);
    left.fillText("Snap", 24, 64);
    left.fillStyle = theme.accent;
    left.font = font(56, "bold");
    left.fillText(fitText(left, snapName(snap), FULL.width - 40), 22, 84);

    clear(right, FULL);
    drawPinTab(right, "", false);
    const cells: PadCell[] = SNAP_VALUES.map((value) => ({
      name: value.name,
      color: quantizes(value.mode) ? theme.text : theme.dimText,
      current: value.mode === snap,
    }));
    drawPadGrid(right, GRID_RECT, cells);
  }

  leds(leds: LedState, mc: ModeContext): void {
    const snap = mc.fl.uiState.snap;
    SNAP_VALUES.slice(0, PAD_COUNT).forEach((value, pad) => {
      leds.setPad(pad, paletteWhite(value.mode === snap ? "bright" : "dim"));
    });
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
    leds.setLight("display2", quantizes(snap) ? "bright" : "dim");
  }
}
