// PATTERN overlay (hold PATTERN; display button 1 is its pin tab). Pads 1–16 are the patterns of
// the current bank of 16, a pad press selects that pattern; display buttons 7 and 8 (the right
// screen's columns 3 and 4) page between the banks. Display 3 `DOUBLE` doubles the current pattern
// (twice the length, the grid steps copied into the new half; piano roll notes cannot be read by a
// script, so they are not), display 4 `DUPLICATE` clones it and display 5 `CREATE` makes a new empty
// one; FL selects the new pattern and the overlay turns to its bank. FL's API has no pattern delete,
// so there is no DELETE. A pad with no pattern behind it (shown as `+`, dim white) creates that
// pattern and selects it; ERASE + pad and DUPLICATE keep their meaning.
//
// Knobs (Maschine's pattern page, PatternPageStudioPattern.lua; FL has no pattern position or start
// offset, so its knobs 2 and 3 are empty): knob 1 = the pattern's COLOR, cycling a dozen colours
// (SET_PATTERN_COLOR, `patterns.setPatternColor`), knob 4 = LENGTH of the current pattern, one detent
// = the next common length (16, 32, 64 … 512 steps = 1, 2, 4 … 32 bars), SHIFT = 1 step, 1 … 512
// steps (SET_PATTERN_LENGTH, `patterns.setPatternLength`, in steps; the script answers with a PROBE
// line that shows what FL read back). One page; the arrow buttons are not ours. Our own value wins
// over FL's for PENDING_MS after a turn so FL answering cannot make it jump.
//
// `PatternBankPage` is the part shared with the DUPLICATE overlay: the bank of 16 patterns on the
// pads and the screens; a subclass says what a pad press does and what the extra buttons are.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import type { ButtonId } from "../hw/ids.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import { LED_OFF, paletteWhite } from "../hw/palette.js";
import {
  TAB_HEIGHT,
  clear,
  drawKnobRow,
  drawTabs,
  fitText,
  font,
  theme,
  type KnobProps,
} from "../render/widgets.js";
import type { FlState } from "../fl/flState.js";
import {
  COMMON_PATTERN_LENGTHS,
  MAX_LENGTH_PATTERN,
  MAX_PATTERN_LENGTH_STEPS,
} from "../fl/protocol.js";
import { FULL } from "./draw.js";
import { flColorToCss, flColorToPalette, lengthText } from "./format.js";
import { isLive, type PendingValue } from "./knob.js";
import type { Mode, ModeContext, ModeName, ViewCommand } from "./mode.js";
import { GRID_RECT, drawFooter, drawPadGrid, windowText, type PadCell } from "./padGrid.js";

const BANK = PAD_COUNT;
const DISPLAY_BUTTONS: readonly ButtonId[] = [
  "display1",
  "display2",
  "display3",
  "display4",
  "display5",
  "display6",
  "display7",
  "display8",
];
const PREVIOUS = 6;
const NEXT = 7;
/** Display 3, 4 and 5 (0-based 2, 3 and 4) in the PATTERN overlay. */
const DOUBLE_BUTTON = 2;
const DUPLICATE_BUTTON = 3;
const CREATE_BUTTON = 4;
/** How long the DOUBLE read-out card stays up. */
const READOUT_MS = 4000;

/** Knob counts that make one detent (a turn is 1000 counts). */
const DETENT_COUNTS = 120;
/** The knobs sit under the left screen: knob 1 = COLOR, knob 4 = LENGTH. */
const LENGTH_KNOB = 3;
const COLOR_KNOB = 0;
const KNOB_ROW = { ...FULL, y: FULL.height - 100, height: 100 };

