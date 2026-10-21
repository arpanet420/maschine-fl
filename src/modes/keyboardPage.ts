// KEYBOARD page (a tool page: KEYBOARD opens it, KEYBOARD again leaves it; the pad mode is set by
// the press, or by SHIFT + KEYBOARD without the page). The pads play notes on the selected channel
// (the global pad handler in main.ts does that: this page takes no pad and leaves the pad LEDs to
// it). Display buttons 5–8 move the base note: OCT- OCT+ SEMI- SEMI+. GROUP A–H pick the channel
// bank. Knob 1 picks the scale (src/modes/chords.ts): the pads then play its degrees from the base
// note and the root pads are brighter. The CHORDS page (chordsPage.ts) is this page with chords.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import { TAB_HEIGHT, clear, drawTabs, fitText, font, theme } from "../render/widgets.js";
import { groupBank, setBankLeds } from "./channelBank.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { CHROMATIC, SCALES, pitchName } from "./chords.js";
import { FULL } from "./draw.js";
import { flColorToCss } from "./format.js";
import { HarmonyPanel } from "./harmonyPanel.js";
import type { Mode, ModeContext, ModeName } from "./mode.js";
import { GRID_RECT, drawFooter, drawPadGrid, type PadCell } from "./padGrid.js";
import { MAX_BASE_NOTE, noteName, type PadState } from "./padState.js";
import type { RepeatTimers } from "./repeatScheduler.js";

/** Semitones each of display buttons 5–8 moves the base note by. */
const STEPS = [-12, 12, -1, 1] as const;
const LABELS = ["OCT-", "OCT+", "SEMI-", "SEMI+"] as const;
const FIRST_STEP_BUTTON = 4;

export interface KeyboardOptions {
  timers?: RepeatTimers;
}

export class KeyboardPage implements Mode {
  readonly name: ModeName = "keyboard";
  /** Knob 1 = scale; CHORDS has four knobs. */
  protected readonly panel: HarmonyPanel;
  /** The tab on display 1. */
  protected readonly tab: string = "KEYBOARD";

  constructor(
    protected readonly pads: PadState,
    options: KeyboardOptions = {},
    knobs = 1,
  ) {
    this.panel = new HarmonyPanel(pads.harmony, knobs, options.timers);
  }

  enter(): void {
    // The page needs nothing from FL beyond the selected channel.
  }

  leave(): void {
    this.panel.leave();
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type === "encoder") return this.panel.onEvent(event, mc);
    if (event.type !== "button") return false; // pads play notes; knobs and the rest fall through
    const bank = groupBank(event.id);
    if (bank !== undefined) {
      if (event.pressed) this.pads.selectBank(bank, mc);
      return true;
    }
    const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
    if (display < 0) return false;
    const step = STEPS[display - FIRST_STEP_BUTTON];
    if (event.pressed && step !== undefined && this.pads.shiftBase(step)) mc.requestRender();
    return true;
  }

  /** Is a step in this direction possible from the base note now? */
  private possible(step: number): boolean {
    const base = this.pads.baseNote;
    return step < 0 ? base > 0 : base < MAX_BASE_NOTE;
  }

  /** `C Minor`, or `Chromatic` (no root without a scale). */
  protected scaleText(): string {
    const { scale } = this.pads.harmony;
    const name = SCALES[scale]?.name ?? "";
    return scale === CHROMATIC ? name : `${pitchName(this.pads.baseNote)} ${name}`;
  }

  /** The text on the pad's grid cell. */
  protected cellName(pad: number): string {
    return noteName(this.pads.keyNote(pad));
  }

  protected footer(): string {
    const last = this.pads.keyNote(PAD_COUNT - 1);
    return `MIDI ${this.pads.keyNote(0)}–${last}`;
  }

  /** The left screen over the knob row: the channel and what the pads play. */
  protected renderLeft(ctx: SKRSContext2D, mc: ModeContext, color: string): void {
    const selected = mc.fl.selectedChannel;
    const top = TAB_HEIGHT + 8;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    if (selected.index !== null) {
      ctx.fillStyle = color;
      ctx.fillRect(14, top, 6, 44);
      ctx.fillStyle = theme.dimText;
      ctx.font = font(13);
      ctx.fillText(`Channel ${selected.index + 1}`, 34, top - 2);
      ctx.fillStyle = theme.text;
      ctx.font = font(22, "bold");
      ctx.fillText(fitText(ctx, selected.name, FULL.width - 50), 34, top + 14);
    } else {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(20);
      ctx.fillText("No channel", 34, top);
    }
    const first = this.pads.keyNote(0);
    const last = this.pads.keyNote(PAD_COUNT - 1);
    const y = top + 56;
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13);
    ctx.fillText("Range", 34, y);
    ctx.fillText("Scale", 250, y);
    ctx.fillStyle = theme.accent;
    ctx.font = font(30, "bold");
    ctx.fillText(`${noteName(first)}–${noteName(last)}`, 32, y + 14);
    ctx.fillText(fitText(ctx, this.scaleText(), FULL.width - 250 - 10), 248, y + 14);
  }

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const selected = mc.fl.selectedChannel;
    const color = selected.index === null ? theme.accent : flColorToCss(selected.color);

    clear(left, FULL);
    drawTabs(left, { ...FULL, height: TAB_HEIGHT }, { tabs: [this.tab], active: [0] });
    this.renderLeft(left, mc, color);
    this.panel.draw(left, mc);

    clear(right, FULL);
    drawTabs(
      right,
      { ...FULL, height: TAB_HEIGHT },
      { tabs: LABELS.map((label, i) => (this.possible(STEPS[i] ?? 0) ? label : "")) },
    );
    const cells: PadCell[] = [];
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      cells.push({ name: this.cellName(pad), color, marked: this.pads.isRootPad(pad) });
    }
    drawPadGrid(right, GRID_RECT, cells);
    drawFooter(right, this.footer());
  }

  leds(leds: LedState, mc: ModeContext): void {
    setBankLeds(leds, mc.fl);
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display1", "bright"); // a tool page is always latched
    LABELS.forEach((_, i) => {
      const id = DISPLAY_BUTTONS[FIRST_STEP_BUTTON + i];
      if (id) leds.setLight(id, this.possible(STEPS[i] ?? 0) ? "dim" : "off");
    });
  }
}
