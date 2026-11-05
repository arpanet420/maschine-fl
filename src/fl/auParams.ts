// The ranges of an Audio Unit's parameters, so PLUG-IN can place a knob before its first turn. FL gives an
// untouched parameter's value only in the plug-in's own units and from when it was loaded (docs/bugs.md #6);
// its text is current, and FL's 0–1 for an Audio Unit is linear over the range the plug-in reports
// (docs/fl-api-notes.md). FL's script API has no range, so a small helper reads them: native/au-params.c, in
// its own process because a plug-in can print or crash. macOS only. Without it knobs wait for the first turn.
import { execFile } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { settingsDir } from "../platform.js";

const execFileAsync = promisify(execFile);
const HELPER_TIMEOUT_MS = 20_000;
/** The FL script cuts strings to this (MAX_STRING). */
const NAME_LIMIT = 32;

export interface AuParam {
  name: string;
  min: number;
  max: number;
}

/** A plug-in's parameters by FL's index, empty if it has no Audio Unit of that name. */
export type AuParamReader = (plugin: string) => Promise<readonly AuParam[]>;

/** The helper's output. */
export function parseAuParams(output: string): AuParam[] {
  return output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", min = "", max = ""] = line.split("\t");
      return { name, min: Number(min), max: Number(max) };
    });
}

/** The number in FL's value text for an Audio Unit (`90.00 `, a comma in some locales), if it is one. */
export function auTextValue(text: string): number | undefined {
  return /^-?\d+[.,]\d\d $/.test(text) ? Number(text.replace(",", ".")) : undefined;
}

/**
 * Where a parameter stands, 0–1: undefined unless its text has FL's Audio Unit form and the name at its index
 * is the plug-in's, which also rules out another format's plug-in of the same name with other parameters.
 */
export function auPosition(
  param: { name: string; valueText: string },
  au: AuParam | undefined,
): number | undefined {
  const value = auTextValue(param.valueText);
  if (value === undefined || !au || !(au.max > au.min)) return undefined;
  if (au.name.slice(0, NAME_LIMIT).trim() !== param.name.trim()) return undefined;
  return Math.min(1, Math.max(0, (value - au.min) / (au.max - au.min)));
}

/** Each plug-in's parameters, read once per run, in the background, one plug-in at a time. */
export class AuRanges {
  private readonly known = new Map<string, readonly AuParam[]>();
  private readonly asked = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly read: AuParamReader,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** What is known so far; the first ask for a plug-in starts the read and `ready` follows if it finds any. */
  params(plugin: string, ready: () => void): readonly AuParam[] | undefined {
    if (!this.asked.has(plugin)) {
      this.asked.add(plugin);
      this.queue = this.queue.then(() => this.load(plugin, ready));
    }
    return this.known.get(plugin);
  }

  private async load(plugin: string, ready: () => void): Promise<void> {
    try {
      const params = await this.read(plugin);
      this.log(`Audio Unit ranges: "${plugin}": ${params.length} parameters`);
      if (params.length === 0) return;
      this.known.set(plugin, params);
      ready();
    } catch (error) {
      this.log(`Audio Unit ranges: "${plugin}": ${(error as Error).message}`);
    }
  }
}

const sourcePath = (): string =>
  fileURLToPath(new URL("../../native/au-params.c", import.meta.url));

const modified = (path: string): number => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;

/** Builds the helper into the settings folder if it's missing or older than its source. */
async function buildHelper(): Promise<string> {
  const source = sourcePath();
  const dir = settingsDir();
  const helper = join(dir, "au-params");
  if (modified(helper) >= modified(source)) return helper;
  // Without this check `cc` opens macOS's dialog offering to install the tools.
  await execFileAsync("xcode-select", ["-p"]);
  mkdirSync(dir, { recursive: true });
  await execFileAsync("cc", [
    "-O1",
    "-o",
    helper,
    source,
    "-framework",
    "AudioToolbox",
    "-framework",
    "CoreFoundation",
  ]);
  return helper;
}

/** The reader mk3d uses. Elsewhere than macOS there are no Audio Units. */
export function auParamHelper(platform: NodeJS.Platform = process.platform): AuParamReader {
  if (platform !== "darwin") return () => Promise.resolve([]);
  let built: Promise<string> | undefined;
  return async (plugin) => {
    built ??= buildHelper();
    try {
      const { stdout } = await execFileAsync(await built, [plugin], {
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      return parseAuParams(stdout);
    } catch (error) {
      if ((error as { code?: unknown }).code === 2) return []; // no Audio Unit of that name
      throw error;
    }
  };
}