/** The colours knob 1 cycles through (`0xRRGGBB`), around FL's own step and channel colours. */
export const PATTERN_COLORS: ReadonlyArray<{ name: string; color: number }> = [
  { name: "Red", color: 0xe0505a },
  { name: "Orange", color: 0xfb9244 },
  { name: "Yellow", color: 0xeec54e },
  { name: "Lime", color: 0xa0dc40 },
  { name: "Mint", color: 0x4ae4a8 },
  { name: "Cyan", color: 0x4ac8e0 },
  { name: "Blue", color: 0x5aa9e6 },
  { name: "Indigo", color: 0x7a7ae6 },
  { name: "Purple", color: 0xa678de },
  { name: "Magenta", color: 0xd070c8 },
  { name: "Pink", color: 0xe0707a },
  { name: "Grey", color: 0x9aa3aa },
];

/**
 * The length one detent away: the next common length up (or the previous one down), also from a
 * length that is not on the list; with nothing further in that direction the length stays.
 */
export function stepCommonLength(length: number, detents: number): number {
  let now = length;
  for (let i = 0; i < Math.abs(detents); i++) {
    const lengths = COMMON_PATTERN_LENGTHS;
    const next =
      detents > 0 ? lengths.find((l) => l > now) : [...lengths].reverse().find((l) => l < now);
    if (next === undefined) break;
    now = next;
  }
  return now;
}

/** 0 … 1 on a log scale from the shortest common length to the longest. */
const lengthGauge = (length: number): number => {
  const first = COMMON_PATTERN_LENGTHS[0] ?? 16;
  const octaves = Math.log2(MAX_PATTERN_LENGTH_STEPS / first);
  return Math.min(1, Math.max(0, Math.log2(Math.max(length, first) / first) / octaves));
};

const patternName = (fl: FlState, index: number): string =>
  fl.patterns.get(index)?.name || `Pattern ${index + 1}`;

export abstract class PatternBankPage implements Mode {
  abstract readonly name: ModeName;
  private bank = 0;
  /** After a clone or create: the pattern number then, until FL selects another one. */
  private followFrom: number | undefined;

  /** The pin tab on display 1. */
  protected abstract readonly pinLabel: string;

  enter(mc: ModeContext): void {
    const current = mc.fl.pattern.number;
    this.bank = this.clampBank(current > 0 ? Math.floor((current - 1) / BANK) : 0, mc.fl);
    this.sendView(mc);
  }

  /** The pattern window FL reports follows the bank. */
  viewPatch(): Partial<ViewCommand> {
    return { patternOffset: this.bank * BANK };
  }

  onFlChange(section: string, mc: ModeContext): void {
    if (section !== "patterns" && section !== "pattern") return;
    const { fl } = mc;
    // A new pattern was made and FL selected it: show its bank, even before the count has caught up.
    if (this.followFrom !== undefined && fl.pattern.number !== this.followFrom) {
      this.followFrom = undefined;
      const bank = Math.floor((fl.pattern.number - 1) / BANK);
      if (fl.pattern.number > 0 && bank !== this.bank) {
        this.setBank(bank, mc, true);
        return;
      }
    }
    // The pattern count can shrink under us.
    if (section !== "patterns") return;
    const bank = this.clampBank(this.bank, fl);
    if (bank !== this.bank) this.setBank(bank, mc);
  }

  /** Remember that a new pattern is on its way, so the bank follows it. */
  protected followNewPattern(mc: ModeContext): void {
    this.followFrom = mc.fl.pattern.number;
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (this.extraEvent?.(event, mc)) return true;
    switch (event.type) {
      case "pad":
        // Down selects; move and up are ours too so no pad ever plays a note under the overlay.
        if (event.phase === "down") this.selectPad(event.pad, mc);
        return true;
      case "button": {
        const display = DISPLAY_BUTTONS.indexOf(event.id);
        if (display < 0) return false;
        if (event.pressed && display === PREVIOUS) this.setBank(this.bank - 1, mc);
        if (event.pressed && display === NEXT) this.setBank(this.bank + 1, mc);
        if (event.pressed) this.displayPressed?.(display, mc);
        return true;
      }
      default:
        return false;
    }
  }

