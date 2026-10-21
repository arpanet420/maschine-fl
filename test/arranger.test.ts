import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { cellRect } from "../src/modes/arrangerPage.js";
import { flColorToCss, flColorToPalette } from "../src/modes/format.js";
import { theme } from "../src/render/widgets.js";
import { demoChannelColor } from "../src/tools/demoState.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";

const arranger = (h: StackHarness) => h.pages.arranger;
const open = (options: Parameters<typeof stackHarness>[0] = {}) => {
  const h = stackHarness(options);
  h.tap("arranger");
  h.sent.length = 0;
  h.views.length = 0;
  return h;
};

/** Every fillText on both screens with the text, the fill style and the x it was drawn at. */
interface Drawn {
  text: string;
  style: string;
  x: number;
}
function draw(h: StackHarness): { left: Drawn[]; right: Drawn[]; right2d: SKRSContext2D } {
  const left = createCanvas(480, 272).getContext("2d");
  const right = createCanvas(480, 272).getContext("2d");
  const result = { left: [] as Drawn[], right: [] as Drawn[], right2d: right };
  const record = (ctx: SKRSContext2D, into: Drawn[]) => {
    const original = ctx.fillText.bind(ctx);
    ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      into.push({ text, style: String(ctx.fillStyle), x });
      original(text, x, y, maxWidth);
    };
  };
  record(left, result.left);
  record(right, result.right);
  h.stack.render(left, right, h.mc);
  return result;
}
const texts = (drawn: Drawn[]) => drawn.map((d) => d.text);

