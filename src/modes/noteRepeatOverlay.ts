// NOTE REPEAT overlay (hold NOTE REPEAT; display button 1 is its pin tab `NOTE RPT`). While it is
// open, held pads repeat their note at the chosen rate instead of playing once (Maschine's Note
// Repeat): KEYBOARD repeats the pad's note, PAD MODE the pad's channel, through PadState's own
// send path and held-pad targets. Releasing a pad ends its repeats; closing the overlay ends them
// all. SHIFT and ERASE keep the pads (the stack handles those before and after the page), and the
// STEP page cannot be open under an overlay, so nothing repeats there.
//
// In KEYBOARD and CHORDS the overlay is the arpeggiator panel instead (arpPanel.ts and
// arpeggiator.ts). It starts on the Type Repeat, which plays the held notes together with pin tab
// `NOTE RPT`; the other Types arpeggiate with pin tab `ARP`. It has the same overlay rules and its
// own settings, saved inside this page's state. PAD MODE stays Note Repeat. If the pad mode changes
// while the overlay is open, what played stops.
//
// As Maschine's page: display 2 LOCK (the pads keep repeating with the page closed), 3 HOLD (pads keep
// repeating once let go; the next press after all were let go starts anew), 4 GATE RESET (gate back
// to 100 %), 5–8 the note values 1/4 1/8 1/16 1/32. Knob 1 = rate (the note value), knob 2 = unit
// (Normal, Dotted, Triplet), knob 3 = gate (10–100 % of the interval), knob 4 = swing (0–50 %, every
// second repeat later). The settings and HOLD are saved with the page stack's state; LOCK is not, so
// pads never repeat after a start without having asked to. The clock is in repeatScheduler.ts.
//
// Velocity: the hit's own for the first note, then the pad's pressure for the repeats. A pad let go
// while its first note waits for its slot keeps its target until that note has played.
//
// MK3D_REPEAT_LOG=1 logs every slot that plays (the hardware check of the timing).
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlState } from "../fl/flState.js";
import type { HwEvent } from "../hw/events.js";
import type { LedState } from "../hw/leds.js";
import {
  TAB_HEIGHT,
  clear,
  drawKnobRow,
  drawTabs,
  font,
  theme,
  type KnobProps,
} from "../render/widgets.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import { pct } from "./format.js";
import { ArpPanel } from "./arpPanel.js";
import type { Mode, ModeContext } from "./mode.js";
import type { PadState } from "./padState.js";
import { clamp, knobStep } from "./knob.js";
import {
  DEFAULT_SETTINGS,
  FALLBACK_BPM,
  GATE_MAX,
  GATE_MIN,
  RATE_VALUES,
  REPEAT_RATES,
  RepeatScheduler,
  SWING_MAX,
  clampRate,
  hitVelocity,
  intervalBeats,
  FEEL_LABELS,
  feelPosition,
  rateFeel,
  rateIndex,
  ratePosition,
  rateValue,
  realTimers,
  songBeats,
  stepFeel,
  stepRate,
  type RepeatSettings,
  type RepeatTimers,
  type RepeatTiming,
  type RepeatTrace,
} from "./repeatScheduler.js";

/** Knob counts that move the rate one step (a turn is 1000 counts). */
const RATE_COUNTS = 120;
/** The settings are written this long after the last knob turn. */
const SAVE_DELAY_MS = 400;
const LOCK_BUTTON = 1; // display 2
const HOLD_BUTTON = 2; // display 3
const GATE_RESET_BUTTON = 3; // display 4
const FIRST_VALUE_BUTTON = 4; // display 5
const KNOB_ROW = { ...FULL, y: FULL.height - 110, height: 110 };

export interface NoteRepeatOptions {
  /** Milliseconds; `performance.now()` by default (and the clock of FlState's SONG_POS stamps). */
  clock?: () => number;
  timers?: RepeatTimers;
  /** 0 ≤ x < 1 for the arpeggiator's Random; `Math.random` by default. */
  random?: () => number;
  /** Every slot that plays; MK3D_REPEAT_LOG=1 logs them by default. */
  trace?: (slot: RepeatTrace) => void;
}

