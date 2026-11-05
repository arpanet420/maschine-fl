// Every page with every main page behind it: a control acts on the page it is on.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FlState } from "../src/fl/flState.js";
import type { FlCommand } from "../src/fl/sysex.js";
import type { HwEvent, NavEvent } from "../src/hw/events.js";
import type { NavDirection } from "../src/hw/ids.js";
import { NAV_LEDS } from "../src/hw/leds.js";
import { DISPLAY_BUTTONS } from "../src/modes/channelPadPage.js";
import type { ModeContext, PageName } from "../src/modes/mode.js";
import { PadState } from "../src/modes/padState.js";
import { PAGE_DEFS, type PageDef } from "../src/modes/pageStack.js";
import { stackHarness } from "../src/tools/stackHarness.js";

type Harness = ReturnType<typeof stackHarness>;

const UNBUILT = new Set<PageName>(["sampling", "events", "macro"]);
const BUILT = PAGE_DEFS.filter((def) => !UNBUILT.has(def.id));
const ON_TOP = BUILT.filter((def) => def.kind !== "main");
const MAIN_PAGES = BUILT.filter((def) => def.kind === "main");
const DIRECTIONS: readonly NavDirection[] = ["up", "down", "left", "right"];

const harness = (): Harness => {
  const h = stackHarness({
    selected: 2,
    channels: 24,
    patternLength: 64,
    patternCount: 20,
    markers: Array.from({ length: 20 }, (_, i) => ({ ticks: i * 3072, name: `M${i}` })),
  });
  h.presets(
    128,
    5,
    Array.from({ length: 16 }, (_, i) => `Preset ${i + 1}`),
  );
  return h;
};

/** Opens a page the way its button does and keeps it open. */
function open(h: Harness, def: PageDef): void {
  h.state.shift = def.shift ?? false;
  h.press(def.button);
  h.state.shift = false;
  if (def.hold) h.advance(600);
  if (def.kind !== "overlay") h.release(def.button);
}

/** What a page shows: both screens and every LED. */
function shown(h: Harness): string {
  const { left, right } = h.render();
  const leds = h.ledState();
  return createHash("sha1")
    .update(left.getImageData(0, 0, 480, 272).data)
    .update(right.getImageData(0, 0, 480, 272).data)
    .update(leds.buttonLeds)
    .update(leds.padLeds)
    .digest("hex");
}

const CONTROLS: readonly HwEvent[] = [
  ...Array.from({ length: 8 }, (_, index): HwEvent => ({ type: "encoder", index, delta: 400 })),
  { type: "nav", action: "turn", delta: 1 },
  { type: "nav", action: "push", pressed: true },
  { type: "nav", action: "push", pressed: false },
  ...DIRECTIONS.map((direction): HwEvent => ({
    type: "nav",
    action: "tilt",
    direction,
    pressed: true,
  })),
  { type: "button", id: "arrowLeft", pressed: true },
  { type: "button", id: "arrowRight", pressed: true },
  ...DISPLAY_BUTTONS.map((id): HwEvent => ({ type: "button", id, pressed: true })),
  { type: "button", id: "groupA", pressed: true },
];

describe("a page on top", () => {
  for (const main of MAIN_PAGES) {
    it(`lets no control reach ${main.label} under it`, () => {
      for (const top of ON_TOP) {
        const h = harness();
        open(h, main);
        open(h, top);
        if (h.stack.top?.page !== top) continue; // MIXER claims MUTE and SOLO: no overlay
        const page = h.pages[main.id as keyof typeof h.pages];
        const onEvent = vi.spyOn(page, "onEvent");
        for (const event of CONTROLS) {
          h.stack.onEvent(event, h.mc);
          h.advance(1);
        }
        expect(onEvent, `${top.label} over ${main.label}`).not.toHaveBeenCalled();
      }
    });
  }

  it("does not light the main page's arrows", () => {
    const h = harness();
    expect(h.light("arrowRight")).toBe("dim"); // CHANNEL's next 16 channels
    h.press("mute");
    expect(h.light("arrowRight")).toBe("off");
    h.release("mute");
    expect(h.light("arrowRight")).toBe("dim");
  });

  it("leaves the main page's bank where it was", () => {
    const h = harness();
    open(h, MAIN_PAGES.find((def) => def.id === "mixer") as PageDef);
    const before = h.views.at(-1)?.mixerOffset;
    h.press("select");
    h.tap("arrowRight");
    h.release("select");
    expect(h.views.at(-1)?.mixerOffset).toBe(before);
  });
});