  // ── Banks and pads ─────────────────────────────────────────────────────────

  private lastBank(fl: FlState): number {
    return Math.max(0, Math.floor((fl.patternCount - 1) / BANK));
  }

  private clampBank(bank: number, fl: FlState): number {
    return Math.min(Math.max(0, bank), this.lastBank(fl));
  }

  private setBank(wanted: number, mc: ModeContext, unclamped = false): void {
    const bank = unclamped ? Math.max(0, wanted) : this.clampBank(wanted, mc.fl);
    if (bank === this.bank) return;
    this.bank = bank;
    this.sendView(mc);
    mc.requestRender();
  }

  private sendView(mc: ModeContext): void {
    const base = mc.baseView?.();
    if (base) mc.send({ ...base, ...this.viewPatch() });
  }

  /** Pattern index (0-based) behind a pad, undefined past the last pattern. */
  private patternOf(pad: number, fl: FlState): number | undefined {
    const index = this.bank * BANK + pad;
    return index < fl.patternCount ? index : undefined;
  }

  private selectPad(pad: number, mc: ModeContext): void {
    const index = this.patternOf(pad, mc.fl);
    if (index !== undefined) this.padPressed(index + 1, mc);
    else if (this.emptyPadPressed && !mc.erase)
      this.emptyPadPressed(this.bank * BANK + pad + 1, mc);
  }

  /** A pad with no pattern behind it went down (pattern `number`, 1-based). Absent = the pad does nothing. */
  protected emptyPadPressed?(number: number, mc: ModeContext): void;

  /** A pad over pattern `number` (1-based) went down. */
  protected abstract padPressed(number: number, mc: ModeContext): void;

  /** A display button (0–7 for display 1–8) was pressed, after the bank buttons were handled. */
  protected displayPressed?(display: number, mc: ModeContext): void;

