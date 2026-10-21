// The touch strip as a controller (docs/mapping.md, "Touch strip"). PITCH, MOD, PERFORM and NOTES are
// a radio group (Maschine: exactly one bright): a press picks that mode, a press on the lit one
// leaves no mode (all dim). The page stack owns the buttons, their LEDs, the saved mode, the read-out
// card and the silencing on page changes; main.ts feeds the strip's reports to `handle`.
//
//   PITCH    the selected channel's pitch (STRIP kind pitch: the script calls setChannelPitch, which
//            works for every generator; FL ignores raw pitch bend from our port): centre = no bend,
//            ends = full, springs back to centre (8192) on release. LEDs: a bar from the centre LED
//            to the finger in the channel's colour, the finger white; untouched: only the centre LED.
//   MOD      the mod wheel, 0–127 left to right; it stays where the finger left it, per FL channel.
//            A VST (FL reports 4224+ parameters) gets STRIP kind mod, which the script writes to
//            the plugin's MIDI CC 1 parameter (4097); any other plugin gets a raw CC 1 on MIDI
//            channel 1 (mk3d decides from the PLUGIN message). LEDs: a bar from the left to the
//            value, the value LED white.
//   PERFORM  a momentary filter sweep (STRIP kind perform): the script finds the plugin's filter
//            cutoff parameter (the channel cutoff for FL's own instruments), remembers its value at
//            the first touch value, follows the finger and puts it back on the release. LEDs: a bar
//            from the left to the finger, white at the finger.
//
// STRIP messages are coalesced to one per STRIP_SEND_MS while sliding (the last value is flushed by
// a timer); the release always goes out at once.
//   NOTES    2 octaves of the KEYBOARD scale from the base note in equal zones (PAD MODE: the 16
//            channels of the bank, like the pads); touching plays the zone's note, sliding to another
//            zone ends it and plays the new one, the release ends it. FIXED VEL replaces the velocity
//            100. LEDs: the zones' first LEDs dim in the channel colour, the zone being played bright,
//            the finger white.
//   none     the LEDs show the play position in the current pattern while FL plays (white bar from
//            the left), off when stopped.
//
// SHIFT + strip does nothing (a touch under SHIFT is as good as no touch). Every effect is ended
// when it should not outlast the touch: the strip hands back the bend, the cutoff and the note on a
// release, a mode change, SHIFT, a page change (notes) and a disconnect.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlState } from "./fl/flState.js";
import { cc, PITCH_BEND_CENTER, PITCH_BEND_MAX } from "./fl/midiBytes.js";
import { midiBytes } from "./fl/midiPorts.js";
import { MAX_CHANNEL_NOTE, VST_CC_PARAM_COUNT } from "./fl/protocol.js";
import type { StripKind } from "./fl/sysex.js";
import type { StripEvent } from "./hw/events.js";
import type { ButtonId } from "./hw/ids.js";
import { STRIP_LED_COUNT, type LedState, type MonoLedId } from "./hw/leds.js";
import { LED_OFF, paletteWhite } from "./hw/palette.js";
import { bankFirst, currentBank } from "./modes/channelBank.js";
import { SCALES } from "./modes/chords.js";
import type { ModeContext } from "./modes/mode.js";
import { noteName, type PadState } from "./modes/padState.js";
import { drawActionReadout } from "./modes/quickEdit.js";
import { realTimers, type RepeatTimers } from "./modes/repeatScheduler.js";
import { PlayPosition } from "./playPosition.js";

export type StripMode = "pitch" | "mod" | "perform" | "notes";
export const STRIP_MODES: readonly StripMode[] = ["pitch", "mod", "perform", "notes"];
export const isStripMode = (value: unknown): value is StripMode =>
  STRIP_MODES.some((mode) => mode === value);

const BUTTON: Record<StripMode, MonoLedId> = {
  pitch: "pitch",
  mod: "mod",
  perform: "perform",
  notes: "notes",
};

/** The mode a button stands for, undefined for any other button. */
export const stripModeOf = (id: ButtonId): StripMode | undefined =>
  STRIP_MODES.find((mode) => BUTTON[mode] === id);

