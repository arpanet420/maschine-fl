import { describe, expect, it } from "vitest";
import { stackHarness } from "../src/tools/stackHarness.js";

describe("page buttons bring up FL's windows", () => {
  const focus = (h: ReturnType<typeof stackHarness>, focused: number) =>
    h.fl.apply({ type: "uiState", snap: 0, visible: [true, true, true, true, true], focused });

  it("shows the window that belongs to the page", () => {
    const h = stackHarness();
    focus(h, 127); // nothing focused (the harness starts with the channel rack focused)
    h.tap("mixer");
    h.tap("padMode");
    h.tap("keyboard");
    expect(h.sentOf("showWindow").map((c) => c.window)).toEqual([0, 1, 3]);
  });

  it("leaves a window alone that has the focus already (SHOW_WINDOW toggles)", () => {
    const h = stackHarness();
    focus(h, 0);
    h.tap("mixer");
    expect(h.sentOf("showWindow")).toEqual([]);
  });

  it("brings up the selected channel's plugin window for BROWSER, unless a plugin has the focus", () => {
    const h = stackHarness();
    focus(h, 127);
    h.tap("browser");
    expect(h.sentOf("showEditor")).toHaveLength(1);
    h.tap("browser"); // home
    focus(h, 5);
    h.tap("browser");
    expect(h.sentOf("showEditor")).toHaveLength(1);
  });

  it("brings up nothing for overlays", () => {
    const h = stackHarness();
    h.press("mute");
    h.release("mute");
    h.press("pattern");
    h.release("pattern");
    expect(h.sentOf("showWindow")).toEqual([]);
    expect(h.sentOf("showEditor")).toEqual([]);
  });
});
