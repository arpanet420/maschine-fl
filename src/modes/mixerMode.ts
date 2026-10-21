// Mixer page (MIXER, a main page): Maschine's mixer with FL's data. Banks of 8 mixer tracks, one
// strip per column (4 per screen): display buttons 1–8 and GROUP A–H select a track, knobs 1–8
// are the volume (or the pan) of the track in the column below them. MUTE or SOLO held turns the
// display and group buttons into mute or solo toggles (the page claims both buttons, so no overlay
// opens). Pads are not used here.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlSection, FlState } from "../fl/flState.js";
import type { MixerEntry, TrackProp } from "../fl/sysex.js";
import type { Rect } from "../hw/display.js";
import type { HwEvent } from "../hw/events.js";
import type { ButtonId } from "../hw/ids.js";
import type { ColorLedId, LedState, MonoLedId } from "../hw/leds.js";
import { LED_OFF } from "../hw/palette.js";
import {
  drawEmptyStrip,
  drawMixerStrip,
  drawMixerTabs,
  peakFraction,
  stripCells,
} from "../render/mixerStrip.js";
import { SCREEN_COLUMNS, TAB_HEIGHT, clear, theme } from "../render/widgets.js";
import { FULL } from "./draw.js";
import { flColorToCss, isDefaultColor, flColorToPalette, panText, pct } from "./format.js";
import { RenderSoon, clamp, isLive, knobStep } from "./knob.js";
import type { Mode, ModeContext, ViewCommand } from "./mode.js";
import { pageStart } from "./channelMode.js";

/** Tracks per bank: one per knob and display button. */
export const BANK = 8;
const GROUPS: readonly ColorLedId[] = [
  "groupA",
  "groupB",
  "groupC",
  "groupD",
  "groupE",
  "groupF",
  "groupG",
  "groupH",
];
const DISPLAY_BUTTONS: readonly MonoLedId[] = [
  "display1",
  "display2",
  "display3",
  "display4",
  "display5",
  "display6",
  "display7",
  "display8",
];
/** What one detent of the 4D encoder moves a 0–1 value (Shift: a tenth of it). */
const NAV_STEP = 0.01;
/** A peak-hold tick stays this long, then falls this much of the meter's height per second. */
const HOLD_MS = 700;
const FALL_PER_SECOND = 0.6;

type Prop = "volume" | "pan" | "mute" | "solo";
type Held = "mute" | "solo";

interface Pending {
  value: number;
  at: number;
}

interface Hold {
  height: number;
  at: number;
}

const WHAT: Record<Prop, TrackProp> = { volume: "volume", pan: "pan", mute: "mute", solo: "solo" };

/** First track of the bank that holds `track`. */
export const bankStart = (track: number) => Math.floor(track / BANK) * BANK;

export class MixerMode implements Mode {
  readonly name = "mixer";
  private offset = 0;
  /** Knobs and the 4D encoder edit the pan instead of the volume. */
  private panMode = false;
  private readonly held = new Set<Held>();
  /** Values we set ourselves, for a moment after a turn or a toggle: `${track}:${prop}`. */
  private readonly pending = new Map<string, Pending>();
  private select: Pending | undefined;
  private lastSelected = 0;
  private lastView: string | undefined;
  private readonly holds = new Map<number, [Hold, Hold]>();
  private holdTimer: NodeJS.Timeout | undefined;
  private readonly redraw = new RenderSoon();

  constructor(private readonly now: () => number = Date.now) {}

  enter(mc: ModeContext): void {
    this.pending.clear();
    this.select = undefined;
    this.held.clear();
    this.holds.clear();
    this.lastSelected = mc.fl.selectedTrack;
    this.offset = bankStart(this.lastSelected);
    this.lastView = undefined;
    this.sendView(mc);
  }

  /** An overlay closed: resend the VIEW and keep everything else. */
  resume(mc: ModeContext): void {
    this.lastView = undefined;
    this.sendView(mc);
  }

