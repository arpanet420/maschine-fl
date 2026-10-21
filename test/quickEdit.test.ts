import { describe, expect, it } from "vitest";
import { READOUT_MS, READOUT_RECT } from "../src/modes/quickEdit.js";
import { stackHarness } from "../src/tools/stackHarness.js";

const norm = (value: number) => Math.round(value * 1e4) / 1e4;

describe("quick edit: the radio group", () => {
  it("starts with all three buttons dim and none on", () => {
    const h = stackHarness();
    expect([h.light("volume"), h.light("swing"), h.light("tempo")]).toEqual(["dim", "dim", "dim"]);
    expect(h.stack.quickEdit.mode).toBeUndefined();
  });

  it("a press turns that mode on (bright), another press moves the light, the same press turns it off", () => {
    const h = stackHarness();
    h.tap("volume");
    expect([h.light("volume"), h.light("swing"), h.light("tempo")]).toEqual([
      "bright",
      "dim",
      "dim",
    ]);
    h.tap("tempo");
    expect(h.stack.quickEdit.mode).toBe("tempo");
    expect([h.light("volume"), h.light("swing"), h.light("tempo")]).toEqual([
      "dim",
      "dim",
      "bright",
    ]);
    h.tap("tempo");
    expect(h.stack.quickEdit.mode).toBeUndefined();
    expect([h.light("volume"), h.light("swing"), h.light("tempo")]).toEqual(["dim", "dim", "dim"]);
  });

  it("is off without FL, and a press then does nothing", () => {
    const h = stackHarness();
    h.fl.reset();
    expect([h.light("volume"), h.light("swing"), h.light("tempo")]).toEqual(["off", "off", "off"]);
    h.tap("volume");
    expect(h.stack.quickEdit.mode).toBeUndefined();
  });

  it("SHIFT + the button does nothing", () => {
    const h = stackHarness();
    h.state.shift = true;
    h.tap("swing");
    expect(h.stack.quickEdit.mode).toBeUndefined();
    h.state.shift = false;
    h.tap("swing");
    h.state.shift = true;
    h.tap("swing"); // does not turn it off either
    expect(h.stack.quickEdit.mode).toBe("swing");
  });

  it("is not a page button: the pages never see it, and it opens nothing", () => {
    const h = stackHarness();
    h.press("volume");
    h.release("volume");
    expect(h.stack.top).toBeUndefined();
    expect(h.stack.main).toBe("channel");
  });
});

describe("quick edit: 4D turns go to it on every page", () => {
  it("without a mode a turn belongs to the page (Channel mode: another channel)", () => {
    const h = stackHarness({ selected: 2 });
    h.turn(1);
    expect(h.sentOf("selectChannel")).toEqual([{ type: "selectChannel", index: 3 }]);
  });

  it("with a mode on, a turn on the Channel page edits FL's main volume instead", () => {
    const h = stackHarness({ selected: 2 });
    h.tap("volume");
    expect(h.turn(1)).toBe(true);
    expect(h.sentOf("selectChannel")).toEqual([]);
    expect(h.sentOf("setMainVolume")).toHaveLength(1);
    expect(h.sentOf("setTrack")).toEqual([]); // not the Master mixer fader
  });

  it("also on the Mixer page (which edits the selected track's volume without it)", () => {
    const h = stackHarness();
    h.tap("mixer");
    h.sent.length = 0;
    h.turn(1);
    expect(h.sentOf("setTrack")).toMatchObject([{ index: 1, what: "volume" }]); // the page's own
    h.sent.length = 0;
    h.advance(1000);
    h.tap("volume");
    h.turn(1);
    expect(h.sentOf("setMainVolume")).toHaveLength(1);
    expect(h.sentOf("setTrack")).toEqual([]);
  });

  it("also under an overlay and on a tool page", () => {
    const h = stackHarness();
    h.tap("volume");
    h.press("pattern"); // an overlay on top
    h.turn(1);
    h.release("pattern");
    h.tap("step"); // a tool page on top
    h.advance(1000);
    h.turn(1);
    expect(h.sentOf("setMainVolume")).toHaveLength(2);
    expect(h.sentOf("selectChannel")).toEqual([]);
  });

  it("push and tilt still reach the page", () => {
    const h = stackHarness({ selected: 2 });
    h.tap("tempo");
    h.push();
    expect(h.sentOf("showEditor")).toEqual([{ type: "showEditor", index: 2 }]); // Channel mode's push
    h.tilt("down");
    expect(h.sentOf("selectChannel")).toEqual([{ type: "selectChannel", index: 3 }]);
  });

  it("a turn is not edited while FL is gone, and not handled by the page either", () => {
    const h = stackHarness();
    h.tap("volume");
    h.fl.reset();
    h.turn(1);
    expect(h.sent).toEqual([]);
  });
});

