// Extra MIDI messages on the note channel (the others live in midiPorts.ts).
import { NOTE_CHANNEL } from "./protocol.js";

const clamp7 = (value: number) => Math.min(127, Math.max(0, Math.round(value)));
export const PITCH_BEND_CENTER = 8192;
export const PITCH_BEND_MAX = 16383;

/** `value14` is 0–16383, centre 8192. */
export function pitchBend(value14: number): number[] {
  const v = Math.min(PITCH_BEND_MAX, Math.max(0, Math.round(value14)));
  return [0xe0 | NOTE_CHANNEL, v & 0x7f, v >> 7];
}

export function cc(controller: number, value: number): number[] {
  return [0xb0 | NOTE_CHANNEL, clamp7(controller), clamp7(value)];
}