  /** Labels of display 2–4 (left screen) and 5–6 (right screen), blank = none. */
  protected leftTabs(): readonly string[] {
    return [];
  }
  /** Indexes into the left screen's tabs (0 = the pin tab) whose button does nothing right now. */
  protected disabledLeftTabs?(mc: ModeContext): readonly number[];
  /** Lines of a read-out card that replaces the pattern info on the left screen while it is up. */
  protected readout?(mc: ModeContext): readonly string[] | undefined;
  protected rightTabs(): readonly string[] {
    return [];
  }
  /** Extra text under the pattern's length on the left screen. */
  protected hint?(mc: ModeContext): string;
  /** Knobs, arrows and the like, before the pads and display buttons. True = handled. */
  protected extraEvent?(event: HwEvent, mc: ModeContext): boolean;
  /** The knob row under the left screen (the page then draws more compactly); none = no knobs. */
  protected knobRow?(mc: ModeContext): ReadonlyArray<KnobProps | undefined>;
  /** The colour of the left screen's colour bar (the pending one while a turn waits for FL). */
  protected displayColor?(mc: ModeContext): number;

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    this.renderLeft(left, mc);
    this.renderRight(right, mc);
  }

  private renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { pattern } = mc.fl;
    clear(ctx, FULL);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      {
        tabs: [this.pinLabel, ...this.leftTabs()],
        active: mc.pinned ? [0] : [],
        disabled: this.disabledLeftTabs?.(mc),
      },
    );
    const card = this.readout?.(mc);
    if (card) {
      this.renderCard(ctx, card);
      const knobRow = this.knobRow?.(mc);
      if (knobRow) drawKnobRow(ctx, KNOB_ROW, knobRow);
      return;
    }
    if (pattern.number <= 0) {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(20);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No pattern", FULL.width / 2, 120);
      return;
    }
    const knobs = this.knobRow?.(mc);
    const top = knobs ? TAB_HEIGHT + 10 : TAB_HEIGHT + 22;
    const size = knobs ? 54 : 72;
    ctx.fillStyle = flColorToCss(this.displayColor?.(mc) ?? pattern.color);
    ctx.fillRect(14, top, 6, knobs ? 112 : 138);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText("Pattern", 34, top);
    ctx.fillStyle = theme.accent;
    ctx.font = font(size, "bold");
    ctx.fillText(String(pattern.number), 32, top + (knobs ? 10 : 14));
    ctx.fillStyle = theme.text;
    ctx.font = font(knobs ? 26 : 30, "bold");
    ctx.fillText(
      fitText(ctx, pattern.name || `Pattern ${pattern.number}`, FULL.width - 50),
      34,
      top + (knobs ? 66 : 92),
    );
    ctx.fillStyle = theme.dimText;
    ctx.font = font(knobs ? 15 : 17);
    ctx.fillText(`${pattern.length} steps`, 34, top + (knobs ? 98 : 130));
    const hint = this.hint?.(mc);
    if (hint) {
      ctx.fillStyle = theme.accent;
      ctx.font = font(knobs ? 15 : 17);
      ctx.fillText(fitText(ctx, hint, FULL.width - 50), 34, top + (knobs ? 120 : 160));
    }
    if (knobs) drawKnobRow(ctx, KNOB_ROW, knobs);
  }

  /** The read-out card: a title, a result line and a small note. */
  private renderCard(ctx: SKRSContext2D, lines: readonly string[]): void {
    ctx.fillStyle = theme.accent;
    ctx.fillRect(14, TAB_HEIGHT + 16, 6, 118);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const styles: Array<[number, "bold" | "normal", string, number]> = [
      [30, "bold", theme.accent, 0],
      [24, "bold", theme.text, 48],
      [14, "normal", theme.dimText, 92],
    ];
    lines.slice(0, 3).forEach((line, i) => {
      const [size, weight, color, dy] = styles[i] ?? styles[2]!;
      ctx.fillStyle = color;
      ctx.font = font(size, weight);
      ctx.fillText(fitText(ctx, line, FULL.width - 50), 34, TAB_HEIGHT + 20 + dy);
    });
  }

  private renderRight(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    clear(ctx, FULL);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      {
        tabs: [
          this.rightTabs()[0] ?? "",
          this.rightTabs()[1] ?? "",
          this.bank > 0 ? "<<" : "",
          this.bank < this.lastBank(fl) ? ">>" : "",
        ],
      },
    );
    const cells: Array<PadCell | undefined> = [];
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const index = this.patternOf(pad, fl);
      if (index === undefined) {
        // A free slot a press fills (PATTERN overlay), else nothing.
        cells.push(
          this.emptyPadPressed
            ? { number: this.bank * BANK + pad + 1, name: "+", color: theme.line }
            : undefined,
        );
        continue;
      }
      const entry = fl.patterns.get(index);
      cells.push({
        number: index + 1,
        name: patternName(fl, index),
        color: entry ? flColorToCss(entry.color) : theme.accent,
        current: index + 1 === fl.pattern.number,
      });
    }
    drawPadGrid(ctx, GRID_RECT, cells);
    const shown = Math.min(BANK, Math.max(0, fl.patternCount - this.bank * BANK));
    drawFooter(ctx, windowText(this.bank * BANK, shown, fl.patternCount));
  }

  leds(leds: LedState, mc: ModeContext): void {
    const { fl } = mc;
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const index = this.patternOf(pad, fl);
      if (index === undefined) {
        leds.setPad(pad, this.emptyPadPressed ? paletteWhite("dim") : LED_OFF);
        continue;
      }
      const entry = fl.patterns.get(index);
      const current = index + 1 === fl.pattern.number;
      leds.setPad(pad, flColorToPalette(entry?.color ?? 0, current ? "bright" : "dim"));
    }
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
    const tabs = [...this.leftTabs(), ...Array<string>(3).fill("")].slice(0, 3);
    const rightTabs = this.rightTabs();
    const labelled = [...tabs, rightTabs[0] ?? "", rightTabs[1] ?? ""];
    const disabled = this.disabledLeftTabs?.(mc) ?? [];
    (["display2", "display3", "display4", "display5", "display6"] as const).forEach((id, i) => {
      leds.setLight(id, labelled[i] && !disabled.includes(i + 1) ? "dim" : "off");
    });
    leds.setLight("display7", this.bank > 0 ? "dim" : "off");
    leds.setLight("display8", this.bank < this.lastBank(fl) ? "dim" : "off");
  }
}

