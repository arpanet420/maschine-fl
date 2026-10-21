import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cc, pitchBend } from "../src/fl/midiBytes.js";
import { midiBytes } from "../src/fl/midiPorts.js";
import { MONO_LEDS } from "../src/hw/leds.js";
import { flColorToPalette } from "../src/modes/format.js";
import { LED_OFF, paletteWhite } from "../src/hw/palette.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";
import { STRIP_READOUT_MS, STRIP_SEND_MS } from "../src/strip.js";

/** The STRIP commands sent so far as [kind, value, release]. */
const strips = (h: StackHarness) =>
  h.sentOf("strip").map((c) => [c.kind, c.value, c.release] as const);
const vst = (h: StackHarness) =>
  h.fl.apply({
    type: "plugin",
    channel: h.fl.selectedChannel.index,
    valid: true,
    paramCount: 4240,
    name: "Diva",
  });
const strip = (h: StackHarness) => Array.from(h.ledState().padLeds.subarray(1, 26));
const buttons = (h: StackHarness) =>
  (["pitch", "mod", "perform", "notes"] as const).map((id) => h.light(id));
const WHITE = paletteWhite("bright");
/** The selected channel's colour on the strip. */
const colorOf = (h: StackHarness) => flColorToPalette(h.fl.selectedChannel.color, "bright");
const dimOf = (h: StackHarness) => flColorToPalette(h.fl.selectedChannel.color, "dim");

describe("midiBytes", () => {
  it("encodes 14-bit pitch bend LSB first on channel 1", () => {
    expect(pitchBend(8192)).toEqual([0xe0, 0x00, 0x40]);
    expect(pitchBend(0)).toEqual([0xe0, 0, 0]);
    expect(pitchBend(16383)).toEqual([0xe0, 0x7f, 0x7f]);
    expect(pitchBend(99999)).toEqual([0xe0, 0x7f, 0x7f]);
    expect(pitchBend(0x1234)).toEqual([0xe0, 0x34, 0x24]);
  });

  it("encodes a control change on channel 1", () => {
    expect(cc(1, 64)).toEqual([0xb0, 1, 64]);
    expect(cc(1, 500)).toEqual([0xb0, 1, 127]);
  });
});

describe("touch strip: the mode buttons", () => {
  it("are a radio group, PITCH by default; the lit one again leaves no mode", () => {
    const h = stackHarness();
    expect(buttons(h)).toEqual(["bright", "dim", "dim", "dim"]);
    h.tap("notes");
    expect(buttons(h)).toEqual(["dim", "dim", "dim", "bright"]);
    h.tap("mod");
    expect(buttons(h)).toEqual(["dim", "bright", "dim", "dim"]);
    h.tap("mod");
    expect(buttons(h)).toEqual(["dim", "dim", "dim", "dim"]);
    h.tap("perform");
    expect(buttons(h)).toEqual(["dim", "dim", "bright", "dim"]);
  });

  it("work on every page and do nothing with SHIFT", () => {
    const h = stackHarness();
    h.press("mixer");
    h.sent.length = 0;
    h.tap("perform");
    expect(h.strip.mode).toBe("perform");
    h.state.shift = true;
    h.tap("pitch");
    expect(h.strip.mode).toBe("perform");
    expect(h.sent).toEqual([]);
  });

  it("are off while FL is not connected", () => {
    const h = stackHarness();
    h.fl.reset();
    expect(buttons(h)).toEqual(["off", "off", "off", "off"]);
    expect(strip(h).every((v) => v === LED_OFF)).toBe(true);
  });

  it("the mode is saved with the page state and comes back", () => {
    const pinsPath = join(mkdtempSync(join(tmpdir(), "strip-")), "pages.json");
    const a = stackHarness({ pinsPath });
    a.tap("notes");
    expect((JSON.parse(readFileSync(pinsPath, "utf8")) as { stripMode: string }).stripMode).toBe(
      "notes",
    );
    expect(stackHarness({ pinsPath }).strip.mode).toBe("notes");
    a.tap("notes"); // no mode
    expect((JSON.parse(readFileSync(pinsPath, "utf8")) as { stripMode: string }).stripMode).toBe(
      "none",
    );
    expect(stackHarness({ pinsPath }).strip.mode).toBeUndefined();
  });

  it("have their own LED bytes", () => {
    expect(new Set([MONO_LEDS.pitch, MONO_LEDS.mod, MONO_LEDS.perform, MONO_LEDS.notes]).size).toBe(
      4,
    );
  });
});

