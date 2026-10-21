// Channel mode. Each screen owns the controls above and below it: display buttons 1–4 and knob 1
// belong to the left screen (channel list; Mute, Solo, Editor; channel select), display buttons
// 5–8 and knobs 5–8 to the right one (the selected channel: Volume, Pan, Pitch, Mixer track).
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import type { ButtonId } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import type { FlSection, FlState } from "../fl/flState.js";
import type { ChannelDetailInfo } from "../fl/sysex.js";
import {
  SCREEN_COLUMNS,
  TAB_HEIGHT,
  clear,
  drawKnobRow,
  drawList,
  drawTabs,
  fitText,
  font,
  theme,
} from "../render/widgets.js";
import type { KnobProps } from "../render/widgets.js";
import { FULL, drawBand, drawTransportBar } from "./draw.js";
import { flColorToCss, panText, pct } from "./format.js";
import { clamp, isLive, knobStep, RenderSoon } from "./knob.js";
import type { Mode, ModeContext, ViewCommand } from "./mode.js";
import type { Rect } from "../hw/display.js";

export const WINDOW = 16;
const COUNTS_PER_TRACK = 30;
const COUNTS_PER_CHANNEL = 40;
/** Hardware knob 1 selects the channel; knobs 5–8 are the right screen's four columns. */
const CHANNEL_KNOB = 0;
const RIGHT_KNOB_BASE = SCREEN_COLUMNS;

type Slot = ParamName | "track";

/** What the right screen's four columns (knobs 5–8) do. */
const SLOTS: readonly Slot[] = ["volume", "pan", "pitch", "track"];

// Left tabs sit over display buttons 1–4; the right screen has none (display 5–8 are unused).
const LEFT_TABS = ["Mute", "Solo", "Editor", ""];

const TABS_RECT: Rect = { ...FULL, height: TAB_HEIGHT };
const LEFT_KNOB_ROW: Rect = { ...FULL, y: FULL.height - 54, height: 54 };
const RIGHT_KNOB_ROW: Rect = { ...FULL, y: FULL.height - 110, height: 110 };
const TRANSPORT_STRIP: Rect = { ...FULL, y: TAB_HEIGHT + 4, height: 28 };

type ParamName = "volume" | "pan" | "pitch";

interface ParamKnob {
  what: ParamName;
  label: string;
  name: string;
  bipolar?: boolean;
  /** FL's value on the wire scale, 0–1 (pan and pitch: (x + 1) / 2). */
  read(fl: FlState): number;
  text(norm: number, fl: FlState): string;
}

const unipolar = (norm: number) => norm * 2 - 1;

/** The detail of the selected channel, or zeros while FL is still catching up. */
export function detailOf(fl: FlState): ChannelDetailInfo {
  const { channelDetail, selectedChannel } = fl;
  if (channelDetail.index !== null && channelDetail.index === selectedChannel.index) {
    return channelDetail;
  }
  return { ...channelDetail, index: null, pitch: 0, pitchRange: 0, cutoff: 0, resonance: 0 };
}

function pitchText(norm: number, fl: FlState): string {
  const semitones = unipolar(norm) * detailOf(fl).pitchRange;
  const abs = Math.abs(semitones);
  return `${semitones < 0 && abs >= 0.005 ? "-" : "+"}${abs.toFixed(2)} st`;
}

const PARAMS: readonly ParamKnob[] = [
  {
    what: "volume",
    label: "Volume",
    name: "Volume",
    read: (fl) => fl.selectedChannel.volume,
    text: pct,
  },
  {
    what: "pan",
    label: "Pan",
    name: "Panning",
    bipolar: true,
    read: (fl) => (fl.selectedChannel.pan + 1) / 2,
    text: (norm) => panText(unipolar(norm)),
  },
  {
    what: "pitch",
    label: "Pitch",
    name: "Pitch",
    bipolar: true,
    read: (fl) => (detailOf(fl).pitch + 1) / 2,
    text: pitchText,
  },
];