export interface PatternOverlayOptions {
  /** Milliseconds; `performance.now()` by default. */
  clock?: () => number;
}

export class PatternOverlay extends PatternBankPage {
  readonly name = "pattern";
  protected readonly pinLabel = "PATTERN";
  private readonly turns = [0, 0, 0, 0];
  private pendingLength: PendingValue<number> | undefined;
  private pendingColor: PendingValue<number> | undefined;
  /** The last DOUBLE: the pattern, its length before and after, and when. */
  private doubled: { pattern: number; from: number; to: number; at: number } | undefined;
  private readonly clock: () => number;

  constructor(options: PatternOverlayOptions = {}) {
    super();
    this.clock = options.clock ?? (() => performance.now());
  }

  protected padPressed(number: number, mc: ModeContext): void {
    mc.send({ type: "selectPattern", number });
  }

  protected emptyPadPressed(number: number, mc: ModeContext): void {
    this.followNewPattern(mc);
    mc.send({ type: "createPattern", number });
  }

  protected displayPressed(display: number, mc: ModeContext): void {
    if (display === DOUBLE_BUTTON) {
      this.doublePattern(mc);
    } else if (display === DUPLICATE_BUTTON) {
      const number = mc.fl.pattern.number;
      if (number <= 0) return;
      this.followNewPattern(mc);
      mc.send({ type: "clonePattern", number });
    } else if (display === CREATE_BUTTON) {
      this.followNewPattern(mc);
      mc.send({ type: "newPattern" });
    }
  }

  protected leftTabs(): readonly string[] {
    return ["", "DOUBLE", "DUPLICATE"];
  }

  /** DOUBLE does nothing without a pattern the length of which can be set, or at the longest length. */
  private canDouble(mc: ModeContext): boolean {
    return this.canResize(mc) && this.length(mc) * 2 <= MAX_PATTERN_LENGTH_STEPS;
  }

  protected disabledLeftTabs(mc: ModeContext): readonly number[] {
    return this.canDouble(mc) ? [] : [2];
  }

  private doublePattern(mc: ModeContext): void {
    if (!this.canDouble(mc)) return;
    const from = this.length(mc);
    const pattern = mc.fl.pattern.number;
    this.doubled = { pattern, from, to: from * 2, at: this.clock() };
    this.pendingLength = { value: from * 2, at: this.clock() };
    // The FL script uses FL's own (hidden) patterns.duplicatePatternData, which copies every note,
    // and falls back to copying the steps where it is missing.
    mc.send({ type: "doublePattern", pattern });
    mc.requestRender();
  }

  protected readout(mc: ModeContext): readonly string[] | undefined {
    const done = this.doubled;
    if (!done || this.clock() - done.at >= READOUT_MS || done.pattern !== mc.fl.pattern.number)
      return undefined;
    return ["DOUBLE", `${done.from} -> ${done.to} steps`, "notes copied"];
  }

  protected rightTabs(): readonly string[] {
    return ["CREATE"];
  }

  // ── Knobs ──────────────────────────────────────────────────────────────────

  enter(mc: ModeContext): void {
    this.turns.fill(0);
    super.enter(mc);
  }

  /** The length shown: ours for a moment after a turn, else FL's. */
  private length(mc: ModeContext): number {
    const pending = this.pendingLength;
    return isLive(pending, this.clock()) && pending ? pending.value : mc.fl.pattern.length;
  }

