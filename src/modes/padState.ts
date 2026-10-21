// Pad state shared by main.ts, the page stack and the pad pages: the pad mode (KEYBOARD, CHORDS or
// PAD MODE), the keyboard's base note, the scale and chord settings, the channel remembered per
// bank, and what each held pad sent.
// Pure: MIDI goes out through the function it is given, FL commands through the ModeContext.
//
// - `keyboard`: pad n plays note `base + n` on MIDI channel 1 (FL plays it on the selected channel);
//   with a scale, scale degree n counted up from the base note (src/modes/chords.ts).
// - `chords`: pad n plays a chord on MIDI channel 1 (every note of it, the same velocity): the
//   harmonizer's chord on the pad's note or chord set's chord n (src/modes/chords.ts).
// - `channels`: pad n plays channel `bankFirst(currentBank) + n`: note number = its group-local
//   index on MIDI channel 2, which the FL script turns into a note on that channel
//   (docs/sysex.md, "Pad notes for channels"). A hit also selects the channel.
// - A pad's up and aftertouch go where its down went (a chord: its exact notes), whatever the mode,
//   base, scale, chord settings or bank is by then.
// - NOTE REPEAT (noteRepeatOverlay.ts) plays held pads through `startRepeat`, `soundRepeat` and
//   `silenceRepeat`: the same targets and MIDI as a single hit, one note per repeat.
// - The arpeggiator (arpeggiator.ts, NOTE REPEAT in KEYBOARD and CHORDS) asks `arpNotes` what a pad
//   plays and sends single notes through `arpOn` and `arpOff`: the same MIDI and FIXED VEL as a hit.
// - FIXED VEL (`settings.fixedOn`): every note on goes out with the fixed velocity instead of the
//   hit's (or the repeat's), whatever plays it.
import type { FlState } from "../fl/flState.js";
import { midiBytes } from "../fl/midiPorts.js";
import { MAX_CHANNEL_NOTE } from "../fl/protocol.js";
import type { PadEvent } from "../hw/events.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import { LED_OFF, paletteColor, type LedVariant } from "../hw/palette.js";
import { bankCount, bankFirst, bankOf, currentBank } from "./channelBank.js";
import { flColorToPalette } from "./format.js";
import { HarmonySettings, chordAt, isRootDegree, keyboardNote, type Chord } from "./chords.js";
import type { ModeContext } from "./mode.js";
import { PadSettings } from "./padSettings.js";

export type PadMode = "keyboard" | "channels" | "chords";
export const PAD_MODES: readonly PadMode[] = ["keyboard", "channels", "chords"];
export const isPadMode = (value: unknown): value is PadMode =>
  PAD_MODES.some((mode) => mode === value);

/** Pad 1 plays this note by default (FL calls it C3). */
export const DEFAULT_BASE_NOTE = 36;
/** The highest base note: pad 16 then plays 127. */
export const MAX_BASE_NOTE = 127 - (PAD_COUNT - 1);
const DEFAULT_PAD_COLOR = 1; // palette color index: orange, until a channel is selected

/** Where a pad's down went. */
type Target =
  | { kind: "note"; note: number }
  | { kind: "chord"; notes: readonly number[] }
  | { kind: "channel"; index: number };

interface Held {
  target: Target;
  /** The last aftertouch value sent, -1 before the first. */
  pressure: number;
  /** Its note is on now (a repeating pad's goes on and off with every repeat). */
  sounding: boolean;
  /** NOTE REPEAT plays this pad: no single note, no aftertouch. */
  repeating: boolean;
}

/** Note names the way FL shows them: note 60 is C5, so 36 is C3. */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export const noteName = (note: number): string =>
  `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12)}`;
export const isC = (note: number): boolean => ((note % 12) + 12) % 12 === 0;

/** The notes a keyboard or chord target plays, the ones its note ons sent and its offs will end. */
const notesOf = (target: Exclude<Target, { kind: "channel" }>): readonly number[] =>
  target.kind === "note" ? [target.note] : target.notes;

export class PadState {
  mode: PadMode = "keyboard";
  private base = DEFAULT_BASE_NOTE;
  /** The channel last selected in each bank. */
  private readonly lastInBank = new Map<number, number>();
  private readonly held = new Map<number, Held>();
  /** The notes the arpeggiator has on now. */
  private readonly arpSounding = new Set<number>();
  /** Scale, chord mode, chord type and position (KEYBOARD and CHORDS; saved by the CHORDS page). */
  readonly harmony = new HarmonySettings();

  constructor(
    private readonly midi: (bytes: number[]) => void = () => undefined,
    /** Pad settings: FIXED VEL replaces the velocity of every note on. */
    readonly settings: PadSettings = new PadSettings(),
  ) {}

  // ── Keyboard base note ─────────────────────────────────────────────────────

  get baseNote(): number {
    return this.base;
  }

  /** Moves the base note by `semitones`, within 0…MAX_BASE_NOTE. True if it changed. */
  shiftBase(semitones: number): boolean {
    const base = Math.min(MAX_BASE_NOTE, Math.max(0, this.base + semitones));
    if (base === this.base) return false;
    this.base = base;
    return true;
  }

