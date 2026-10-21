import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import { FlState } from "../src/fl/flState.js";
import type { FlCommand } from "../src/fl/sysex.js";
import type { HwEvent } from "../src/hw/events.js";
import type { ButtonId } from "../src/hw/ids.js";
import { LedState, MONO_LEDS, COLOR_LEDS } from "../src/hw/leds.js";
import { paletteWhite } from "../src/hw/palette.js";
import type { Mode, ModeContext, PageName, ViewCommand } from "../src/modes/mode.js";
import { PageStack } from "../src/modes/pageStack.js";

const VIEW: ViewCommand = {
  type: "view",
  channelOffset: 0,
  mixerOffset: 0,
  patternOffset: 0,
  stepOffset: 0,
  meters: false,
  presets: false,
  patternGrid: false,
  params: [],
};

interface FakeOptions {
  /** Events this page handles (all others fall through). */
  handles?: (event: HwEvent) => boolean;
  /** Overlay: what it changes in the VIEW. */
  patch?: Partial<ViewCommand>;
  /** Main page: overlay buttons it claims (see Mode.claimsPageButton). */
  claims?: readonly ButtonId[];
}

class FakePage implements Mode {
  enters = 0;
  resumes = 0;
  events: HwEvent[] = [];
  changes: string[] = [];
  /** A main page sends its VIEW from enter and resume, like the real ones. */
  sendsView = false;

  constructor(
    readonly name: PageName,
    private readonly options: FakeOptions = {},
  ) {
    const { patch } = options;
    if (patch) this.viewPatch = () => patch;
    const { claims } = options;
    if (claims) this.claimsPageButton = (id) => claims.includes(id);
  }

  enter(mc: ModeContext): void {
    this.enters++;
    if (this.sendsView) mc.send(VIEW);
  }
  resume(mc: ModeContext): void {
    this.resumes++;
    if (this.sendsView) mc.send(VIEW);
  }
  view(): ViewCommand {
    return VIEW;
  }
  viewPatch?: () => Partial<ViewCommand> | undefined;
  claimsPageButton?: (id: ButtonId) => boolean;
  onFlChange(section: string): void {
    this.changes.push(section);
  }
  onEvent(event: HwEvent): boolean {
    this.events.push(event);
    return this.options.handles?.(event) ?? false;
  }
  render(): void {}
  leds: (leds?: LedState) => void = () => undefined;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "mk3d-pages-"));
  dirs.push(dir);
  return join(dir, "mk3d", "pages.json");
};

function setup(extra: Partial<Record<PageName, FakePage>> = {}, pinsPath?: string) {
  const channel = new FakePage("channel");
  const plugin = new FakePage("plugin");
  const pattern = new FakePage("pattern", { patch: { patternOffset: 16 } });
  const mute = new FakePage("mute");
  channel.sendsView = true;
  const pages = { channel, plugin, pattern, mute, ...extra };
  const log: string[] = [];
  const stack = new PageStack({ pages, pinsPath, log: (line) => log.push(line) });
  const fl = new FlState();
  fl.apply({ type: "hello", version: 2 });
  const sent: FlCommand[] = [];
  const state = { shift: false, renders: 0 };
  const mc: ModeContext = {
    fl,
    send: (command) => sent.push(command),
    get shift() {
      return state.shift;
    },
    touchedKnobs: new Set(),
    requestRender: () => state.renders++,
  };
  stack.enter(mc);
  sent.length = 0;
  const press = (id: ButtonId) => stack.onEvent({ type: "button", id, pressed: true }, mc);
  const release = (id: ButtonId) => stack.onEvent({ type: "button", id, pressed: false }, mc);
  const pad = (index: number, phase: "down" | "move" | "up") =>
    stack.onEvent({ type: "pad", pad: index, phase, pressure: 0.5, velocity: 0.5 }, mc);
  const knob = () => stack.onEvent({ type: "encoder", index: 0, delta: 5 }, mc);
  const light = (id: keyof typeof MONO_LEDS) => {
    const leds = new LedState();
    stack.leds(leds, mc);
    const value = leds.buttonLeds[MONO_LEDS[id]];
    return value === 0 ? "off" : value === 16 ? "dim" : value === 63 ? "bright" : `?${value}`;
  };
  return { stack, pages, log, fl, sent, state, mc, press, release, pad, knob, light };
}