function logSlot(slot: RepeatTrace): void {
  const ms = (value: number) => (Number.isFinite(value) ? value.toFixed(1) : "-");
  const beat = slot.beats === undefined ? "free" : slot.beats.toFixed(3);
  console.log(
    `[repeat] n=${slot.n} gap=${ms(slot.gapMs)} late=${ms(slot.lateMs)} ` +
      `beat=${beat} reading=${ms(slot.readingMs)}`,
  );
}

export class NoteRepeatOverlay implements Mode {
  readonly name = "noteRepeat";
  readonly settings: RepeatSettings = { ...DEFAULT_SETTINGS };
  /** The arpeggiator (KEYBOARD and CHORDS). */
  readonly arp: ArpPanel;
  private readonly scheduler: RepeatScheduler;
  private readonly timers: RepeatTimers;
  private fl: FlState | undefined;
  private mc: ModeContext | undefined;
  private rateTurn = 0;
  private unitTurn = 0;
  /** LOCK: the pads keep repeating with the page closed. */
  private locked = false;
  /** HOLD: pads keep repeating once let go. */
  private hold = false;
  /** The pads that are down (HOLD keeps others repeating). */
  private readonly down = new Set<number>();
  private saveTimer: unknown;
  /** Which of the two is running: the pad mode when it last changed. */
  private arpeggiating = false;

  constructor(
    private readonly pads: PadState,
    options: NoteRepeatOptions = {},
  ) {
    this.timers = options.timers ?? realTimers;
    this.arpeggiating = this.pads.mode !== "channels";
    const trace = options.trace ?? (process.env.MK3D_REPEAT_LOG === "1" ? logSlot : undefined);
    this.arp = new ArpPanel(pads, {
      trace,
      lock: {
        on: () => this.locked,
        toggle: () => this.toggleLock(),
      },
      clock: options.clock,
      timers: this.timers,
      timing: () => this.timing(),
      random: options.random,
      requestLeds: () => this.mc?.requestLeds?.(),
    });
    this.scheduler = new RepeatScheduler({
      player: {
        on: (pad, velocity) => {
          this.pads.soundRepeat(pad, velocity);
          this.mc?.requestLeds?.();
        },
        off: (pad) => {
          this.pads.silenceRepeat(pad);
          this.mc?.requestLeds?.();
        },
        ended: (pad) => {
          this.pads.endRepeat(pad);
          this.mc?.requestLeds?.();
        },
      },
      trace,
      timing: () => this.timing(),
      settings: () => this.settings,
      clock: options.clock,
      timers: this.timers,
    });
  }

  /** The pads Note Repeat has going now. */
  get repeatingPads(): number[] {
    return [...this.scheduler.repeating];
  }

  /** Is any pad repeating (or arpeggiating) now? */
  get repeating(): boolean {
    return this.scheduler.active || this.arp.active;
  }

  /** The pads play the arpeggiator now: KEYBOARD or CHORDS. */
  get arpeggiates(): boolean {
    return this.pads.mode !== "channels";
  }

  readonly persisted = {
    save: () => ({ ...this.settings, hold: this.hold, arp: this.arp.save() }),
    load: (data: unknown) => {
      const saved = data as
        (Partial<Record<keyof RepeatSettings, unknown>> & { arp?: unknown; hold?: unknown }) | null;
      this.arp.load(saved?.arp);
      const number = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : undefined;
      const rate = number(saved?.rate);
      const gate = number(saved?.gate);
      const swing = number(saved?.swing);
      if (rate !== undefined) this.settings.rate = clampRate(rate);
      if (gate !== undefined) this.settings.gate = clamp(gate, GATE_MIN, GATE_MAX);
      if (swing !== undefined) this.settings.swing = clamp(swing, 0, SWING_MAX);
      if (typeof saved?.hold === "boolean") this.hold = saved.hold;
    },
  };

