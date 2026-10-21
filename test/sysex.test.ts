import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FlState } from "../src/fl/flState.js";
import { FROM_FL, MARKER_TICKS_UNKNOWN, TO_FL, VIEW_FLAGS } from "../src/fl/protocol.js";
import { describeProbe } from "../src/flLog.js";
import {
  decodeCommand,
  decodeSysex,
  encodeCommand,
  encodeFlMessage,
  encodeSysex,
  type FlCommand,
  type FlMessage,
} from "../src/fl/sysex.js";

interface Vector {
  name: string;
  direction: "fromFl" | "toFl";
  message: unknown;
  hex: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/sysex-vectors.json", import.meta.url), "utf8"),
) as Vector[];

const toBytes = (hex: string) => (hex.match(/../g) ?? []).map((h) => parseInt(h, 16));
const toHex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
const frame = (command: number, payload: number[]) => [
  0xf0,
  0x7d,
  0x4d,
  0x33,
  command,
  ...payload,
  0xf7,
];

/** Float fields decode to v / 16383 (peaks: v / 127), so they only match within one step. */
const TOLERANCE: Record<string, number> = {
  volume: 1 / 16383,
  pan: 1 / 16383,
  pitch: 1 / 16383,
  cutoff: 1 / 16383,
  resonance: 1 / 16383,
  value: 1 / 16383,
  swing: 1 / 16383,
  mainVolume: 1 / 16383,
  peaks: 1 / 127,
};

function expectMatch(actual: unknown, expected: unknown, tolerance?: number): void {
  if (typeof expected === "number" && tolerance !== undefined) {
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);
  } else if (Array.isArray(expected)) {
    expect(actual).toBeInstanceOf(Array);
    expect((actual as unknown[]).length).toBe(expected.length);
    expected.forEach((item, i) => expectMatch((actual as unknown[])[i], item, tolerance));
  } else if (typeof expected === "object" && expected !== null) {
    const record = expected as Record<string, unknown>;
    expect(Object.keys(actual as object).sort()).toEqual(Object.keys(record).sort());
    for (const [key, value] of Object.entries(record)) {
      expectMatch((actual as Record<string, unknown>)[key], value, TOLERANCE[key] ?? tolerance);
    }
  } else {
    expect(actual).toEqual(expected);
  }
}

const fromFl = vectors.filter((v) => v.direction === "fromFl");
const toFl = vectors.filter((v) => v.direction === "toFl");

describe("shared SysEx vectors", () => {
  it("has the 95 vectors of the spec", () => {
    expect(vectors).toHaveLength(95);
  });

  describe.each(fromFl)("FL → mk3d: $name", ({ message, hex }) => {
    const bytes = toBytes(hex);

    it("decodes", () => {
      expectMatch(decodeSysex(bytes), message);
    });

    it("encodes", () => {
      expect(toHex(encodeFlMessage(message as FlMessage))).toBe(hex);
    });

    it("survives decode → encode", () => {
      const decoded = decodeSysex(bytes);
      expect(decoded && toHex(encodeFlMessage(decoded))).toBe(hex);
    });
  });

  describe.each(toFl)("mk3d → FL: $name", ({ message, hex }) => {
    const bytes = toBytes(hex);

    it("encodes", () => {
      expect(toHex(encodeCommand(message as FlCommand))).toBe(hex);
    });

    it("decodes", () => {
      expectMatch(decodeCommand(bytes), message);
    });

    it("survives decode → encode", () => {
      const decoded = decodeCommand(bytes);
      expect(decoded && toHex(encodeCommand(decoded))).toBe(hex);
    });
  });
});

