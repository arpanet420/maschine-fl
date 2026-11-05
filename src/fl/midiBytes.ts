// Extra MIDI messages on the note channel (the others live in midiPorts.ts).
import { NOTE_CHANNEL } from "./protocol.js";

export const clamp7 = (value: number) => Math.min(127, Math.max(0, Math.round(value)));
export const PITCH_BEND_CENTER = 8192;
export const PITCH_BEND_MAX = 16383;

export function cc(controller: number, value: number): number[] {
  return [0xb0 | NOTE_CHANNEL, clamp7(controller), clamp7(value)];
}