/** The color of one pixel as `#rrggbb`. */
function pixel(ctx: SKRSContext2D, x: number, y: number): string {
  const [r = 0, g = 0, b = 0] = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
/** The pixel in the middle of a step cell. */
function cellColor(ctx: SKRSContext2D, row: number, column: number): string {
  const rect = cellRect(row, column);
  return pixel(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2);
}
const brightness = (hex: string) =>
  [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);

const setPattern = (h: StackHarness, patch: Partial<StackHarness["fl"]["pattern"]>) => {
  h.fl.apply({ type: "pattern", ...h.fl.pattern, ...patch });
  h.stack.onFlChange("pattern", h.mc);
};
const lastView = (h: StackHarness) => h.views.at(-1);

describe("ARRANGER as the pattern overview", () => {
  it("is a main page: shows the playlist, watches the pattern grid, and the same button goes home", () => {
    const h = stackHarness();
    h.tap("arranger");
    expect(h.stack.main).toBe("arranger");
    expect(h.sentOf("showWindow")).toEqual([{ type: "showWindow", window: 2 }]);
    expect(h.sentOf("requestMarkers")).toEqual([]);
    expect(h.sentOf("runProbe")).toEqual([]);
    expect(lastView(h)).toMatchObject({
      patternGrid: true,
      meters: false,
      presets: false,
      channelOffset: 0,
      patternOffset: 0,
      stepOffset: 0,
    });
    expect(h.light("arranger")).toBe("bright");
    h.tap("arranger");
    expect(h.stack.main).toBe("channel");
    expect(lastView(h)?.patternGrid).toBe(false);
  });

  it("does not toggle the playlist away when it has the focus already", () => {
    const h = stackHarness({ ui: { visible: [false, true, true, false, false], focused: 2 } });
    h.tap("arranger");
    expect(h.sentOf("showWindow")).toEqual([]);
  });

  it("sends RUN_PROBE only with MK3D_PROBE=1 (or the option), once per opening", () => {
    const saved = process.env.MK3D_PROBE;
    try {
      delete process.env.MK3D_PROBE;
      const off = stackHarness();
      off.tap("arranger");
      expect(off.sentOf("runProbe")).toEqual([]);

      process.env.MK3D_PROBE = "1";
      const env = stackHarness();
      env.tap("arranger");
      expect(env.sentOf("runProbe")).toHaveLength(1);
      env.press("scene"); // an overlay's return is not an opening
      env.release("scene");
      expect(env.sentOf("runProbe")).toHaveLength(1);
      env.tap("arranger"); // home
      env.tap("arranger");
      expect(env.sentOf("runProbe")).toHaveLength(2);

      const overridden = stackHarness({ arranger: { probe: false } });
      overridden.tap("arranger");
      expect(overridden.sentOf("runProbe")).toEqual([]);

      process.env.MK3D_PROBE = "0";
      const zero = stackHarness();
      zero.tap("arranger");
      expect(zero.sentOf("runProbe")).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.MK3D_PROBE;
      else process.env.MK3D_PROBE = saved;
    }
    const forced = stackHarness({ arranger: { probe: true } });
    forced.tap("arranger");
    expect(forced.sentOf("runProbe")).toHaveLength(1);
  });

  it("has the patternGrid flag in the VIEW only while ARRANGER is the main page", () => {
    const h = stackHarness({ selected: 17 });
    expect(lastView(h)?.patternGrid ?? false).toBe(false);
    h.tap("mixer");
    expect(lastView(h)?.patternGrid).toBe(false);
    h.tap("arranger");
    expect(lastView(h)).toMatchObject({ patternGrid: true, channelOffset: 16, meters: false });
    h.press("pattern"); // an overlay patches the pattern window and keeps the rest
    expect(lastView(h)).toMatchObject({ patternGrid: true, patternOffset: 0, channelOffset: 16 });
    h.release("pattern");
    expect(lastView(h)?.patternGrid).toBe(true);
    h.tap("browser");
    expect(lastView(h)?.patternGrid).toBe(false);
    h.tap("arranger");
    h.tap("arranger"); // home
    expect(lastView(h)?.patternGrid).toBe(false);
  });

  it("keeps its VIEW under the STEP page and the SCENE overlay, and resends it when they close", () => {
    const h = open({ selected: 17 });
    h.tap("step");
    expect(lastView(h)).toMatchObject({ patternGrid: true, channelOffset: 16 });
    h.tap("step");
    h.views.length = 0;
    h.press("scene");
    h.release("scene");
    expect(lastView(h)).toMatchObject({ patternGrid: true, channelOffset: 16 });
    expect(h.sentOf("requestMarkers")).toHaveLength(1); // SCENE's own, not ARRANGER's
  });
});

describe("ARRANGER rows and the cursor", () => {
  it("shows the 8 first channels of the bank of the selected channel, the cursor on it", () => {
    const h = open({ selected: 0 });
    expect(arranger(h).rows(h.fl)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(arranger(h).cursorChannel).toBe(0);
    const bank2 = open({ selected: 18 });
    expect(arranger(bank2).rows(bank2.fl)).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
    expect(arranger(bank2).cursorChannel).toBe(18);
    expect(lastView(bank2)).toBeUndefined(); // the VIEW was sent on opening, before the reset
    const few = open({ selected: 1, channels: 5 });
    expect(arranger(few).rows(few.fl)).toEqual([0, 1, 2, 3, 4]);
  });

  it("turns the 4D encoder into the row cursor, scrolling the 8 rows through the 16 channels", () => {
    const h = open({ selected: 0 });
    h.turn(3);
    expect(arranger(h).cursorChannel).toBe(3);
    expect(arranger(h).rows(h.fl)[0]).toBe(0); // still in view: no scroll yet
    h.turn(5);
    expect(arranger(h).cursorChannel).toBe(8);
    expect(arranger(h).rows(h.fl)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    h.turn(100); // stops at the bank's last channel
    expect(arranger(h).cursorChannel).toBe(15);
    expect(arranger(h).rows(h.fl)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    h.turn(-4);
    expect(arranger(h).cursorChannel).toBe(11);
    expect(arranger(h).rows(h.fl)[0]).toBe(8); // the window stays while the cursor is in it
    h.turn(-100);
    expect(arranger(h).cursorChannel).toBe(0);
    expect(arranger(h).rows(h.fl)[0]).toBe(0);
    // the turn does not select anything in FL, and sends no VIEW (the bank did not change)
    expect(h.sentOf("selectChannel")).toEqual([]);
    expect(h.views).toEqual([]);
  });

  it("does not leave the bank: the last bank has the channels it has", () => {
    const h = open({ selected: 17 }); // bank B holds channels 16–23
    h.turn(50);
    expect(arranger(h).cursorChannel).toBe(23);
    h.turn(-50);
    expect(arranger(h).cursorChannel).toBe(16);
  });

  it("selects the cursor's channel in FL on a push, and the cursor stays there", () => {
    const h = open({ selected: 0 });
    h.turn(4);
    h.push(false); // a release does nothing
    expect(h.sentOf("selectChannel")).toEqual([]);
    h.push();
    expect(h.sentOf("selectChannel")).toEqual([{ type: "selectChannel", index: 4 }]);
    expect(h.fl.selectedChannel.index).toBe(4); // the harness answers like FL
    expect(arranger(h).cursorChannel).toBe(4);
  });

  it("moves the cursor with knob 5, a detent at a time", () => {
    const h = open({ selected: 0 });
    h.knob(4, 50);
    expect(arranger(h).cursorChannel).toBe(0); // under a detent
    h.knob(4, 70);
    expect(arranger(h).cursorChannel).toBe(1);
    h.knob(4, 360);
    expect(arranger(h).cursorChannel).toBe(4);
    h.knob(4, -1000);
    expect(arranger(h).cursorChannel).toBe(0);
  });

  it("leaves the other knobs alone: the left screen's knobs are empty", () => {
    const h = open();
    for (const index of [0, 1, 2, 3, 6, 7]) expect(h.knob(index, 120)).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.views).toEqual([]);
  });

  it("follows FL's selection when it changes (GROUP A–H, FL's own UI), but not a volume change", () => {
    const h = open({ selected: 0 });
    h.turn(5);
    h.fl.apply({
      type: "selectedChannel",
      ...h.fl.selectedChannel,
      volume: 0.3,
      index: h.fl.selectedChannel.index,
    });
    h.stack.onFlChange("selectedChannel", h.mc);
    expect(arranger(h).cursorChannel).toBe(5);
    h.select(20);
    expect(arranger(h).cursorChannel).toBe(20);
    expect(lastView(h)).toMatchObject({ channelOffset: 16, patternGrid: true });
    expect(arranger(h).rows(h.fl)).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it("changes the bank with GROUP A–H as on every page", () => {
    const h = open({ selected: 3 });
    h.tap("groupB");
    expect(h.sentOf("selectChannel")).toEqual([{ type: "selectChannel", index: 16 }]);
    expect(lastView(h)).toMatchObject({ channelOffset: 16 });
    expect(arranger(h).cursorChannel).toBe(16);
    h.tap("groupA");
    expect(arranger(h).cursorChannel).toBe(3); // the channel last selected in bank A
    expect(lastView(h)).toMatchObject({ channelOffset: 0 });
  });

  it("clamps the cursor when channels disappear", () => {
    const h = open({ selected: 0 });
    h.turn(12);
    h.fl.apply({ type: "channels", total: 6, offset: 0, entries: [] });
    h.stack.onFlChange("channels", h.mc);
    expect(arranger(h).cursorChannel).toBe(5);
    expect(arranger(h).rows(h.fl)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("ARRANGER step pages", () => {
  it("pages with 4D tilt, the knob 6 and display 7 and 8, sending the page in the VIEW", () => {
    const h = open(); // 64 steps: 4 pages
    expect(arranger(h).stepPage).toBe(0);
    h.tilt("right");
    expect(arranger(h).stepPage).toBe(1);
    expect(lastView(h)).toMatchObject({ stepOffset: 16, patternGrid: true });
    h.tilt("right", false); // a release does nothing
    expect(arranger(h).stepPage).toBe(1);
    h.tilt("left");
    expect(arranger(h).stepPage).toBe(0);
    h.tilt("left"); // at the start
    expect(arranger(h).stepPage).toBe(0);
    expect(h.tilt("up")).toBe(false);
    h.knob(5, 120);
    h.knob(5, 240);
    expect(arranger(h).stepPage).toBe(3);
    expect(lastView(h)).toMatchObject({ stepOffset: 48 });
    h.knob(5, 120); // at the end
    expect(arranger(h).stepPage).toBe(3);
    h.tap("display7");
    h.tap("display7");
    expect(arranger(h).stepPage).toBe(1);
    h.tap("display8");
    expect(arranger(h).stepPage).toBe(2);
    h.turn(2); // the 4D turn moves rows, not pages
    expect(arranger(h).stepPage).toBe(2);
  });

  it("lights display 7 and 8 only where there is another page", () => {
    const h = open();
    expect(h.light("display7")).toBe("off");
    expect(h.light("display8")).toBe("dim");
    h.tap("display8");
    expect(h.light("display7")).toBe("dim");
    h.tap("display8");
    h.tap("display8");
    expect(h.light("display8")).toBe("off");
    const single = open({ patternLength: 16 });
    expect(single.light("display7")).toBe("off");
    expect(single.light("display8")).toBe("off");
  });

  it("keeps the page inside a shorter pattern", () => {
    const h = open();
    h.tilt("right");
    h.tilt("right");
    h.tilt("right");
    h.views.length = 0;
    setPattern(h, { length: 20 });
    expect(arranger(h).stepPage).toBe(1);
    expect(lastView(h)).toMatchObject({ stepOffset: 16 });
  });

  it("follows the play head page by page while FOLLOW is on, and paging by hand sticks until the head moves on", () => {
    const h = open();
    h.playing(true);
    h.songPos(1, 5);
    expect(arranger(h).stepPage).toBe(0);
    h.songPos(3, 2); // step 33: page 2
    expect(arranger(h).stepPage).toBe(2);
    expect(lastView(h)).toMatchObject({ stepOffset: 32 });
    h.tilt("left"); // by hand, to page 1
    h.songPos(3, 9); // the head is still on page 2
    expect(arranger(h).stepPage).toBe(1);
    h.songPos(4, 1); // page 3: entered
    expect(arranger(h).stepPage).toBe(3);
    h.songPos(5, 1); // bar 5 wraps to step 1 of the 64: page 0
    expect(arranger(h).stepPage).toBe(0);
  });

  it("toggles FOLLOW on the FOLLOW button, and its LED shows it", () => {
    const h = open();
    expect(h.light("follow")).toBe("bright");
    h.playing(true);
    h.tap("follow");
    expect(h.light("follow")).toBe("dim");
    h.songPos(4, 1); // page 3, but FOLLOW is off
    expect(arranger(h).stepPage).toBe(0);
    h.tap("follow"); // on while playing: to the head's page at once
    expect(h.light("follow")).toBe("bright");
    expect(arranger(h).stepPage).toBe(3);
  });

  it("does not follow while FL is stopped", () => {
    const h = open();
    h.songPos(4, 1);
    expect(arranger(h).stepPage).toBe(0);
  });

  it("starts on the play head's page when it opens while FL plays", () => {
    const h = stackHarness();
    h.playing(true);
    h.songPos(3, 2);
    h.tap("arranger");
    expect(arranger(h).stepPage).toBe(2);
    expect(lastView(h)).toMatchObject({ stepOffset: 32 });
  });
});

describe("ARRANGER pads are the patterns", () => {
  const led = (index: number, variant: "bright" | "dim") =>
    flColorToPalette(demoChannelColor(index), variant);

  it("lights the patterns of the bank, the current one bright, the others dim, the rest off", () => {
    const h = open({ patternCount: 3 });
    expect(h.padLed(0)).toBe(led(0, "bright"));
    expect(h.padLed(1)).toBe(led(1, "dim"));
    expect(h.padLed(2)).toBe(led(2, "dim"));
    for (let pad = 3; pad < 16; pad++) expect(h.padLed(pad), `pad ${pad + 1}`).toBe(0);
  });

  it("selects the pattern on a press, swallows moves and releases, and plays no note", () => {
    const h = open({ patternCount: 3 });
    h.pad(1);
    h.pad(1, "move");
    h.pad(1, "up");
    h.pad(2);
    h.pad(7); // no pattern there
    expect(h.sentOf("selectPattern")).toEqual([
      { type: "selectPattern", number: 2 },
      { type: "selectPattern", number: 3 },
    ]);
    expect(h.midi).toEqual([]);
  });

  it("does nothing with ERASE held (FL cannot delete a pattern) and plays no note", () => {
    const h = open();
    h.press("erase");
    h.pad(1);
    h.pad(1, "up");
    h.release("erase");
    expect(h.sentOf("selectPattern")).toEqual([]);
    expect(h.midi).toEqual([]);
  });

  it("shows the bank of the current pattern and sends it in the VIEW", () => {
    const h = stackHarness({ patternCount: 20, pattern: 18 });
    h.tap("arranger");
    expect(lastView(h)).toMatchObject({ patternOffset: 16 });
    expect(h.padLed(1)).toBe(led(17, "bright"));
    expect(h.padLed(0)).toBe(led(16, "dim"));
    expect(h.padLed(3)).toBe(led(19, "dim"));
    expect(h.padLed(4)).toBe(0);
    h.pad(0);
    expect(h.sentOf("selectPattern")).toEqual([{ type: "selectPattern", number: 17 }]);
  });

  it("follows a new current pattern into its bank", () => {
    const h = open({ patternCount: 20 });
    expect(lastView(h)).toBeUndefined();
    h.fl.apply({
      type: "patterns",
      count: 20,
      offset: 16,
      entries: Array.from({ length: 4 }, (_, i) => ({
        current: i === 1,
        color: 0xe0707a,
        name: `Pattern ${17 + i}`,
      })),
    });
    setPattern(h, { number: 18, count: 20 });
    expect(lastView(h)).toMatchObject({ patternOffset: 16 });
    expect(h.padLed(1)).toBe(flColorToPalette(0xe0707a, "bright"));
    setPattern(h, { number: 2, count: 20 });
    expect(lastView(h)).toMatchObject({ patternOffset: 0 });
  });

  it("clamps the pattern bank when patterns disappear", () => {
    const h = stackHarness({ patternCount: 20, pattern: 18 });
    h.tap("arranger");
    h.fl.apply({ type: "patterns", count: 5, offset: 0, entries: [] });
    h.stack.onFlChange("patterns", h.mc);
    expect(lastView(h)).toMatchObject({ patternOffset: 0 });
  });

  it("selects the previous and next pattern on display 5 and 6, lit only where there is one", () => {
    const h = open({ patternCount: 3, pattern: 2 });
    expect(h.light("display5")).toBe("dim");
    expect(h.light("display6")).toBe("dim");
    h.tap("display5");
    h.tap("display6");
    expect(h.sentOf("selectPattern")).toEqual([
      { type: "selectPattern", number: 1 },
      { type: "selectPattern", number: 3 },
    ]);
    setPattern(h, { number: 1 });
    expect(h.light("display5")).toBe("off");
    h.tap("display5");
    expect(h.sentOf("selectPattern")).toHaveLength(2);
    setPattern(h, { number: 3 });
    expect(h.light("display6")).toBe("off");
    h.tap("display6");
    expect(h.sentOf("selectPattern")).toHaveLength(2);
  });

  it("toggles pattern/song on display 2, bright in song mode", () => {
    const h = open();
    expect(h.light("display2")).toBe("dim");
    h.tap("display2");
    expect(h.sentOf("setLoopMode")).toEqual([{ type: "setLoopMode", song: true }]);
    h.songMode(true);
    expect(h.light("display2")).toBe("bright");
    h.tap("display2");
    expect(h.sentOf("setLoopMode").at(-1)).toEqual({ type: "setLoopMode", song: false });
  });

  it("takes the other display buttons without sending anything, and lights none of them", () => {
    const h = open();
    for (const id of ["display1", "display3", "display4"] as const) {
      expect(h.light(id)).toBe("off");
      h.tap(id);
    }
    expect(h.sent).toEqual([]);
  });

  it("lets the SCENE overlay take the pads over it, and gives them back", () => {
    const h = open({ patternCount: 3, markers: [{ ticks: 0, name: "Intro" }] });
    h.press("scene");
    h.pad(0);
    expect(h.sentOf("jumpMarker")).toHaveLength(1);
    expect(h.sentOf("selectPattern")).toEqual([]);
    h.release("scene");
    h.pad(1);
    expect(h.sentOf("selectPattern")).toEqual([{ type: "selectPattern", number: 2 }]);
  });
});

describe("ARRANGER screens", () => {
  it("puts each control's label on its own screen (Layout rule)", () => {
    const h = open();
    const { left, right } = draw(h);
    expect(texts(left)).toEqual(expect.arrayContaining(["ARRANGER", "SONG"]));
    expect(texts(right)).toEqual(
      expect.arrayContaining(["PREV PAT", "NEXT PAT", ">>", "Rows", "Steps"]),
    );
    expect(texts(right)).not.toContain("<<"); // page 1
    for (const label of ["PREV PAT", "NEXT PAT", ">>", "<<", "Rows", "Steps"]) {
      expect(texts(left), label).not.toContain(label);
    }
    for (const label of ["ARRANGER", "SONG"]) expect(texts(right), label).not.toContain(label);
    // the knob labels sit in the first two columns of the right screen (knobs 5 and 6)
    const rows = right.find((d) => d.text === "Rows");
    const steps = right.find((d) => d.text === "Steps");
    expect(rows?.x).toBe(60);
    expect(steps?.x).toBe(180);
    expect(rows?.x).toBeLessThan(120);
    expect(steps?.x).toBeGreaterThan(120);
    expect(steps?.x).toBeLessThan(240);
  });

  it("shows the pattern name and length, the channels of the rows and the bank on the left", () => {
    const h = open();
    const { left } = draw(h);
    const text = texts(left);
    expect(text).toEqual(
      expect.arrayContaining([
        "1  Pattern 1",
        "64 steps",
        "Kick",
        "Snare",
        "Clap",
        "Hat",
        "Open Hat",
        "Perc",
        "Rim",
        "Tom",
        "Group A   1–16 of 24",
      ]),
    );
    expect(text).toEqual(expect.arrayContaining(["1", "2", "3", "4", "5", "6", "7", "8"]));
    expect(text).not.toContain("Bass"); // channel 9 is below the 8 rows
    h.turn(10);
    expect(texts(draw(h).left)).toEqual(expect.arrayContaining(["Bass", "Sub", "Lead"]));
    expect(texts(draw(h).left)).not.toContain("Kick");
  });

  it("shows the step page and the pages on the right", () => {
    const h = open();
    let text = texts(draw(h).right);
    expect(text).toEqual(
      expect.arrayContaining(["steps 1–16 of 64", "1/24", "1/4", "1", "5", "9", "13"]),
    );
    h.tilt("right");
    text = texts(draw(h).right);
    expect(text).toEqual(
      expect.arrayContaining(["<<", ">>", "steps 17–32 of 64", "2/4", "17", "21", "25", "29"]),
    );
    h.tilt("right");
    h.tilt("right");
    text = texts(draw(h).right);
    expect(text).not.toContain(">>");
    expect(text).toContain("steps 49–64 of 64");
    h.turn(4);
    expect(texts(draw(h).right)).toContain("5/24");
  });

  it("draws the steps in FL's colors: on = the channel's color, off alternating per group of 4", () => {
    const h = open({ grid: { 0: [0, 4, 8, 12], 1: [4, 12] } });
    const { right2d } = draw(h);
    const kick = flColorToCss(demoChannelColor(0));
    const snare = flColorToCss(demoChannelColor(1));
    expect(cellColor(right2d, 0, 0)).toBe(kick);
    expect(cellColor(right2d, 0, 4)).toBe(kick);
    expect(cellColor(right2d, 0, 12)).toBe(kick);
    expect(cellColor(right2d, 1, 4)).toBe(snare);
    expect(cellColor(right2d, 1, 0)).toBe(theme.stepOffA);
    expect(cellColor(right2d, 0, 1)).toBe(theme.stepOffA);
    expect(cellColor(right2d, 0, 5)).toBe(theme.stepOffB);
    expect(cellColor(right2d, 0, 13)).toBe(theme.stepOffB);
    expect(cellColor(right2d, 0, 9)).toBe(theme.stepOffA);
    expect(cellColor(right2d, 7, 3)).toBe(theme.stepOffA); // a channel without steps yet
  });

  it("draws the other pages of the pattern, and nothing past its end", () => {
    const h = open({ patternLength: 20, grid: { 0: [16, 19] } });
    h.tilt("right");
    const { right2d } = draw(h);
    expect(cellColor(right2d, 0, 0)).toBe(flColorToCss(demoChannelColor(0)));
    expect(cellColor(right2d, 0, 3)).toBe(flColorToCss(demoChannelColor(0)));
    expect(cellColor(right2d, 0, 1)).toBe(theme.stepOffA);
    expect(cellColor(right2d, 0, 4)).toBe(theme.background); // step 21 does not exist
    expect(cellColor(right2d, 3, 15)).toBe(theme.background);
    expect(texts(draw(h).right)).toContain("steps 17–20 of 20");
  });

  it("lights the play head's column over every row", () => {
    const h = open({ grid: { 0: [6] } });
    h.playing(true);
    h.songPos(1, 7); // step 7: the 7th cell
    const { right2d } = draw(h);
    expect(brightness(cellColor(right2d, 0, 6))).toBeGreaterThan(
      brightness(flColorToCss(demoChannelColor(0))),
    );
    expect(brightness(cellColor(right2d, 3, 6))).toBeGreaterThan(brightness(theme.stepOffB));
    expect(cellColor(right2d, 3, 5)).toBe(theme.stepOffB); // its neighbors are plain
    expect(cellColor(right2d, 3, 7)).toBe(theme.stepOffB);
    // stopped: no head
    h.playing(false);
    expect(cellColor(draw(h).right2d, 3, 6)).toBe(theme.stepOffB);
  });

  it("outlines the cursor's row on the right and highlights it on the left", () => {
    const h = open();
    h.turn(2);
    const { right2d } = draw(h);
    const edge = (row: number) => {
      const rect = cellRect(row, 0);
      return pixel(right2d, rect.x - 2, rect.y + rect.height / 2);
    };
    expect(edge(2)).toBe(theme.accent);
    expect(edge(1)).toBe(theme.panel);
    expect(edge(3)).toBe(theme.panel);
    // the left: the cursor row's number is orange, the others dim
    const { left } = draw(h);
    expect(left.find((d) => d.text === "3")?.style).toBe(theme.accent);
    expect(left.find((d) => d.text === "2")?.style).toBe(theme.dimText);
  });

  it("shows `piano roll` across the row of a channel without a step row", () => {
    const h = open({ grid: { 0: [0], 1: { on: [], stepSequencer: false } } });
    const { right, right2d } = draw(h);
    expect(right.filter((d) => d.text === "piano roll")).toHaveLength(1);
    expect(cellColor(right2d, 1, 4)).toBe(theme.background);
    expect(cellColor(right2d, 0, 4)).toBe(theme.stepOffB);
    // unknown (no PATTERN_GRID yet): nothing
    expect(draw(stackHarness()).right.some((d) => d.text === "piano roll")).toBe(false);
  });

  it("dims a muted channel's name and marks a soloed one", () => {
    const h = open({ muted: [1], solo: [2] });
    const { left } = draw(h);
    expect(left.find((d) => d.text === "Snare")?.style).toBe(theme.dimText);
    expect(left.find((d) => d.text === "Kick")?.style).toBe(theme.text);
    expect(left.find((d) => d.text === "Clap")?.style).toBe(theme.text);
    expect(left.filter((d) => d.text === "S")).toHaveLength(1);
    expect(left.find((d) => d.text === "S")?.style).toBe(theme.option);
  });

  it("draws the song mode on the SONG tab and survives an empty project", () => {
    const h = open({ songMode: true });
    expect(texts(draw(h).left)).toContain("SONG");
    const none = open({ channels: 0, patternCount: 0, patternLength: 0 });
    const { left, right } = draw(none);
    expect(texts(left)).toContain("No channels");
    expect(texts(right)).toContain("no steps");
    expect(none.padLed(0)).toBe(0);
    none.turn(3);
    none.push();
    none.tilt("right");
    expect(none.sentOf("selectChannel")).toEqual([]);
  });

  it("shows no more than 256 steps of a longer pattern", () => {
    const h = open({ patternLength: 400 });
    for (let i = 0; i < 30; i++) h.tilt("right");
    expect(arranger(h).stepPage).toBe(15);
    expect(texts(draw(h).right)).toContain("steps 241–256 of 256+");
    expect(texts(draw(h).right)).toContain("16/16");
  });
});