describe("touch strip: PITCH", () => {
  it("sends STRIP pitch with the finger (no raw pitch bend) and springs back to centre on release", () => {
    const h = stackHarness();
    h.stripAt(1);
    h.stripAt(1); // same value: not resent
    h.stripAt(0.25); // inside the rate limit: held back
    expect(strips(h)).toEqual([["pitch", 16383, false]]);
    h.advance(STRIP_SEND_MS);
    h.stripAt(0.25, false);
    expect(strips(h)).toEqual([
      ["pitch", 16383, false],
      ["pitch", 4096, false],
      ["pitch", 8192, true],
    ]);
    expect(h.midi).toEqual([]);
  });

  it("coalesces a fast slide to one message per STRIP_SEND_MS and keeps the last value", () => {
    const h = stackHarness();
    h.stripAt(0);
    h.stripAt(0.1);
    h.stripAt(0.2);
    h.stripAt(0.3);
    expect(strips(h)).toEqual([["pitch", 0, false]]);
    h.advance(STRIP_SEND_MS - 1);
    expect(strips(h).length).toBe(1);
    h.advance(1);
    expect(strips(h)).toEqual([
      ["pitch", 0, false],
      ["pitch", Math.round(0.3 * 16383), false],
    ]);
    h.advance(200); // nothing more waits
    expect(strips(h).length).toBe(2);
  });

  it("the release goes out at once and drops what was held back", () => {
    const h = stackHarness();
    h.stripAt(1);
    h.stripAt(0.2); // held back
    h.stripAt(0.2, false);
    h.advance(200);
    expect(strips(h)).toEqual([
      ["pitch", 16383, false],
      ["pitch", 8192, true],
    ]);
  });

  it("the centre of the strip is still a value (the script owns the no-bend case)", () => {
    const h = stackHarness();
    h.stripAt(0.5);
    expect(strips(h)).toEqual([["pitch", 8192, false]]);
  });

  it("LEDs: untouched only the centre, white; touched a bar from the centre to a white finger", () => {
    const h = stackHarness();
    const lit = (leds: number[]) => leds.filter((v) => v !== LED_OFF);
    expect(lit(strip(h))).toEqual([WHITE]);
    expect(strip(h)[12]).toBe(WHITE);
    h.stripAt(1);
    let leds = strip(h);
    expect(leds.slice(12, 24)).toEqual(Array(12).fill(colorOf(h)));
    expect(leds[24]).toBe(WHITE);
    expect(leds.slice(0, 12).every((v) => v === LED_OFF)).toBe(true);
    h.stripAt(0);
    leds = strip(h);
    expect(leds[0]).toBe(WHITE);
    expect(leds.slice(1, 13)).toEqual(Array(12).fill(colorOf(h)));
    h.stripAt(0, false);
    expect(lit(strip(h))).toEqual([WHITE]);
  });

  it("SHIFT ends the bend and sends nothing new", () => {
    const h = stackHarness();
    h.stripAt(1);
    h.state.shift = true;
    h.stripAt(0.2);
    h.stripAt(0.3);
    h.advance(100);
    expect(strips(h)).toEqual([
      ["pitch", 16383, false],
      ["pitch", 8192, true],
    ]);
  });

  it("release() and a page change put the bend back; so does a channel change", () => {
    const h = stackHarness();
    h.stripAt(0);
    h.strip.release(h.mc);
    expect(strips(h).at(-1)).toEqual(["pitch", 8192, true]);
    h.stripAt(0, false);
    h.stripAt(0.8);
    h.press("mixer");
    expect(strips(h).at(-1)).toEqual(["pitch", 8192, true]);
    const n = strips(h).length;
    h.stripAt(0.9); // the same touch plays nothing more
    h.advance(100);
    expect(strips(h).length).toBe(n);
    h.stripAt(0.9, false);
    h.stripAt(0.7);
    h.select(5);
    expect(strips(h).at(-1)).toEqual(["pitch", 8192, true]);
  });
});