  private timing(): RepeatTiming {
    const fl = this.fl;
    if (!fl) return { bpm: 0, playing: false };
    const at = fl.songPosAt;
    return {
      bpm: fl.tempo,
      playing: fl.transport.playing,
      songPos: at === undefined ? undefined : { beats: songBeats(fl.songPos, fl.ppq), at },
    };
  }

  enter(mc: ModeContext): void {
    this.fl = mc.fl;
    this.mc = mc;
    this.arp.enter(mc);
    this.syncKind();
  }

  /** The pad mode changed (SHIFT + PAD MODE ...) while open: stop what the other kind played. */
  private syncKind(): void {
    const arpeggiating = this.arpeggiates;
    if (arpeggiating === this.arpeggiating) return;
    this.arpeggiating = arpeggiating;
    this.stopPlaying();
    this.mc?.requestLeds?.();
  }

  private stopPlaying(): void {
    const repeating = this.scheduler.repeating;
    this.scheduler.stopAll();
    for (const pad of repeating) this.pads.endRepeat(pad);
    this.down.clear();
    this.arp.stop();
  }

  /** LOCK keeps the page's pads while it is closed (the stack asks). */
  locksPads(): boolean {
    return this.locked;
  }

  /** The device went away: nothing may stay on, LOCK or not. */
  stopPads(): void {
    this.stopPlaying();
    this.mc?.requestLeds?.();
  }

  private toggleLock(): void {
    this.locked = !this.locked;
    this.mc?.requestLeds?.();
    this.mc?.requestRender();
  }

  /** Closed, replaced or the device went away: no repeat and no note may stay on, unless LOCK. */
  leave(): void {
    if (!this.locked) {
      this.arp.leave();
      this.stopPlaying();
    }
    this.mc?.requestLeds?.();
    if (this.saveTimer !== undefined) {
      this.timers.clear(this.saveTimer);
      this.saveTimer = undefined;
      this.mc?.saveState?.();
    }
  }

