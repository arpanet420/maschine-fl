// Quick edit: VOLUME, SWING and TEMPO turn the 4D encoder into an editor, like Maschine's info bar
// (docs/workflow.md). The three buttons are a radio group: a press turns that mode on (LED bright,
// the others dim), a press on the lit one turns it off. While a mode is on, 4D turns edit its value
// instead of reaching the page; push and tilt still go to the page. The page stack owns this (every
// page gets it) and calls it from onEvent, render and leds.
//
//   mode    nothing held                          a pad held
//   VOLUME  FL's main volume (SET_MAIN_VOLUME)    the channel's volume (SET_CHANNEL), 1/100
//           (not the Master mixer fader), 1/100
//   SWING   main swing (SET_SWING), 1/100         the same
//   TEMPO   tempo (SET_TEMPO), ±1 BPM             the channel's pitch (SET_CHANNEL), ±1 semitone
//
// SHIFT makes a turn a tenth as big for volume and swing (1/1000) and ±0.01 for tempo and pitch.
// The held pad's channel is the one the pad plays (PAD MODE) or the selected one (everywhere else;
// in PAD MODE the hit also selects the channel, so they agree once FL has caught up).
//
// The main volume reads as the percentage of its normalized value (FL's own hint may show another
// scale); it stays unknown, and a turn does nothing, until FL's script reports it in TRANSPORT.
//
// The same card also shows the feedback of a SHIFT + pad action for a moment (`flash`): the action
// big, a detail line under it (docs/workflow.md).
//
// Values: ours for a moment after a turn (the pending-value pattern of the other pages), then FL's,
// so FL catching up never makes the number jump back. The read-out is drawn over the page's middle
// on the left screen, away from the tabs and the knob labels.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlState } from "../fl/flState.js";
import { TEMPO_MAX, TEMPO_MIN } from "../fl/protocol.js";
import type { ButtonId } from "../hw/ids.js";
import type { LedState, MonoLedId } from "../hw/leds.js";
import { fitText, font, theme } from "../render/widgets.js";
import { detailOf } from "./channelMode.js";
import { clamp, isLive } from "./knob.js";
import type { ModeContext } from "./mode.js";

export type QuickMode = "volume" | "swing" | "tempo";
export const QUICK_MODES: readonly QuickMode[] = ["volume", "swing", "tempo"];

/** The button of each mode (they are lit by the quick edit, not by a page). */
const BUTTON: Record<QuickMode, MonoLedId> = { volume: "volume", swing: "swing", tempo: "tempo" };

/** The mode a button stands for, undefined for any other button. */
export const quickModeOf = (id: ButtonId): QuickMode | undefined =>
  QUICK_MODES.find((mode) => BUTTON[mode] === id);

/** How long the read-out stays after the last turn. */
export const READOUT_MS = 2000;
/** How long the feedback of a SHIFT + pad action stays. */
export const FLASH_MS = 1500;
/** One detent of the 4D encoder moves a 0–1 value this much (SHIFT: a tenth of it). */
export const NORM_STEP = 0.01;
/** One detent moves the tempo or a channel's pitch by this much (SHIFT: 0.01). */
export const WHOLE_STEP = 1;
export const FINE_STEP = 0.01;

/** Which pads are held, as the page stack sees them. */
export interface HeldTarget {
  /** A pad is held. */
  pad: boolean;
  /** The channel a held pad plays or, for a pad that plays none, the selected one. */
  channel: number | null;
}

/** What one quick-edit mode edits right now. */
interface Field {
  /** Pending values are kept per key (the target is part of it). */
  key: string;
  /** `MAIN` or the channel's name. */
  level: string;
  label: string;
  min: number;
  max: number;
  /** Change per detent, whole and with SHIFT. */
  step: number;
  fineStep: number;
  /** Decimals to round to (keeps 0.01 steps from drifting). */
  decimals: number;
  /** FL's value, undefined while FL hasn't told us. */
  read(fl: FlState): number | undefined;
  send(value: number, mc: ModeContext): void;
  /** The number and its unit, drawn big and small. */
  text(value: number): { value: string; unit: string };
  /** Where the value sits in the bar under it, 0–1. */
  fraction(value: number): number;
  bipolar?: boolean;
}

/** What the read-out draws. */
export interface Readout {
  level: string;
  label: string;
  value: string;
  unit: string;
  fraction: number;
  bipolar: boolean;
}