  /** The pattern's colour shown: ours for a moment after a turn, else FL's. */
  private color(mc: ModeContext): number {
    const pending = this.pendingColor;
    return isLive(pending, this.clock()) && pending ? pending.value : mc.fl.pattern.color;
  }

  /** Can the length be set? Not without the function in FL, and not for patterns 128 and up. */
  private canResize(mc: ModeContext): boolean {
    const { number } = mc.fl.pattern;
    return !mc.fl.missing.patternLength && number >= 1 && number <= MAX_LENGTH_PATTERN;
  }

  protected extraEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type !== "encoder") return false;
    if (event.index === LENGTH_KNOB) {
      const detents = this.detents(LENGTH_KNOB, event.delta);
      if (detents !== 0) this.changeLength(detents, mc);
      return true;
    }
    if (event.index === COLOR_KNOB) {
      const detents = this.detents(COLOR_KNOB, event.delta);
      if (detents !== 0) this.changeColor(detents, mc);
      return true;
    }
    return false;
  }

  private detents(knob: number, delta: number): number {
    const total = (this.turns[knob] ?? 0) + delta;
    const detents = Math.trunc(total / DETENT_COUNTS);
    this.turns[knob] = total - detents * DETENT_COUNTS;
    return detents;
  }

  private changeLength(detents: number, mc: ModeContext): void {
    if (!this.canResize(mc)) return;
    const now = this.length(mc);
    const length = mc.shift
      ? Math.min(MAX_PATTERN_LENGTH_STEPS, Math.max(1, now + detents))
      : stepCommonLength(now, detents);
    if (length === now) return;
    this.pendingLength = { value: length, at: this.clock() };
    mc.send({ type: "setPatternLength", pattern: mc.fl.pattern.number, length });
    mc.requestRender();
  }

  private changeColor(detents: number, mc: ModeContext): void {
    const { number } = mc.fl.pattern;
    if (number <= 0) return;
    const now = this.color(mc) & 0xffffff;
    const at = PATTERN_COLORS.findIndex((c) => c.color === now);
    const size = PATTERN_COLORS.length;
    // A colour that is not on the list starts the cycle at its first entry.
    const next = at < 0 ? (detents > 0 ? detents - 1 : size + detents) : at + detents;
    const color = PATTERN_COLORS[((next % size) + size) % size]?.color ?? now;
    this.pendingColor = { value: color, at: this.clock() };
    mc.send({ type: "setPatternColor", pattern: number, color });
    mc.requestRender();
  }

  protected knobRow(mc: ModeContext): ReadonlyArray<KnobProps | undefined> {
    const touched = (knob: number) => mc.touchedKnobs.has(knob);
    const now = this.color(mc) & 0xffffff;
    const entry = PATTERN_COLORS.find((c) => c.color === now);
    const length = this.length(mc);
    const knobs: Array<KnobProps | undefined> = [undefined, undefined, undefined, undefined];
    knobs[COLOR_KNOB] = {
      label: "COLOR",
      valueText: entry?.name ?? "Custom",
      value: entry ? PATTERN_COLORS.indexOf(entry) / (PATTERN_COLORS.length - 1) : 0,
      color: flColorToCss(now),
      touched: touched(COLOR_KNOB),
    };
    knobs[LENGTH_KNOB] = {
      label: "LENGTH",
      valueText: mc.fl.missing.patternLength ? "n/a" : lengthText(length),
      value: mc.fl.missing.patternLength ? undefined : lengthGauge(length),
      touched: touched(LENGTH_KNOB),
    };
    return knobs;
  }

  protected displayColor(mc: ModeContext): number {
    return this.color(mc);
  }

  protected hint(mc: ModeContext): string {
    if (mc.fl.missing.patternLength) return "Not available in this FL version";
    if (mc.fl.pattern.number > MAX_LENGTH_PATTERN) return "Patterns from 128 up cannot be resized";
    return "";
  }
}
