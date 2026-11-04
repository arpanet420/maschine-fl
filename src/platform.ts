// What differs between macOS and Windows: where files live. docs/windows.md has the port's status.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

interface Host {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

const thisHost = (): Host => ({ platform: process.platform, env: process.env, home: homedir() });

/** Settings: `~/Library/Application Support/mk3d`, or `%APPDATA%\mk3d` on Windows. */
export function settingsDir(host: Host = thisHost()): string {
  if (host.platform === "win32") {
    return win32.join(host.env.APPDATA ?? win32.join(host.home, "AppData", "Roaming"), "mk3d");
  }
  return posix.join(host.home, "Library", "Application Support", "mk3d");
}

/** Caches: `~/Library/Caches/mk3d`, or `%LOCALAPPDATA%\mk3d` on Windows. */
export function cacheDir(host: Host = thisHost()): string {
  if (host.platform === "win32") {
    return win32.join(host.env.LOCALAPPDATA ?? win32.join(host.home, "AppData", "Local"), "mk3d");
  }
  return posix.join(host.home, "Library", "Caches", "mk3d");
}

/** Where an installed FL Studio keeps its fonts, newest first. */
export function flFontDirs(host: Host = thisHost()): string[] {
  const years = ["2026", "2025"];
  if (host.platform === "win32") {
    const programs = host.env.ProgramFiles ?? "C:\\Program Files";
    return years.map((year) =>
      win32.join(programs, "Image-Line", `FL Studio ${year}`, "Shared", "Artwork", "Fonts"),
    );
  }
  return years.map(
    (year) => `/Applications/FL Studio ${year}.app/Contents/Resources/FL/Shared/Artwork/Fonts`,
  );
}

/** The font used when FL's aren't found. */
export function fallbackFont(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "Segoe UI" : "Helvetica Neue";
}