/** The feedback of a SHIFT + pad action (docs/workflow.md). */
export interface ActionFlash {
  /** The action, drawn big: `UNDO`, `CLEAR`, `OCTAVE +` … */
  title: string;
  /** The line under it: the channel, the new range. */
  detail: string;
  /** Undo and redo: the detail is FL's undo hint, and `position / count` shows small. */
  undo?: boolean;
  /** The small line above the title; `SHIFT + PAD` unless given (FILE, FIXED VEL). */
  source?: string;
}

/** What the action card draws. */
export interface ActionReadout {
  title: string;
  detail: string;
  /** Small, top right: the undo position (empty for the other actions). */
  small: string;
  /** The small line above the title when it is not `SHIFT + PAD`. */
  source?: string;
}

interface Pending {
  value: number;
  at: number;
}

const NO_UNIT = "";
const trimmed = (n: number, decimals: number) => String(Number(n.toFixed(decimals)));
const percent = (n: number) => ({ value: trimmed(n * 100, 1), unit: "%" });

export class QuickEdit {
  mode: QuickMode | undefined;
  private lastTurn: number | undefined;
  private readonly pending = new Map<string, Pending>();
  private readoutTimer: NodeJS.Timeout | undefined;
  private pendingTimer: NodeJS.Timeout | undefined;
  private flashed: { flash: ActionFlash; at: number } | undefined;
  private flashTimer: NodeJS.Timeout | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  get active(): boolean {
    return this.mode !== undefined;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** A press of VOLUME, SWING or TEMPO: that mode on, or off when it was the one on. */
  press(mode: QuickMode, mc: ModeContext): void {
    this.mode = this.mode === mode ? undefined : mode;
    this.lastTurn = undefined;
    this.flashed = undefined;
    this.pending.clear();
    mc.requestRender();
  }

  /** Shows the feedback of a SHIFT + pad action for FLASH_MS (over the value read-out). */
  flash(flash: ActionFlash, mc: ModeContext): void {
    this.flashed = { flash, at: this.now() };
    mc.requestRender();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => mc.requestRender(), FLASH_MS + 30);
    this.flashTimer.unref();
  }

  /** The action card to draw now, undefined once it has been shown long enough. */
  actionReadout(mc: ModeContext): ActionReadout | undefined {
    const shown = this.flashed;
    if (!shown || this.now() - shown.at >= FLASH_MS) return undefined;
    const { title, detail, undo, source } = shown.flash;
    const from = source === undefined ? {} : { source };
    if (!undo) return { title, detail, small: "", ...from };
    // FL's answer (UNDO_STATE) may arrive a moment after the press: the card shows what FL says now.
    const state = mc.fl.undoState;
    return {
      title,
      detail: state.hint,
      small: state.count > 0 ? `${state.position} / ${state.count}` : "",
      ...from,
    };
  }

  /** A 4D turn of `delta` detents (positive = clockwise). */
  turn(delta: number, mc: ModeContext, held: HeldTarget): void {
    const field = this.field(held, mc.fl);
    if (!field) return;
    const old = this.valueOf(field, mc.fl);
    if (old === undefined) return;
    const step = mc.shift ? field.fineStep : field.step;
    const factor = 10 ** field.decimals;
    const value = clamp(Math.round((old + delta * step) * factor) / factor, field.min, field.max);
    this.lastTurn = this.now();
    this.flashed = undefined;
    if (value !== old) {
      this.pending.set(field.key, { value, at: this.lastTurn });
      field.send(value, mc);
    }
    this.renderLater(mc);
  }

  /** Forget a held-over state, e.g. when the device went away. */
  reset(): void {
    this.lastTurn = undefined;
    this.flashed = undefined;
    this.pending.clear();
    clearTimeout(this.readoutTimer);
    clearTimeout(this.pendingTimer);
    clearTimeout(this.flashTimer);
  }