export function trackText(fl: FlState, track: number): string {
  return track === 0 ? "Master" : (fl.mixer.get(track)?.name ?? `Insert ${track}`);
}

/** First channel of the page that holds `index`. */
export const pageStart = (index: number) => Math.floor(index / WINDOW) * WINDOW;

interface KnobView {
  name: string;
  props: KnobProps;
}

interface Pending<T> {
  channel: number;
  value: T;
  at: number;
}

export class ChannelMode implements Mode {
  readonly name = "channel";
  private offset = 0;
  private readonly params = new Map<ParamName, Pending<number>>();
  private track: Pending<number> | undefined;
  private select: Pending<number> | undefined;
  private trackCounts = 0;
  private channelCounts = 0;
  private lastSelected: number | null = null;
  private readonly redraw = new RenderSoon();

  constructor(private readonly now: () => number = Date.now) {}

  enter(mc: ModeContext): void {
    this.params.clear();
    this.track = undefined;
    this.select = undefined;
    this.trackCounts = 0;
    this.channelCounts = 0;
    const selected = mc.fl.selectedChannel.index;
    this.lastSelected = selected;
    this.offset = selected === null ? 0 : pageStart(selected);
    this.sendView(mc);
  }

  /** An overlay closed: resend the VIEW and keep everything else. */
  resume(mc: ModeContext): void {
    this.sendView(mc);
  }

  view(): ViewCommand {
    return {
      type: "view",
      channelOffset: this.offset,
      mixerOffset: 0,
      patternOffset: 0,
      stepOffset: 0,
      meters: false,
      presets: false,
      patternGrid: false,
      params: [0, 1, 2, 3, 4, 5, 6, 7],
    };
  }

