// STEP page (a tool page: STEP opens it, STEP again leaves it). While it is open the pads are the
// steps of the selected channel in the current pattern: pad n = step `page × 16 + n` (VIEW
// `stepOffset` = page × 16, merged into the main page's VIEW). The pad mode underneath (KEYBOARD or
// PAD MODE) is not touched, so it comes back when the page closes.
//
// - A press on a dark step turns it on at once. A press on a lit step removes it on the release, unless
//   it was held for `STEP_HOLD_MS` or a knob turned meanwhile. While a step is held for that long the
//   left screen shows it: knob 1 = its velocity, knob 2 = its pitch (REQUEST_STEP_PARAMS, SET_STEP_PARAM).
// - ERASE held + pad clears that step (the stack tells the page through `mc.erase`).
// - Steps past the pattern length have no LED and ignore presses.
// - Display 7 and 8 (`<<` `>>`) and the arrow buttons page through the pattern, 16 steps at a time.
//   Display 5 and the FOLLOW button toggle FOLLOW: while on and playing, the page follows the play
//   position, each time the play head enters another page (so paging by hand sticks until then).
// - GROUP A–H still pick the channel bank, so the steps switch to the channel selected there.
// - The play position comes from SONG_POS, assuming 16 steps per bar: position in the pattern =
//   ((bar − 1) × 16 + step − 1) mod pattern length (docs/mapping.md).
// - Other knobs, the 4D encoder and everything else fall through to the main page underneath.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlSection, FlState } from "../fl/flState.js";
import type { HwEvent } from "../hw/events.js";
import type { ButtonId } from "../hw/ids.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { Rect } from "../hw/display.js";
import type { LedState } from "../hw/leds.js";
import { LED_OFF, contrastPalette } from "../hw/palette.js";
import {
  TAB_HEIGHT,
  clear,
  drawKnobRow,
  drawTabs,
  fitText,
  font,
  theme,
} from "../render/widgets.js";
import { setBankLeds, groupBank } from "./channelBank.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import { knobStep } from "./knob.js";
import { flColorToCss, flColorToPalette } from "./format.js";
import type { Mode, ModeContext, ViewCommand } from "./mode.js";
import { padCellRect } from "./padGrid.js";
import { noteName, type PadState } from "./padState.js";
import { realTimers, type RepeatTimers } from "./repeatScheduler.js";

/** A step held this long stays when let go, and the page shows its values. */
export const STEP_HOLD_MS = 400;
/** Knob counts that move a held step's pitch one semitone. */
const PITCH_COUNTS = 60;
/** The MIDI values FL starts a step with (`midi.pPitch`, `midi.pVelocity`). */
const DEFAULT_PITCH = 60;
const DEFAULT_VELOCITY = 100;
const PARAM_PITCH = 0;
const PARAM_VELOCITY = 1;

/** A pad held on the page. */
interface HeldStep {
  pad: number;
  channel: number;
  step: number;
  /** It was on when pressed: the release removes it unless it was held or edited. */
  wasOn: boolean;
  /** Held long enough or edited: it stays, and the screen shows it. */
  kept: boolean;
  timer: unknown;
  pitch: number;
  velocity: number;
  /** Knob counts not yet a semitone. */
  pitchTurn: number;
}

const clamp127 = (value: number): number => Math.min(127, Math.max(0, value));

/** Steps on the pads. */
export const STEPS_PER_PAGE = PAD_COUNT;
/** FL's grid is 16 steps to the bar (the assumption behind the play position). */
export const STEPS_PER_BAR = 16;

/** Display 5, 7 and 8 (0-based 4, 6, 7): FOLLOW, `<<`, `>>`. */
const FOLLOW_BUTTON = 4;
const PREVIOUS = 6;
const NEXT = 7;

/** The grid fills the right screen under the tab strip. */
const GRID: Rect = {
  x: 4,
  y: TAB_HEIGHT + 4,
  width: FULL.width - 8,
  height: FULL.height - TAB_HEIGHT - 8,
};