describe("quick edit: main values", () => {
  const lastMain = (h: ReturnType<typeof stackHarness>) =>
    (h.sentOf("setMainVolume").at(-1) as { value: number }).value;

  it("VOLUME: FL's main volume, 1/100 per detent, 1/1000 with SHIFT, clamped to 0…1", () => {
    const h = stackHarness({ mainVolume: 0.8 });
    h.tap("volume");
    h.turn(1);
    expect(norm(lastMain(h))).toBe(0.81);
    h.turn(2); // before FL answers: the value we set wins
    expect(norm(lastMain(h))).toBe(0.83);
    h.advance(1000);
    h.state.shift = true;
    h.turn(-1);
    expect(norm(lastMain(h))).toBe(0.799);
    h.state.shift = false;
    h.advance(1000);
    h.turn(-100);
    expect(lastMain(h)).toBe(0);
    expect(h.sentOf("setTrack")).toEqual([]); // never the Master mixer fader
  });

  it("stops at the top and the bottom once FL agrees", () => {
    const h = stackHarness();
    h.tap("volume");
    h.transport({ mainVolume: 1 });
    h.turn(1);
    expect(h.sentOf("setMainVolume")).toEqual([]); // nothing above 100 %
    h.transport({ mainVolume: 0 });
    h.turn(-1);
    expect(h.sentOf("setMainVolume")).toEqual([]);
  });

  it("after the pending value runs out the turn starts from what FL says", () => {
    const h = stackHarness({ mainVolume: 0.8 });
    h.tap("volume");
    h.turn(1);
    h.advance(400);
    h.turn(1); // FL never moved: 0.8 + 0.01 again
    expect(norm(lastMain(h))).toBe(0.81);
  });

  it("VOLUME ignores a turn until FL has reported the main volume (an older script never does)", () => {
    const h = stackHarness();
    h.tap("volume");
    // a TRANSPORT without the main volume field, like the script before it was added
    h.fl.apply({
      type: "transport",
      state: { ...h.fl.transport },
      tempo: h.fl.tempo,
      swing: h.fl.swing,
    });
    expect(h.fl.mainVolume).toBeUndefined();
    h.turn(1);
    expect(h.sent).toEqual([]);
    expect(h.stack.quickEdit.readout(h.mc, { pad: true, channel: null })).toBeUndefined();
    h.transport({ mainVolume: 0.5 }); // the script catches up
    h.turn(1);
    expect(norm(lastMain(h))).toBe(0.51);
  });

  it("SWING: main swing, 1/100 per detent, 1/1000 with SHIFT", () => {
    const h = stackHarness({ swing: 0.5 });
    h.tap("swing");
    h.turn(3);
    expect(h.sentOf("setSwing").map((c) => norm(c.value))).toEqual([0.53]);
    h.advance(1000);
    h.state.shift = true;
    h.turn(2);
    expect(h.sentOf("setSwing").map((c) => norm(c.value))).toEqual([0.53, 0.502]);
  });

  it("SWING clamps to 0…1", () => {
    const h = stackHarness({ swing: 0.005 });
    h.tap("swing");
    h.turn(-1);
    expect(h.sentOf("setSwing")[0]?.value).toBe(0);
    h.advance(1000);
    h.transport({ swing: 0 }); // FL has it now
    h.turn(-1);
    expect(h.sentOf("setSwing")).toHaveLength(1);
  });

  it("TEMPO: ±1 BPM per detent, ±0.01 with SHIFT, within FL's 10…522", () => {
    const h = stackHarness({ tempo: 120 });
    h.tap("tempo");
    h.turn(1);
    h.turn(1);
    expect(h.sentOf("setTempo").map((c) => c.bpm)).toEqual([121, 122]);
    h.advance(1000);
    h.transport({ tempo: 122 }); // FL has it now
    h.state.shift = true;
    h.turn(-1);
    h.turn(-1);
    expect(h.sentOf("setTempo").map((c) => c.bpm)).toEqual([121, 122, 121.99, 121.98]);
  });

  it("TEMPO stops at the limits", () => {
    const h = stackHarness({ tempo: 521.5 });
    h.tap("tempo");
    h.turn(5);
    expect(h.sentOf("setTempo").map((c) => c.bpm)).toEqual([522]);
    h.advance(1000);
    h.fl.apply({
      type: "transport",
      state: {
        songMode: false,
        playing: false,
        recording: false,
        metronome: false,
        countIn: false,
      },
      tempo: 11,
      swing: 0,
    });
    h.sent.length = 0;
    h.turn(-5);
    expect(h.sentOf("setTempo").map((c) => c.bpm)).toEqual([10]);
  });

  it("TEMPO waits for FL's tempo", () => {
    const h = stackHarness();
    h.fl.apply({
      type: "transport",
      state: {
        songMode: false,
        playing: false,
        recording: false,
        metronome: false,
        countIn: false,
      },
      tempo: 0,
      swing: 0,
    });
    h.tap("tempo");
    h.turn(1);
    expect(h.sent).toEqual([]);
  });

  it("switching the mode drops our pending values", () => {
    const h = stackHarness({ mainVolume: 0.8 });
    h.tap("volume");
    h.turn(5);
    h.tap("swing");
    h.tap("volume");
    h.turn(1); // FL still says 0.8
    expect(norm(lastMain(h))).toBe(0.81);
  });
});