describe("strings", () => {
  const nameOf = (name: string) => {
    const bytes = encodeFlMessage({
      type: "selectedChannel",
      index: 0,
      color: 0,
      volume: 0,
      pan: 0,
      name,
      plugin: "",
    });
    const message = decodeSysex(bytes);
    return { bytes, name: message?.type === "selectedChannel" ? message.name : undefined };
  };

  it("escapes UTF-8 bytes of 0x80 and up as 7F + low 7 bits", () => {
    const { bytes, name } = nameOf("Hö");
    // 'H', ö = C3 B6, terminator, empty plugin name
    expect(bytes.slice(-8)).toEqual([0x48, 0x7f, 0x43, 0x7f, 0x36, 0x00, 0x00, 0xf7]);
    expect(name).toBe("Hö");
  });

  it("round-trips multi-byte characters", () => {
    expect(nameOf("日本語 ♪ 😀").name).toBe("日本語 ♪ 😀");
  });

  it("cuts at 32 characters, not bytes", () => {
    expect(nameOf("a".repeat(40)).name).toBe("a".repeat(32));
    expect(nameOf("ö".repeat(40)).name).toBe("ö".repeat(32));
    expect(nameOf("😀".repeat(40)).name).toBe("😀".repeat(32));
    expect(nameOf("b".repeat(32)).name).toBe("b".repeat(32));
  });

  it("drops control characters and DEL", () => {
    expect(nameOf("a\tb\x7fc\nd\x00e").name).toBe("abcde");
  });

  it("keeps every byte 7-bit", () => {
    const { bytes } = nameOf("Ωmega ü 😀");
    expect(bytes.slice(1, -1).every((b) => b <= 0x7f)).toBe(true);
  });
});

describe("numbers", () => {
  const selected = (color: number, volume = 0, pan = 0): FlMessage => ({
    type: "selectedChannel",
    index: 0,
    color,
    volume,
    pan,
    name: "",
    plugin: "",
  });
  const roundTrip = (message: FlMessage) => decodeSysex(encodeFlMessage(message));

  it("masks FL's signed colors to 24 bits", () => {
    for (const [color, expected] of [
      [-1, 0xffffff],
      [-16711936, 0x00ff00], // 0xFF00FF00
      [0x1ff0000, 0xff0000],
      [0x123456, 0x123456],
    ] as const) {
      expect(roundTrip(selected(color))).toMatchObject({ color: expected });
    }
  });

  it("clamps norm and pan values", () => {
    const hi = encodeCommand({ type: "setParam", param: 0, value: 1.5 });
    const lo = encodeCommand({ type: "setParam", param: 0, value: -0.5 });
    const nan = encodeCommand({ type: "setParam", param: 0, value: NaN });
    expect(hi.slice(-3, -1)).toEqual([0x7f, 0x7f]);
    expect(lo.slice(-3, -1)).toEqual([0, 0]);
    expect(nan.slice(-3, -1)).toEqual([0, 0]);
    expect(roundTrip(selected(0, 7, -3))).toMatchObject({ volume: 1, pan: -1 });
    expect(roundTrip(selected(0, -7, 3))).toMatchObject({ volume: 0, pan: 1 });
  });

  it("rounds half up", () => {
    // 0.5 × 16383 = 8191.5 → 8192, so pan 0 is 0x4000 (half up, not half to even)
    expect(encodeCommand({ type: "setParam", param: 0, value: 0.5 }).slice(-3, -1)).toEqual([
      0x40, 0x00,
    ]);
    expect(
      encodeFlMessage({ type: "meters", offset: 0, peaks: [[2.5 / 127, 3.5 / 127]] }).slice(-3, -1),
    ).toEqual([3, 4]);
  });

  it("clamps integers to their field width", () => {
    expect(encodeCommand({ type: "selectChannel", index: 99999 }).slice(-3, -1)).toEqual([
      0x7f, 0x7f,
    ]);
    expect(encodeCommand({ type: "selectChannel", index: -4 }).slice(-3, -1)).toEqual([0, 0]);
  });

  it("encodes tempo in hundredths of a BPM", () => {
    const state = {
      songMode: false,
      playing: false,
      recording: false,
      metronome: false,
      countIn: false,
    };
    expect(roundTrip({ type: "transport", state, tempo: 99.99, swing: 0 })).toMatchObject({
      tempo: 99.99,
    });
    expect(roundTrip({ type: "transport", state, tempo: 30000, swing: 0 })).toMatchObject({
      tempo: 0x1fffff / 100,
    });
  });
});