describe("touch strip: MOD", () => {
  it("falls back to a raw CC 1 on channel 1 for a plugin without CC parameters", () => {
    const h = stackHarness();
    h.tap("mod");
    h.stripAt(0);
    h.stripAt(0.5);
    h.stripAt(1);
    h.stripAt(1, false);
    expect(h.midi).toEqual([cc(1, 0), cc(1, 64), cc(1, 127)]);
    expect(strips(h)).toEqual([]);
  });

  it("sends STRIP mod (0 to 127) for a VST with CC parameters, and the last value at the release", () => {
    const h = stackHarness();
    vst(h);
    h.tap("mod");
    h.stripAt(0);
    h.stripAt(0.5); // held back
    h.advance(STRIP_SEND_MS);
    h.stripAt(1);
    h.stripAt(1, false);
    expect(strips(h)).toEqual([
      ["mod", 0, false],
      ["mod", 64, false],
      ["mod", 127, true],
    ]);
    expect(h.midi).toEqual([]);
  });

  it("a plugin with fewer than 4224 parameters gets the raw CC", () => {
    const h = stackHarness();
    h.fl.apply({ type: "plugin", channel: 0, valid: true, paramCount: 300, name: "Sytrus" });
    h.tap("mod");
    h.stripAt(1);
    expect(h.midi).toEqual([cc(1, 127)]);
    expect(strips(h)).toEqual([]);
  });

  it("remembers the value per FL channel and shows it when the channel is selected", () => {
    const h = stackHarness({ selected: 0 });
    h.tap("mod");
    h.stripAt(1);
    h.stripAt(1, false);
    h.select(1);
    expect(strip(h).every((v) => v === LED_OFF)).toBe(true); // channel 2 has no value yet
    h.stripAt(0.5);
    h.stripAt(0.5, false);
    expect(strip(h)[12]).toBe(WHITE);
    h.select(0);
    expect(strip(h)[24]).toBe(WHITE);
    expect(strip(h)[0]).toBe(colorOf(h));
    h.select(1);
    expect(strip(h)[12]).toBe(WHITE);
    expect(strip(h)[13]).toBe(LED_OFF);
  });

  it("LEDs: a bar from the left to the value in the channel colour, the value LED white", () => {
    const h = stackHarness();
    h.tap("mod");
    h.stripAt(0.25);
    const leds = strip(h);
    const value = Math.round((Math.round(0.25 * 127) / 127) * 24);
    expect(leds.slice(0, value)).toEqual(Array(value).fill(colorOf(h)));
    expect(leds[value]).toBe(WHITE);
    expect(leds.slice(value + 1).every((v) => v === LED_OFF)).toBe(true);
  });
});

describe("touch strip: PERFORM", () => {
  it("sends STRIP perform for the selected channel and the release when the finger lifts", () => {
    const h = stackHarness({ selected: 2 });
    h.tap("perform");
    h.stripAt(0);
    h.advance(STRIP_SEND_MS);
    h.stripAt(0.5);
    h.stripAt(0.5); // unchanged: not resent
    h.advance(STRIP_SEND_MS);
    h.stripAt(1);
    h.stripAt(1, false);
    expect(strips(h).map((c) => c[0])).toEqual(["perform", "perform", "perform", "perform"]);
    expect(
      strips(h)
        .map((c) => c[1])
        .slice(0, 3),
    ).toEqual([0, 8192, 16383]);
    expect(strips(h).at(-1)?.[2]).toBe(true);
    expect(h.sentOf("setChannel")).toEqual([]); // the script sets the filter now
    expect(h.midi).toEqual([]);
  });

  it("hands the value back (a release) on a mode change, SHIFT, a page change, a channel change and release()", () => {
    const releases = (h: StackHarness) => strips(h).filter((c) => c[2]).length;
    const h = stackHarness();
    h.tap("perform");
    h.stripAt(0.8);
    h.tap("mod"); // mode change
    expect(releases(h)).toBe(1);
    h.tap("perform");
    h.stripAt(0, false);
    h.stripAt(0.7);
    h.state.shift = true;
    h.stripAt(0.6); // SHIFT
    expect(releases(h)).toBe(2);
    h.state.shift = false;
    h.stripAt(0.6, false);
    h.stripAt(0.5);
    h.press("mixer"); // page change
    expect(releases(h)).toBe(3);
    h.stripAt(0.5, false);
    h.stripAt(0.5);
    h.select(4); // channel change under the finger
    expect(releases(h)).toBe(4);
    h.stripAt(0.5, false);
    h.stripAt(0.5);
    h.strip.release(h.mc); // disconnect
    expect(releases(h)).toBe(5);
    h.strip.release(h.mc); // nothing left to give back
    expect(releases(h)).toBe(5);
  });

  it("LEDs: off untouched; a bar from the left, white at the finger, while touched", () => {
    const h = stackHarness();
    h.tap("perform");
    expect(strip(h).every((v) => v === LED_OFF)).toBe(true);
    h.stripAt(0.5);
    const leds = strip(h);
    expect(leds.slice(0, 12)).toEqual(Array(12).fill(colorOf(h)));
    expect(leds[12]).toBe(WHITE);
    expect(leds.slice(13).every((v) => v === LED_OFF)).toBe(true);
    h.stripAt(0.5, false);
    expect(strip(h).every((v) => v === LED_OFF)).toBe(true);
  });
});

