// LOOP overlay (hold SHIFT + RESTART about 400 ms; display button 1 is its pin tab `LOOP`). The song
// loop range is FL's playlist time selection (`arrangement.selectionSet`, hidden: docs/fl-ilmcp.md).
// Maschine's loop page: knob 1 = the loop's start in bars (the loop moves, its length stays), knob 2 =
// its length in bars (SHIFT = steps on both), the 4D encoder moves the whole loop by a bar (SHIFT = a
// step) and tilt ◀ ▶ picks the start or the end for the turn (a second tilt the same way gives the
// whole loop back). Display 2 `ON`/`OFF` toggles the loop, display 3 `CLEAR` clears it and forgets the
// remembered range. The pads are the markers, as in SCENE (markerPage.ts): a pad sets the loop to that
// marker's section (up to the next marker, or four bars for the last one).
//
// A tap on SHIFT + RESTART (the page stack calls `tap`) toggles the loop without opening the page: off
// = `selectionClear`, on = the remembered range, which is the last loop mk3d set or saw switched off,
// else the current marker's section when there are markers, else the first four bars. The range is
// saved with the page stack's state. RESTART's LED is bright while FL says a loop is active.
//
// Positions are kept in steps (16th notes, 4 beats a bar) from bar 1 and sent as ticks (`fl.ppq`
// ticks a beat). NOT VERIFIED (docs/fl-ilmcp.md): that `selectionSet` takes absolute ticks; the
// script's PROBE line after each set (`selectionSet(0, 1536) -> active=1 start=0 end=1536`) shows it.
// Our own values win over FL's for PENDING_MS after each change, so FL answering cannot make them jump.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlSection, FlState } from "../fl/flState.js";
import { MAX_LOOP_TICKS } from "../fl/protocol.js";
import type { HwEvent } from "../hw/events.js";
import type { LedState } from "../hw/leds.js";
import type { LedVariant } from "../hw/palette.js";
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
import type { Rect } from "../hw/display.js";
import { FULL } from "./draw.js";
import { STEPS_PER_BAR, lengthText, positionStepsText } from "./format.js";
import { PENDING_MS, clamp } from "./knob.js";
import {
  MarkerPadsPage,
  currentMarker,
  drawMarkerGrid,
  markerBeats,
  markerWindowText,
} from "./markerPage.js";
import type { ModeContext } from "./mode.js";
import { GRID_RECT, drawFooter } from "./padGrid.js";
import { realTimers, type RepeatTimers } from "./repeatScheduler.js";

/** Knob counts that make one detent (a turn is 1000 counts). */
const DETENT_COUNTS = 120;
const ON_OFF_BUTTON = 1;
const CLEAR_BUTTON = 2;
/** The loop at least this long, in steps. */
const MIN_STEPS = 1;
/** The longest loop and the furthest start: 256 bars. */
const MAX_STEPS = 256 * STEPS_PER_BAR;
/** The default range without markers, and the last marker's section: four bars. */
const DEFAULT_STEPS = 4 * STEPS_PER_BAR;
const SAVE_DELAY_MS = 400;
const KNOB_ROW: Rect = { ...FULL, y: FULL.height - 110, height: 110 };
const RULER: Rect = { x: 14, y: TAB_HEIGHT + 34, width: FULL.width - 28, height: 118 };

/** A loop range in steps from bar 1, end exclusive. */
export interface StepRange {
  start: number;
  end: number;
}

/** What the loop is for knobs, 4D and the screens: FL's, or ours while it has not answered yet. */
interface Shown extends StepRange {
  active: boolean;
}

export interface LoopOptions {
  clock?: () => number;
  timers?: RepeatTimers;
}

type Boundary = "both" | "start" | "end";

export class LoopOverlay extends MarkerPadsPage {
  readonly name = "loop";
  /** The range switched on again by SHIFT + tap RESTART; undefined = the default until one is set. */
  private range: StepRange | undefined;
  private pending: (Shown & { at: number }) | undefined;
  private boundary: Boundary = "both";
  private readonly turns = [0, 0];
  private saveTimer: unknown;
  private mc: ModeContext | undefined;
  private readonly clock: () => number;
  private readonly timers: RepeatTimers;

  constructor(options: LoopOptions = {}) {
    super();
    this.clock = options.clock ?? (() => performance.now());
    this.timers = options.timers ?? realTimers;
  }

  readonly persisted = {
    save: () => (this.range ? { start: this.range.start, end: this.range.end } : {}),
    load: (data: unknown) => {
      const saved = data as { start?: unknown; end?: unknown } | null;
      const { start, end } = saved ?? {};
      if (typeof start === "number" && typeof end === "number" && Number.isFinite(start + end)) {
        this.range = sanitize(start, end);
      }
    },
  };