  view(mc: ModeContext): ViewCommand {
    const channel = mc.fl.selectedChannel.index;
    return {
      type: "view",
      channelOffset: channel === null ? 0 : pageStart(channel),
      mixerOffset: this.offset,
      patternOffset: 0,
      stepOffset: 0,
      meters: true,
      presets: false,
      patternGrid: false,
      params: [],
    };
  }

  private sendView(mc: ModeContext): void {
    const view = this.view(mc);
    const json = JSON.stringify(view);
    if (json === this.lastView) return;
    this.lastView = json;
    mc.send(view);
  }

  /** The Mixer takes MUTE and SOLO: held, they switch the strip buttons to mute and solo. */
  claimsPageButton(id: ButtonId): boolean {
    return id === "mute" || id === "solo";
  }

  onFlChange(section: FlSection, mc: ModeContext): void {
    const { fl } = mc;
    if (section === "selectedTrack") {
      const selected = fl.selectedTrack;
      if (this.select && selected === this.select.value) this.select = undefined;
      if (selected !== this.lastSelected) {
        this.lastSelected = selected;
        if (!this.live(this.select)) this.setOffset(bankStart(selected), mc);
      }
    } else if (section === "mixer" && fl.mixerTotal > 0) {
      const last = bankStart(fl.mixerTotal - 1);
      if (this.offset > last) this.setOffset(last, mc);
    } else if (section === "selectedChannel") {
      this.sendView(mc);
    } else if (section === "meters") {
      this.updateHolds(mc);
    }
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    switch (event.type) {
      case "encoder":
        if (event.index >= BANK) return false;
        this.turn(this.offset + event.index, event.delta, mc);
        return true;
      case "nav":
        return this.onNav(event, mc);
      case "button":
        return this.onButton(event.id, event.pressed, mc);
      default:
        return false;
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private onNav(event: Extract<HwEvent, { type: "nav" }>, mc: ModeContext): boolean {
    if (event.action === "turn") {
      const track = this.selected(mc);
      if (track < mc.fl.mixerTotal) {
        this.turnBy(track, (event.delta * NAV_STEP) / (mc.shift ? 10 : 1), mc);
      }
      return true;
    }
    if (event.action === "push") {
      if (event.pressed) {
        this.panMode = !this.panMode;
        mc.requestRender();
      }
      return true;
    }
    if (event.action === "tilt" && (event.direction === "left" || event.direction === "right")) {
      if (event.pressed) this.moveSelection(event.direction === "left" ? -1 : 1, mc);
      return true;
    }
    return false;
  }

  private onButton(id: ButtonId, pressed: boolean, mc: ModeContext): boolean {
    if (id === "mute" || id === "solo") {
      if (pressed) this.held.add(id);
      else this.held.delete(id);
      return true;
    }
    // display buttons 1–8 and GROUP A–H are the same 8 strips
    const strip = Math.max(
      DISPLAY_BUTTONS.findIndex((button) => button === id),
      GROUPS.findIndex((group) => group === id),
    );
    if (strip >= 0) {
      if (pressed) this.pressStrip(strip, mc);
      return true;
    }
    if (id === "arrowLeft" || id === "arrowRight") {
      if (pressed) this.setOffset(this.offset + (id === "arrowLeft" ? -BANK : BANK), mc);
      return true;
    }
    return false;
  }

  /** Select the strip's track; with MUTE or SOLO held, toggle its mute or solo instead. */
  private pressStrip(strip: number, mc: ModeContext): void {
    const track = this.offset + strip;
    if (track >= mc.fl.mixerTotal) return;
    if (this.held.has("mute")) this.toggle(track, "mute", mc);
    else if (this.held.has("solo")) this.toggle(track, "solo", mc);
    else this.selectTrack(track, mc);
  }

  private prop(): "volume" | "pan" {
    return this.panMode ? "pan" : "volume";
  }

  private turn(track: number, delta: number, mc: ModeContext): void {
    if (track < mc.fl.mixerTotal) this.turnBy(track, knobStep(delta, mc.shift), mc);
  }

  /** Move the volume or pan (0–1 on the wire) of `track` by `step`. */
  private turnBy(track: number, step: number, mc: ModeContext): void {
    const prop = this.prop();
    const old = this.valueOf(track, prop, mc.fl);
    if (old === undefined) return; // FL hasn't reported the track yet
    const value = clamp(old + step, 0, 1);
    if (value === old) return;
    this.pending.set(key(track, prop), { value, at: this.now() });
    mc.send({ type: "setTrack", index: track, what: WHAT[prop], value });
    this.redraw.request(mc);
  }

  private toggle(track: number, prop: "mute" | "solo", mc: ModeContext): void {
    const old = this.valueOf(track, prop, mc.fl);
    if (old === undefined) return;
    const value = old > 0.5 ? 0 : 1;
    this.pending.set(key(track, prop), { value, at: this.now() });
    mc.send({ type: "setTrack", index: track, what: WHAT[prop], value });
    this.redraw.request(mc);
  }

  private moveSelection(delta: number, mc: ModeContext): void {
    const total = mc.fl.mixerTotal;
    if (total === 0) return;
    const track = clamp(this.selected(mc) + delta, 0, total - 1);
    if (track !== this.selected(mc)) this.selectTrack(track, mc);
  }

  private selectTrack(track: number, mc: ModeContext): void {
    this.select = { value: track, at: this.now() };
    mc.send({ type: "selectTrack", index: track });
    // the bank follows the selection when it leaves it
    this.setOffset(bankStart(track), mc);
    this.redraw.request(mc);
  }

  // ── Bank ───────────────────────────────────────────────────────────────────

  private setOffset(wanted: number, mc: ModeContext): void {
    const total = mc.fl.mixerTotal;
    const offset = clamp(wanted, 0, total > 0 ? bankStart(total - 1) : 0);
    if (offset === this.offset) return;
    this.offset = offset;
    this.sendView(mc);
    mc.requestRender();
  }

  // ── Values: ours for a moment after a turn, then FL's ─────────────────────

  private live(pending: Pending | undefined): pending is Pending {
    return isLive(pending, this.now());
  }

  private selected(mc: ModeContext): number {
    return this.live(this.select) ? this.select.value : mc.fl.selectedTrack;
  }

  /** The wire value (0–1; pan as `(pan + 1) / 2`, mute and solo 0 or 1); undefined without FL's data. */
  private valueOf(track: number, prop: Prop, fl: FlState): number | undefined {
    const pending = this.pending.get(key(track, prop));
    if (this.live(pending)) return pending.value;
    const entry = fl.mixer.get(track);
    if (!entry) return undefined;
    switch (prop) {
      case "volume":
        return entry.volume;
      case "pan":
        return (entry.pan + 1) / 2;
      case "mute":
        return entry.muted ? 1 : 0;
      case "solo":
        return entry.solo ? 1 : 0;
    }
  }

  private flag(track: number, prop: "mute" | "solo", fl: FlState): boolean {
    return (this.valueOf(track, prop, fl) ?? 0) > 0.5;
  }

  // ── Peak hold ──────────────────────────────────────────────────────────────

  /** A peak-hold tick's height now: held for a moment, then falling. */
  private holdHeight(hold: Hold): number {
    const idle = this.now() - hold.at - HOLD_MS;
    return idle <= 0 ? hold.height : Math.max(0, hold.height - (idle / 1000) * FALL_PER_SECOND);
  }

  private updateHolds(mc: ModeContext): void {
    const now = this.now();
    for (let strip = 0; strip < BANK; strip++) {
      const track = this.offset + strip;
      const peak = mc.fl.meters.get(track);
      if (!peak) continue;
      const holds = this.holds.get(track) ?? [
        { height: 0, at: now },
        { height: 0, at: now },
      ];
      [peak.left, peak.right].forEach((level, side) => {
        const hold = holds[side];
        const height = peakFraction(level);
        if (hold && height >= this.holdHeight(hold)) holds[side] = { height, at: now };
      });
      this.holds.set(track, holds);
    }
    this.fallLater(mc);
  }

  /** The ticks fall without FL sending anything: redraw until they are down. */
  private fallLater(mc: ModeContext): void {
    if (this.holdTimer) return;
    const busy = [...this.holds.values()].some((pair) =>
      pair.some((hold) => this.holdHeight(hold) > 0),
    );
    if (!busy) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      mc.requestRender();
      this.fallLater(mc);
    }, 100);
    this.holdTimer.unref();
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const selected = this.selected(mc);
    [left, right].forEach((ctx, screen) => {
      const base = screen * SCREEN_COLUMNS;
      clear(ctx, FULL, theme.background);
      const labels = Array.from({ length: SCREEN_COLUMNS }, (_, i) => {
        const track = this.offset + base + i;
        if (track >= mc.fl.mixerTotal) return undefined;
        return track === 0 ? "M" : String(track);
      });
      drawMixerTabs(ctx, { ...FULL, height: TAB_HEIGHT }, labels, selected - this.offset - base);
      const cells = stripCells(
        { ...FULL, y: TAB_HEIGHT, height: FULL.height - TAB_HEIGHT },
        SCREEN_COLUMNS,
      );
      cells.forEach((cell, i) => {
        const track = this.offset + base + i;
        if (track >= mc.fl.mixerTotal) drawEmptyStrip(ctx, cell);
        else this.drawStrip(ctx, cell, track, base + i, selected, mc);
      });
    });
  }