export const DEFAULT_STRIP_MODE: StripMode = "pitch";
/** The saved value for "no mode". */
export const NO_STRIP_MODE = "none";

/** How long the read-out stays after the finger left. */
export const STRIP_READOUT_MS = 1000;
/** NOTES velocity without FIXED VEL. */
export const STRIP_NOTE_VELOCITY = 100;
/** NOTES in KEYBOARD and CHORDS: this many octaves of the scale. */
const NOTE_OCTAVES = 2;
const MOD_WHEEL = 1;
const MOD_MAX = 127;
const CENTER_SEGMENT = Math.floor(STRIP_LED_COUNT / 2);
const LAST_SEGMENT = STRIP_LED_COUNT - 1;
const PAD_MODE_ZONES = 16;
/** At most one STRIP message per this many ms while the finger slides (the release is never held back). */
export const STRIP_SEND_MS = 15;
const PERFORM_MAX = 16383;

/** What NOTES plays in a zone. */
type NoteTarget = { kind: "note"; note: number } | { kind: "channel"; index: number };

interface Zones {
  count: number;
  /** undefined = nothing under this zone (PAD MODE past the last channel). */
  target(zone: number): NoteTarget | undefined;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const segmentOf = (position: number) => Math.round(clamp(position, 0, 1) * LAST_SEGMENT);

export class StripControl {
  mode: StripMode | undefined = DEFAULT_STRIP_MODE;

  /** The finger is on the strip (whatever the effect). */
  private fingerDown = false;
  /** The finger's effect is running: not under SHIFT, not silenced. */
  private active = false;
  /** Silenced by a page change: this touch plays nothing more. */
  private suppressed = false;
  private position = 0.5;

  private readonly modValues = new Map<number, number>();
  private modKey = -1;
  /** The channel this touch started on; undefined = nothing to sweep (PERFORM without a channel). */
  private touchChannel: number | undefined;
  /** The last STRIP message sent (not the releases), for the dedupe, and when. */
  private lastStrip: { kind: StripKind; value: number } | undefined;
  private lastStripAt = -Infinity;
  /** A value held back by the rate limit, sent by `stripTimer`. */
  private pendingStrip: { kind: StripKind; value: number } | undefined;
  private stripTimer: unknown;
  private readonly playPosition: PlayPosition;
  private sounding: { target: NoteTarget; zone: number } | undefined;

  private text = "";
  private detail = "";
  private releasedAt: number | undefined;
  private readoutTimer: NodeJS.Timeout | undefined;
  private lastKey = "";
  private lastFill = -1;
  private lastMc: ModeContext | undefined;

  constructor(
    private readonly send: (bytes: number[]) => void,
    private readonly pads: PadState,
    private readonly now: () => number = () => performance.now(),
    private readonly timers: RepeatTimers = realTimers,
  ) {
    this.playPosition = new PlayPosition(now);
  }

  // ── Mode ───────────────────────────────────────────────────────────────────

  /** A press of PITCH, MOD, PERFORM or NOTES: that mode, or no mode when it is the one on. */
  press(mode: StripMode, mc: ModeContext): void {
    this.lastMc = mc;
    this.endTouch(mc);
    this.suppressed = this.fingerDown;
    this.mode = this.mode === mode ? undefined : mode;
    this.clearReadout();
    this.lastKey = "";
    mc.requestRender();
  }

  /** The mode as saved with the page state. */
  savedMode(): string {
    return this.mode ?? NO_STRIP_MODE;
  }