describe("quick edit: while a pad is held", () => {
  it("VOLUME edits the selected channel's volume in KEYBOARD mode", () => {
    const h = stackHarness({ selected: 2, volume: 0.5 });
    h.tap("volume");
    h.pad(4);
    h.turn(2);
    expect(h.sentOf("setChannel").map((c) => ({ ...c, value: norm(c.value) }))).toEqual([
      { type: "setChannel", index: 2, what: "volume", value: 0.52 },
    ]);
    expect(h.sentOf("setTrack")).toEqual([]);
    h.pad(4, "up");
    h.advance(1000);
    h.turn(1); // released: the main volume again
    expect(h.sentOf("setMainVolume")).toHaveLength(1);
  });

  it("in PAD MODE the hit's channel is the one, once FL has selected it", () => {
    const h = stackHarness({ selected: 0 });
    h.tap("padMode");
    h.release("padMode");
    h.sent.length = 0;
    h.tap("volume");
    h.pad(3); // channel 3: the hit selects it, and FL answers at once in this harness
    h.sent.length = 0;
    h.turn(1);
    expect(h.sentOf("setChannel")).toMatchObject([{ index: 3, what: "volume" }]);
    expect(norm(h.sentOf("setChannel")[0]?.value ?? 0)).toBe(0.79);
  });

  it("in PAD MODE a turn waits while FL still reports another channel", () => {
    const h = stackHarness({ selected: 0 });
    h.tap("padMode");
    h.release("padMode");
    h.tap("volume");
    // FL does not answer the selection yet
    const answers = h.mc.send;
    h.mc.send = (command) => {
      if (command.type !== "selectChannel") answers(command);
    };
    h.pad(5);
    h.sent.length = 0;
    h.turn(1);
    expect(h.sent).toEqual([]);
    h.mc.send = answers;
  });

  it("TEMPO tunes the channel: ±1 semitone per detent, SHIFT ±0.01, as a pan-style value", () => {
    const h = stackHarness({ selected: 1, pitch: 0, pitchRange: 12 });
    h.tap("tempo");
    h.pad(0);
    h.turn(1);
    h.advance(1000);
    h.state.shift = true;
    h.turn(-1);
    const values = h.sentOf("setChannel").map((c) => ({ what: c.what, value: c.value }));
    expect(values[0]?.what).toBe("pitch");
    expect(values[0]?.value).toBeCloseTo((1 / 12 + 1) / 2, 6);
    expect(values[1]?.value).toBeCloseTo((-0.01 / 12 + 1) / 2, 6);
    expect(h.sentOf("setTempo")).toEqual([]);
  });

  it("TUNE stops at the pitch range", () => {
    const h = stackHarness({ selected: 1, pitch: 11 / 12, pitchRange: 12 });
    h.tap("tempo");
    h.pad(0);
    h.turn(5);
    expect(h.sentOf("setChannel")[0]?.value).toBe(1);
  });

  it("SWING stays the main swing with a pad held", () => {
    const h = stackHarness({ swing: 0.2 });
    h.tap("swing");
    h.pad(0);
    h.turn(1);
    expect(h.sentOf("setSwing").map((c) => norm(c.value))).toEqual([0.21]);
    expect(h.sentOf("setChannel")).toEqual([]);
  });

  it("a pad that ERASE or SHIFT took is not a held pad", () => {
    const h = stackHarness();
    h.tap("volume");
    h.press("erase");
    h.pad(2);
    h.turn(1);
    expect(h.sentOf("setChannel")).toEqual([]);
    expect(h.sentOf("setMainVolume")).toHaveLength(1);
  });
});