  onFlChange(section: string, mc: ModeContext): void {
    this.fl = mc.fl;
    this.mc = mc;
    this.syncKind();
    if (section === "transport" || (section === "songPos" && mc.fl.transport.playing)) {
      this.scheduler.refresh();
      this.arp.onFlChange();
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    this.fl = mc.fl;
    this.mc = mc;
    this.syncKind();
    if (this.arpeggiating) return this.arp.onEvent(event, mc);
    switch (event.type) {
      case "pad":
        return this.onPad(event, mc);
      case "encoder":
        if (event.index > 3) return false;
        this.turn(event.index, event.delta, mc);
        return true;
      case "button": {
        // GROUP A–H are not ours: the page stack turns them into channel banks.
        const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
        if (display < 0) return false;
        // Display buttons never reach the page underneath.
        if (event.pressed) this.pressDisplay(display, mc);
        return true;
      }
      default:
        return false;
    }
  }

  private onPad(event: Extract<HwEvent, { type: "pad" }>, mc: ModeContext): boolean {
    const { pad } = event;
    if (event.phase === "down") {
      if (mc.erase) return false; // ERASE takes the pad
      // HOLD: the first press after every pad was let go starts anew.
      if (this.hold && this.down.size === 0) this.stopPlaying();
      this.down.add(pad);
      if (this.pads.startRepeat(pad, mc)) {
        this.scheduler.start(pad, hitVelocity(event.velocity ?? 0), event.pressure);
      }
    } else if (event.phase === "move") {
      if (this.scheduler.isRepeating(pad)) this.scheduler.setPressure(pad, event.pressure);
    } else {
      this.down.delete(pad);
      if (this.hold) return true; // it goes on until the next press
      if (!this.scheduler.release(pad)) this.pads.endRepeat(pad);
    }
    return true; // move and up are ours too, so no pad plays a note under the page
  }

  private pressDisplay(display: number, mc: ModeContext): void {
    const value = RATE_VALUES[display - FIRST_VALUE_BUTTON];
    if (value !== undefined) this.setRate(rateIndex(value, rateFeel(this.settings.rate)), mc);
    else if (display === LOCK_BUTTON) this.toggleLock();
    else if (display === HOLD_BUTTON) this.toggleHold(mc);
    else if (display === GATE_RESET_BUTTON) this.change({ gate: GATE_MAX }, mc, true);
  }

  private toggleHold(mc: ModeContext): void {
    this.hold = !this.hold;
    if (!this.hold) {
      for (const pad of this.scheduler.repeating) {
        if (this.down.has(pad)) continue;
        this.scheduler.stop(pad);
        this.pads.endRepeat(pad);
      }
    }
    mc.saveState?.();
    mc.requestRender();
  }

  /** Two touches of a knob: Gate and Swing back to where they start. */
  resetKnob(knob: number, mc: ModeContext): boolean {
    if (this.arpeggiating) return this.arp.resetKnob(knob, mc);
    if (knob === 2) this.change({ gate: DEFAULT_SETTINGS.gate }, mc, true);
    else if (knob === 3) this.change({ swing: DEFAULT_SETTINGS.swing }, mc, true);
    else return false;
    return true;
  }

  private turn(knob: number, delta: number, mc: ModeContext): void {
    if (knob === 0) {
      this.rateTurn += delta;
      const steps = Math.trunc(this.rateTurn / RATE_COUNTS);
      if (steps === 0) return;
      this.rateTurn -= steps * RATE_COUNTS;
      this.setRate(stepRate(this.settings.rate, steps), mc);
    } else if (knob === 1) {
      this.unitTurn += delta;
      const steps = Math.trunc(this.unitTurn / RATE_COUNTS);
      if (steps === 0) return;
      this.unitTurn -= steps * RATE_COUNTS;
      this.setRate(stepFeel(this.settings.rate, steps), mc);
    } else if (knob === 2) {
      const gate = this.settings.gate + knobStep(delta, mc.shift) * (GATE_MAX - GATE_MIN);
      this.change({ gate: clamp(gate, GATE_MIN, GATE_MAX) }, mc, false);
    } else {
      const swing = this.settings.swing + knobStep(delta, mc.shift) * SWING_MAX;
      this.change({ swing: clamp(swing, 0, SWING_MAX) }, mc, false);
    }
  }

  private setRate(rate: number, mc: ModeContext): void {
    this.change({ rate: clampRate(rate) }, mc, true);
  }

  private change(patch: Partial<RepeatSettings>, mc: ModeContext, now: boolean): void {
    const before = { ...this.settings };
    Object.assign(this.settings, patch);
    if (
      before.rate === this.settings.rate &&
      before.gate === this.settings.gate &&
      before.swing === this.settings.swing
    ) {
      return;
    }
    this.scheduler.refresh();
    this.timers.clear(this.saveTimer);
    if (now) {
      this.saveTimer = undefined;
      mc.saveState?.();
    } else {
      this.saveTimer = this.timers.set(() => {
        this.saveTimer = undefined;
        mc.saveState?.();
      }, SAVE_DELAY_MS);
    }
    mc.requestRender();
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    this.mc = mc;
    this.syncKind();
    if (this.arpeggiating) {
      this.arp.render(left, right, mc);
      return;
    }
    const { rate, gate, swing } = this.settings;
    const tabs = { ...FULL, height: TAB_HEIGHT };
    const valueButton = RATE_VALUES.indexOf(rateValue(rate));

    clear(left, FULL);
    drawTabs(left, tabs, {
      tabs: ["NOTE RPT", "LOCK", "HOLD", "GATE RESET"],
      active: [
        ...(mc.pinned ? [0] : []),
        ...(this.locked ? [LOCK_BUTTON] : []),
        ...(this.hold ? [HOLD_BUTTON] : []),
      ],
    });
    left.textAlign = "left";
    left.textBaseline = "top";
    left.fillStyle = theme.dimText;
    left.font = font(15);
    left.fillText("Note Repeat", 24, TAB_HEIGHT + 10);
    left.fillStyle = theme.accent;
    left.font = font(60, "bold");
    left.fillText(REPEAT_RATES[rate]?.label ?? "", 22, TAB_HEIGHT + 28);
    left.fillStyle = theme.dimText;
    left.font = font(14);
    const fl = mc.fl;
    const bpm = fl.tempo > 0 ? fl.tempo : FALLBACK_BPM;
    const locked = fl.transport.playing ? "locked to FL's grid" : "free running";
    left.fillText(`${Math.round(bpm)} BPM, ${locked}`, 24, TAB_HEIGHT + 104);
    const touched = (knob: number) => mc.touchedKnobs.has(knob);
    const knobs: KnobProps[] = [
      {
        label: "Rate",
        valueText: REPEAT_RATES[rate]?.label ?? "",
        value: ratePosition(rate),
        touched: touched(0),
      },
      {
        label: "Unit",
        valueText: FEEL_LABELS[rateFeel(rate)],
        value: feelPosition(rate),
        touched: touched(1),
      },
      {
        label: "Gate",
        valueText: pct(gate),
        value: (gate - GATE_MIN) / (GATE_MAX - GATE_MIN),
        touched: touched(2),
      },
      { label: "Swing", valueText: pct(swing), value: swing / SWING_MAX, touched: touched(3) },
    ];
    drawKnobRow(left, KNOB_ROW, knobs);

    clear(right, FULL);
    drawTabs(right, tabs, {
      tabs: RATE_VALUES.map((value) => `1/${value}`),
      active: [valueButton],
    });
    this.drawPattern(right);
  }

  /** Two beats of repeats: where each note starts and how long it sounds. */
  private drawPattern(ctx: SKRSContext2D): void {
    const { rate, gate, swing } = this.settings;
    const beats = 2;
    const x0 = 20;
    const width = FULL.width - 40;
    const top = TAB_HEIGHT + 40;
    const height = 70;
    const perBeat = width / beats;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText("Two beats", x0, TAB_HEIGHT + 10);
    clear(ctx, { x: x0, y: top, width, height }, theme.background);
    ctx.fillStyle = theme.line;
    for (let beat = 0; beat <= beats; beat++) {
      ctx.fillRect(
        Math.round(x0 + beat * perBeat) - (beat === beats ? 1 : 0),
        top - 6,
        1,
        height + 12,
      );
    }
    const interval = intervalBeats(rate);
    for (let n = 0; n * interval < beats - 1e-9; n++) {
      const start = n * interval + (n % 2 === 1 ? swing * interval : 0);
      const length = Math.min(gate * interval, beats - start);
      ctx.fillStyle = n % 2 === 1 ? theme.selected : theme.accent;
      const x = x0 + start * perBeat;
      ctx.fillRect(
        Math.round(x) + 1,
        top + 8,
        Math.max(2, Math.round(length * perBeat) - 1),
        height - 16,
      );
    }
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13);
    ctx.textAlign = "center";
    for (let beat = 0; beat < beats; beat++) {
      ctx.fillText(String(beat + 1), x0 + beat * perBeat + perBeat / 2, top + height + 12);
    }
  }

  leds(leds: LedState, mc: ModeContext): void {
    if (this.arpeggiates) {
      this.arp.leds(leds, mc);
      return;
    }
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
    const { rate } = this.settings;
    DISPLAY_BUTTONS.forEach((id, display) => {
      const value = RATE_VALUES[display - FIRST_VALUE_BUTTON];
      if (value !== undefined) leds.setLight(id, value === rateValue(rate) ? "bright" : "dim");
      else if (display === LOCK_BUTTON) leds.setLight(id, this.locked ? "bright" : "dim");
      else if (display === HOLD_BUTTON) leds.setLight(id, this.hold ? "bright" : "dim");
      else if (display === GATE_RESET_BUTTON) leds.setLight(id, "dim");
    });
    // The pads are the pad mode's (PadState lights them, a repeating pad flashes with each repeat).
  }
}