describe("PageStack: main pages", () => {
  it("starts on CHANNEL, with exactly one of CHANNEL and PLUG-IN bright", () => {
    const { stack, light } = setup();
    expect(stack.main).toBe("channel");
    expect(stack.top).toBeUndefined();
    expect([light("channel"), light("plugIn")]).toEqual(["bright", "dim"]);
  });

  it("a main button shows that page and enters it; the same button again does nothing", () => {
    const { stack, pages, press, release, light } = setup();
    press("plugIn");
    release("plugIn");
    expect(stack.main).toBe("plugin");
    expect(pages.plugin.enters).toBe(1);
    expect([light("channel"), light("plugIn")]).toEqual(["dim", "bright"]);
    press("plugIn");
    release("plugIn");
    expect(stack.main).toBe("plugin");
    expect(pages.plugin.enters).toBe(1);
    expect(pages.plugin.resumes).toBe(0);
  });

  it("a main button closes an overlay and resumes (not re-enters) the page under it", () => {
    const { stack, pages, press, release } = setup();
    press("pattern");
    expect(stack.top?.page.id).toBe("pattern");
    press("channel");
    expect(stack.top).toBeUndefined();
    expect(pages.channel.resumes).toBe(1);
    expect(pages.channel.enters).toBe(1);
    release("channel");
    release("pattern");
    expect(stack.top).toBeUndefined();
  });

  it("another main page's button leaves the overlay and enters that page", () => {
    const { stack, pages, press } = setup();
    press("pattern");
    press("plugIn");
    expect(stack.top).toBeUndefined();
    expect(stack.main).toBe("plugin");
    expect(pages.plugin.enters).toBe(1);
    expect(pages.channel.resumes).toBe(0);
  });

  it("any other main page goes back to the last control page on its second press", () => {
    const mixer = new FakePage("mixer");
    const { stack, press, release, light } = setup({ mixer });
    press("plugIn");
    release("plugIn");
    press("mixer");
    release("mixer");
    expect(stack.main).toBe("mixer");
    expect([light("plugIn"), light("mixer")]).toEqual(["bright", "bright"]);
    press("mixer");
    release("mixer");
    expect(stack.main).toBe("plugin");
  });
});

describe("PageStack: MIXER as a main page", () => {
  it("goes back to the last control page when MIXER is pressed twice", () => {
    const mixer = new FakePage("mixer");
    const { stack, pages, press, release } = setup({ mixer });
    press("mixer");
    release("mixer");
    expect(stack.main).toBe("mixer");
    expect(mixer.enters).toBe(1);
    press("mixer");
    release("mixer");
    expect(stack.main).toBe("channel");
    expect(pages.channel.enters).toBe(2);
    // and with PLUG-IN as the last control page
    press("plugIn");
    release("plugIn");
    press("mixer");
    release("mixer");
    press("mixer");
    release("mixer");
    expect(stack.main).toBe("plugin");
    expect(mixer.enters).toBe(2);
  });

  it("lights MIXER dim until it is shown and bright then, next to the control page", () => {
    const mixer = new FakePage("mixer");
    const { press, release, light } = setup({ mixer });
    expect([light("channel"), light("mixer")]).toEqual(["bright", "dim"]);
    press("mixer");
    release("mixer");
    expect([light("channel"), light("mixer")]).toEqual(["bright", "bright"]);
  });
});

describe("PageStack: buttons claimed by the main page", () => {
  const claiming = () => new FakePage("mixer", { claims: ["mute", "solo"] });
  const buttons = (page: FakePage) =>
    page.events.map((e) => (e.type === "button" ? `${e.id}:${e.pressed ? "down" : "up"}` : e.type));

  it("gives a claimed button's press and release to the page and opens no overlay", () => {
    const mixer = claiming();
    const { stack, pages, press, release } = setup({ mixer });
    press("mixer");
    release("mixer");
    expect(press("mute")).toBe(true);
    expect(stack.top).toBeUndefined();
    expect(pages.mute.enters).toBe(0);
    expect(release("mute")).toBe(true);
    expect(stack.top).toBeUndefined();
    expect(buttons(mixer)).toEqual(["mute:down", "mute:up"]);
    press("solo");
    release("solo");
    expect(buttons(mixer).slice(2)).toEqual(["solo:down", "solo:up"]);
  });

  it("opens the overlay as before on a page that does not claim the button", () => {
    const mixer = claiming();
    const { stack, pages, press, release } = setup({ mixer });
    press("mute"); // CHANNEL is shown
    expect(stack.top?.page.id).toBe("mute");
    expect(pages.mute.enters).toBe(1);
    release("mute");
    // a claimed MUTE does not stop the other overlays
    press("mixer");
    release("mixer");
    press("pattern");
    expect(stack.top?.page.id).toBe("pattern");
    release("pattern");
    expect(buttons(mixer)).toEqual([]);
  });

  it("sends the release to the page that took the press, even if the main page changed", () => {
    const mixer = claiming();
    const { stack, pages, press, release } = setup({ mixer });
    press("mixer");
    release("mixer");
    press("mute");
    press("channel");
    expect(stack.main).toBe("channel");
    release("mute");
    expect(buttons(mixer)).toEqual(["mute:down", "mute:up"]);
    expect(pages.channel.events).toEqual([]);
    expect(stack.top).toBeUndefined();
  });

  it("keeps the LED the page set for a claimed button", () => {
    const mixer = claiming();
    mixer.leds = (leds?: LedState) => leds?.setLight("mute", "bright");
    const { press, release, light } = setup({ mixer });
    expect(light("mute")).toBe("dim"); // the mute overlay's own button, CHANNEL on top
    press("mixer");
    release("mixer");
    expect(light("mute")).toBe("bright");
  });

  it("does not claim while FL is not connected", () => {
    const mixer = claiming();
    const { fl, stack, press, release } = setup({ mixer });
    press("mixer");
    release("mixer");
    fl.reset();
    press("mute");
    expect(stack.top?.page.id).toBe("mute");
    expect(buttons(mixer)).toEqual([]);
    release("mute");
  });

  it("passes SHIFT + MUTE (not an overlay) through to the page like any other event", () => {
    const mixer = claiming();
    const { state, press, release } = setup({ mixer });
    press("mixer");
    release("mixer");
    state.shift = true;
    press("mute");
    release("mute");
    expect(buttons(mixer)).toEqual(["mute:down", "mute:up"]);
  });
});