/** Groups of 4 steps alternate (steps 1–4 and 9–12 are group A, 5–8 and 13–16 group B). */
export const groupB = (pad: number): boolean => Math.floor(pad / 4) % 2 === 1;

/** Pages in a pattern of `length` steps; at least one. */
export const pageCount = (length: number): number =>
  Math.max(1, Math.ceil(length / STEPS_PER_PAGE));

/**
 * The step the play head is on in the current pattern (0-based), undefined while FL is stopped. The
 * position comes from SONG_POS with 16 steps to the bar, wrapped to the pattern's length.
 */
export function playHeadStep(fl: FlState): number | undefined {
  const length = fl.pattern.length;
  if (!fl.transport.playing || length <= 0) return undefined;
  const { bar, step } = fl.songPos;
  const position = (bar - 1) * STEPS_PER_BAR + (step - 1);
  return ((position % length) + length) % length;
}

export class StepPage implements Mode {
  readonly name = "step";
  private held: HeldStep[] = [];
  private page = 0;
  private follow = true;
  /** The page the play head was last on; undefined while stopped. */
  private playPage: number | undefined;
  /** The play position last drawn, so a new frame is only asked for when it moves. */
  private shownHead: number | undefined;

  constructor(
    private readonly pads: PadState,
    private readonly timers: RepeatTimers = realTimers,
  ) {}

  /** Closed with a step held: the step stays as it is. */
  leave(): void {
    for (const held of [...this.held]) this.forgetHeld(held.pad);
  }

  // ── Window ─────────────────────────────────────────────────────────────────

  enter(mc: ModeContext): void {
    this.playPage = undefined;
    this.page = Math.min(this.page, this.lastPage(mc.fl));
    this.followPlayHead(mc, false);
    this.shownHead = this.playHead(mc.fl);
    this.sendView(mc);
  }

  /** The step window FL reports follows the page. */
  viewPatch(): Partial<ViewCommand> {
    return { stepOffset: this.page * STEPS_PER_PAGE };
  }

  private sendView(mc: ModeContext): void {
    const base = mc.baseView?.();
    if (base) mc.send({ ...base, ...this.viewPatch() });
  }

  private lastPage(fl: FlState): number {
    return pageCount(fl.pattern.length) - 1;
  }

  private setPage(wanted: number, mc: ModeContext): void {
    const page = Math.min(Math.max(0, wanted), this.lastPage(mc.fl));
    if (page === this.page) return;
    this.page = page;
    this.sendView(mc);
    mc.requestRender();
  }

  onFlChange(section: FlSection, mc: ModeContext): void {
    if (section === "stepParams") {
      const answer = mc.fl.stepParams;
      const held = this.held.find((h) => h.channel === answer?.channel && h.step === answer.step);
      if (answer && held) {
        held.pitch = answer.pitch;
        held.velocity = answer.velocity;
        mc.requestRender();
      }
      return;
    }
    switch (section) {
      case "pattern":
        // The pattern may be shorter than the page we are on.
        this.setPage(this.page, mc);
        this.followPlayHead(mc);
        break;
      case "transport":
        this.followPlayHead(mc);
        break;
      case "songPos": {
        this.followPlayHead(mc);
        // The pad LEDs only change when the play head moves a step: ask for a frame then.
        const head = this.playHead(mc.fl);
        if (head !== this.shownHead) {
          this.shownHead = head;
          mc.requestRender();
        }
        break;
      }
    }
  }

  // ── Play head ──────────────────────────────────────────────────────────────

  /** The step the play head is on in the pattern (0-based), undefined while stopped. */
  private playHead(fl: FlState): number | undefined {
    return playHeadStep(fl);
  }

  /** FOLLOW: turn to the play head's page when the head enters a page it was not on before. */
  private followPlayHead(mc: ModeContext, render = true): void {
    const head = this.playHead(mc.fl);
    if (head === undefined) {
      this.playPage = undefined;
      return;
    }
    const page = Math.floor(head / STEPS_PER_PAGE);
    const entered = page !== this.playPage;
    this.playPage = page;
    if (!this.follow || !entered) return;
    if (render) this.setPage(page, mc);
    else this.page = Math.min(page, this.lastPage(mc.fl));
  }