  loadMode(value: unknown): void {
    if (isStripMode(value)) this.mode = value;
    else if (value === NO_STRIP_MODE) this.mode = undefined;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** A strip report. True = the LEDs or the read-out changed (the reports come every ~11 ms). */
  handle(event: StripEvent, mc: ModeContext): boolean {
    this.lastMc = mc;
    this.fingerDown = event.touched;
    if (event.touched) this.position = clamp(event.position, 0, 1);
    else this.suppressed = false;
    const wanted = event.touched && !mc.shift && !this.suppressed && this.mode !== undefined;
    const before = this.text;
    if (!wanted) {
      if (this.active) this.endTouch(mc);
    } else {
      if (!this.active) this.startTouch(mc);
      this.update(mc);
    }
    const key = this.ledKey(mc.fl);
    const changed = key !== this.lastKey;
    this.lastKey = key;
    if (this.text !== before) mc.requestRender();
    return changed;
  }

  /** A page changed: a note that is sounding ends, and this touch plays no more. */
  silence(): void {
    if (!this.active) return;
    this.endTouch(this.lastMc);
    this.suppressed = this.fingerDown;
  }

  /** FL selected another channel: a pitch or a sweep started on the old one is handed back. */
  channelChanged(mc: ModeContext): void {
    if (!this.active || this.mode === "notes") return;
    if (mc.fl.selectedChannel.index === this.touchChannel) return;
    this.lastMc = mc;
    this.endTouch(mc);
    this.suppressed = this.fingerDown;
  }

  /** The device went away, FL left or mk3d is stopping: hand everything back. */
  release(mc?: ModeContext): void {
    this.endTouch(mc ?? this.lastMc);
    this.fingerDown = false;
    this.suppressed = false;
    this.clearReadout();
    this.lastKey = "";
  }

  private startTouch(mc: ModeContext): void {
    this.active = true;
    this.releasedAt = undefined;
    this.touchChannel = mc.fl.selectedChannel.index ?? undefined;
  }

  private update(mc: ModeContext): void {
    const { position } = this;
    switch (this.mode) {
      case "pitch": {
        const value = Math.round(position * PITCH_BEND_MAX);
        if (this.touchChannel !== undefined) this.sendStrip("pitch", value, mc);
        this.setReadout(`PITCH ${signed((value - PITCH_BEND_CENTER) / PITCH_BEND_CENTER)}`, mc);
        break;
      }
      case "mod": {
        const value = Math.round(position * MOD_MAX);
        this.modKey = mc.fl.selectedChannel.index ?? -1;
        if (this.modValues.get(this.modKey) !== value) {
          this.modValues.set(this.modKey, value);
          if (hasCcParams(mc.fl)) this.sendStrip("mod", value, mc);
          else this.send(cc(MOD_WHEEL, value));
        }
        this.setReadout(`MOD ${value}`, mc);
        break;
      }
      case "perform": {
        if (this.touchChannel === undefined) return; // no channel: nothing to sweep
        this.sendStrip("perform", Math.round(position * PERFORM_MAX), mc);
        this.setReadout(`CUTOFF ${Math.round(position * 100)} %`, mc);
        break;
      }
      case "notes":
        this.updateNotes(mc);
        break;
      default:
        break;
    }
  }

  /** The finger lifted (or must not count any more): undo what the touch did. */
  private endTouch(mc: ModeContext | undefined): void {
    if (!this.active) return;
    this.active = false;
    this.releasedAt = this.now();
    const channel = this.touchChannel;
    this.touchChannel = undefined;
    switch (this.mode) {
      case "pitch":
        if (channel !== undefined) this.releaseStrip("pitch", PITCH_BEND_CENTER, mc);
        this.text = `PITCH ${signed(0)}`;
        break;
      case "mod": {
        const value = this.modValues.get(this.modKey);
        if (value !== undefined && hasCcParams(mc?.fl)) this.releaseStrip("mod", value, mc);
        break;
      }
      case "perform":
        if (channel !== undefined) this.releaseStrip("perform", PERFORM_MAX, mc);
        break;
      case "notes":
        this.stopNote();
        break;
      default:
        break;
    }
    if (mc) {
      mc.requestRender();
      this.readoutTimer = setTimeout(() => mc.requestRender(), STRIP_READOUT_MS + 30);
      this.readoutTimer.unref();
    }
  }

  // ── STRIP messages ─────────────────────────────────────────────────────────

  /** A value while the finger is down: at most one per STRIP_SEND_MS, the latest one wins. */
  private sendStrip(kind: StripKind, value: number, mc: ModeContext): void {
    const last = this.lastStrip;
    if (last && last.kind === kind && last.value === value) {
      this.pendingStrip = undefined;
      return;
    }
    const wait = this.lastStripAt + STRIP_SEND_MS - this.now();
    if (wait <= 0) {
      this.emitStrip(kind, value, false, mc);
      return;
    }
    this.pendingStrip = { kind, value };
    if (this.stripTimer === undefined) {
      this.stripTimer = this.timers.set(() => {
        this.stripTimer = undefined;
        const pending = this.pendingStrip;
        this.pendingStrip = undefined;
        if (pending && this.lastMc) this.emitStrip(pending.kind, pending.value, false, this.lastMc);
      }, wait);
    }
  }

  /** The finger lifted: whatever waits is dropped (the script handles `release`), this goes at once. */
  private releaseStrip(kind: StripKind, value: number, mc: ModeContext | undefined): void {
    this.pendingStrip = undefined;
    if (this.stripTimer !== undefined) this.timers.clear(this.stripTimer);
    this.stripTimer = undefined;
    this.lastStrip = undefined;
    this.lastStripAt = -Infinity;
    mc?.send({ type: "strip", kind, value, release: true });
  }

  private emitStrip(kind: StripKind, value: number, release: boolean, mc: ModeContext): void {
    this.lastStrip = { kind, value };
    this.lastStripAt = this.now();
    mc.send({ type: "strip", kind, value, release });
  }

  // ── NOTES ──────────────────────────────────────────────────────────────────

  /** The zones now: 2 octaves of the KEYBOARD scale, or the 16 channels of the bank in PAD MODE. */
  private zones(fl: FlState): Zones {
    if (this.pads.mode === "channels") {
      const first = bankFirst(currentBank(fl));
      return {
        count: PAD_MODE_ZONES,
        target: (zone) => {
          const index = first + zone;
          return index < fl.channelTotal && index <= MAX_CHANNEL_NOTE
            ? { kind: "channel", index }
            : undefined;
        },
      };
    }
    const degrees = SCALES[this.pads.harmony.scale]?.intervals.length ?? 12;
    return {
      count: degrees * NOTE_OCTAVES,
      target: (zone) => ({ kind: "note", note: this.pads.keyNote(zone) }),
    };
  }

  private updateNotes(mc: ModeContext): void {
    const zones = this.zones(mc.fl);
    const zone = Math.min(zones.count - 1, Math.floor(this.position * zones.count));
    if (this.sounding?.zone === zone) return;
    this.stopNote();
    const target = zones.target(zone);
    if (!target) {
      this.sounding = undefined;
      return;
    }
    const velocity = this.pads.settings.apply(STRIP_NOTE_VELOCITY);
    if (target.kind === "note") {
      this.send(midiBytes.noteOn(target.note, velocity));
      this.setReadout(`NOTE ${noteName(target.note)}`, mc);
    } else {
      this.send(midiBytes.channelNoteOn(target.index, velocity));
      if (mc.fl.selectedChannel.index !== target.index) {
        mc.send({ type: "selectChannel", index: target.index });
      }
      this.setReadout(`CHANNEL ${target.index + 1}`, mc);
    }
    this.sounding = { target, zone };
  }

  private stopNote(): void {
    const sounding = this.sounding;
    if (!sounding) return;
    this.sounding = undefined;
    const { target } = sounding;
    this.send(
      target.kind === "note"
        ? midiBytes.noteOff(target.note)
        : midiBytes.channelNoteOff(target.index),
    );
  }

  // ── Read-out ───────────────────────────────────────────────────────────────

  private setReadout(text: string, mc: ModeContext): void {
    this.text = text;
    this.detail = mc.fl.selectedChannel.name;
  }

  private clearReadout(): void {
    this.text = "";
    this.releasedAt = undefined;
    clearTimeout(this.readoutTimer);
  }

  /** The card's text while the finger is down and for a second after, else undefined. */
  readoutText(): string | undefined {
    if (!this.text) return undefined;
    if (this.active) return this.text;
    if (this.releasedAt !== undefined && this.now() - this.releasedAt < STRIP_READOUT_MS) {
      return this.text;
    }
    return undefined;
  }

  /** Draws the read-out card on the left screen when there is one. */
  render(ctx: SKRSContext2D, mc: ModeContext): void {
    const text = mc.fl.connected ? this.readoutText() : undefined;
    if (text) {
      drawActionReadout(ctx, {
        title: text,
        detail: this.detail,
        small: "",
        source: "TOUCH STRIP",
      });
    }
  }

  // ── LEDs ───────────────────────────────────────────────────────────────────

  /** Everything the strip LEDs depend on in the strip's own state, for the change check. */
  private ledKey(fl: FlState): string {
    const lit = this.active;
    return `${this.mode}|${lit}|${segmentOf(this.position)}|${this.sounding?.zone ?? -1}|${this.shownMod(fl)}`;
  }

  private shownMod(fl: FlState): number {
    return this.modValues.get(fl.selectedChannel.index ?? -1) ?? -1;
  }

  /** The play position moved enough to change the LEDs (no mode only). */
  playPositionChanged(fl: FlState): boolean {
    return this.mode === undefined && this.playFill(fl) !== this.lastFill;
  }

  private playFill(fl: FlState): number {
    const at = this.playPosition.at(fl);
    if (!at) return 0;
    return clamp(Math.floor((at.position / at.length) * STRIP_LED_COUNT) + 1, 1, STRIP_LED_COUNT);
  }

  /** The four buttons (a radio group) and the 25 strip LEDs. */
  leds(leds: LedState, mc: ModeContext): void {
    const { fl } = mc;
    for (const mode of STRIP_MODES) {
      leds.setLight(BUTTON[mode], !fl.connected ? "off" : this.mode === mode ? "bright" : "dim");
    }
    const frame = new Array<number>(STRIP_LED_COUNT).fill(LED_OFF);
    if (fl.connected) this.frame(frame, fl);
    frame.forEach((color, i) => leds.setStrip(i, color));
  }

  private frame(frame: number[], fl: FlState): void {
    const white = paletteWhite("bright");
    const color = this.pads.keyLed(fl, "bright");
    const dim = this.pads.keyLed(fl, "dim");
    const finger = segmentOf(this.position);
    const bar = (from: number, to: number) => {
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) frame[i] = color;
    };
    switch (this.mode) {
      case "pitch":
        if (this.active) {
          bar(CENTER_SEGMENT, finger);
          frame[finger] = white;
        } else {
          frame[CENTER_SEGMENT] = white;
        }
        break;
      case "mod": {
        const value = this.active ? Math.round(this.position * MOD_MAX) : this.shownMod(fl);
        if (value < 0) break;
        const end = Math.round((value / MOD_MAX) * LAST_SEGMENT);
        bar(0, end);
        frame[end] = white;
        break;
      }
      case "perform":
        if (this.active && this.touchChannel !== undefined) {
          bar(0, finger);
          frame[finger] = white;
        }
        break;
      case "notes": {
        const zones = this.zones(fl);
        let previous = -1;
        for (let i = 0; i < STRIP_LED_COUNT; i++) {
          const zone = Math.min(zones.count - 1, Math.floor((i / LAST_SEGMENT) * zones.count));
          if (zone !== previous && zones.target(zone)) frame[i] = dim;
          if (this.sounding?.zone === zone && zones.target(zone)) frame[i] = color;
          previous = zone;
        }
        if (this.active) frame[finger] = white;
        break;
      }
      default: {
        const fill = this.playFill(fl);
        this.lastFill = fill;
        for (let i = 0; i < fill; i++) frame[i] = white;
        break;
      }
    }
  }
}

/** True for a plugin with FL's VST wrapper parameters (4096–4223 = MIDI CC 0–127). */
function hasCcParams(fl: FlState | undefined): boolean {
  return !!fl && fl.plugin.valid && fl.plugin.paramCount >= VST_CC_PARAM_COUNT;
}

/** `+0.43`, `-0.12`, `+0.00`. */
function signed(value: number): string {
  const abs = Math.abs(value);
  return `${value < 0 && abs >= 0.005 ? "-" : "+"}${abs.toFixed(2)}`;
}