  /** The pads are the markers even while SHIFT is still held from opening the page. */
  usesShiftPads(): boolean {
    return true;
  }

  // ── The loop, in steps ─────────────────────────────────────────────────────

  private stepsOf(ticks: number, fl: FlState): number {
    return (ticks / fl.ppq) * (STEPS_PER_BAR / 4);
  }

  private ticksOf(steps: number, fl: FlState): number {
    return Math.round((steps * fl.ppq) / (STEPS_PER_BAR / 4));
  }

  /** The loop as shown: ours for a moment after a change, else FL's; the remembered range if off. */
  private shown(fl: FlState): Shown {
    const pending = this.pending;
    if (pending && this.clock() - pending.at < PENDING_MS) return pending;
    if (fl.loop.active && fl.loop.end > fl.loop.start) {
      return {
        active: true,
        start: this.stepsOf(fl.loop.start, fl),
        end: this.stepsOf(fl.loop.end, fl),
      };
    }
    return { active: false, ...this.rangeToUse(fl) };
  }

  /** The remembered range, else the current marker's section, else the first four bars. */
  rangeToUse(fl: FlState): StepRange {
    return this.range ?? defaultRange(fl);
  }

  /** The range SHIFT + tap RESTART would switch on, for the tests and the read-outs. */
  get remembered(): StepRange | undefined {
    return this.range;
  }

  private unavailable(fl: FlState): boolean {
    return fl.missing.loop;
  }

  /** Send a loop (start, end in steps) to FL, remember it and show it until FL answers. */
  private setLoop(start: number, end: number, mc: ModeContext): void {
    if (this.unavailable(mc.fl)) return;
    const range = sanitize(start, end);
    this.range = range;
    this.pending = { active: true, ...range, at: this.clock() };
    const from = this.ticksOf(range.start, mc.fl);
    const to = Math.min(MAX_LOOP_TICKS, this.ticksOf(range.end, mc.fl));
    mc.send({ type: "setLoop", start: from, end: to });
    this.scheduleSave(mc);
    mc.requestRender();
  }

  private clearLoop(mc: ModeContext, forget: boolean): void {
    if (this.unavailable(mc.fl)) return;
    const shown = this.shown(mc.fl);
    if (shown.active) this.range = { start: shown.start, end: shown.end };
    if (forget) this.range = undefined;
    this.pending = { active: false, ...this.rangeToUse(mc.fl), at: this.clock() };
    mc.send({ type: "setLoop", start: 0, end: 0 });
    this.scheduleSave(mc, true);
    mc.requestRender();
  }

  private toggle(mc: ModeContext): void {
    if (this.shown(mc.fl).active) this.clearLoop(mc, false);
    else {
      const range = this.rangeToUse(mc.fl);
      this.setLoop(range.start, range.end, mc);
    }
  }

  /** SHIFT + tap RESTART with the page closed: loop on or off, and say so on the read-out card. */
  tap(mc: ModeContext): void {
    if (this.unavailable(mc.fl)) {
      mc.reportAction?.(
        { title: "LOOP", detail: "Not available in this FL version", source: "SHIFT + RESTART" },
        "loop: not available in this FL version",
      );
      return;
    }
    this.toggle(mc);
    const loop = this.shown(mc.fl);
    mc.reportAction?.(
      {
        title: loop.active ? "LOOP ON" : "LOOP OFF",
        detail: `${positionStepsText(loop.start)} – ${positionStepsText(loop.end)}`,
        source: "SHIFT + RESTART",
      },
      `loop ${loop.active ? "on" : "off"}: ${positionStepsText(loop.start)} – ${positionStepsText(loop.end)}`,
    );
  }

  private scheduleSave(mc: ModeContext, now = false): void {
    this.timers.clear(this.saveTimer);
    if (now) {
      this.saveTimer = undefined;
      mc.saveState?.();
      return;
    }
    this.saveTimer = this.timers.set(() => {
      this.saveTimer = undefined;
      mc.saveState?.();
    }, SAVE_DELAY_MS);
  }

  // ── Page lifecycle ─────────────────────────────────────────────────────────

  enter(mc: ModeContext): void {
    this.mc = mc;
    this.boundary = "both";
    this.turns[0] = 0;
    this.turns[1] = 0;
    super.enter(mc);
    mc.send({ type: "requestLoop" });
  }

  leave(): void {
    if (this.saveTimer !== undefined) {
      this.timers.clear(this.saveTimer);
      this.saveTimer = undefined;
      this.mc?.saveState?.();
    }
  }

