// NOTE REPEAT overlay (hold NOTE REPEAT; display button 1 is its pin tab `NOTE RPT`). While it is
// open, held pads repeat their note at the chosen rate instead of playing once (Maschine's Note
// Repeat): KEYBOARD repeats the pad's note, PAD MODE the pad's channel, through PadState's own
// send path and held-pad targets. Releasing a pad ends its repeats; closing the overlay ends them
// all. SHIFT and ERASE keep the pads (the stack handles those before and after the page), and the
// STEP page cannot be open under an overlay, so nothing repeats there.
//
// In KEYBOARD and CHORDS the overlay is the arpeggiator instead (pin tab `ARP`, arpPanel.ts and
// arpeggiator.ts): the same overlay rules, its own settings, saved inside this page's state. PAD
// MODE stays Note Repeat. If the pad mode changes while the overlay is open, what played stops.
//
// Display 2–8 pick the rate (1/4 1/8 1/16 1/32 1/8T 1/16T 1/32T); knob 1 = rate, knob 2 = gate
// (10–100 % of the interval), knob 3 = swing (0–50 %, every second repeat later). The settings are
// saved with the page stack's state. The clock is in repeatScheduler.ts.
//
// Velocity: the hit's own for the first note, then the pad's pressure for the repeats.
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
import { knobStep } from "./knob.js";
import {
  DEFAULT_SETTINGS,
  FALLBACK_BPM,
  GATE_MAX,
  GATE_MIN,
  REPEAT_RATES,
  RepeatScheduler,
  SWING_MAX,
  clampRate,
  hitVelocity,
  intervalBeats,
  realTimers,
  songBeats,
  type RepeatSettings,
  type RepeatTimers,
  type RepeatTiming,
} from "./repeatScheduler.js";

/** Knob counts that move the rate one step (a turn is 1000 counts). */
const RATE_COUNTS = 120;
/** The settings are written this long after the last knob turn. */
const SAVE_DELAY_MS = 400;
const FIRST_RATE_BUTTON = 1;
const LEFT_RATES = 3;
const KNOB_ROW = { ...FULL, y: FULL.height - 110, height: 110 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export interface NoteRepeatOptions {
  /** Milliseconds; `performance.now()` by default (and the clock of FlState's SONG_POS stamps). */
  clock?: () => number;
  timers?: RepeatTimers;
  /** 0 ≤ x < 1 for the arpeggiator's Random; `Math.random` by default. */
  random?: () => number;
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
  private saveTimer: unknown;
  /** Which of the two is running: the pad mode when it last changed. */
  private arpeggiating = false;

  constructor(
    private readonly pads: PadState,
    options: NoteRepeatOptions = {},
  ) {
    this.timers = options.timers ?? realTimers;
    this.arpeggiating = this.pads.mode !== "channels";
    this.arp = new ArpPanel(pads, {
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
      },
      timing: () => this.timing(),
      settings: () => this.settings,
      clock: options.clock,
      timers: this.timers,
    });
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
    save: () => ({ ...this.settings, arp: this.arp.save() }),
    load: (data: unknown) => {
      const saved = data as
        (Partial<Record<keyof RepeatSettings, unknown>> & { arp?: unknown }) | null;
      this.arp.load(saved?.arp);
      const number = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : undefined;
      const rate = number(saved?.rate);
      const gate = number(saved?.gate);
      const swing = number(saved?.swing);
      if (rate !== undefined) this.settings.rate = clampRate(rate);
      if (gate !== undefined) this.settings.gate = clamp(gate, GATE_MIN, GATE_MAX);
      if (swing !== undefined) this.settings.swing = clamp(swing, 0, SWING_MAX);
    },
  };

  private timing(): RepeatTiming {
    const fl = this.fl;
    if (!fl) return { bpm: 0, playing: false };
    const at = fl.songPosAt;
    return {
      bpm: fl.tempo,
      playing: fl.transport.playing,
      songPos: at === undefined ? undefined : { beats: songBeats(fl.songPos), at },
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
    this.arp.stop();
  }

  /** Closed, replaced or the device went away: no repeat and no note may stay on. */
  leave(): void {
    this.arp.leave();
    const repeating = this.scheduler.repeating;
    this.scheduler.stopAll();
    for (const pad of repeating) this.pads.endRepeat(pad);
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
        if (event.index > 2) return false;
        this.turn(event.index, event.delta, mc);
        return true;
      case "button": {
        // GROUP A–H are not ours: the page stack turns them into channel banks.
        const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
        if (display < 0) return false;
        // Display buttons never reach the page underneath.
        if (event.pressed && display >= FIRST_RATE_BUTTON) {
          this.setRate(display - FIRST_RATE_BUTTON, mc);
        }
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
      if (this.pads.startRepeat(pad, mc)) {
        this.scheduler.start(pad, hitVelocity(event.velocity ?? 0), event.pressure);
      }
    } else if (event.phase === "move") {
      if (this.scheduler.isRepeating(pad)) this.scheduler.setPressure(pad, event.pressure);
    } else {
      this.scheduler.stop(pad);
      this.pads.endRepeat(pad);
    }
    return true; // move and up are ours too, so no pad plays a note under the page
  }

  private turn(knob: number, delta: number, mc: ModeContext): void {
    if (knob === 0) {
      this.rateTurn += delta;
      const steps = Math.trunc(this.rateTurn / RATE_COUNTS);
      if (steps === 0) return;
      this.rateTurn -= steps * RATE_COUNTS;
      this.setRate(this.settings.rate + steps, mc);
    } else if (knob === 1) {
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
    const leftRates = REPEAT_RATES.slice(0, LEFT_RATES).map((r) => r.label);
    const rightRates = REPEAT_RATES.slice(LEFT_RATES).map((r) => r.label);

    clear(left, FULL);
    drawTabs(left, tabs, {
      tabs: ["NOTE RPT", ...leftRates],
      active: [...(mc.pinned ? [0] : []), ...(rate < LEFT_RATES ? [rate + 1] : [])],
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
        value: rate / (REPEAT_RATES.length - 1),
        touched: touched(0),
      },
      {
        label: "Gate",
        valueText: pct(gate),
        value: (gate - GATE_MIN) / (GATE_MAX - GATE_MIN),
        touched: touched(1),
      },
      { label: "Swing", valueText: pct(swing), value: swing / SWING_MAX, touched: touched(2) },
    ];
    drawKnobRow(left, KNOB_ROW, knobs);

    clear(right, FULL);
    drawTabs(right, tabs, {
      tabs: rightRates,
      active: rate >= LEFT_RATES ? [rate - LEFT_RATES] : [],
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
    DISPLAY_BUTTONS.slice(FIRST_RATE_BUTTON).forEach((id, i) => {
      leds.setLight(id, i === this.settings.rate ? "bright" : "dim");
    });
    // The pads are the pad mode's (PadState lights them, a repeating pad flashes with each repeat).
  }
}