  onFlChange(section: FlSection, mc: ModeContext): void {
    const { fl } = mc;
    if (section === "selectedChannel") {
      const selected = fl.selectedChannel.index;
      if (this.select && selected === this.select.value) this.select = undefined;
      if (selected !== this.lastSelected) {
        this.lastSelected = selected;
        if (selected !== null && !this.live(this.select)) this.showPageOf(selected, mc);
      }
    } else if (section === "channels" && fl.channelTotal > 0) {
      const last = pageStart(fl.channelTotal - 1);
      if (this.offset > last) this.setOffset(last, mc);
    }
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    switch (event.type) {
      case "encoder":
        return this.turnKnob(event.index, event.delta, mc);
      case "nav":
        if (event.action === "turn") return this.moveSelection(event.delta, mc);
        if (event.action === "push") {
          if (event.pressed) this.showEditor(mc);
          return true;
        }
        if (event.action === "tilt" && (event.direction === "up" || event.direction === "down")) {
          if (event.pressed) this.moveSelection(event.direction === "up" ? -1 : 1, mc);
          return true;
        }
        return false;
      case "button":
        return this.onButton(event.id, event.pressed, mc);
      default:
        return false;
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private onButton(id: ButtonId, pressed: boolean, mc: ModeContext): boolean {
    // GROUP A–H are not ours: the page stack turns them into channel banks.
    switch (id) {
      case "arrowLeft":
      case "arrowRight":
        if (pressed) this.setOffset(this.offset + (id === "arrowLeft" ? -WINDOW : WINDOW), mc);
        return true;
      case "display1":
        if (pressed) this.toggleMute(this.selected(mc), mc);
        return true;
      case "display2":
        if (pressed) this.toggleSolo(mc);
        return true;
      case "display3":
        if (pressed) this.showEditor(mc);
        return true;
      default:
        return false;
    }
  }

  /** What the right screen's column `column` (hardware knob 5–8) does. */
  private slot(column: number): Slot | undefined {
    return SLOTS[column];
  }

  private turnKnob(knob: number, delta: number, mc: ModeContext): boolean {
    if (knob === CHANNEL_KNOB) return this.turnChannel(delta, mc);
    const slot = knob >= RIGHT_KNOB_BASE ? this.slot(knob - RIGHT_KNOB_BASE) : undefined;
    if (slot === undefined) return false;
    const index = mc.fl.selectedChannel.index;
    // While our own selection is ahead of FL's, FL's values belong to another channel.
    if (index === null || index !== this.selected(mc)) return true;
    if (slot === "track") this.turnTrack(index, delta, mc);
    else {
      const param = PARAMS.find((p) => p.what === slot);
      if (param) this.turnParam(param, index, delta, mc);
    }
    return true;
  }

  /** Knob 1: one channel per 40 counts, the remainder kept so slow turns add up. */
  private turnChannel(delta: number, mc: ModeContext): boolean {
    if (Math.sign(delta) !== Math.sign(this.channelCounts)) this.channelCounts = 0;
    this.channelCounts += delta;
    const steps = Math.trunc(this.channelCounts / COUNTS_PER_CHANNEL);
    if (steps === 0) return true;
    this.channelCounts -= steps * COUNTS_PER_CHANNEL;
    return this.moveSelection(steps, mc);
  }

  private turnParam(param: ParamKnob, index: number, delta: number, mc: ModeContext): void {
    const step = knobStep(delta, mc.shift);
    const old = this.paramValue(param, index, mc.fl);
    const value = clamp(old + step, 0, 1);
    if (value === old) return;
    this.params.set(param.what, { channel: index, value, at: this.now() });
    mc.send({ type: "setChannel", index, what: param.what, value });
    this.renderSoon(mc);
  }

  private turnTrack(index: number, delta: number, mc: ModeContext): void {
    if (Math.sign(delta) !== Math.sign(this.trackCounts)) this.trackCounts = 0;
    this.trackCounts += delta;
    const steps = Math.trunc(this.trackCounts / COUNTS_PER_TRACK);
    if (steps === 0) return;
    this.trackCounts -= steps * COUNTS_PER_TRACK;
    const old = this.trackValue(index, mc.fl);
    const track = clamp(old + steps, 0, Math.max(0, mc.fl.mixerTotal - 1));
    if (track === old) return;
    this.track = { channel: index, value: track, at: this.now() };
    mc.send({ type: "setChannelTrack", index, track });
    this.renderSoon(mc);
  }

  private moveSelection(delta: number, mc: ModeContext): boolean {
    const total = mc.fl.channelTotal;
    if (total === 0) return true;
    const current = this.selected(mc);
    const index = current === null ? 0 : clamp(current + delta, 0, total - 1);
    if (index !== current) this.selectChannel(index, mc);
    return true;
  }

  private selectChannel(index: number, mc: ModeContext): void {
    this.select = { channel: index, value: index, at: this.now() };
    mc.send({ type: "selectChannel", index });
    if (index < this.offset || index >= this.offset + WINDOW) this.setOffset(pageStart(index), mc);
    this.renderSoon(mc);
  }

  private showEditor(mc: ModeContext): void {
    const index = this.selected(mc);
    if (index !== null) mc.send({ type: "showEditor", index });
  }

  private toggleMute(index: number | null, mc: ModeContext): void {
    if (index === null) return;
    const muted = mc.fl.channels.get(index)?.muted ?? false;
    mc.send({ type: "setChannel", index, what: "mute", value: muted ? 0 : 1 });
  }

  private toggleSolo(mc: ModeContext): void {
    const index = this.selected(mc);
    if (index === null) return;
    const solo = mc.fl.channels.get(index)?.solo ?? false; // FL reports the solo flag
    mc.send({ type: "setChannel", index, what: "solo", value: solo ? 0 : 1 });
  }

  // ── Window ─────────────────────────────────────────────────────────────────

  private showPageOf(index: number, mc: ModeContext): void {
    if (index < this.offset || index >= this.offset + WINDOW) this.setOffset(pageStart(index), mc);
  }

  private setOffset(wanted: number, mc: ModeContext): void {
    const total = mc.fl.channelTotal;
    const last = total > 0 ? pageStart(total - 1) : 0;
    const offset = clamp(wanted, 0, last);
    if (offset === this.offset) return;
    this.offset = offset;
    this.sendView(mc);
    mc.requestRender();
  }

  private sendView(mc: ModeContext): void {
    mc.send(this.view());
  }

  // ── Values: ours for a moment after a turn, then FL's ─────────────────────

  private live<T extends { at: number }>(pending: T | undefined): pending is T {
    return isLive(pending, this.now());
  }

  private selected(mc: ModeContext): number | null {
    return this.live(this.select) ? this.select.value : mc.fl.selectedChannel.index;
  }

  private paramValue(param: ParamKnob, index: number, fl: FlState): number {
    const pending = this.params.get(param.what);
    return this.live(pending) && pending.channel === index ? pending.value : param.read(fl);
  }

  private trackValue(index: number, fl: FlState): number {
    const pending = this.track;
    return this.live(pending) && pending.channel === index
      ? pending.value
      : detailOf(fl).mixerTrack;
  }

  /** Redraw now, and once more when our values stop overriding FL's. */
  private renderSoon(mc: ModeContext): void {
    this.redraw.request(mc);
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    this.renderLeft(left, mc);
    this.renderRight(right, mc);
  }

  private renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    clear(ctx, FULL);
    const total = fl.channelTotal;
    const last = Math.min(this.offset + WINDOW, total);
    const selected = this.selected(mc);
    const channel = selected === null ? undefined : fl.channels.get(selected);
    drawTabs(ctx, TABS_RECT, {
      tabs: LEFT_TABS,
      active: [...(channel?.muted ? [0] : []), ...(channel?.solo ? [1] : [])],
    });
    const items = [];
    let selectedRow = -1;
    for (let index = this.offset; index < last; index++) {
      const entry = fl.channels.get(index);
      if (!entry) continue;
      if (index === selected) selectedRow = items.length;
      items.push({
        text: entry.name,
        detail: String(index + 1),
        color: flColorToCss(entry.color),
        muted: entry.muted,
      });
    }
    const listTop = TAB_HEIGHT + 4;
    const footer = LEFT_KNOB_ROW.y - 18;
    drawList(
      ctx,
      { ...FULL, y: listTop, height: footer - listTop },
      { items, selected: selectedRow, rowHeight: 22 },
    );
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(12);
    if (total > 0) {
      ctx.fillText(`${this.offset + 1}–${last} of ${total}`, FULL.width - 8, footer + 9);
    }

    const name = selected === null ? "" : (fl.channels.get(selected)?.name ?? "");
    const knob: KnobView = {
      name: "Channel",
      props: {
        label: "Channel",
        valueText: selected === null ? "–" : `${selected + 1} ${name}`.trim(),
        touched: mc.touchedKnobs.has(CHANNEL_KNOB),
      },
    };
    drawKnobRow(ctx, LEFT_KNOB_ROW, [knob.props]);
    if (knob.props.touched) {
      drawBand(ctx, { ...FULL, y: footer - 64, height: 64 }, knob);
    }
  }

  private renderRight(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    clear(ctx, FULL);
    const index = fl.selectedChannel.index;
    const color = flColorToCss(fl.selectedChannel.color);
    drawTabs(ctx, TABS_RECT, { tabs: [] });
    drawTransportBar(ctx, fl, TRANSPORT_STRIP);
    const knobs = index === null ? [] : this.pageKnobs(index, mc);
    const touched = knobs.findIndex((_, i) => mc.touchedKnobs.has(RIGHT_KNOB_BASE + i));
    if (index !== null) {
      drawKnobRow(
        ctx,
        RIGHT_KNOB_ROW,
        knobs.map((knob, i) => ({
          ...knob.props,
          touched: mc.touchedKnobs.has(RIGHT_KNOB_BASE + i),
        })),
      );
    }
    const top = TRANSPORT_STRIP.y + TRANSPORT_STRIP.height + 6;
    const middle = { ...FULL, y: top, height: RIGHT_KNOB_ROW.y - top - 4 };
    const touchedKnob = knobs[touched];
    if (touchedKnob) drawBand(ctx, middle, touchedKnob);
    else this.drawInfo(ctx, middle, mc, color);
  }

  /** Big channel name in its color, with the plug-in and mixer track under it. */
  private drawInfo(ctx: SKRSContext2D, rect: Rect, mc: ModeContext, color: string): void {
    const { fl } = mc;
    const index = fl.selectedChannel.index;
    ctx.fillStyle = color;
    ctx.fillRect(rect.x, rect.y, 4, rect.height);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.text;
    ctx.font = font(30, "bold");
    ctx.fillText(
      fitText(ctx, index === null ? "No channel" : fl.selectedChannel.name, rect.width - 24),
      rect.x + 14,
      rect.y + 4,
    );
    if (index === null) return;
    ctx.fillStyle = theme.dimText;
    ctx.font = font(17);
    const plugin = this.pluginLabel(fl);
    if (plugin) ctx.fillText(fitText(ctx, plugin, rect.width - 24), rect.x + 14, rect.y + 44);
    const track = this.trackValue(index, fl);
    ctx.fillText(
      fitText(ctx, `Mixer ${track}: ${trackText(fl, track)}`, rect.width - 24),
      rect.x + 14,
      rect.y + 68,
    );
  }

  private pluginLabel(fl: FlState): string {
    if (fl.selectedChannel.plugin) return fl.selectedChannel.plugin;
    return detailOf(fl).index !== null && fl.channelDetail.channelType === 0 ? "Sampler" : "";
  }

  /** The knobs of the right screen, in the order of its columns. */
  private pageKnobs(index: number, mc: ModeContext): KnobView[] {
    const { fl } = mc;
    const knobs: KnobView[] = [];
    for (const slot of SLOTS) {
      if (slot === "track") {
        const track = this.trackValue(index, fl);
        const last = Math.max(1, fl.mixerTotal - 1);
        knobs.push({
          name: "Mixer track",
          props: {
            label: "Mixer",
            valueText: trackText(fl, track),
            value: clamp(track / last, 0, 1),
          },
        });
        continue;
      }
      const param = PARAMS.find((p) => p.what === slot);
      if (!param) continue;
      const norm = this.paramValue(param, index, fl);
      knobs.push({
        name: param.name,
        props: {
          label: param.label,
          valueText: param.text(norm, fl),
          value: norm,
          bipolar: param.bipolar,
        },
      });
    }
    return knobs;
  }

  leds(leds: LedState, mc: ModeContext): void {
    const { fl } = mc;
    const selected = this.selected(mc);
    const muted = selected !== null && (fl.channels.get(selected)?.muted ?? false);
    const solo = selected !== null && (fl.channels.get(selected)?.solo ?? false);
    // Dim = the button has a function, bright = it is on, off = unused.
    leds.setLight("display1", selected === null ? "off" : muted ? "bright" : "dim");
    leds.setLight("display2", selected === null ? "off" : solo ? "bright" : "dim");
    leds.setLight("display3", selected === null ? "off" : "dim");
    leds.setLight("display4", "off");
    leds.setLight("display5", "off");
    leds.setLight("display6", "off");
    leds.setLight("display7", "off");
    leds.setLight("display8", "off");
    leds.setLight("arrowLeft", this.offset > 0 ? "dim" : "off");
    leds.setLight("arrowRight", this.offset + WINDOW < fl.channelTotal ? "dim" : "off");
  }
}