  private toggleFollow(mc: ModeContext): void {
    this.follow = !this.follow;
    this.playPage = undefined; // turning it on while playing turns to the play head at once
    this.followPlayHead(mc);
    mc.requestRender();
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    switch (event.type) {
      case "pad":
        // Down acts; move and up are ours too so no pad ever plays a note under the page.
        if (event.phase === "down") this.padPressed(event.pad, mc);
        else if (event.phase === "up") this.padReleased(event.pad, mc);
        return true;
      case "encoder":
        return this.turnHeldStep(event.index, event.delta, mc);
      case "button": {
        const bank = groupBank(event.id);
        if (bank !== undefined) {
          if (event.pressed) this.pads.selectBank(bank, mc);
          return true;
        }
        if (event.id === "arrowLeft" || event.id === "arrowRight") {
          if (event.pressed) this.setPage(this.page + (event.id === "arrowLeft" ? -1 : 1), mc);
          return true;
        }
        if (event.id === "follow") {
          if (event.pressed) this.toggleFollow(mc);
          return true;
        }
        const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
        if (display < 0) return false;
        // Display buttons never reach the page underneath.
        if (!event.pressed) return true;
        if (display === FOLLOW_BUTTON) this.toggleFollow(mc);
        if (display === PREVIOUS) this.setPage(this.page - 1, mc);
        if (display === NEXT) this.setPage(this.page + 1, mc);
        return true;
      }
      default:
        return false;
    }
  }

  private padPressed(pad: number, mc: ModeContext): void {
    const { fl } = mc;
    const channel = fl.selectedChannel.index;
    const step = this.page * STEPS_PER_PAGE + pad;
    if (channel === null || step >= fl.pattern.length) return;
    // ERASE held: clear the step.
    if (mc.erase) {
      mc.send({ type: "setStep", channel, step, on: false });
      return;
    }
    const wasOn = this.stepOn(fl, step);
    if (!wasOn) mc.send({ type: "setStep", channel, step, on: true });
    this.forgetHeld(pad);
    const held: HeldStep = {
      pad,
      channel,
      step,
      wasOn,
      kept: false,
      timer: undefined,
      pitch: DEFAULT_PITCH,
      velocity: DEFAULT_VELOCITY,
      pitchTurn: 0,
    };
    held.timer = this.timers.set(() => this.keepHeld(held, mc), STEP_HOLD_MS);
    this.held.push(held);
  }

  /** It has been held long enough: it stays, and FL says what its values are. */
  private keepHeld(held: HeldStep, mc: ModeContext): void {
    held.timer = undefined;
    if (!this.held.includes(held)) return;
    held.kept = true;
    mc.send({ type: "requestStepParams", channel: held.channel, step: held.step });
    mc.requestRender();
  }

  private padReleased(pad: number, mc: ModeContext): void {
    const held = this.held.find((h) => h.pad === pad);
    if (!held) return;
    this.forgetHeld(pad);
    if (held.wasOn && !held.kept) {
      mc.send({ type: "setStep", channel: held.channel, step: held.step, on: false });
    }
    if (held.kept) mc.requestRender();
  }

  private forgetHeld(pad: number): void {
    const held = this.held.find((h) => h.pad === pad);
    if (!held) return;
    if (held.timer !== undefined) this.timers.clear(held.timer);
    this.held = this.held.filter((h) => h !== held);
  }

  /** The step the knobs edit: the one pressed last. */
  private get editing(): HeldStep | undefined {
    return this.held.at(-1);
  }