  private drawStrip(
    ctx: SKRSContext2D,
    cell: Rect,
    track: number,
    knob: number,
    selected: number,
    mc: ModeContext,
  ): void {
    const { fl } = mc;
    const entry: MixerEntry | undefined = fl.mixer.get(track);
    const prop = this.prop();
    const norm = this.valueOf(track, prop, fl) ?? 0;
    const peak = fl.meters.get(track);
    const holds = this.holds.get(track);
    drawMixerStrip(ctx, cell, {
      name: entry?.name || (track === 0 ? "Master" : `Insert ${track}`),
      color: flColorToCss(entry?.color ?? 0),
      uncolored: isDefaultColor(entry?.color ?? 0),
      selected: track === selected,
      muted: this.flag(track, "mute", fl),
      solo: this.flag(track, "solo", fl),
      armed: entry?.armed ?? false,
      volume: this.valueOf(track, "volume", fl) ?? 0,
      meter: [peakFraction(peak?.left ?? 0), peakFraction(peak?.right ?? 0)],
      hold: [
        holds?.[0] ? this.holdHeight(holds[0]) : 0,
        holds?.[1] ? this.holdHeight(holds[1]) : 0,
      ],
      scale: track === 0,
      knobLabel: prop === "pan" ? "PAN" : "VOL",
      valueText: prop === "pan" ? panText(norm * 2 - 1) : pct(norm),
      touched: mc.touchedKnobs.has(knob),
      touchedName: prop === "pan" ? "Pan" : "Volume",
    });
  }