  onFlChange(section: FlSection, mc: ModeContext): void {
    this.mc = mc;
    super.onFlChange(section, mc);
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    this.mc = mc;
    if (event.type === "encoder") {
      if (event.index > 1) return false;
      this.turnKnob(event.index, event.delta, mc);
      return true;
    }
    if (event.type === "nav") {
      if (event.action === "turn") {
        this.turnNav(event.delta, mc);
        return true;
      }
      if (event.action === "tilt") {
        if (event.direction === "left" || event.direction === "right") {
          if (event.pressed) this.pickBoundary(event.direction === "left" ? "start" : "end", mc);
          return true;
        }
        return false;
      }
      return false;
    }
    return super.onEvent(event, mc);
  }

  private turnKnob(knob: number, delta: number, mc: ModeContext): void {
    this.turns[knob] = (this.turns[knob] ?? 0) + delta;
    const detents = Math.trunc((this.turns[knob] ?? 0) / DETENT_COUNTS);
    if (detents === 0) return;
    this.turns[knob] = (this.turns[knob] ?? 0) - detents * DETENT_COUNTS;
    const unit = mc.shift ? 1 : STEPS_PER_BAR;
    const loop = this.shown(mc.fl);
    if (knob === 0) {
      // Start: the loop moves, its length stays.
      const length = loop.end - loop.start;
      const start = clamp(loop.start + detents * unit, 0, MAX_STEPS - length);
      this.setLoop(start, start + length, mc);
    } else {
      this.setLoop(loop.start, loop.end + detents * unit, mc);
    }
  }

  private turnNav(delta: number, mc: ModeContext): void {
    const unit = (mc.shift ? 1 : STEPS_PER_BAR) * delta;
    const loop = this.shown(mc.fl);
    if (this.boundary === "start") this.setLoop(loop.start + unit, loop.end, mc);
    else if (this.boundary === "end") this.setLoop(loop.start, loop.end + unit, mc);
    else {
      const start = clamp(loop.start + unit, 0, MAX_STEPS - (loop.end - loop.start));
      this.setLoop(start, start + (loop.end - loop.start), mc);
    }
  }

  private pickBoundary(boundary: "start" | "end", mc: ModeContext): void {
    this.boundary = this.boundary === boundary ? "both" : boundary;
    mc.requestRender();
  }

  protected displayPressed(display: number, mc: ModeContext): void {
    if (display === ON_OFF_BUTTON) this.toggle(mc);
    else if (display === CLEAR_BUTTON) this.clearLoop(mc, true);
  }

  /** A marker's pad: the loop becomes that marker's section. */
  protected padPressed(index: number, mc: ModeContext): void {
    const section = markerSection(mc.fl, index);
    if (section) this.setLoop(section.start, section.end, mc);
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /** The marker whose section is the loop (its start), undefined if none is. */
  private loopMarker(fl: FlState): number | undefined {
    const loop = this.shown(fl);
    if (!loop.active) return undefined;
    for (let i = 0; i < fl.markerTotal; i++) {
      const section = markerSection(fl, i);
      if (section && Math.abs(section.start - loop.start) < 0.5) return i;
    }
    return undefined;
  }

  /** The marker lit bright while the LEDs are set. */
  private litMarker: number | undefined;

  protected padVariant(index: number): LedVariant {
    return index === this.litMarker ? "bright" : "dim";
  }

  leds(leds: LedState, mc: ModeContext): void {
    this.litMarker = this.loopMarker(mc.fl);
    super.leds(leds, mc);
  }

  protected rightTabs(): readonly [string, string] {
    return ["", ""];
  }

  protected displayLeds(leds: LedState, mc: ModeContext): void {
    const active = this.shown(mc.fl).active;
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
    leds.setLight("display2", active ? "bright" : "dim");
    leds.setLight("display3", "dim");
  }

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    this.mc = mc;
    const { fl } = mc;
    const loop = this.shown(fl);
    this.renderLeft(left, mc, loop);
    this.drawRightTabs(right, mc);
    if (fl.markerTotal === 0) {
      drawRuler(right, RULER, loop);
    } else {
      drawMarkerGrid(right, GRID_RECT, fl, this.bank, this.loopMarker(fl));
      drawFooter(right, markerWindowText(fl, this.bank));
    }
  }