  /** Knob 1 = velocity, knob 2 = pitch of the held step. False = no step held, or another knob. */
  private turnHeldStep(knob: number, delta: number, mc: ModeContext): boolean {
    const held = this.editing;
    if (!held || knob > 1) return false;
    if (!held.kept) this.keepHeld(held, mc);
    if (held.timer !== undefined) {
      this.timers.clear(held.timer);
      held.timer = undefined;
    }
    if (knob === 0) {
      const velocity = clamp127(held.velocity + knobStep(delta, mc.shift) * 127);
      if (Math.round(velocity) !== Math.round(held.velocity)) {
        this.sendParam(held, PARAM_VELOCITY, Math.round(velocity), mc);
      }
      held.velocity = velocity;
    } else {
      held.pitchTurn += delta;
      const steps = Math.trunc(held.pitchTurn / PITCH_COUNTS);
      if (steps !== 0) {
        held.pitchTurn -= steps * PITCH_COUNTS;
        held.pitch = clamp127(held.pitch + steps);
        this.sendParam(held, PARAM_PITCH, held.pitch, mc);
      }
    }
    mc.requestRender();
    return true;
  }

  private sendParam(held: HeldStep, param: number, value: number, mc: ModeContext): void {
    mc.send({ type: "setStepParam", channel: held.channel, step: held.step, param, value });
  }

  /** Is the step on, as far as FL has told us (for the selected channel in the current pattern)? */
  private stepOn(fl: FlState, step: number): boolean {
    const grid = fl.stepGrid;
    if (grid.channel !== fl.selectedChannel.index || grid.pattern !== fl.pattern.number) {
      return false;
    }
    return grid.steps.get(step) ?? false;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    this.renderLeft(left, mc);
    this.renderRight(right, mc);
  }

  /** The held step's values, in the columns over knobs 1 and 2. */
  private renderHeld(ctx: SKRSContext2D, held: HeldStep, mc: ModeContext): void {
    clear(ctx, FULL);
    drawTabs(ctx, { ...FULL, height: TAB_HEIGHT }, { tabs: ["STEP"], active: [0] });
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText(mc.fl.selectedChannel.name, 14, TAB_HEIGHT + 18);
    ctx.fillStyle = theme.accent;
    ctx.font = font(44, "bold");
    ctx.fillText(`Step ${held.step + 1}`, 14, TAB_HEIGHT + 42);
    drawKnobRow(ctx, { ...FULL, y: FULL.height - 110, height: 110 }, [
      {
        label: "Velocity",
        valueText: String(Math.round(held.velocity)),
        value: held.velocity / 127,
      },
      { label: "Pitch", valueText: noteName(held.pitch), value: held.pitch / 127 },
    ]);
  }