  /** Could the base note move by `semitones` (the same limits as `shiftBase`)? */
  canShiftBase(semitones: number): boolean {
    return semitones < 0 ? this.base > 0 : this.base < MAX_BASE_NOTE;
  }

  /** The note KEYBOARD's pad plays now (scale degree `pad` from the base note, within 0–127). */
  keyNote(pad: number): number {
    return keyboardNote(this.base, this.harmony.scale, pad);
  }

  /** The chord CHORDS' pad plays now. */
  chordAt(pad: number): Chord {
    return chordAt(
      {
        base: this.base,
        scale: this.harmony.scale,
        mode: this.harmony.mode,
        type: this.harmony.type,
        position: this.harmony.position,
      },
      pad,
    );
  }

  /** Is the pad a root (KEYBOARD: a root of the scale, a C in Chromatic; CHORDS: a root chord)? */
  isRootPad(pad: number): boolean {
    if (this.mode === "chords") return this.chordAt(pad).root;
    return isRootDegree(this.harmony.scale, this.keyNote(pad), pad);
  }

  // ── Banks ──────────────────────────────────────────────────────────────────

  /** Remember the selected channel as the last one of its bank. */
  observe(fl: FlState): void {
    const selected = fl.selectedChannel.index;
    if (selected !== null) this.lastInBank.set(bankOf(selected), selected);
  }

  /**
   * Select the channel last selected in `bank`, else its first channel. A bank without channels is
   * ignored.
   */
  selectBank(bank: number, mc: ModeContext): void {
    const { fl } = mc;
    this.observe(fl);
    if (bank < 0 || bank >= bankCount(fl)) return;
    const last = this.lastInBank.get(bank);
    const index =
      last !== undefined && bankOf(last) === bank && last < fl.channelTotal
        ? last
        : bankFirst(bank);
    if (index === fl.selectedChannel.index) return;
    this.lastInBank.set(bank, index);
    mc.send({ type: "selectChannel", index });
  }

  // ── Pads ───────────────────────────────────────────────────────────────────

  isHeld(pad: number): boolean {
    return this.held.has(pad);
  }

  /** The channel a held pad plays (PAD MODE), the most recently hit one; undefined otherwise. */
  heldChannel(): number | undefined {
    let index: number | undefined;
    for (const { target } of this.held.values()) {
      if (target.kind === "channel") index = target.index;
    }
    return index;
  }

  /** What a hit on `pad` would play now: the channel's index (channels) or the note (keyboard). */
  private targetOf(pad: number, fl: FlState): Target | undefined {
    if (this.mode === "keyboard") {
      return { kind: "note", note: this.keyNote(pad) };
    }
    if (this.mode === "chords") return { kind: "chord", notes: this.chordAt(pad).notes };
    const index = bankFirst(currentBank(fl)) + pad;
    if (index >= fl.channelTotal || index > MAX_CHANNEL_NOTE) return undefined;
    return { kind: "channel", index };
  }

  /** The global fallback for pads no page took: play a note or a channel. */
  handlePad(event: PadEvent, mc: ModeContext): void {
    const { pad } = event;
    if (event.phase === "down") {
      this.release(pad); // a new hit on a pad that is still held: end the old one first
      const target = this.targetOf(pad, mc.fl);
      if (!target) return;
      const velocity = Math.round((event.velocity ?? 0) * 126) + 1;
      this.held.set(pad, { target, pressure: -1, sounding: false, repeating: false });
      this.noteOn(pad, velocity);
      this.selectTarget(target, mc);
    } else if (event.phase === "move") {
      const held = this.held.get(pad);
      const pressure = Math.round(event.pressure * 127);
      if (!held || held.repeating || held.pressure === pressure) return;
      held.pressure = pressure;
      const { target } = held;
      if (target.kind === "channel") this.midi(midiBytes.channelPressure(target.index, pressure));
      else {
        for (const note of notesOf(target)) this.midi(midiBytes.polyPressure(note, pressure));
      }
    } else {
      this.release(pad);
    }
  }

  private selectTarget(target: Target, mc: ModeContext): void {
    if (target.kind === "channel" && mc.fl.selectedChannel.index !== target.index) {
      mc.send({ type: "selectChannel", index: target.index });
    }
  }

  private noteOn(pad: number, velocity: number): void {
    const held = this.held.get(pad);
    if (!held) return;
    const { target } = held;
    const sent = this.settings.apply(velocity); // FIXED VEL: the same velocity for every note
    if (target.kind === "channel") this.midi(midiBytes.channelNoteOn(target.index, sent));
    else for (const note of notesOf(target)) this.midi(midiBytes.noteOn(note, sent));
    held.sounding = true;
  }

  private noteOff(pad: number): void {
    const held = this.held.get(pad);
    if (!held?.sounding) return;
    held.sounding = false;
    const { target } = held;
    if (target.kind === "channel") this.midi(midiBytes.channelNoteOff(target.index));
    else for (const note of notesOf(target)) this.midi(midiBytes.noteOff(note));
  }