describe("quick edit, NAVIGATE and GRID messages", () => {
  it("clamps SET_TEMPO to FL's 10–522 BPM", () => {
    const wire = (bpm: number) => decodeCommand(encodeCommand({ type: "setTempo", bpm }));
    expect(wire(5)).toEqual({ type: "setTempo", bpm: 10 });
    expect(wire(1000)).toEqual({ type: "setTempo", bpm: 522 });
    expect(wire(120.01)).toEqual({ type: "setTempo", bpm: 120.01 });
  });

  it("clamps SET_SWING like every norm", () => {
    expect(encodeCommand({ type: "setSwing", value: 1.5 }).slice(-3, -1)).toEqual([0x7f, 0x7f]);
    expect(encodeCommand({ type: "setSwing", value: -1 }).slice(-3, -1)).toEqual([0, 0]);
  });

  it("encodes the new UI actions as 9–13", () => {
    const code = (action: Extract<FlCommand, { type: "ui" }>["action"]) =>
      encodeCommand({ type: "ui", action })[5];
    expect(
      ["cut", "copy", "paste", "quantize", "quantizeStarts"].map((a) => code(a as never)),
    ).toEqual([9, 10, 11, 12, 13]);
  });

  it("reads UI_STATE: snap, one bit per window, focus", () => {
    expect(decodeSysex(frame(FROM_FL.uiState, [13, 0b10101, 5]))).toEqual({
      type: "uiState",
      snap: 13,
      visible: [true, false, true, false, true],
      focused: 5,
    });
    expect(decodeSysex(frame(FROM_FL.uiState, [0, 0, 127, 9, 9]))).toMatchObject({ focused: 127 });
  });

  it("uses commands 13 and 50–53 (free before)", () => {
    expect(FROM_FL.uiState).toBe(0x13);
    expect([TO_FL.setTempo, TO_FL.setSwing, TO_FL.showWindow, TO_FL.setSnap]).toEqual([
      0x50, 0x51, 0x52, 0x53,
    ]);
    const used = [...Object.values(FROM_FL), ...Object.values(TO_FL)];
    expect(new Set(used).size).toBe(used.length);
  });
});

describe("main volume and undo state", () => {
  it("TRANSPORT carries the main volume after the swing, absent in older messages (unknown)", () => {
    const state = {
      songMode: false,
      playing: false,
      recording: false,
      metronome: false,
      countIn: false,
    };
    const wire = (mainVolume?: number) =>
      decodeSysex(
        encodeFlMessage({ type: "transport", state, tempo: 120, swing: 0.5, mainVolume }),
      );
    expect(wire(0.8)).toMatchObject({
      swing: expect.closeTo(0.5, 3),
      mainVolume: expect.closeTo(0.8, 3),
    });
    expect(wire(0)).toMatchObject({ mainVolume: 0 }); // 0 is a value, not "unknown"
    expect(wire(undefined)).not.toHaveProperty("mainVolume");
    // an older script's frame: flags, tempo and swing only
    expect(decodeSysex(frame(FROM_FL.transport, [0, 0, 0x64, 0x32, 0x20, 0]))).not.toHaveProperty(
      "mainVolume",
    );
  });

  it("SET_MAIN_VOLUME is command 54, a norm, clamped", () => {
    expect(TO_FL.setMainVolume).toBe(0x54);
    expect(encodeCommand({ type: "setMainVolume", value: 2 })).toEqual(frame(0x54, [0x7f, 0x7f]));
    expect(decodeCommand(frame(0x54, [0, 0]))).toEqual({ type: "setMainVolume", value: 0 });
  });

  it("UNDO_STATE is command 14: u14 position, u14 count, str hint", () => {
    expect(FROM_FL.undoState).toBe(0x14);
    expect(decodeSysex(frame(0x14, [0, 3, 1, 22, 0x41, 0x42, 0]))).toEqual({
      type: "undoState",
      position: 3,
      count: 150,
      hint: "AB",
    });
    const long = "x".repeat(40);
    expect(
      decodeSysex(encodeFlMessage({ type: "undoState", position: 20000, count: 0, hint: long })),
    ).toEqual({ type: "undoState", position: 0x3fff, count: 0, hint: "x".repeat(32) });
    expect(decodeSysex(frame(0x14, [0, 3]))).toBeUndefined(); // cut short
  });
});

