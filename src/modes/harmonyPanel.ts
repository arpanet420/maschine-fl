// The knobs of KEYBOARD (scale) and CHORDS (scale, chord mode, chord type, position): turning them
// changes PadState's HarmonySettings and saves the page state soon after; drawing them on the left
// screen's columns. The settings are saved by the CHORDS page (`pages.chords`).
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import { drawKnobRow, theme, type KnobProps } from "../render/widgets.js";
import { FULL } from "./draw.js";
import {
  CHORD_MODE_NAMES,
  CHORD_MODES,
  CHORD_TYPES,
  SCALES,
  type HarmonySettings,
} from "./chords.js";
import type { ModeContext } from "./mode.js";
import { realTimers, type RepeatTimers } from "./repeatScheduler.js";

/** The settings are written this long after the last knob turn. */
const SAVE_DELAY_MS = 400;
/** The knob row at the bottom of the left screen, over knobs 1–4. */
export const KNOB_ROW = { ...FULL, y: FULL.height - 110, height: 110 };

export class HarmonyPanel {
  private saveTimer: unknown;
  private mc: ModeContext | undefined;

  constructor(
    private readonly settings: HarmonySettings,
    /** How many knobs (from knob 1) the page uses. */
    private readonly knobs: number,
    private readonly timers: RepeatTimers = realTimers,
  ) {}

  /** A knob turn on one of the page's knobs. True = handled (the turn is ours, changed or not). */
  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type !== "encoder" || event.index >= this.knobs) return false;
    this.mc = mc;
    if (!this.settings.turn(event.index, event.delta)) return true;
    this.timers.clear(this.saveTimer);
    this.saveTimer = this.timers.set(() => {
      this.saveTimer = undefined;
      mc.saveState?.();
    }, SAVE_DELAY_MS);
    mc.requestRender();
    return true;
  }

  /** The page is left: write what is waiting to be saved. */
  leave(): void {
    if (this.saveTimer === undefined) return;
    this.timers.clear(this.saveTimer);
    this.saveTimer = undefined;
    this.mc?.saveState?.();
  }

  /** The page's knobs under their columns of the left screen. */
  draw(ctx: SKRSContext2D, mc: ModeContext): void {
    const s = this.settings;
    const touched = (knob: number) => mc.touchedKnobs.has(knob);
    const all: KnobProps[] = [
      {
        label: "Scale",
        valueText: SCALES[s.scale]?.name ?? "",
        value: s.scale / (SCALES.length - 1),
        touched: touched(0),
      },
      {
        label: "Chord mode",
        valueText: CHORD_MODE_NAMES[s.mode],
        value: CHORD_MODES.indexOf(s.mode),
        touched: touched(1),
      },
      s.typeActive
        ? {
            label: "Chord type",
            valueText: CHORD_TYPES[s.type]?.name ?? "",
            value: s.type / (CHORD_TYPES.length - 1),
            touched: touched(2),
          }
        : {
            label: "Chord type",
            valueText: "—",
            color: theme.knobRim,
            touched: touched(2),
          },
      {
        label: "Position",
        valueText: String(s.position),
        value: s.maxPosition > 0 ? s.position / s.maxPosition : 0,
        touched: touched(3),
      },
    ];
    drawKnobRow(ctx, KNOB_ROW, all.slice(0, this.knobs));
  }
}
