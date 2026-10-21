// The ARP side of the NOTE REPEAT overlay (noteRepeatOverlay.ts hands every event, screen and LED to
// this while the pads are in KEYBOARD or CHORDS, as Maschine's NOTE REPEAT button opens ARP there).
// The notes come from arpeggiator.ts; this file is the controls, the screens and the LEDs.
//
// Display 1 is the pin tab (the stack's), 2 and 4 are empty (LOCK and GATE RESET are not built), 3 =
// HOLD, 5–8 = presets that set Type, Rate, Octaves and Gate at once. Knobs: 1 Type, 2 Rate (the
// rates of Note Repeat), 3 Octaves, 4 Gate (left screen), 5 Swing (right screen). Dynamic is not built:
// the velocity of a note is the hit of the pad that owns it (FIXED VEL wins, in PadState).
//
// The settings are separate from Note Repeat's and saved inside its state (`pages.noteRepeat.arp`).
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlState } from "../fl/flState.js";
import type { HwEvent } from "../hw/events.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
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
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import { pct } from "./format.js";
import {
  ARP_PRESETS,
  ARP_TYPES,
  Arpeggiator,
  DEFAULT_ARP_SETTINGS,
  OCTAVES_MAX,
  OCTAVES_MIN,
  clampOctaves,
  isArpType,
  matchesPreset,
  type ArpPreset,
  type ArpSettings,
} from "./arpeggiator.js";
import { knobStep } from "./knob.js";
import type { ModeContext } from "./mode.js";
import { noteName, type PadState } from "./padState.js";
import {
  FALLBACK_BPM,
  GATE_MAX,
  GATE_MIN,
  REPEAT_RATES,
  SWING_MAX,
  clampRate,
  hitVelocity,
  type RepeatTimers,
  type RepeatTiming,
} from "./repeatScheduler.js";

/** Knob counts that move Type or Rate one step (a turn is 1000 counts). */
const STEP_COUNTS = 120;
/** Knob counts that move Octaves one step. */
const OCTAVE_COUNTS = 200;
/** The settings are written this long after the last knob turn. */
const SAVE_DELAY_MS = 400;
const HOLD_BUTTON = 2; // display 3
const FIRST_PRESET_BUTTON = 4; // display 5
const KNOB_ROW = { ...FULL, y: FULL.height - 110, height: 110 };
const CELL_WIDTH = 54;
const CELL_HEIGHT = 34;
const CELL_GAP = 4;
const MAX_ROWS = 3;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export interface ArpPanelOptions {
  clock?: () => number;
  timers: RepeatTimers;
  timing: () => RepeatTiming;
  random?: () => number;
  /** Redraw only the LEDs (a pad flashing with a step). */
  requestLeds: () => void;
}

export class ArpPanel {
  readonly settings: ArpSettings = { ...DEFAULT_ARP_SETTINGS };
  readonly engine: Arpeggiator;
  private mc: ModeContext | undefined;
  private typeTurn = 0;
  private rateTurn = 0;
  private octaveTurn = 0;
  private saveTimer: unknown;

  constructor(
    private readonly pads: PadState,
    private readonly options: ArpPanelOptions,
  ) {
    this.engine = new Arpeggiator({
      output: {
        on: (note, velocity) => this.pads.arpOn(note, velocity),
        off: (note) => this.pads.arpOff(note),
        changed: () => this.options.requestLeds(),
      },
      timing: options.timing,
      settings: () => this.settings,
      clock: options.clock,
      timers: options.timers,
      random: options.random,
    });
  }

  get active(): boolean {
    return this.engine.active;
  }

  // ── Saved state ────────────────────────────────────────────────────────────

  save(): unknown {
    return { ...this.settings, hold: this.engine.holding };
  }