describe("PageStack: overlays", () => {
  it("shows an overlay while its button is held and closes it on release", () => {
    const { stack, pages, press, release, light } = setup();
    expect(press("pattern")).toBe(true);
    expect(stack.top).toMatchObject({ held: true, pinned: false });
    expect(pages.pattern.enters).toBe(1);
    expect([light("pattern"), light("channel")]).toEqual(["bright", "bright"]);
    release("pattern");
    expect(stack.top).toBeUndefined();
    expect(pages.channel.resumes).toBe(1);
    expect([light("pattern"), light("channel")]).toEqual(["dim", "bright"]);
  });

  it("opening an overlay closes the one that is open", () => {
    const { stack, pages, press, release } = setup();
    press("pattern");
    press("mute");
    expect(stack.top?.page.id).toBe("mute");
    release("pattern"); // the first press's release means nothing now
    expect(stack.top?.page.id).toBe("mute");
    release("mute");
    expect(stack.top).toBeUndefined();
    expect(pages.mute.enters).toBe(1);
  });

  it("display button 1 pins the overlay and the overlay never sees it", () => {
    const { stack, pages, press, release } = setup();
    press("pattern");
    expect(press("display1")).toBe(true);
    expect(release("display1")).toBe(true);
    expect(stack.top?.pinned).toBe(true);
    release("pattern");
    expect(stack.top).toMatchObject({ held: false, pinned: true });
    expect(pages.pattern.events).toEqual([]);
    expect(pages.channel.events).toEqual([]);
  });

  it("unpinning while the overlay's button is held keeps it until the release", () => {
    const { stack, press, release } = setup();
    press("pattern");
    press("display1");
    release("display1");
    press("display1");
    release("display1");
    expect(stack.top).toMatchObject({ held: true, pinned: false });
    release("pattern");
    expect(stack.top).toBeUndefined();
  });

  it("unpinning while the button is not held closes the overlay at once", () => {
    const { stack, pages, press, release } = setup();
    press("pattern");
    press("display1");
    release("display1");
    release("pattern");
    expect(stack.top?.pinned).toBe(true);
    press("display1");
    expect(stack.top).toBeUndefined();
    expect(pages.channel.resumes).toBe(1);
    release("display1");
  });

  it("a pinned overlay closes on the next press and release, and opens pinned again", () => {
    const { stack, press, release } = setup();
    press("pattern");
    press("display1");
    release("display1");
    release("pattern");
    press("pattern");
    expect(stack.top).toMatchObject({ held: true, pinned: true });
    release("pattern");
    expect(stack.top).toBeUndefined();
    press("pattern");
    release("pattern");
    expect(stack.top).toMatchObject({ held: false, pinned: true });
  });

  it("display button 1 goes to the main page when there is no overlay", () => {
    const { pages, press } = setup();
    expect(press("display1")).toBe(false);
    expect(pages.channel.events).toHaveLength(1);
  });

  it("reads SHIFT at press time: the release goes to the page the press opened", () => {
    const navigate = new FakePage("navigate");
    const variation = new FakePage("variation");
    const { stack, state, press, release } = setup({ navigate, variation });
    state.shift = true;
    press("variation");
    expect(stack.top?.page.id).toBe("navigate");
    state.shift = false;
    release("variation");
    expect(stack.top).toBeUndefined();

    press("variation");
    expect(stack.top?.page.id).toBe("variation");
    state.shift = true;
    release("variation");
    expect(stack.top).toBeUndefined();
  });

  it("changes the main page's VIEW with the overlay's patch while it is on top", () => {
    const { stack, sent, mc, press, release } = setup();
    press("pattern");
    expect(stack.top).toBeDefined();
    // the main page sends its own VIEW (e.g. after a channel select): the patch is merged in
    stack.enter(mc);
    expect(sent).toContainEqual({ ...VIEW, patternOffset: 16 });
    sent.length = 0;
    release("pattern");
    expect(sent).toEqual([VIEW]); // resume: the plain VIEW again
  });

  it("restores the VIEW when an overlay with a patch is replaced by one without", () => {
    const { sent, press, release } = setup();
    press("pattern");
    sent.length = 0;
    press("mute");
    expect(sent).toEqual([VIEW]);
    release("mute");
  });
});

