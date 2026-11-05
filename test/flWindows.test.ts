import { describe, expect, it } from "vitest";
import { FOCUS_PLUGIN } from "../src/fl/protocol.js";
import { stackHarness } from "../src/tools/stackHarness.js";

describe("page buttons bring up FL's windows", () => {
  const focus = (h: ReturnType<typeof stackHarness>, focused: number) =>
    h.fl.apply({ type: "uiState", snap: 0, visible: [true, true, true, true, true], focused });
  const raised = (h: ReturnType<typeof stackHarness>) =>
    h.sentOf("raiseWindow").map((c) => c.window);

  it("shows the window that belongs to the page", () => {
    const h = stackHarness();
    focus(h, 127); // nothing focused (the harness starts with the channel rack focused)
    h.tap("mixer");
    h.tap("padMode");
    h.tap("keyboard");
    expect(raised(h)).toEqual([0, 1, 3]);
  });

  it("asks whatever mk3d's copy of the focus says, and never with the toggle (bug 11)", () => {
    const h = stackHarness();
    focus(h, 0); // this copy is about 200 ms old, so FL's script decides
    h.tap("mixer");
    expect(raised(h)).toEqual([0]);
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

  it("brings up the channel rack for CHANNEL, also when its page is already shown", () => {
    const h = stackHarness();
    focus(h, 0);
    h.tap("channel"); // the page is home, the mixer has the focus
    expect(h.sentOf("showWindow").map((c) => c.window)).toEqual([1]);
    h.tap("mixer");
    focus(h, 0);
    h.tap("channel");
    expect(raised(h)).toEqual([0, 1]);
  });

  it("brings up the page's window when a tool page closes back to it", () => {
    const h = stackHarness();
    h.tap("keyboard");
    focus(h, 3);
    h.tap("channel");
    expect(raised(h).at(-1)).toBe(1);
  });

  it("brings up the piano roll for SAMPLING and leaves the page as it is", () => {
    const h = stackHarness();
    focus(h, 127);
    h.tap("mixer");
    h.press("sampling");
    expect(raised(h)).toEqual([0]);
    expect(h.sentOf("showWindow").map((c) => c.window)).toEqual([3]);
    h.release("sampling");
    expect(h.stack.main).toBe("mixer");
    focus(h, 3);
  });

  it("keeps the page on top when SAMPLING brings up the piano roll", () => {
    const h = stackHarness();
    focus(h, 127);
    h.tap("step");
    h.tap("sampling");
    expect(h.stack.top?.page.id).toBe("step");
  });

  describe("the same button again closes the window", () => {
    const closed = (h: ReturnType<typeof stackHarness>) =>
      h.sentOf("closeWindow").map((c) => c.window);
    const toggled = (h: ReturnType<typeof stackHarness>) =>
      h.sentOf("showWindow").map((c) => c.window);

    it("CHANNEL and SAMPLING stay where they are and toggle it", () => {
      const h = stackHarness();
      h.tap("channel");
      h.tap("sampling");
      h.tap("sampling");
      expect(toggled(h)).toEqual([1, 3, 3]);
      expect(h.stack.main).toBe("channel");
    });

    it("MIXER and ARRANGER go home, close it and bring up no other window", () => {
      const h = stackHarness();
      h.tap("mixer");
      h.tap("mixer");
      expect(closed(h)).toEqual([0]);
      expect(raised(h)).toEqual([0]);
      expect(h.stack.main).toBe("channel");
      h.tap("arranger");
      h.tap("arranger");
      expect(closed(h)).toEqual([0, 2]);
      expect(raised(h)).toEqual([0, 2]);
    });

    it("a third press opens the page and the window again", () => {
      const h = stackHarness();
      h.tap("mixer");
      h.tap("mixer");
      h.tap("mixer");
      expect(raised(h)).toEqual([0, 0]);
      expect(h.stack.main).toBe("mixer");
    });

    it("a tool page closes its window on the press", () => {
      const h = stackHarness();
      h.tap("keyboard");
      h.press("keyboard");
      expect(closed(h)).toEqual([3]);
      h.release("keyboard");
      expect(h.stack.top).toBeUndefined();
    });

    it("BROWSER closes the plugin window only if a plugin has the focus", () => {
      const h = stackHarness();
      h.tap("browser");
      const opened = h.sentOf("showEditor").length;
      focus(h, 127);
      h.tap("browser");
      expect(h.sentOf("showEditor")).toHaveLength(opened);
      h.tap("browser");
      focus(h, FOCUS_PLUGIN);
      h.tap("browser");
      expect(h.sentOf("showEditor")).toHaveLength(opened + 2);
    });

    it("a main button under a tool page brings the window up, it never closes it", () => {
      const h = stackHarness();
      h.tap("keyboard");
      h.tap("channel");
      expect(raised(h).at(-1)).toBe(1);
      expect(toggled(h)).toEqual([]);
      expect(closed(h)).toEqual([]);
    });

    it("sends nothing with FL gone", () => {
      const h = stackHarness();
      h.tap("mixer");
      h.fl.reset();
      h.sent.length = 0;
      h.tap("sampling");
      h.tap("mixer");
      expect(h.sent).toEqual([]);
    });
  });

  it("brings up nothing for PLUG-IN", () => {
    const h = stackHarness();
    focus(h, 127);
    h.tap("plugIn");
    expect(h.sentOf("showWindow")).toEqual([]);
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