  private renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    const { pattern, selectedChannel } = fl;
    const held = this.editing;
    if (held?.kept) {
      this.renderHeld(ctx, held, mc);
      return;
    }
    clear(ctx, FULL);
    drawTabs(ctx, { ...FULL, height: TAB_HEIGHT }, { tabs: ["STEP"], active: [0] });
    if (selectedChannel.index === null) {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(20);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No channel", FULL.width / 2, 120);
      return;
    }
    const top = TAB_HEIGHT + 22;
    ctx.fillStyle = flColorToCss(selectedChannel.color);
    ctx.fillRect(14, top, 6, 128);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText(`Channel ${selectedChannel.index + 1}`, 34, top);
    ctx.fillStyle = flColorToCss(selectedChannel.color);
    ctx.font = font(30, "bold");
    ctx.fillText(fitText(ctx, selectedChannel.name, FULL.width - 50), 34, top + 20);
    // Pattern number dim, its name after it.
    ctx.font = font(17);
    ctx.fillStyle = theme.dimText;
    const label = `Pattern ${pattern.number}`;
    ctx.fillText(label, 34, top + 70);
    ctx.fillStyle = theme.text;
    const labelWidth = ctx.measureText(`${label}   `).width;
    ctx.fillText(
      fitText(ctx, pattern.name, FULL.width - 50 - labelWidth),
      34 + labelWidth,
      top + 70,
    );
    ctx.fillStyle = theme.text;
    ctx.font = font(28, "bold");
    const first = this.page * STEPS_PER_PAGE;
    const last = Math.min(first + STEPS_PER_PAGE, pattern.length);
    ctx.fillText(
      pattern.length > 0 ? `steps ${first + 1}–${last} of ${pattern.length}` : "no steps",
      34,
      top + 98,
    );
    this.drawOverview(ctx, mc);
  }

  /** One cell per page of the pattern: the shown page orange, the play head's page marked. */
  private drawOverview(ctx: SKRSContext2D, mc: ModeContext): void {
    const pages = pageCount(mc.fl.pattern.length);
    const gap = 4;
    const left = 14;
    const width = Math.min(48, (FULL.width - 2 * left - (pages - 1) * gap) / pages);
    const y = 206;
    const height = 18;
    const head = this.playHead(mc.fl);
    const playing = head === undefined ? undefined : Math.floor(head / STEPS_PER_PAGE);
    for (let i = 0; i < pages; i++) {
      const x = Math.round(left + i * (width + gap));
      const cell = { x, y, width: Math.round(width), height };
      clear(ctx, cell, i === this.page ? theme.accent : theme.panelRaised);
      if (i === playing) {
        ctx.fillStyle = theme.text;
        ctx.fillRect(cell.x, cell.y + height - 4, cell.width, 4);
      }
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13);
    ctx.fillText(`page ${this.page + 1} of ${pages}`, left, y + height + 8);
  }

  private renderRight(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    clear(ctx, FULL);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      {
        tabs: ["FOLLOW", "", this.page > 0 ? "<<" : "", this.page < this.lastPage(fl) ? ">>" : ""],
        active: this.follow ? [0] : [],
      },
    );
    const head = this.playHead(fl);
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const step = this.page * STEPS_PER_PAGE + pad;
      const cell = padCellRect(GRID, pad);
      if (step >= fl.pattern.length || fl.selectedChannel.index === null) {
        clear(ctx, cell, theme.background);
        continue;
      }
      const on = this.stepOn(fl, step);
      const b = groupB(pad);
      ctx.fillStyle = on
        ? b
          ? theme.stepOnB
          : theme.stepOnA
        : b
          ? theme.stepOffB
          : theme.stepOffA;
      ctx.beginPath();
      ctx.roundRect(cell.x, cell.y, cell.width, cell.height, 6);
      ctx.fill();
      const isHead = head === step;
      if (isHead) {
        // The play head lights its step up, like the white pad: an outline alone gets lost on
        // the pink and blue of lit steps.
        ctx.fillStyle = "#ffffff";
        ctx.globalAlpha = 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.roundRect(cell.x + 2, cell.y + 2, cell.width - 4, cell.height - 4, 5);
        ctx.stroke();
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.font = font(13, "bold");
      ctx.fillStyle = on || isHead ? theme.line : theme.dimText;
      ctx.fillText(String(step + 1), cell.x + 8, cell.y + 6);
    }
  }

  ownsButtonLed(id: ButtonId): boolean {
    return id === "follow";
  }

  leds(leds: LedState, mc: ModeContext): void {
    const { fl } = mc;
    const head = this.playHead(fl);
    const channel = fl.selectedChannel;
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const step = this.page * STEPS_PER_PAGE + pad;
      if (!fl.connected || channel.index === null || step >= fl.pattern.length) {
        leds.setPad(pad, LED_OFF);
      } else if (head === step) {
        // The opposite hue of the channel's color, so the head shows on lit steps too.
        const on = this.stepOn(fl, step);
        const base = flColorToPalette(channel.color, "bright");
        leds.setPad(pad, contrastPalette(base, on ? "pressed" : "bright"));
      } else if (this.stepOn(fl, step)) {
        leds.setPad(pad, flColorToPalette(channel.color, "bright"));
      } else {
        leds.setPad(pad, flColorToPalette(channel.color, groupB(pad) ? "faint" : "dim"));
      }
    }
    setBankLeds(leds, fl);
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display1", "bright"); // a tool page is always latched
    leds.setLight("display5", this.follow ? "bright" : "dim");
    const hasPrevious = this.page > 0;
    const hasNext = this.page < this.lastPage(fl);
    leds.setLight("display7", hasPrevious ? "dim" : "off");
    leds.setLight("display8", hasNext ? "dim" : "off");
    leds.setLight("arrowLeft", hasPrevious ? "dim" : "off");
    leds.setLight("arrowRight", hasNext ? "dim" : "off");
    leds.setLight("follow", this.follow ? "bright" : "dim");
  }
}