describe("PageStack: tool pages", () => {
  it("latches: press opens, the release keeps it, the next press and release close it", () => {
    const step = new FakePage("step");
    const { stack, press, release, pages } = setup({ step });
    press("step");
    release("step");
    expect(stack.top).toMatchObject({ page: { id: "step" }, pinned: false });
    press("step");
    expect(stack.top?.page.id).toBe("step");
    release("step");
    expect(stack.top).toBeUndefined();
    expect(pages.channel.resumes).toBe(1);
  });

  it("closes when another page button is pressed, and has no pin tab", () => {
    const step = new FakePage("step");
    const { stack, press, release } = setup({ step });
    press("step");
    release("step");
    expect(press("display1")).toBe(false);
    release("display1");
    press("pattern");
    expect(stack.top?.page.id).toBe("pattern");
    release("pattern");
    expect(stack.top).toBeUndefined();
  });
});

describe("PageStack: pages that are not built", () => {
  it("logs once per press, changes nothing and keeps the LED off", () => {
    const { stack, log, press, release, light, state } = setup();
    expect(press("scene")).toBe(true);
    expect(release("scene")).toBe(true);
    expect(log).toEqual(['page "scene" is not built yet']);
    press("mixer");
    release("mixer");
    expect(log).toHaveLength(2);
    expect(log[1]).toBe('page "mixer" is not built yet');
    expect(stack.top).toBeUndefined();
    expect(stack.main).toBe("channel");
    expect([light("scene"), light("mixer"), light("step"), light("settings")]).toEqual([
      "off",
      "off",
      "off",
      "off",
    ]);
    state.shift = true;
    press("variation");
    expect(log[2]).toBe('page "navigate" is not built yet');
  });

  it("does not touch an overlay that is open", () => {
    const { stack, press, log } = setup();
    press("pattern");
    press("scene");
    expect(stack.top?.page.id).toBe("pattern");
    expect(log).toHaveLength(1);
  });

  it("draws the SAMPLING LED (a color LED) off", () => {
    const { stack, mc } = setup();
    const leds = new LedState();
    leds.setButtonColor("sampling", paletteWhite("bright"));
    stack.leds(leds, mc);
    expect(leds.buttonLeds[COLOR_LEDS.sampling]).toBe(0);
  });

  it("turns every page LED off while FL is not connected", () => {
    const { stack, mc, fl } = setup();
    fl.reset();
    const leds = new LedState();
    stack.leds(leds, mc);
    expect(leds.buttonLeds[MONO_LEDS.channel]).toBe(0);
    expect(leds.buttonLeds[MONO_LEDS.pattern]).toBe(0);
  });
});

