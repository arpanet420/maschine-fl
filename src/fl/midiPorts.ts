// Virtual CoreMIDI ports: FL Studio sees "MK3 Bridge" as an input and "MK3 Bridge FB" as an output.
import { EventEmitter } from "node:events";
import midi from "@julusian/midi";
import {
  CC,
  CHANNEL_NOTE_CHANNEL,
  CONTROL_CHANNEL,
  NOTE_CHANNEL,
  PORT_FROM_FL,
  PORT_TO_FL,
} from "./protocol.js";
import {
  decodeSysex,
  encodeCommand,
  encodeSysex,
  type FlCommand,
  type FlMessage,
} from "./sysex.js";

export interface FlPortEvents {
  message: [message: FlMessage];
}

const clamp7 = (value: number) => Math.min(127, Math.max(0, Math.round(value)));

/** MIDI bytes, separated from the ports so they can be tested without CoreMIDI. */
export const midiBytes = {
  noteOn: (note: number, velocity: number) => [
    0x90 | NOTE_CHANNEL,
    clamp7(note),
    Math.max(1, clamp7(velocity)),
  ],
  noteOff: (note: number) => [0x80 | NOTE_CHANNEL, clamp7(note), 0],
  polyPressure: (note: number, pressure: number) => [
    0xa0 | NOTE_CHANNEL,
    clamp7(note),
    clamp7(pressure),
  ],
  /** PAD MODE: `index` is the channel's group-local index, sent as the note number on MIDI channel 2. */
  channelNoteOn: (index: number, velocity: number) => [
    0x90 | CHANNEL_NOTE_CHANNEL,
    clamp7(index),
    Math.max(1, clamp7(velocity)),
  ],
  channelNoteOff: (index: number) => [0x80 | CHANNEL_NOTE_CHANNEL, clamp7(index), 0],
  channelPressure: (index: number, pressure: number) => [
    0xa0 | CHANNEL_NOTE_CHANNEL,
    clamp7(index),
    clamp7(pressure),
  ],
  control: (cc: (typeof CC)[keyof typeof CC]) => [0xb0 | CONTROL_CHANNEL, cc, 127],
};

export class FlPorts extends EventEmitter<FlPortEvents> {
  private readonly output = new midi.Output();
  private readonly input = new midi.Input();

  open(): void {
    this.output.openVirtualPort(PORT_TO_FL);
    // RtMidi ignores SysEx unless told otherwise: (sysex, timing, active sensing).
    this.input.ignoreTypes(false, true, true);
    this.input.on("message", (_delta: number, bytes: number[]) => {
      const message = decodeSysex(bytes);
      if (message) this.emit("message", message);
    });
    this.input.openVirtualPort(PORT_FROM_FL);
  }

  close(): void {
    this.input.closePort();
    this.output.closePort();
  }

  send(bytes: number[]): void {
    this.output.sendMessage(bytes);
  }

  sendSysex(command: number, payload: number[] = []): void {
    this.output.sendMessage(encodeSysex(command, payload));
  }

  sendCommand(command: FlCommand): void {
    this.output.sendMessage(encodeCommand(command));
  }
}
