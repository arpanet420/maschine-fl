// The MIDI ports to FL Studio: it sees "MK3 Bridge" as an input and "MK3 Bridge FB" as an output.
// macOS: virtual CoreMIDI ports we create. Windows has no such thing, so they are loopMIDI ports
// made beforehand, and we open them by name (docs/windows.md).
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

/** MIDI bytes, separated from the ports so they can be tested without real ports. */
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

/**
 * The port called `name`. RtMidi adds a number to Windows port names ("MK3 Bridge 2"), so that may
 * follow, but not more text: "MK3 Bridge" must not find "MK3 Bridge FB 3".
 */
export function findPort(names: readonly string[], name: string): number {
  return names.findIndex(
    (candidate) =>
      candidate.startsWith(name) && /^( \d+)?$/.test(candidate.slice(name.length).trimEnd()),
  );
}

function portNames(port: midi.Input | midi.Output): string[] {
  return Array.from({ length: port.getPortCount() }, (_, i) => port.getPortName(i));
}

function openNamed(port: midi.Input | midi.Output, name: string): void {
  const names = portNames(port);
  const index = findPort(names, name);
  if (index < 0) {
    throw new Error(
      `MIDI port "${name}" not found (there are: ${names.join(", ") || "none"}). ` +
        'On Windows, make "MK3 Bridge" and "MK3 Bridge FB" in loopMIDI first: docs/windows.md.',
    );
  }
  port.openPort(index);
}

export class FlPorts extends EventEmitter<FlPortEvents> {
  private readonly output = new midi.Output();
  private readonly input = new midi.Input();

  open(): void {
    const windows = process.platform === "win32";
    if (windows) openNamed(this.output, PORT_TO_FL);
    else this.output.openVirtualPort(PORT_TO_FL);
    // RtMidi ignores SysEx unless told otherwise: (sysex, timing, active sensing).
    this.input.ignoreTypes(false, true, true);
    this.input.on("message", (_delta: number, bytes: number[]) => {
      const message = decodeSysex(bytes);
      if (message) this.emit("message", message);
    });
    if (windows) openNamed(this.input, PORT_FROM_FL);
    else this.input.openVirtualPort(PORT_FROM_FL);
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
