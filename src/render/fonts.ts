// FL Studio's UI font (Barlow), loaded from the installed app at runtime. Nothing is bundled:
// if no FL Studio is installed, drawing falls back to a system font and nothing fails.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";

const FONT_DIRS = [
  "/Applications/FL Studio 2026.app/Contents/Resources/FL/Shared/Artwork/Fonts",
  "/Applications/FL Studio 2025.app/Contents/Resources/FL/Shared/Artwork/Fonts",
];

/** Canvas family names the two weights are registered under. */
export const BARLOW_MEDIUM = "Barlow Medium";
export const BARLOW_SEMIBOLD = "Barlow SemiBold";
export const FALLBACK_FAMILY = "Helvetica Neue";

const FILES: ReadonlyArray<[file: string, family: string]> = [
  ["Barlow-Medium.ttf", BARLOW_MEDIUM],
  ["Barlow-SemiBold.ttf", BARLOW_SEMIBOLD],
];

let registered: boolean | undefined;

/**
 * Registers Barlow Medium and SemiBold once (later calls return the first result). True when
 * both weights are available. Never throws.
 */
export function registerFonts(dirs: readonly string[] = FONT_DIRS): boolean {
  if (registered !== undefined) return registered;
  registered = false;
  try {
    for (const dir of dirs) {
      const paths = FILES.map(([file]) => join(dir, file));
      if (!paths.every((path) => existsSync(path))) continue;
      const ok = FILES.every(
        ([, family], i) => GlobalFonts.registerFromPath(paths[i] as string, family) !== null,
      );
      if (ok) {
        registered = true;
        break;
      }
    }
  } catch {
    registered = false;
  }
  return registered;
}

/** The canvas family for a weight: Barlow when registered, else Helvetica Neue. */
export function fontFamily(bold: boolean): string {
  if (!registerFonts()) return FALLBACK_FAMILY;
  return bold ? BARLOW_SEMIBOLD : BARLOW_MEDIUM;
}