  private renderLeft(ctx: SKRSContext2D, mc: ModeContext, loop: Shown): void {
    clear(ctx, FULL);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      {
        tabs: ["LOOP", loop.active ? "ON" : "OFF", "CLEAR"],
        active: [...(mc.pinned ? [0] : []), ...(loop.active ? [1] : [])],
      },
    );
    const x = 24;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText("Loop", x, TAB_HEIGHT + 8);
    if (this.unavailable(mc.fl)) {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(22);
      ctx.fillText("Not available in this FL version", x, TAB_HEIGHT + 40);
      return;
    }
    ctx.fillStyle = loop.active ? theme.accent : theme.dimText;
    ctx.font = font(38, "bold");
    ctx.fillText(
      fitText(
        ctx,
        `${positionStepsText(loop.start)} – ${positionStepsText(loop.end)}`,
        FULL.width - 2 * x,
      ),
      x,
      TAB_HEIGHT + 26,
    );
    ctx.fillStyle = theme.text;
    ctx.font = font(20);
    ctx.fillText(lengthText(loop.end - loop.start), x, TAB_HEIGHT + 76);
    ctx.fillStyle = theme.dimText;
    ctx.font = font(14);
    const target =
      this.boundary === "both" ? "the loop" : this.boundary === "start" ? "the start" : "the end";
    ctx.fillText(
      loop.active ? `4D turn moves ${target}` : "Loop is off (OFF = SHIFT + RESTART)",
      x,
      TAB_HEIGHT + 108,
    );
    const touched = (knob: number) => mc.touchedKnobs.has(knob);
    const knobs: KnobProps[] = [
      {
        label: "Start",
        valueText: positionStepsText(loop.start),
        value: loop.start / (64 * STEPS_PER_BAR),
        touched: touched(0),
      },
      {
        label: "Length",
        valueText: lengthText(loop.end - loop.start),
        value: (loop.end - loop.start) / (64 * STEPS_PER_BAR),
        touched: touched(1),
      },
    ];
    drawKnobRow(ctx, KNOB_ROW, knobs);
  }
}

// ── Ranges ──────────────────────────────────────────────────────────────────────

/** A loop in steps that FL can take: start ≥ 0, at least a step long, within 256 bars. */
export function sanitize(start: number, end: number): StepRange {
  const from = clamp(Math.round(start), 0, MAX_STEPS - MIN_STEPS);
  const to = clamp(Math.round(end), from + MIN_STEPS, MAX_STEPS);
  return { start: from, end: to };
}

/** Marker `index`'s section: up to the next marker, or four bars for the last. Undefined if its time is unknown. */
export function markerSection(fl: FlState, index: number): StepRange | undefined {
  const beats = markerBeats(fl, index);
  if (beats === undefined) return undefined;
  const start = beats * (STEPS_PER_BAR / 4);
  const next = index + 1 < fl.markerTotal ? markerBeats(fl, index + 1) : undefined;
  const nextSteps = next === undefined ? undefined : next * (STEPS_PER_BAR / 4);
  const end = nextSteps !== undefined && nextSteps > start ? nextSteps : start + DEFAULT_STEPS;
  return sanitize(start, end);
}

/** Without a remembered range: the current marker's section, else the first four bars. */
export function defaultRange(fl: FlState): StepRange {
  if (fl.markerTotal > 0) {
    const section = markerSection(fl, Math.max(0, currentMarker(fl)));
    if (section) return section;
  }
  return { start: 0, end: DEFAULT_STEPS };
}

// ── The bar ruler ───────────────────────────────────────────────────────────────

/** Bars from bar 1, a window of 16 bars or more around the loop, the loop filled in FL's orange. */
export function drawRuler(ctx: SKRSContext2D, rect: Rect, loop: Shown): void {
  const startBar = loop.start / STEPS_PER_BAR;
  const endBar = loop.end / STEPS_PER_BAR;
  const first = Math.floor(startBar / 4) * 4;
  const wanted = Math.max(16, Math.ceil((endBar - first) / 4) * 4);
  const bars = Math.min(64, wanted);
  const perBar = rect.width / bars;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.dimText;
  ctx.font = font(15);
  ctx.fillText("Bars", rect.x, TAB_HEIGHT + 10);
  clear(ctx, rect, theme.background);
  const x = (bar: number) => rect.x + clamp((bar - first) * perBar, 0, rect.width);
  const lx = x(startBar);
  const rx = x(endBar);
  if (rx > lx) {
    ctx.globalAlpha = loop.active ? 1 : 0.35;
    ctx.fillStyle = theme.accent;
    ctx.fillRect(lx, rect.y + 28, rx - lx, rect.height - 56);
    ctx.globalAlpha = 1;
  }
  const labelEvery = bars > 32 ? 8 : bars > 16 ? 4 : 2;
  ctx.font = font(13);
  ctx.textAlign = "center";
  for (let bar = 0; bar <= bars; bar++) {
    const px = Math.round(rect.x + bar * perBar);
    const major = bar % 4 === 0;
    ctx.fillStyle = major ? theme.dimText : theme.line;
    ctx.fillRect(px, rect.y + (major ? 6 : 12), 1, rect.height - (major ? 12 : 24));
    if (bar < bars && bar % labelEvery === 0) {
      ctx.fillStyle = theme.dimText;
      ctx.textBaseline = "top";
      ctx.fillText(String(first + bar + 1), px + 1 + perBar / 2, rect.y + rect.height + 6);
    }
  }
}
