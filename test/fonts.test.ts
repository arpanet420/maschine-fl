import { describe, expect, it, vi } from "vitest";

describe("fonts", () => {
  it("falls back and never throws when FL's fonts are missing", async () => {
    vi.resetModules();
    const fonts = await import("../src/render/fonts.js");
    expect(fonts.registerFonts(["/nonexistent/fonts"])).toBe(false);
    expect(fonts.registerFonts()).toBe(false); // the first result sticks
    expect(fonts.fontFamily(true)).toBe(fonts.FALLBACK_FAMILY);
    const { font } = await import("../src/render/widgets.js");
    expect(font(14)).toBe(`14px "${fonts.FALLBACK_FAMILY}"`);
    expect(font(14, "bold")).toBe(`bold 14px "${fonts.FALLBACK_FAMILY}"`);
  });

  it("uses Barlow when the fonts are registered, whatever machine this runs on", async () => {
    vi.resetModules();
    const fonts = await import("../src/render/fonts.js");
    const { font } = await import("../src/render/widgets.js");
    const family = fonts.registerFonts() ? "Barlow SemiBold" : fonts.FALLBACK_FAMILY;
    expect(font(14, "bold")).toContain(family);
  });
});