  /**
   * NOTE REPEAT: a hit on `pad` that the repeater plays. Holds the pad (as a hit does: its target
   * is where every repeat and the end go, and PAD MODE selects the channel) but sends no note.
   * False = nothing sits under the pad.
   */
  startRepeat(pad: number, mc: ModeContext): boolean {
    this.release(pad);
    const target = this.targetOf(pad, mc.fl);
    if (!target) return false;
    this.held.set(pad, { target, pressure: -1, sounding: false, repeating: true });
    this.selectTarget(target, mc);
    return true;
  }

  /** NOTE REPEAT: one repeat of a held pad (a note still on ends first). Velocity 1–127. */
  soundRepeat(pad: number, velocity: number): void {
    this.noteOff(pad);
    this.noteOn(pad, velocity);
  }

  /** NOTE REPEAT: the end of a repeat's note. */
  silenceRepeat(pad: number): void {
    this.noteOff(pad);
  }

  /** NOTE REPEAT: the pad is let go (or the overlay closed): ends its note and forgets it. */
  endRepeat(pad: number): void {
    if (this.held.get(pad)?.repeating) this.release(pad);
  }

  /** Is the pad held and playing through NOTE REPEAT? */
  isRepeating(pad: number): boolean {
    return this.held.get(pad)?.repeating ?? false;
  }

  /** The notes a hit on `pad` plays now in KEYBOARD or CHORDS; none in PAD MODE. */
  arpNotes(pad: number): readonly number[] {
    if (this.mode === "keyboard") return [this.keyNote(pad)];
    if (this.mode === "chords") return this.chordAt(pad).notes;
    return [];
  }

  /** The arpeggiator: a note on (a note still on ends first). Velocity 1–127; FIXED VEL replaces it. */
  arpOn(note: number, velocity: number): void {
    this.arpOff(note);
    this.midi(midiBytes.noteOn(note, this.settings.apply(velocity)));
    this.arpSounding.add(note);
  }

  /** The arpeggiator: the end of a note. */
  arpOff(note: number): void {
    if (!this.arpSounding.delete(note)) return;
    this.midi(midiBytes.noteOff(note));
  }

  /**
   * A pad hit while ERASE is held and no page took it (the stack calls this): PAD MODE clears all
   * steps of the pad's channel in the current pattern, KEYBOARD and CHORDS do nothing. Nothing is played, so
   * there is no held note to track.
   */
  erase(pad: number, mc: ModeContext): void {
    if (this.mode !== "channels") return;
    const index = bankFirst(currentBank(mc.fl)) + pad;
    if (index < mc.fl.channelTotal) mc.send({ type: "clearSteps", channel: index });
  }

  private release(pad: number): void {
    const held = this.held.get(pad);
    if (!held) return;
    this.noteOff(pad);
    this.held.delete(pad);
  }

  /** End every held pad's note (the device went away, or mk3d is shutting down). */
  releaseAll(): void {
    for (const pad of [...this.held.keys()]) this.release(pad);
    for (const note of [...this.arpSounding]) this.arpOff(note);
  }

  // ── LEDs ───────────────────────────────────────────────────────────────────

  /** A held pad is pressed; a repeating one flashes with each repeat. */
  private isPressed(pad: number): boolean {
    const held = this.held.get(pad);
    return held !== undefined && (!held.repeating || held.sounding);
  }

  /** The color of a KEYBOARD or CHORDS pad in `variant` (the arpeggiator lights its own pads). */
  keyLed(fl: FlState, variant: LedVariant): number {
    if (!fl.connected) return LED_OFF;
    return fl.selectedChannel.index === null
      ? paletteColor(DEFAULT_PAD_COLOR, variant)
      : flColorToPalette(fl.selectedChannel.color, variant);
  }

  /**
   * The pad LEDs when no page owns the pads. keyboard and chords: the selected channel's color, the
   * roots (C notes in Chromatic; a scale's root, a chord set's I chords) brighter; channels: each pad its channel's color, the selected one bright, the rest dim, off
   * past the last channel. A held pad is pressed; so is a channel pad while FL plays that channel
   * (ACTIVITY: the sequencer, the playlist or another controller), like Maschine's pads flashing
   * with the pattern.
   */
  leds(leds: LedState, fl: FlState): void {
    const bank = currentBank(fl);
    const selected = fl.selectedChannel.index;
    const color = (value: number | undefined, variant: LedVariant) =>
      value === undefined
        ? paletteColor(DEFAULT_PAD_COLOR, variant)
        : flColorToPalette(value, variant);
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      let led = LED_OFF;
      if (fl.connected) {
        if (this.mode !== "channels") {
          const variant = this.isPressed(pad) ? "pressed" : this.isRootPad(pad) ? "bright" : "dim";
          led = color(selected === null ? undefined : fl.selectedChannel.color, variant);
        } else {
          const index = bankFirst(bank) + pad;
          if (index < fl.channelTotal) {
            const variant =
              this.isPressed(pad) || fl.channelActive(index)
                ? "pressed"
                : index === selected
                  ? "bright"
                  : "dim";
            led = color(fl.channels.get(index)?.color, variant);
          }
        }
      }
      leds.setPad(pad, led);
    }
  }
}