describe("quick edit: the read-out", () => {
  it("is not there until the 4D encoder is turned, and not for ever after", () => {
    const h = stackHarness({ mainVolume: 0.78 });
    h.tap("volume");
    expect(h.stack.quickEdit.readout(h.mc, { pad: false, channel: null })).toBeUndefined();
    h.turn(1);
    const free = { pad: false, channel: null };
    expect(h.stack.quickEdit.readout(h.mc, free)).toMatchObject({
      level: "MAIN",
      label: "VOLUME",
      value: "79",
      unit: "%",
    });
    h.advance(READOUT_MS - 100);
    expect(h.stack.quickEdit.readout(h.mc, free)).toBeDefined();
    h.advance(200);
    expect(h.stack.quickEdit.readout(h.mc, free)).toBeUndefined();
  });

  it("every turn starts the 2 s again", () => {
    const h = stackHarness();
    h.tap("swing");
    h.turn(1);
    h.advance(READOUT_MS - 100);
    h.turn(1);
    h.advance(READOUT_MS - 100);
    expect(h.stack.quickEdit.readout(h.mc, { pad: false, channel: null })).toBeDefined();
  });

  it("is shown for as long as a pad is held in the mode, and goes when it is released", () => {
    const h = stackHarness({ selected: 2 });
    h.tap("volume");
    h.pad(0);
    const held = { pad: true, channel: 2 };
    expect(h.stack.quickEdit.readout(h.mc, held)).toMatchObject({
      level: "Clap",
      label: "VOLUME",
      value: "78",
    });
    h.advance(60_000);
    expect(h.stack.quickEdit.readout(h.mc, held)).toBeDefined();
    expect(h.stack.quickEdit.readout(h.mc, { pad: false, channel: null })).toBeUndefined();
  });

  it("shows nothing while the mode is off, even after a turn", () => {
    const h = stackHarness();
    h.tap("tempo");
    h.turn(1);
    h.tap("tempo");
    expect(h.stack.quickEdit.readout(h.mc, { pad: false, channel: null })).toBeUndefined();
  });

  it("tempo reads like 120.00 BPM, swing like a percentage, pitch in semitones", () => {
    const h = stackHarness({ tempo: 120, swing: 0.25, selected: 1, pitch: 0.25, pitchRange: 12 });
    const free = { pad: false, channel: null };
    h.tap("tempo");
    h.turn(1);
    expect(h.stack.quickEdit.readout(h.mc, free)).toMatchObject({
      label: "TEMPO",
      value: "121.00",
      unit: "BPM",
    });
    h.tap("swing");
    h.turn(1);
    expect(h.stack.quickEdit.readout(h.mc, free)).toMatchObject({
      label: "SWING",
      value: "26",
      unit: "%",
    });
    h.state.shift = true;
    h.advance(1000);
    h.transport({ tempo: 121, swing: 0.26 }); // FL has them now
    h.turn(1);
    expect(h.stack.quickEdit.readout(h.mc, free)).toMatchObject({ value: "26.1" });
    h.tap("tempo"); // SHIFT: ignored
    h.state.shift = false;
    h.tap("tempo");
    expect(h.stack.quickEdit.readout(h.mc, { pad: true, channel: 1 })).toMatchObject({
      level: "Snare",
      label: "TUNE",
      value: "+3.00",
      unit: "st",
    });
  });

  it("is drawn over the middle of the left screen only: not over the tabs or the knob labels", () => {
    const h = stackHarness();
    const pixels = (ctx: ReturnType<typeof h.render>["left"]) =>
      ctx.getImageData(0, 0, 480, 272).data;
    const before = pixels(h.render().left);
    h.tap("volume");
    h.turn(1);
    const { left, right } = h.render();
    const after = pixels(left);
    const changed = { top: 272, bottom: 0, left: 480, right: 0 };
    for (let y = 0; y < 272; y++) {
      for (let x = 0; x < 480; x++) {
        const i = (y * 480 + x) * 4;
        if (before[i] === after[i] && before[i + 1] === after[i + 1]) continue;
        changed.top = Math.min(changed.top, y);
        changed.bottom = Math.max(changed.bottom, y);
        changed.left = Math.min(changed.left, x);
        changed.right = Math.max(changed.right, x);
      }
    }
    expect(changed.top).toBeGreaterThanOrEqual(READOUT_RECT.y - 1);
    expect(changed.top).toBeGreaterThan(20); // the tab strip is 20 px
    expect(changed.bottom).toBeLessThanOrEqual(READOUT_RECT.y + READOUT_RECT.height);
    expect(changed.bottom).toBeLessThan(272 - 60); // the knob labels
    // the right screen is not touched
    const rightBefore = pixels(stackHarness().render().right);
    expect(pixels(right)).toEqual(rightBefore);
  });
});