describe("touch strip: NOTES", () => {
  const on = (note: number, velocity = 100) => midiBytes.noteOn(note, velocity);
  const off = (note: number) => midiBytes.noteOff(note);

  it("plays the zone's note (2 octaves from the base note), slides, and ends on release", () => {
    const h = stackHarness();
    h.tap("notes");
    h.stripAt(0); // chromatic, base 36: 24 zones
    h.stripAt(0.01); // same zone
    h.stripAt(0.5);
    h.stripAt(1);
    h.stripAt(1, false);
    expect(h.midi).toEqual([on(36), off(36), on(48), off(48), on(59), off(59)]);
  });

  it("follows the KEYBOARD scale and base note: 2 octaves of the scale", () => {
    const h = stackHarness();
    h.pads.harmony.scale = 1; // Major: 7 notes, 14 zones
    h.pads.shiftBase(1); // 37
    h.tap("notes");
    h.stripAt(0);
    h.stripAt(0.5); // zone 7 = the octave
    h.stripAt(0.999);
    h.stripAt(0.999, false);
    expect(h.midi).toEqual([
      on(37),
      off(37),
      on(49),
      off(49),
      on(h.pads.keyNote(13)),
      off(h.pads.keyNote(13)),
    ]);
    expect(h.pads.keyNote(13)).toBe(37 + 12 + 11);
  });

  it("uses FIXED VEL when it is on", () => {
    const h = stackHarness();
    h.padSettings.fixedOn = true;
    h.padSettings.fixedVelocity = 64;
    h.tap("notes");
    h.stripAt(0);
    expect(h.midi).toEqual([on(36, 64)]);
  });

  it("PAD MODE: the zones are the 16 channels of the bank, notes on MIDI channel 2", () => {
    const h = stackHarness({ selected: 2 });
    h.pads.mode = "channels";
    h.tap("notes");
    h.stripAt(0.5); // zone 8
    h.stripAt(0.5, false);
    expect(h.midi).toEqual([midiBytes.channelNoteOn(8, 100), midiBytes.channelNoteOff(8)]);
    expect(h.midi[0]?.[0]).toBe(0x91);
    expect(h.sentOf("selectChannel").at(-1)).toEqual({ type: "selectChannel", index: 8 });
  });

  it("never leaves a note hanging: mode change, page change, SHIFT, release()", () => {
    const h = stackHarness();
    h.tap("notes");
    h.stripAt(0);
    h.tap("mod"); // mode change
    expect(h.midi).toEqual([on(36), off(36)]);

    h.tap("notes");
    h.midi.length = 0;
    h.stripAt(0, false);
    h.stripAt(0.5);
    h.press("mixer"); // page change
    expect(h.midi).toEqual([on(48), off(48)]);
    h.stripAt(0.6); // the finger is still down: this touch plays nothing more
    expect(h.midi).toEqual([on(48), off(48)]);
    h.stripAt(0.6, false);
    h.stripAt(0.6);
    expect(h.midi.at(-1)).toEqual(on(50)); // a new touch plays again (zone 14 = 36 + 14)

    h.stripAt(0, false);
    h.midi.length = 0;
    h.state.shift = true;
    h.stripAt(0.6);
    h.stripAt(0.3);
    expect(h.midi).toEqual([]); // under SHIFT the strip plays nothing
    h.state.shift = false;
    h.stripAt(0.3, false);
    h.stripAt(0.3);
    h.strip.release(h.mc); // disconnect
    expect(h.midi.at(-1)).toEqual(off(43));
  });

  it("LEDs: zone starts dim in the channel colour, the playing zone bright, the finger white", () => {
    const h = stackHarness();
    h.pads.harmony.scale = 1; // 14 zones over 25 LEDs
    h.tap("notes");
    const dim = dimOf(h);
    let leds = strip(h);
    expect(leds[0]).toBe(dim);
    expect(leds.filter((v) => v === dim).length).toBe(14);
    expect(leds.filter((v) => v !== LED_OFF && v !== dim)).toEqual([]);
    h.stripAt(0.5); // finger on LED 12, zone 7
    leds = strip(h);
    expect(leds[12]).toBe(WHITE);
    expect(leds.filter((v) => v === colorOf(h)).length).toBeGreaterThanOrEqual(1);
    h.stripAt(0.5, false);
    expect(strip(h).filter((v) => v === WHITE)).toEqual([]);
  });

  it("PAD MODE LEDs: no boundary where there is no channel", () => {
    const h = stackHarness({ selected: 0 });
    h.pads.mode = "channels";
    h.tap("notes");
    const boundaries = strip(h).filter((v) => v !== LED_OFF).length;
    expect(boundaries).toBeLessThanOrEqual(16);
    expect(boundaries).toBe(Math.min(16, h.fl.channelTotal));
  });
});

