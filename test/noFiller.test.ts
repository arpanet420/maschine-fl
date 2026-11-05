// What the screens may not say. A page draws what each of its controls does and its value, not how to
// use them, and not what a tab or a knob next to it already says.
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { PageName } from "../src/modes/mode.js";
import { PAGE_DEFS, type PageDef } from "../src/modes/pageStack.js";
import { stackHarness } from "../src/tools/stackHarness.js";

type Harness = ReturnType<typeof stackHarness>;

const UNBUILT = new Set<PageName>(["sampling", "events", "macro"]);
const BUILT = PAGE_DEFS.filter((def) => !UNBUILT.has(def.id));

/** A line that tells the player what to do with a control. */
const HELP = /\b(4D|display \d|press|Press|PRESS|Push|PUSH|Turn|Tilt)\b|Hold keys|A pad /;

function drawn(h: Harness): { left: string[]; right: string[] } {
  const result = { left: [] as string[], right: [] as string[] };
  const record = (into: string[]) => {
    const ctx = createCanvas(480, 272).getContext("2d");
    const original = ctx.fillText.bind(ctx);
    ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      into.push(text);
      original(text, x, y, maxWidth);
    };
    return ctx;
  };
  h.stack.render(record(result.left), record(result.right), h.mc);
  return result;
}

function open(h: Harness, def: PageDef): void {
  h.state.shift = def.shift ?? false;
  h.press(def.button);
  h.state.shift = false;
  if (def.hold) h.advance(600);
  if (def.kind !== "overlay") h.release(def.button);
}

const page = (id: PageName): PageDef => {
  const def = BUILT.find((candidate) => candidate.id === id);
  if (!def) throw new Error(id);
  return def;
};

describe("no help lines", () => {
  const projects = {
    "with markers": { markers: [{ ticks: 0, name: "Intro" }] },
    "without markers": { markers: [] },
  };
  for (const [name, options] of Object.entries(projects)) {
    for (const def of BUILT) {
      it(`${def.label} ${name}`, () => {
        const h = stackHarness({ selected: 2, channels: 24, ...options });
        h.presets(128, 5, ["Preset 1", "Preset 2"]);
        open(h, def);
        const { left, right } = drawn(h);
        expect([...left, ...right].filter((text) => HELP.test(text))).toEqual([]);
      });
    }
  }

  it("BROWSER's PLUG-INS only says whether FL's picker is open", () => {
    const h = stackHarness();
    open(h, page("browser"));
    h.tap("display2");
    expect(drawn(h).left).toEqual(expect.arrayContaining(["Picker open"]));
    expect(drawn(h).right).toContain("CLOSE");
    h.tap("display2");
    expect(drawn(h).left).toEqual(expect.arrayContaining(["Picker closed"]));
  });

  it("BROWSER's cursor shows in its list, not on the left screen too", () => {
    const h = stackHarness();
    open(h, page("browser"));
    h.presets(128, 0, ["First", "Second", "Third"]);
    h.turn(1);
    expect(drawn(h).left).not.toContain("Second");
    expect(drawn(h).right).toContain("Second");
  });
});

describe("nothing said twice", () => {
  it("a pattern with FL's default name shows the number only", () => {
    const h = stackHarness({ patternLength: 64 });
    h.patternInfo({ name: "Pattern 1", number: 1 });
    open(h, page("duplicate"));
    expect(drawn(h).left).not.toContain("Pattern 1");
    expect(drawn(h).left).toEqual(expect.arrayContaining(["1", "64 steps"]));
  });

  it("a pattern with a name of its own shows it", () => {
    const h = stackHarness({ patternLength: 64 });
    h.patternInfo({ name: "Bassline", number: 1 });
    open(h, page("duplicate"));
    expect(drawn(h).left).toContain("Bassline");
  });

  it("FILE draws the undo state once, under UNDO and REDO", () => {
    const h = stackHarness();
    h.fl.apply({ type: "undoState", position: 4, count: 12, hint: "MK3: clear steps" });
    open(h, page("file"));
    const { left, right } = drawn(h);
    expect(right).toEqual(expect.arrayContaining(["UNDO", "REDO", "4 / 12"]));
    expect(left).toEqual(["FILE", "SAVE", "NEW VER"]);
  });

  it("SETTINGS shows the brightness at its knob only", () => {
    const h = stackHarness();
    open(h, page("settings"));
    const { right } = drawn(h);
    expect(right.filter((text) => text.endsWith("%"))).toHaveLength(1);
    expect(right).not.toContain("SCREEN");
  });

  it("LOOP's range doesn't repeat the Length knob's value", () => {
    const h = stackHarness();
    h.fl.apply({ type: "loopState", active: true, start: 0, end: 1536 });
    h.state.shift = true;
    h.press("restart");
    h.advance(600);
    const lengths = drawn(h).left.filter((text) => text === "4 bars");
    expect(lengths).toHaveLength(1);
  });
});