  /** Redraw now, and when the read-out and our own values stop being shown. */
  private renderLater(mc: ModeContext): void {
    mc.requestRender();
    clearTimeout(this.readoutTimer);
    this.readoutTimer = setTimeout(() => mc.requestRender(), READOUT_MS + 30);
    this.readoutTimer.unref();
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => mc.requestRender(), 330);
    this.pendingTimer.unref();
  }

  // ── Values ─────────────────────────────────────────────────────────────────

  /** What the mode edits now, undefined while there is nothing to edit (or FL is catching up). */
  private field(held: HeldTarget, fl: FlState): Field | undefined {
    if (!this.mode) return undefined;
    const channel = held.pad ? held.channel : null;
    if (channel !== null) {
      // Our own selection can be ahead of FL's: its values belong to another channel until then.
      if (fl.selectedChannel.index !== channel) return undefined;
      return this.channelField(this.mode, channel, fl);
    }
    return this.globalField(this.mode);
  }

  private globalField(mode: QuickMode): Field {
    const base = { level: "MAIN", min: 0, max: 1, step: NORM_STEP, fineStep: NORM_STEP / 10 };
    switch (mode) {
      case "volume":
        return {
          ...base,
          key: "main volume",
          label: "VOLUME",
          decimals: 4,
          read: (fl) => (fl.connected ? fl.mainVolume : undefined),
          send: (value, mc) => mc.send({ type: "setMainVolume", value }),
          text: percent,
          fraction: (value) => value,
        };
      case "swing":
        return {
          ...base,
          key: "swing",
          label: "SWING",
          decimals: 4,
          read: (fl) => (fl.connected ? fl.swing : undefined),
          send: (value, mc) => mc.send({ type: "setSwing", value }),
          text: percent,
          fraction: (value) => value,
        };
      case "tempo":
        return {
          ...base,
          key: "tempo",
          label: "TEMPO",
          min: TEMPO_MIN,
          max: TEMPO_MAX,
          step: WHOLE_STEP,
          fineStep: FINE_STEP,
          decimals: 2,
          read: (fl) => (fl.tempo > 0 ? fl.tempo : undefined),
          send: (bpm, mc) => mc.send({ type: "setTempo", bpm }),
          text: (bpm) => ({ value: bpm.toFixed(2), unit: "BPM" }),
          fraction: (bpm) => (bpm - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN),
        };
    }
  }

  private channelField(mode: QuickMode, index: number, fl: FlState): Field | undefined {
    const name = fl.channels.get(index)?.name || fl.selectedChannel.name || `Channel ${index + 1}`;
    if (mode === "volume") {
      return {
        key: `channel ${index} volume`,
        level: name,
        label: "VOLUME",
        min: 0,
        max: 1,
        step: NORM_STEP,
        fineStep: NORM_STEP / 10,
        decimals: 4,
        read: (state) => state.selectedChannel.volume,
        send: (value, mc) => mc.send({ type: "setChannel", index, what: "volume", value }),
        text: percent,
        fraction: (value) => value,
      };
    }
    if (mode === "swing") return this.globalField("swing");
    // TEMPO with a pad held tunes the channel: ±1 semitone per detent, within its pitch range.
    const range = detailOf(fl).pitchRange;
    if (range <= 0) return undefined; // FL hasn't reported the pitch range yet
    return {
      key: `channel ${index} pitch`,
      level: name,
      label: "TUNE",
      min: -range,
      max: range,
      step: WHOLE_STEP,
      fineStep: FINE_STEP,
      decimals: 2,
      bipolar: true,
      read: (state) => detailOf(state).pitch * range,
      // The wire value is pan-style, like Channel mode's pitch knob: (factor + 1) / 2.
      send: (semitones, mc) =>
        mc.send({
          type: "setChannel",
          index,
          what: "pitch",
          value: (semitones / range + 1) / 2,
        }),
      text: (semitones) => ({
        value: `${semitones < 0 ? "-" : "+"}${Math.abs(semitones).toFixed(2)}`,
        unit: "st",
      }),
      fraction: (semitones) => (semitones / range + 1) / 2,
    };
  }

  private valueOf(field: Field, fl: FlState): number | undefined {
    const pending = this.pending.get(field.key);
    if (pending && isLive(pending, this.now())) return pending.value;
    return field.read(fl);
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /** What to show now: while a mode is on and the encoder was turned lately, or a pad is held. */
  readout(mc: ModeContext, held: HeldTarget): Readout | undefined {
    if (!this.mode || !mc.fl.connected) return undefined;
    const turned = this.lastTurn !== undefined && this.now() - this.lastTurn < READOUT_MS;
    if (!held.pad && !turned) return undefined;
    const field = this.field(held, mc.fl);
    const value = field && this.valueOf(field, mc.fl);
    if (!field || value === undefined) return undefined;
    const { value: text, unit } = field.text(value);
    return {
      level: field.level,
      label: field.label,
      value: text,
      unit,
      fraction: clamp(field.fraction(value), 0, 1),
      bipolar: field.bipolar ?? false,
    };
  }

  /** The buttons are a radio group: the mode on is bright, the others dim, all off without FL. */
  leds(leds: LedState, connected: boolean): void {
    for (const mode of QUICK_MODES) {
      leds.setLight(BUTTON[mode], !connected ? "off" : this.mode === mode ? "bright" : "dim");
    }
  }

  /** Draws the card on the left screen, if there is one to show: an action's, else the value's. */
  render(ctx: SKRSContext2D, mc: ModeContext, held: HeldTarget): void {
    const action = mc.fl.connected ? this.actionReadout(mc) : undefined;
    if (action) {
      drawActionReadout(ctx, action);
      return;
    }
    const readout = this.readout(mc, held);
    if (readout) drawReadout(ctx, readout);
  }
}