  leds(leds: LedState, mc: ModeContext): void {
    const { fl } = mc;
    const selected = this.selected(mc);
    const held = this.held.has("mute") ? "mute" : this.held.has("solo") ? "solo" : undefined;
    for (let strip = 0; strip < BANK; strip++) {
      const track = this.offset + strip;
      const exists = fl.connected && track < fl.mixerTotal;
      // Holding MUTE or SOLO the buttons show that state (bright = on); else the selection.
      const bright = held ? this.flag(track, held, fl) : track === selected;
      const display = DISPLAY_BUTTONS[strip];
      const group = GROUPS[strip];
      if (display) leds.setLight(display, !exists ? "off" : bright ? "bright" : "dim");
      if (group) {
        const entry = exists ? fl.mixer.get(track) : undefined;
        leds.setButtonColor(
          group,
          exists ? flColorToPalette(entry?.color ?? 0, bright ? "bright" : "dim") : LED_OFF,
        );
      }
    }
    leds.setLight("arrowLeft", this.offset > 0 ? "dim" : "off");
    leds.setLight("arrowRight", this.offset + BANK < fl.mixerTotal ? "dim" : "off");
    leds.setLight("mute", !fl.connected ? "off" : this.held.has("mute") ? "bright" : "dim");
    leds.setLight("solo", !fl.connected ? "off" : this.held.has("solo") ? "bright" : "dim");
  }
}

const key = (track: number, prop: Prop) => `${track}:${prop}`;