describe("the playlist probe: PROBE and RUN_PROBE", () => {
  it("PROBE is command 17: a string of up to 100 characters", () => {
    expect(FROM_FL.probe).toBe(0x17);
    expect(decodeSysex(frame(0x17, [0x61, 0x62, 0]))).toEqual({ type: "probe", text: "ab" });
    const hundred = "x".repeat(100);
    expect(decodeSysex(encodeFlMessage({ type: "probe", text: hundred + "yyy" }))).toEqual({
      type: "probe",
      text: hundred,
    });
    expect(decodeSysex(encodeFlMessage({ type: "probe", text: "" }))).toEqual({
      type: "probe",
      text: "",
    });
    expect(decodeSysex(frame(0x17, [0x61, 0x62]))).toBeUndefined(); // no terminator
  });

  it("RUN_PROBE is command 5C, no payload", () => {
    expect(TO_FL.runProbe).toBe(0x5c);
    expect(encodeCommand({ type: "runProbe" })).toEqual(frame(0x5c, []));
    expect(decodeCommand(frame(0x5c, []))).toEqual({ type: "runProbe" });
  });

  it("is logged as a line and leaves FlState alone", () => {
    const fl = new FlState();
    fl.apply({ type: "hello", version: 2 });
    const sections: string[] = [];
    fl.on("change", (section) => sections.push(section));
    fl.apply({ type: "probe", text: "perf=0 tracks=2" });
    expect(sections).toEqual([]);
    expect(describeProbe("perf=0 tracks=2")).toBe("← FL probe: perf=0 tracks=2");
  });
});