  load(data: unknown): void {
    const saved = data as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object") return;
    const rate = finite(saved.rate);
    const gate = finite(saved.gate);
    const swing = finite(saved.swing);
    const octaves = finite(saved.octaves);
    if (rate !== undefined) this.settings.rate = clampRate(rate);
    if (gate !== undefined) this.settings.gate = clamp(gate, GATE_MIN, GATE_MAX);
    if (swing !== undefined) this.settings.swing = clamp(swing, 0, SWING_MAX);
    if (octaves !== undefined) this.settings.octaves = clampOctaves(octaves);
    if (isArpType(saved.type)) this.settings.type = saved.type;
    if (typeof saved.hold === "boolean") this.engine.setHold(saved.hold);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  enter(mc: ModeContext): void {
    this.mc = mc;
  }

  /** Closed, replaced, the device went away or the pads left KEYBOARD and CHORDS: nothing stays on. */
  stop(): void {
    this.engine.stopAll();
  }

  /** The overlay is left: stop and write what is waiting to be saved. */
  leave(): void {
    this.stop();
    if (this.saveTimer === undefined) return;
    this.options.timers.clear(this.saveTimer);
    this.saveTimer = undefined;
    this.mc?.saveState?.();
  }

  onFlChange(): void {
    this.engine.refresh();
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** Pads, knobs and display buttons. True = handled. */
  onEvent(event: HwEvent, mc: ModeContext): boolean {
    this.mc = mc;
    switch (event.type) {
      case "pad":
        return this.onPad(event, mc);
      case "encoder":
        if (event.index > 4) return false;
        this.turn(event.index, event.delta, mc);
        return true;
      case "button": {
        const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
        if (display < 0) return false;
        if (event.pressed && display === HOLD_BUTTON) this.toggleHold(mc);
        else if (event.pressed && display >= FIRST_PRESET_BUTTON) {
          const preset = ARP_PRESETS[display - FIRST_PRESET_BUTTON];
          if (preset) this.applyPreset(preset, mc);
        }
        return true; // display buttons never reach the page underneath
      }
      default:
        return false;
    }
  }

  private onPad(event: Extract<HwEvent, { type: "pad" }>, mc: ModeContext): boolean {
    const { pad } = event;
    if (event.phase === "down") {
      if (mc.erase) return false; // ERASE takes the pad
      this.engine.press(pad, this.pads.arpNotes(pad), hitVelocity(event.velocity ?? 0));
    } else if (event.phase === "up") {
      this.engine.release(pad);
    }
    return true; // move is ours too, so no pad plays a note under the page
  }

  private turn(knob: number, delta: number, mc: ModeContext): void {
    const settings = this.settings;
    if (knob === 0) {
      const steps = this.steps("typeTurn", delta, STEP_COUNTS);
      if (steps === 0) return;
      const index = ARP_TYPES.findIndex((t) => t.id === settings.type);
      const next = ARP_TYPES[clamp(index + steps, 0, ARP_TYPES.length - 1)];
      if (next) this.change({ type: next.id }, mc, true);
    } else if (knob === 1) {
      const steps = this.steps("rateTurn", delta, STEP_COUNTS);
      if (steps !== 0) this.change({ rate: clampRate(settings.rate + steps) }, mc, true);
    } else if (knob === 2) {
      const steps = this.steps("octaveTurn", delta, OCTAVE_COUNTS);
      if (steps !== 0) this.change({ octaves: clampOctaves(settings.octaves + steps) }, mc, true);
    } else if (knob === 3) {
      const gate = settings.gate + knobStep(delta, mc.shift) * (GATE_MAX - GATE_MIN);
      this.change({ gate: clamp(gate, GATE_MIN, GATE_MAX) }, mc, false);
    } else {
      const swing = settings.swing + knobStep(delta, mc.shift) * SWING_MAX;
      this.change({ swing: clamp(swing, 0, SWING_MAX) }, mc, false);
    }
  }

  /** Adds a turn to a stepped knob's counter and returns the whole steps it holds (and keeps the rest). */
  private steps(counter: "typeTurn" | "rateTurn" | "octaveTurn", delta: number, per: number) {
    this[counter] += delta;
    const steps = Math.trunc(this[counter] / per);
    this[counter] -= steps * per;
    return steps;
  }

  private applyPreset(preset: ArpPreset, mc: ModeContext): void {
    const { type, rate, octaves, gate } = preset;
    this.change({ type, rate, octaves, gate }, mc, true);
  }

  private toggleHold(mc: ModeContext): void {
    this.engine.setHold(!this.engine.holding);
    this.saveSoon(mc, true);
    mc.requestRender();
  }

  private change(patch: Partial<ArpSettings>, mc: ModeContext, now: boolean): void {
    const before = { ...this.settings };
    Object.assign(this.settings, patch);
    const same = (Object.keys(before) as Array<keyof ArpSettings>).every(
      (key) => before[key] === this.settings[key],
    );
    if (same) return;
    this.engine.refresh();
    this.saveSoon(mc, now);
    mc.requestRender();
  }

  private saveSoon(mc: ModeContext, now: boolean): void {
    this.options.timers.clear(this.saveTimer);
    if (now) {
      this.saveTimer = undefined;
      mc.saveState?.();
    } else {
      this.saveTimer = this.options.timers.set(() => {
        this.saveTimer = undefined;
        mc.saveState?.();
      }, SAVE_DELAY_MS);
    }
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const { rate, gate, swing, octaves, type } = this.settings;
    const typeInfo = ARP_TYPES.find((t) => t.id === type);
    const typeIndex = Math.max(0, ARP_TYPES.indexOf(typeInfo ?? ARP_TYPES[0]!));
    const rateLabel = REPEAT_RATES[rate]?.label ?? "";
    const tabs = { ...FULL, height: TAB_HEIGHT };
    const touched = (knob: number) => mc.touchedKnobs.has(knob);

    clear(left, FULL);
    drawTabs(left, tabs, {
      tabs: ["ARP", "", "HOLD", ""],
      active: [...(mc.pinned ? [0] : []), ...(this.engine.holding ? [2] : [])],
    });
    left.textAlign = "left";
    left.textBaseline = "top";
    left.fillStyle = theme.dimText;
    left.font = font(15);
    left.fillText("Arpeggiator", 24, TAB_HEIGHT + 10);
    left.fillStyle = theme.accent;
    left.font = font(44, "bold");
    left.fillText(
      fitText(left, `${typeInfo?.label ?? ""} · ${rateLabel}`, FULL.width - 44),
      22,
      TAB_HEIGHT + 34,
    );
    left.fillStyle = theme.dimText;
    left.font = font(14);
    const bpm = mc.fl.tempo > 0 ? mc.fl.tempo : FALLBACK_BPM;
    const locked = mc.fl.transport.playing ? "locked to FL's grid" : "free running";
    left.fillText(`${Math.round(bpm)} BPM, ${locked}`, 24, TAB_HEIGHT + 104);
    const knobs: KnobProps[] = [
      {
        label: "Type",
        valueText: typeInfo?.label ?? "",
        value: typeIndex / (ARP_TYPES.length - 1),
        touched: touched(0),
      },
      {
        label: "Rate",
        valueText: rateLabel,
        value: rate / (REPEAT_RATES.length - 1),
        touched: touched(1),
      },
      {
        label: "Octaves",
        valueText: String(octaves),
        value: (octaves - OCTAVES_MIN) / (OCTAVES_MAX - OCTAVES_MIN),
        touched: touched(2),
      },
      {
        label: "Gate",
        valueText: pct(gate),
        value: (gate - GATE_MIN) / (GATE_MAX - GATE_MIN),
        touched: touched(3),
      },
    ];
    drawKnobRow(left, KNOB_ROW, knobs);

    clear(right, FULL);
    drawTabs(right, tabs, {
      tabs: ARP_PRESETS.map((p) => p.label),
      active: ARP_PRESETS.flatMap((p, i) => (matchesPreset(this.settings, p) ? [i] : [])),
    });
    this.drawSequence(right);
    drawKnobRow(right, KNOB_ROW, [
      { label: "Swing", valueText: pct(swing), value: swing / SWING_MAX, touched: touched(4) },
    ]);
  }

  /** The round as a row of note names; the one that played last is highlighted. */
  private drawSequence(ctx: SKRSContext2D): void {
    const x0 = 20;
    const width = FULL.width - 40;
    const top = TAB_HEIGHT + 40;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText("Sequence", x0, TAB_HEIGHT + 10);
    const { notes, lit } = this.engine.view();
    if (notes.length === 0) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = font(18);
      ctx.fillText("Hold keys to arpeggiate", FULL.width / 2, top + 40);
      return;
    }
    const perRow = Math.floor((width + CELL_GAP) / (CELL_WIDTH + CELL_GAP));
    const shown = Math.min(notes.length, perRow * MAX_ROWS);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < shown; i++) {
      const x = x0 + (i % perRow) * (CELL_WIDTH + CELL_GAP);
      const y = top + Math.floor(i / perRow) * (CELL_HEIGHT + CELL_GAP);
      const on = lit.has(i);
      ctx.fillStyle = on ? theme.accent : theme.panelRaised;
      ctx.fillRect(x, y, CELL_WIDTH, CELL_HEIGHT);
      ctx.fillStyle = on ? theme.background : theme.text;
      ctx.font = font(16, on ? "bold" : "normal");
      ctx.fillText(noteName(notes[i] ?? 0), x + CELL_WIDTH / 2, y + CELL_HEIGHT / 2);
    }
    if (notes.length > shown) {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(13);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const rows = Math.ceil(shown / perRow);
      ctx.fillText(`+${notes.length - shown} more`, x0, top + rows * (CELL_HEIGHT + CELL_GAP));
    }
  }

  leds(leds: LedState, mc: ModeContext): void {
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
    DISPLAY_BUTTONS.slice(1).forEach((id, i) => {
      const display = i + 1;
      if (display === HOLD_BUTTON) leds.setLight(id, this.engine.holding ? "bright" : "dim");
      else if (display >= FIRST_PRESET_BUTTON) {
        const preset = ARP_PRESETS[display - FIRST_PRESET_BUTTON];
        leds.setLight(id, preset && matchesPreset(this.settings, preset) ? "bright" : "dim");
      } else leds.setLight(id, "off");
    });
    this.padLeds(leds, mc.fl);
  }

  /** Pads as in the pad mode; a pad whose note plays is pressed, a latched one bright. */
  private padLeds(leds: LedState, fl: FlState): void {
    const playing = this.engine.playingPads;
    const latched = new Set(this.engine.latchedPads);
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      if (playing.has(pad)) leds.setPad(pad, this.pads.keyLed(fl, "pressed"));
      else if (latched.has(pad)) leds.setPad(pad, this.pads.keyLed(fl, "bright"));
    }
  }
}