describe("PageStack: events", () => {
  it("gives the top page an event first, then the main page", () => {
    const pattern = new FakePage("pattern", {
      handles: (e) => e.type === "encoder" && e.index === 1,
    });
    const { pages, press, stack, mc } = setup({ pattern });
    press("pattern");
    stack.onEvent({ type: "encoder", index: 1, delta: 1 }, mc);
    expect(pattern.events).toHaveLength(1);
    expect(pages.channel.events).toHaveLength(0);
    // an encoder the overlay doesn't take reaches the main page
    expect(stack.onEvent({ type: "encoder", index: 0, delta: 1 }, mc)).toBe(false);
    expect(pattern.events).toHaveLength(2);
    expect(pages.channel.events).toHaveLength(1);
  });

  it("gets no events and no page buttons' enter while FL is disconnected", () => {
    const { stack, mc, fl, pages, press, knob } = setup();
    fl.reset();
    expect(knob()).toBe(false);
    expect(pages.channel.events).toHaveLength(0);
    press("pattern");
    expect(stack.top?.page.id).toBe("pattern");
    expect(pages.pattern.enters).toBe(0);
    stack.enter(mc); // enters both again once FL is back
    expect(pages.pattern.enters).toBe(1);
  });

  it("forwards FL changes to the main page and the page on top", () => {
    const { stack, pages, press, mc } = setup();
    press("pattern");
    stack.onFlChange("patterns", mc);
    expect(pages.channel.changes).toEqual(["patterns"]);
    expect(pages.pattern.changes).toEqual(["patterns"]);
  });

  it("leaves pads nobody takes to the caller", () => {
    const { pad, press } = setup();
    expect(pad(0, "down")).toBe(false);
    expect(pad(0, "move")).toBe(false);
    expect(pad(0, "up")).toBe(false);
    press("pattern");
    expect(pad(1, "down")).toBe(false);
  });

  it("gives a pad to the overlay and keeps moves and the release with it, even after it closed", () => {
    const pattern = new FakePage("pattern", { handles: (e) => e.type === "pad" });
    const { stack, pages, press, release, pad } = setup({ pattern });
    press("pattern");
    expect(pad(3, "down")).toBe(true);
    release("pattern");
    expect(stack.top).toBeUndefined();
    expect(pad(3, "move")).toBe(true);
    expect(pad(3, "up")).toBe(true);
    expect(pattern.events.map((e) => e.type === "pad" && e.phase)).toEqual(["down", "move", "up"]);
    expect(pages.channel.events).toHaveLength(0);
  });

  it("does not hand a note's release to an overlay opened while the pad was held", () => {
    const pattern = new FakePage("pattern", { handles: (e) => e.type === "pad" });
    const { press, pad } = setup({ pattern });
    expect(pad(2, "down")).toBe(false); // played as a note by the caller
    press("pattern");
    expect(pad(2, "up")).toBe(false); // so the caller ends that note
    expect(pattern.events).toHaveLength(0);
  });

  it("gives pads the main page handles to the main page under an overlay", () => {
    const channel = new FakePage("channel", { handles: (e) => e.type === "pad" });
    const { press, pad } = setup({ channel });
    press("pattern");
    expect(pad(0, "down")).toBe(true);
    expect(pad(0, "up")).toBe(true);
    expect(channel.events).toHaveLength(2);
  });
});

describe("PageStack: pin persistence", () => {
  it("saves a pin and an overlay opens pinned in a new stack", () => {
    const file = tempFile();
    const first = setup({}, file);
    first.press("pattern");
    first.press("display1");
    first.release("display1");
    first.release("pattern");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ pinned: { pattern: true } });

    const second = setup({}, file);
    expect(second.stack.isPinned("pattern")).toBe(true);
    expect(second.stack.isPinned("mute")).toBe(false);
    second.press("pattern");
    second.release("pattern");
    expect(second.stack.top).toMatchObject({ held: false, pinned: true });
  });

  it("remembers the pin of each page separately and forgets an unpinned one", () => {
    const file = tempFile();
    const { press, release, stack } = setup({}, file);
    for (const id of ["pattern", "mute"] as const) {
      press(id);
      press("display1");
      release("display1");
      release(id);
    }
    expect(stack.isPinned("pattern") && stack.isPinned("mute")).toBe(true);
    press("display1"); // unpins mute (pinned, on top)
    release("display1");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ pinned: { pattern: true } });
  });

  it("starts unpinned from a missing or damaged file", () => {
    const file = tempFile();
    expect(setup({}, file).stack.isPinned("pattern")).toBe(false);
    // damaged: a stack that cannot read it still works (the file is rewritten on the next pin)
    const damaged = setup({}, join(tmpdir(), "mk3d-no-such-dir", "x.json"));
    expect(damaged.stack.isPinned("pattern")).toBe(false);
  });
});

describe("PageStack: render", () => {
  it("renders the top page, else the main page", () => {
    const channel = new FakePage("channel");
    const pattern = new FakePage("pattern");
    let drawn = "";
    channel.render = () => void (drawn = "channel");
    pattern.render = () => void (drawn = "pattern");
    const { stack, press, release, mc } = setup({ channel, pattern });
    const canvas = createCanvas(480, 272).getContext("2d");
    stack.render(canvas, canvas, mc);
    expect(drawn).toBe("channel");
    press("pattern");
    stack.render(canvas, canvas, mc);
    expect(drawn).toBe("pattern");
    release("pattern");
  });
});
