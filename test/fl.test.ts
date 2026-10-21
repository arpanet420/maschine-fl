import { describe, expect, it } from "vitest";
import { midiBytes } from "../src/fl/midiPorts.js";
import { CC, CMD, FROM_FL, PROTOCOL_VERSION, TO_FL } from "../src/fl/protocol.js";
import { decodeSysex, encodeSysex } from "../src/fl/sysex.js";

describe("SysEx", () => {
  it("frames commands with our header and terminator", () => {
    expect(encodeSysex(CMD.requestState)).toEqual([0xf0, 0x7d, 0x4d, 0x33, 0x41, 0xf7]);
    expect(() => encodeSysex(0x02, [0x80])).toThrow(RangeError);
  });

  it("decodes HELLO and TRANSPORT from FL", () => {
    expect(decodeSysex([0xf0, 0x7d, 0x4d, 0x33, 0x01, 0x01, 0xf7])).toEqual({
      type: "hello",
      version: 1,
    });
    expect(decodeSysex(encodeSysex(CMD.transport, [0b1011]))).toEqual({
      type: "transport",
      state: { songMode: false, playing: true, recording: true, metronome: false, countIn: true },
      tempo: 0,
      swing: 0,
    });
  });

  it("ignores other manufacturers and broken frames", () => {
    expect(decodeSysex([0xf0, 0x00, 0x21, 0x09, 0x01, 0xf7])).toBeUndefined();
    expect(decodeSysex([0xf0, 0x7d, 0x4d, 0x33, 0x01])).toBeUndefined();
    expect(decodeSysex([0x90, 60, 100])).toBeUndefined();
  });

  it("passes unknown commands through for logging", () => {
    expect(decodeSysex(encodeSysex(0x3e, [1, 2]))).toEqual({
      type: "unknown",
      command: 0x3e,
      payload: [1, 2],
    });
  });
});

describe("PROTOCOL", () => {
  it("is version 2 with disjoint command ranges", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(Object.values(FROM_FL).every((c) => c >= 0x01 && c <= 0x3f)).toBe(true);
    expect(Object.values(TO_FL).every((c) => c >= 0x40 && c <= 0x7f)).toBe(true);
    expect(new Set(Object.values(CMD)).size).toBe(Object.keys(CMD).length);
  });
});

describe("MIDI bytes", () => {
  it("sends notes on channel 1 with velocity 1–127", () => {
    expect(midiBytes.noteOn(36, 100)).toEqual([0x90, 36, 100]);
    expect(midiBytes.noteOn(36, 0)).toEqual([0x90, 36, 1]);
    expect(midiBytes.noteOn(36, 300)).toEqual([0x90, 36, 127]);
    expect(midiBytes.noteOff(51)).toEqual([0x80, 51, 0]);
    expect(midiBytes.polyPressure(40, 64.4)).toEqual([0xa0, 40, 64]);
  });

  it("sends transport CCs on channel 16", () => {
    expect(midiBytes.control(CC.play)).toEqual([0xbf, 102, 127]);
    expect(midiBytes.control(CC.metronome)).toEqual([0xbf, 106, 127]);
    expect(midiBytes.control(CC.restart)).toEqual([0xbf, 108, 127]);
  });
});