describe("touch strip: no mode", () => {
  it("shows nothing for touches and the play position in the pattern while FL plays", () => {
    const h = stackHarness({ patternLength: 32 });
    h.tap("pitch"); // no mode
    expect(h.strip.mode).toBeUndefined();
    h.stripAt(0.5);
    expect(h.midi).toEqual([]);
    expect(strip(h).every((v) => v === LED_OFF)).toBe(true);
    h.playing(true);
    h.songPos(1, 1);
    expect(strip(h).filter((v) => v === WHITE).length).toBe(1); // step 1 of 32
    h.songPos(1, 17);
    const half = strip(h);
    expect(half.filter((v) => v === WHITE).length).toBe(Math.floor((16 / 32) * 25) + 1);
    expect(half.slice(0, 13).every((v) => v === WHITE)).toBe(true);
    h.songPos(2, 16); // the last step of 32 = 2 bars
    expect(strip(h).filter((v) => v === WHITE).length).toBe(25);
    h.songPos(3, 1); // wraps: the pattern starts again
    expect(strip(h).filter((v) => v === WHITE).length).toBe(1);
    h.playing(false);
    expect(strip(h).every((v) => v === LED_OFF)).toBe(true);
  });

  it("says when the play position moved enough to need new LEDs", () => {
    const h = stackHarness({ patternLength: 32 });
    h.tap("pitch");
    h.playing(true);
    h.songPos(1, 1);
    h.ledState();
    expect(h.strip.playPositionChanged(h.fl)).toBe(false);
    h.songPos(1, 2); // 1 of 32 steps: still the first LED
    expect(h.strip.playPositionChanged(h.fl)).toBe(false);
    h.songPos(1, 3);
    expect(h.strip.playPositionChanged(h.fl)).toBe(true);
    h.ledState();
    expect(h.strip.playPositionChanged(h.fl)).toBe(false);
  });
});