/** The card: over the middle of the left screen, under the tabs and above the knob labels. */
export const READOUT_RECT = { x: 8, y: 52, width: 464, height: 132 } as const;

function drawCard(ctx: SKRSContext2D): void {
  const { x, y, width, height } = READOUT_RECT;
  ctx.fillStyle = theme.line;
  ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
  ctx.fillStyle = theme.panelRaised;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = theme.accent;
  ctx.fillRect(x, y, 5, height);
}

/** The card of a SHIFT + pad action (or a FILE or FIXED VEL press): the action big, the detail under it. */
export function drawActionReadout(ctx: SKRSContext2D, action: ActionReadout): void {
  drawCard(ctx);
  const { x, y, width } = READOUT_RECT;
  const left = x + 24;
  const right = x + width - 20;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.font = font(18, "bold");
  ctx.fillStyle = theme.dimText;
  ctx.fillText(action.source ?? "SHIFT + PAD", left, y + 14);
  if (action.small) {
    ctx.textAlign = "right";
    ctx.fillStyle = theme.accent;
    ctx.fillText(action.small, right, y + 14);
    ctx.textAlign = "left";
  }
  // The action as big as fits.
  let size = 54;
  ctx.font = font(size, "bold");
  while (size > 28 && ctx.measureText(action.title).width > right - left) {
    size -= 2;
    ctx.font = font(size, "bold");
  }
  ctx.fillStyle = theme.text;
  ctx.fillText(action.title, left, y + 38);
  ctx.font = font(22);
  ctx.fillStyle = theme.dimText;
  ctx.fillText(fitText(ctx, action.detail, right - left), left, y + 98);
}

export function drawReadout(ctx: SKRSContext2D, readout: Readout): void {
  drawCard(ctx);
  const { x, y, width, height } = READOUT_RECT;

  const left = x + 24;
  const right = x + width - 20;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.font = font(18, "bold");
  ctx.fillStyle = theme.dimText;
  ctx.fillText(fitText(ctx, readout.level.toUpperCase(), width - 150), left, y + 14);
  ctx.textAlign = "right";
  ctx.fillStyle = theme.accent;
  ctx.fillText(readout.label, right, y + 14);

  // The value big, its unit smaller after it.
  ctx.textAlign = "left";
  ctx.font = font(64, "bold");
  ctx.fillStyle = theme.text;
  ctx.fillText(readout.value, left, y + 38);
  if (readout.unit !== NO_UNIT) {
    const valueWidth = ctx.measureText(readout.value).width;
    ctx.font = font(26, "bold");
    ctx.fillStyle = theme.dimText;
    ctx.fillText(readout.unit, left + valueWidth + 10, y + 68);
  }

  // A bar under it: fills from the left, or from the middle for a pitch.
  const barY = y + height - 24;
  const barWidth = right - left;
  ctx.fillStyle = theme.faderSlot;
  ctx.fillRect(left, barY, barWidth, 8);
  ctx.fillStyle = theme.accent;
  if (readout.bipolar) {
    const middle = left + barWidth / 2;
    const end = left + barWidth * readout.fraction;
    ctx.fillRect(Math.min(middle, end), barY, Math.abs(end - middle), 8);
    ctx.fillStyle = theme.text;
    ctx.fillRect(middle - 1, barY - 3, 2, 14);
  } else {
    ctx.fillRect(left, barY, barWidth * readout.fraction, 8);
  }
}