describe("PRESETS, PRESET_STEP, the presets VIEW flag and the saveNew UI action", () => {
  it("PRESETS is command 15: u14 count, u14 current (none = 16383), u7 n, u14 offset, n × str", () => {
    expect(FROM_FL.presets).toBe(0x15);
    expect(decodeSysex(frame(0x15, [2, 0x2c, 0, 17, 2, 0, 14, 0x41, 0, 0x42, 0]))).toEqual({
      type: "presets",
      count: 300,
      current: 17,
      offset: 14,
      names: ["A", "B"],
    });
    expect(decodeSysex(frame(0x15, [0, 0, 0x7f, 0x7f, 0, 0, 0]))).toEqual({
      type: "presets",
      count: 0,
      current: null,
      offset: 0,
      names: [],
    });
    expect(decodeSysex(frame(0x15, [2, 0x2c, 0, 17, 2, 0, 14, 0x41, 0]))).toBeUndefined(); // 1 of 2 names
  });

  it("encodes the window the way the script does, and cuts long names", () => {
    const names = ["x".repeat(40), "y"];
    expect(
      decodeSysex(encodeFlMessage({ type: "presets", count: 20000, current: 3, offset: 2, names })),
    ).toEqual({
      type: "presets",
      count: 0x3fff,
      current: 3,
      offset: 2,
      names: ["x".repeat(32), "y"],
    });
  });

  it("PRESET_STEP is command 55: u7 dir, 0 = previous and 1 = next", () => {
    expect(TO_FL.presetStep).toBe(0x55);
    expect(encodeCommand({ type: "presetStep", dir: "prev" })).toEqual(frame(0x55, [0]));
    expect(encodeCommand({ type: "presetStep", dir: "next" })).toEqual(frame(0x55, [1]));
    expect(decodeCommand(frame(0x55, [1]))).toEqual({ type: "presetStep", dir: "next" });
    expect(decodeCommand(frame(0x55, [0]))).toEqual({ type: "presetStep", dir: "prev" });
    expect(decodeCommand(frame(0x55, []))).toBeUndefined();
  });

  it("PRESET_WINDOW is 5D and PRESET_LOAD is 5E, each a u14", () => {
    expect(TO_FL.presetWindow).toBe(0x5d);
    expect(TO_FL.presetLoad).toBe(0x5e);
    expect(encodeCommand({ type: "presetWindow", offset: 300 })).toEqual(frame(0x5d, [2, 44]));
    expect(encodeCommand({ type: "presetLoad", index: 17 })).toEqual(frame(0x5e, [0, 17]));
    expect(decodeCommand(frame(0x5d, [2, 44]))).toEqual({ type: "presetWindow", offset: 300 });
    expect(decodeCommand(frame(0x5e, [0, 17]))).toEqual({ type: "presetLoad", index: 17 });
    expect(decodeCommand(frame(0x5e, [0]))).toBeUndefined();
  });

  it("VIEW flag 2 is presets, flag 1 stays meters", () => {
    const view = (meters: boolean, presets: boolean) =>
      encodeCommand({
        type: "view",
        channelOffset: 0,
        mixerOffset: 0,
        patternOffset: 0,
        stepOffset: 0,
        meters,
        presets,
        patternGrid: false,
        params: [],
      });
    expect(view(false, false)[13]).toBe(0);
    expect(view(true, false)[13]).toBe(1);
    expect(view(false, true)[13]).toBe(2);
    expect(view(true, true)[13]).toBe(3);
    for (const [meters, presets] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      expect(decodeCommand(view(meters, presets))).toMatchObject({ meters, presets });
    }
  });

  it("VIEW flag 4 is patternGrid, next to meters and presets", () => {
    const view = (meters: boolean, presets: boolean, patternGrid: boolean) =>
      encodeCommand({
        type: "view",
        channelOffset: 0,
        mixerOffset: 0,
        patternOffset: 0,
        stepOffset: 0,
        meters,
        presets,
        patternGrid,
        params: [],
      });
    expect(VIEW_FLAGS.patternGrid).toBe(4);
    expect(view(false, false, true)[13]).toBe(4);
    expect(view(true, true, true)[13]).toBe(7);
    expect(view(false, true, false)[13]).toBe(2);
    expect(decodeCommand(view(false, false, true))).toMatchObject({
      meters: false,
      presets: false,
      patternGrid: true,
    });
    expect(decodeCommand(view(true, false, false))).toMatchObject({ patternGrid: false });
  });

  it("PATTERN_GRID is 1B: channel, start, n, the bits 7 to a byte, flags", () => {
    expect(FROM_FL.patternGrid).toBe(0x1b);
    const steps = (list: number[], length: number) =>
      Array.from({ length }, (_, i) => list.includes(i));
    // 7 steps fill one byte; the 8th starts the next
    const message = (n: number, on: number[], stepSequencer = true): FlMessage => ({
      type: "patternGrid",
      channel: 3,
      start: 48,
      steps: steps(on, n),
      stepSequencer,
    });
    expect(encodeFlMessage(message(7, [0, 6]))).toEqual(frame(0x1b, [3, 0, 48, 7, 0x41, 1]));
    expect(encodeFlMessage(message(8, [7]))).toEqual(frame(0x1b, [3, 0, 48, 8, 0, 1, 1]));
    expect(encodeFlMessage(message(16, [0, 7, 14, 15]))).toEqual(
      frame(0x1b, [3, 0, 48, 16, 0x01, 0x01, 0x03, 1]),
    );
    expect(encodeFlMessage(message(1, [0], false))).toEqual(frame(0x1b, [3, 0, 48, 1, 1, 0]));
    expect(encodeFlMessage(message(0, []))).toEqual(frame(0x1b, [3, 0, 48, 0, 1]));
    // every length 0–16 round-trips, partial last bytes included
    for (let n = 0; n <= 16; n++) {
      const on = Array.from({ length: n }, (_, i) => i).filter((i) => (i * 5) % 3 === 0);
      const sent = message(n, on, n % 2 === 0);
      expect(decodeSysex(encodeFlMessage(sent))).toEqual(sent);
    }
    // a start beyond 127 needs both u14 bytes
    const far: FlMessage = { ...message(2, [1]), start: 250 } as FlMessage;
    expect(encodeFlMessage(far).slice(5, 8)).toEqual([3, 1, 122]);
    expect(decodeSysex(encodeFlMessage(far))).toEqual(far);
  });

  it("PATTERN_GRID is cut short or too long: nothing decodes", () => {
    expect(decodeSysex(frame(0x1b, [3, 0, 48, 8, 0, 1]))).toBeUndefined(); // the second byte and flags missing
    expect(decodeSysex(frame(0x1b, [3, 0, 48, 16, 0, 0, 0]))).toBeUndefined(); // flags missing
    expect(decodeSysex(frame(0x1b, [3, 0, 48, 17, 0, 0, 0, 0, 1]))).toBeUndefined(); // 17 steps
    expect(decodeSysex(frame(0x1b, [3, 0]))).toBeUndefined();
    expect(
      encodeFlMessage({
        type: "patternGrid",
        channel: 200,
        start: 0,
        steps: Array.from({ length: 20 }, () => true),
        stepSequencer: true,
      }),
    ).toEqual(frame(0x1b, [127, 0, 0, 16, 0x7f, 0x7f, 0x03, 1])); // clamped to 127 and 16 steps
  });

  it("MARKERS ticks 0x1FFFFF means the time is unknown (null)", () => {
    expect(MARKER_TICKS_UNKNOWN).toBe(0x1fffff);
    const markers = decodeSysex(
      frame(0x16, [2, 0, 2, 0x7f, 0x7f, 0x7f, 0x41, 0, 0, 1, 0, 0x42, 0, 0, 0x60]),
    );
    expect(markers).toEqual({
      type: "markers",
      total: 2,
      offset: 0,
      entries: [
        { ticks: null, name: "A" },
        { ticks: 128, name: "B" },
      ],
      ppq: 96,
    });
    expect(encodeFlMessage(markers as FlMessage)).toEqual(
      frame(0x16, [2, 0, 2, 0x7f, 0x7f, 0x7f, 0x41, 0, 0, 1, 0, 0x42, 0, 0, 0x60]),
    );
  });

  it("UI action 14 is saveNew (FPT_SaveNew)", () => {
    expect(encodeCommand({ type: "ui", action: "saveNew" })).toEqual(frame(TO_FL.ui, [14]));
    expect(decodeCommand(frame(TO_FL.ui, [14]))).toEqual({ type: "ui", action: "saveNew" });
  });
});