describe("touch strip: play position", () => {
  const whites = (h: StackHarness) => strip(h).filter((v) => v === WHITE).length;
  // 120 BPM = 8 steps a second = 125 ms a step; a 16 step pattern is 25 / 16 LEDs a step.
  const idle = () => {
    const h = stackHarness({ patternLength: 16, tempo: 120 });
    h.tap("pitch"); // no mode
    h.playing(true);
    return h;
  };

  it("moves between SONG_POS messages, estimated from the tempo", () => {
    const h = idle();
    h.songPos(1, 1);
    expect(whites(h)).toBe(1);
    h.advance(100); // 0.8 step
    expect(h.strip.playPositionChanged(h.fl)).toBe(true);
    expect(whites(h)).toBe(2);
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      h.advance(10);
      seen.push(whites(h));
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("includes the ticks of the message", () => {
    const h = idle();
    h.songPos(1, 5, 12); // 4.5 steps = 7.03 LEDs
    expect(whites(h)).toBe(8);
  });

  it("never steps back when a message is late, and only redraws when the lit LED changes", () => {
    const h = idle();
    h.songPos(1, 2);
    h.advance(60); // 1.48 steps
    const ahead = whites(h);
    expect(ahead).toBe(3);
    h.songPos(1, 2); // a late message that says 1.0
    expect(h.strip.playPositionChanged(h.fl)).toBe(false);
    expect(whites(h)).toBe(ahead);
    h.advance(10);
    expect(h.strip.playPositionChanged(h.fl)).toBe(false);
  });

  it("holds the last LED at the end of the pattern and wraps with the next message", () => {
    const h = idle();
    h.songPos(1, 16);
    h.advance(400); // past the end: the estimate stops there
    expect(whites(h)).toBe(25);
    h.songPos(2, 1); // the pattern came round
    expect(whites(h)).toBe(1);
    h.advance(10);
    expect(whites(h)).toBe(1);
  });

  it("pattern mode wraps by the pattern length, whatever the bar", () => {
    const h = idle();
    h.songPos(5, 9); // step 72 of the song: 72 mod 16 = 8
    expect(whites(h)).toBe(Math.floor((8 / 16) * 25) + 1);
  });

  it("song mode uses the song loop when one is active, else the pattern", () => {
    const h = stackHarness({ patternLength: 16, tempo: 120, songMode: true });
    h.tap("pitch");
    h.playing(true);
    h.songPos(3, 9); // no loop: 40 steps mod 16 = 8
    expect(whites(h)).toBe(Math.floor((8 / 16) * 25) + 1);
    // Bars 3 and 4 as the loop: 32 steps from tick 768 to 1536 (PPQ 96, 24 ticks a step).
    h.fl.apply({ type: "loopState", active: true, start: 768, end: 1536 });
    h.songPos(3, 1);
    expect(whites(h)).toBe(1);
    h.songPos(3, 9); // 8 of 32
    expect(whites(h)).toBe(Math.floor((8 / 32) * 25) + 1);
    h.songPos(4, 16); // the last step of the loop
    expect(whites(h)).toBe(Math.floor((31 / 32) * 25) + 1);
    h.songPos(5, 1); // outside and past the end: wraps within the loop
    expect(whites(h)).toBe(1);
    h.fl.apply({ type: "loopState", active: false, start: 0, end: 0 });
    h.songPos(5, 9);
    expect(whites(h)).toBe(Math.floor((8 / 16) * 25) + 1);
  });

  it("goes dark when FL stops and starts over when it plays again", () => {
    const h = idle();
    h.songPos(1, 9);
    expect(whites(h)).toBeGreaterThan(10);
    h.playing(false);
    expect(whites(h)).toBe(0);
    h.playing(true);
    h.songPos(1, 1);
    expect(whites(h)).toBe(1);
  });
});

describe("touch strip: change reports and read-out", () => {
  it("only reports a change when the LEDs or the card would differ", () => {
    const h = stackHarness();
    expect(h.stripAt(0.5)).toBe(true);
    expect(h.stripAt(0.5)).toBe(false);
    expect(h.stripAt(0.502)).toBe(false); // same LED and value
    expect(h.stripAt(0.9)).toBe(true);
  });

  const text = (h: StackHarness) => h.strip.readoutText();

  it("reads PITCH +0.43, MOD 87, CUTOFF 62 %, NOTE D#4", () => {
    const h = stackHarness();
    h.stripAt(0.5 + 0.43 / 2);
    expect(text(h)).toBe("PITCH +0.43");
    h.stripAt(0.2);
    expect(text(h)).toBe("PITCH -0.60");
    h.stripAt(0.2, false);
    h.tap("mod");
    h.stripAt(87 / 127);
    expect(text(h)).toBe("MOD 87");
    h.stripAt(0, false);
    h.tap("perform");
    h.stripAt(0.62);
    expect(text(h)).toBe("CUTOFF 62 %");
    h.stripAt(0, false);
    h.tap("notes");
    h.stripAt(0.34); // zone 8: 36 + 8 = D#...
    expect(text(h)).toBe("NOTE G#3");
    h.pads.shiftBase(3); // 39 = D#3
    h.stripAt(0.5);
    h.stripAt(0, false);
    h.stripAt(0);
    expect(text(h)).toBe("NOTE D#3");
  });

  it("is gone about a second after the release", () => {
    const h = stackHarness();
    h.stripAt(0.7);
    expect(text(h)).toBeDefined();
    h.stripAt(0.7, false);
    expect(text(h)).toBe("PITCH +0.00"); // the bend springs back
    h.advance(STRIP_READOUT_MS - 10);
    expect(text(h)).toBeDefined();
    h.advance(20);
    expect(text(h)).toBeUndefined();
  });

  it("is drawn on the left screen as a card with the channel", () => {
    const h = stackHarness();
    const before = h.render().left.getImageData(0, 52, 480, 132).data.join();
    h.stripAt(0.75);
    const after = h.render().left.getImageData(0, 52, 480, 132).data.join();
    expect(after).not.toBe(before);
    h.stripAt(0.75, false);
    h.advance(STRIP_READOUT_MS + 10);
    expect(h.render().left.getImageData(0, 52, 480, 132).data.join()).toBe(before);
  });
});
