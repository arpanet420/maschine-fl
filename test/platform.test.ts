import { describe, expect, it } from "vitest";
import { findPort } from "../src/fl/midiPorts.js";
import { cacheDir, fallbackFont, flFontDirs, settingsDir } from "../src/platform.js";

const windows = {
  platform: "win32" as const,
  home: "C:\\Users\\me",
  env: { APPDATA: "D:\\Roaming", LOCALAPPDATA: "D:\\Local", ProgramFiles: "E:\\Programs" },
};
const mac = { platform: "darwin" as const, home: "/Users/me", env: {} };

describe("where files live", () => {
  it("on macOS", () => {
    expect(settingsDir(mac)).toBe("/Users/me/Library/Application Support/mk3d");
    expect(cacheDir(mac)).toBe("/Users/me/Library/Caches/mk3d");
    expect(flFontDirs(mac)[0]).toBe(
      "/Applications/FL Studio 2026.app/Contents/Resources/FL/Shared/Artwork/Fonts",
    );
    expect(fallbackFont("darwin")).toBe("Helvetica Neue");
  });

  it("on Windows", () => {
    expect(settingsDir(windows)).toBe("D:\\Roaming\\mk3d");
    expect(cacheDir(windows)).toBe("D:\\Local\\mk3d");
    expect(flFontDirs(windows)[0]).toBe(
      "E:\\Programs\\Image-Line\\FL Studio 2026\\Shared\\Artwork\\Fonts",
    );
    expect(fallbackFont("win32")).toBe("Segoe UI");
  });

  it("on Windows without the environment variables", () => {
    const bare = { ...windows, env: {} };
    expect(settingsDir(bare)).toBe("C:\\Users\\me\\AppData\\Roaming\\mk3d");
    expect(cacheDir(bare)).toBe("C:\\Users\\me\\AppData\\Local\\mk3d");
    expect(flFontDirs(bare)[0]).toContain("C:\\Program Files\\Image-Line");
  });
});

describe("findPort", () => {
  const names = ["Stream Deck 0", "MK3 Bridge FB 1", "MK3 Bridge 2"];

  it("takes RtMidi's number on Windows, and no number", () => {
    expect(findPort(names, "MK3 Bridge")).toBe(2);
    expect(findPort(names, "MK3 Bridge FB")).toBe(1);
    expect(findPort(["MK3 Bridge"], "MK3 Bridge")).toBe(0);
  });

  it("doesn't take another port that starts the same", () => {
    expect(findPort(["MK3 Bridge FB 1"], "MK3 Bridge")).toBe(-1);
    expect(findPort(["MK3 Bridge2"], "MK3 Bridge")).toBe(-1);
    expect(findPort([], "MK3 Bridge")).toBe(-1);
  });
});