describe("the 4D's arrows", () => {
  const cases: Array<[string, (h: Harness) => void]> = BUILT.map((def) => [
    def.label,
    (h) => open(h, def),
  ]);
  cases.push([
    "BROWSER's PLUG-INS, picker closed",
    (h) => {
      h.tap("browser");
      h.tap("display2");
      h.tap("display2");
    },
  ]);
  cases.push([
    "BROWSER's PLUG-INS, picker open",
    (h) => {
      h.tap("browser");
      h.tap("display2");
    },
  ]);

  it.each(cases)("%s: lit where a tilt does something, dark where it doesn't", (_name, build) => {
    for (const direction of DIRECTIONS) {
      const h = harness();
      build(h);
      h.sent.length = 0;
      h.advance(1000);
      const before = shown(h);
      const lit = (h.ledState().buttonLeds[NAV_LEDS[direction]] ?? 0) !== 0;
      h.tilt(direction, true);
      h.tilt(direction, false);
      const works = h.sent.length > 0 || shown(h) !== before;
      expect(lit, `${direction} lit, and it ${works ? "works" : "does nothing"}`).toBe(works);
    }
  });
});

describe("the pages that show the selected channel", () => {
  const CHANNEL_PAGES = BUILT.filter((def) =>
    (["keyboard", "chords", "padMode", "step"] as PageName[]).includes(def.id),
  );

  for (const main of MAIN_PAGES) {
    it.each(CHANNEL_PAGES.map((def) => [def.label, def] as const))(
      `%s over ${main.label}: the 4D picks the channel`,
      (_name, def) => {
        const h = harness();
        open(h, main);
        open(h, def);
        h.sent.length = 0;
        h.turn(1);
        expect(h.fl.selectedChannel.index).toBe(3);
        h.tilt("up");
        h.tilt("up", false);
        expect(h.fl.selectedChannel.index).toBe(2);
        h.tilt("down");
        expect(h.fl.selectedChannel.index).toBe(3);
        expect(h.sent.every((command) => command.type === "selectChannel")).toBe(true);
      },
    );
  }

  it("does nothing on the 4D's push", () => {
    const h = harness();
    h.tap("keyboard");
    h.sent.length = 0;
    expect(h.push()).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe("PadState.channelNav", () => {
  const setup = () => {
    let now = 1000;
    const fl = new FlState();
    fl.apply({ type: "hello", version: 2 });
    fl.apply({ type: "channels", total: 5, offset: 0, entries: [] });
    fl.apply({
      type: "selectedChannel",
      index: 1,
      color: 0,
      volume: 0,
      pan: 0,
      name: "",
      plugin: "",
    });
    const sent: FlCommand[] = [];
    const mc = {
      fl,
      send: (command: FlCommand) => sent.push(command),
      shift: false,
      touchedKnobs: new Set<number>(),
      requestRender: () => undefined,
    } as ModeContext;
    const pads = new PadState(undefined, undefined, undefined, () => now);
    const turn = (delta: number): NavEvent => ({ type: "nav", action: "turn", delta });
    return {
      sent,
      turnBy: (delta: number) => pads.channelNav(turn(delta), mc),
      advance: (ms: number) => {
        now += ms;
      },
    };
  };
  const indexes = (sent: FlCommand[]) =>
    sent.map((command) => (command.type === "selectChannel" ? command.index : undefined));

  it("goes on from the channel it asked for while FL has not reported it", () => {
    const { sent, turnBy } = setup();
    turnBy(1);
    turnBy(1);
    expect(indexes(sent)).toEqual([2, 3]);
  });

  it("goes back to what FL says when FL did not follow", () => {
    const { sent, turnBy, advance } = setup();
    turnBy(1);
    advance(1000);
    turnBy(1);
    expect(indexes(sent)).toEqual([2, 2]);
  });

  it("stops at both ends", () => {
    const { sent, turnBy } = setup();
    turnBy(-5);
    turnBy(-1);
    expect(indexes(sent)).toEqual([0]);
    sent.length = 0;
    turnBy(99);
    turnBy(1);
    expect(indexes(sent)).toEqual([4]);
  });
});