describe("tolerant decoding", () => {
  it("reads a v1 TRANSPORT (flags only) with tempo 0 and swing 0", () => {
    expect(decodeSysex(frame(FROM_FL.transport, [0b0101]))).toEqual({
      type: "transport",
      state: { songMode: false, playing: true, recording: false, metronome: true, countIn: false },
      tempo: 0,
      swing: 0,
    });
  });

  it("reads a TRANSPORT without the swing field (flags and tempo only) as swing 0", () => {
    expect(decodeSysex(frame(FROM_FL.transport, [0, 0, 0x64, 0x32]))).toMatchObject({
      tempo: 128.5,
      swing: 0,
    });
  });

  it("ignores extra bytes at the end of known messages", () => {
    expect(decodeSysex(frame(FROM_FL.hello, [2, 9, 9, 9]))).toEqual({ type: "hello", version: 2 });
    expect(decodeCommand(frame(TO_FL.selectTrack, [0, 12, 5]))).toEqual({
      type: "selectTrack",
      index: 12,
    });
    expect(decodeCommand(frame(TO_FL.requestState, [1, 2]))).toEqual({ type: "requestState" });
  });

  it("passes unknown FL commands through for logging", () => {
    expect(decodeSysex(frame(0x3f, [1, 2]))).toEqual({
      type: "unknown",
      command: 0x3f,
      payload: [1, 2],
    });
    expect(encodeFlMessage({ type: "unknown", command: 0x3f, payload: [1, 2] })).toEqual(
      frame(0x3f, [1, 2]),
    );
  });

  it("returns undefined for frames that are not ours", () => {
    const garbage: number[][] = [
      [],
      [0xf0],
      [0xf0, 0xf7],
      [0x90, 60, 100],
      [0xf0, 0x00, 0x21, 0x09, 0x01, 0xf7],
      [0xf0, 0x7d, 0x4d, 0x34, 0x01, 0x02, 0xf7],
      [0xf0, 0x7d, 0x4d, 0x33, 0x01, 0x02],
      [0x7d, 0x4d, 0x33, 0x01, 0x02, 0xf7],
    ];
    for (const bytes of garbage) {
      expect(decodeSysex(bytes), JSON.stringify(bytes)).toBeUndefined();
      expect(decodeCommand(bytes), JSON.stringify(bytes)).toBeUndefined();
    }
  });

  it("returns undefined for payloads that are not 7-bit", () => {
    expect(decodeSysex(frame(FROM_FL.hello, [0x82]))).toBeUndefined();
  });

  it("returns undefined for unknown commands and codes in mk3d → FL", () => {
    expect(decodeCommand(frame(0x7e, []))).toBeUndefined();
    expect(decodeCommand(frame(TO_FL.setChannel, [0, 1, 7, 0, 0]))).toBeUndefined();
    expect(decodeCommand(frame(TO_FL.setTrack, [0, 1, 5, 0, 0]))).toBeUndefined();
    expect(decodeCommand(frame(TO_FL.ui, [15]))).toBeUndefined();
  });

  it("does not throw on truncated frames", () => {
    for (const { direction, hex, name } of vectors) {
      const full = toBytes(hex);
      const payloadStart = 5;
      for (let end = payloadStart; end < full.length - 1; end++) {
        const cut = [...full.slice(0, end), 0xf7];
        const decoded = direction === "fromFl" ? decodeSysex(cut) : decodeCommand(cut);
        const label = `${name} cut to ${end - payloadStart} payload bytes`;
        // A v1 TRANSPORT is flags only, so a cut after the flags is a valid message.
        if (name.startsWith("transport") && end > payloadStart)
          expect(decoded, label).toBeDefined();
        else if (name === "requestState") expect(decoded, label).toBeDefined();
        else expect(decoded, label).toBeUndefined();
      }
    }
  });

  it("does not throw on random bytes", () => {
    let seed = 1;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 128;
    for (let i = 0; i < 2000; i++) {
      const payload = Array.from({ length: next() % 40 }, next);
      const command = i % 2 ? (next() % 0x40) + 1 : 0x40 + (next() % 0x40);
      expect(() => decodeSysex(frame(command, payload))).not.toThrow();
      expect(() => decodeCommand(frame(command, payload))).not.toThrow();
    }
  });
});

describe("framing", () => {
  it("rejects payload bytes above 0x7f when encoding", () => {
    expect(() => encodeSysex(0x02, [0x80])).toThrow(RangeError);
  });
});
