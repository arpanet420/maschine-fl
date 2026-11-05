// A diagnostic for PLUG-IN's page one: with MK3D_PARAM_DUMP=1, mk3d writes the selected plugin's named
// parameters to out/params/<plugin>.txt, one "index<TAB>name" line each. The FL script sends the names in
// one burst once its scan is done, so the list is written when no name has come for a moment.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FlSection, FlState } from "./flState.js";

/** How long without a new name before the list counts as complete. */
export const QUIET_MS = 2000;

export interface ParamDumpOptions {
  fl: FlState;
  folder: string;
  log?: (line: string) => void;
  /** Writes a file (tests pass their own). */
  write?: (path: string, text: string) => Promise<void>;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** A file name for a plugin name: letters, digits, space, dot, dash and underscore kept. */
export const dumpFileName = (plugin: string): string =>
  `${plugin.replace(/[^\p{L}\p{N} ._-]+/gu, "_").trim() || "plugin"}.txt`;

/** The file's text: a header line, then "index<TAB>name" for each named parameter in index order. */
export function dumpText(
  plugin: string,
  paramCount: number,
  names: ReadonlyMap<number, string>,
): string {
  const lines = [...names].sort(([a], [b]) => a - b).map(([index, name]) => `${index}\t${name}`);
  return [`# ${plugin}: ${names.size} named of ${paramCount}`, ...lines, ""].join("\n");
}

interface Listed {
  name: string;
  count: number;
  names: ReadonlyMap<number, string>;
}

export class ParamDump {
  private timer: unknown;
  /** The selected plugin's names as they stand. */
  private last: Listed | undefined;
  /** What was last written, per file: the text, so the same list isn't written twice. */
  private readonly written = new Map<string, string>();
  private readonly write: NonNullable<ParamDumpOptions["write"]>;
  private readonly setTimer: NonNullable<ParamDumpOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ParamDumpOptions["clearTimer"]>;

  constructor(private readonly options: ParamDumpOptions) {
    this.write =
      options.write ??
      (async (path, text) => {
        await mkdir(options.folder, { recursive: true });
        await writeFile(path, text);
      });
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  onFlChange(section: FlSection): void {
    if (section !== "plugin" && section !== "paramNames") return;
    const { plugin, paramNames } = this.options.fl;
    // Another plugin before the list went quiet: write the one there was (FL has dropped its names).
    if (this.last && this.last.name !== plugin.name) this.flush(this.last);
    this.last =
      plugin.valid && plugin.name !== "" && paramNames.size > 0
        ? { name: plugin.name, count: plugin.paramCount, names: new Map(paramNames) }
        : undefined;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (this.last) this.flush(this.last);
    }, QUIET_MS);
  }

  private flush(list: Listed): void {
    const path = join(this.options.folder, dumpFileName(list.name));
    const text = dumpText(list.name, list.count, list.names);
    if (this.written.get(path) === text) return;
    this.written.set(path, text);
    this.write(path, text).then(
      () =>
        this.options.log?.(
          `PLUG-IN: ${list.names.size} parameter names of ${list.name} written to ${path}`,
        ),
      (error: unknown) => {
        this.written.delete(path);
        this.options.log?.(`PLUG-IN: writing ${path} failed: ${String(error)}`);
      },
    );
  }
}
