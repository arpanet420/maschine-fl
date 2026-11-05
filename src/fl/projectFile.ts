// Finding the .flp FL has open, for SCENE's FOLLOW: FL's scripting API gives no path (docs/fl-api-notes.md,
// "Channel groups"), and FL 2026's window title (`ui.getProgTitle`) is just "FL Studio 2026". So the file is the
// newest project under FL's Projects folder (Backup folders left out) with FL's markers. Should a title name the
// project, a file of that name goes first.
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readProjectGroups, type ProjectGroups } from "./flpGroups.js";

export interface FoundProject {
  path: string;
  /** The file's modification time when it was read: a later one means FL saved it again. */
  mtimeMs: number;
  project: ProjectGroups;
}

/** FL's default Projects folder (the same place on macOS and Windows). */
export const defaultProjectsFolder = (): string =>
  join(homedir(), "Documents", "Image-Line", "FL Studio", "Projects");

/** Folders deeper than this under the Projects folder are not looked in. */
const MAX_DEPTH = 4;
/** At most this many .flp files are listed. */
const MAX_FILES = 5000;
/** Without a file of the project's name, the newest this many are read for FL's markers. */
const NEWEST_TRIED = 40;

/**
 * The project's name in FL's window title: the part that isn't "FL Studio …", without ".flp" or the "*" of unsaved
 * changes ("song - FL Studio 2026", "FL Studio 2026 - song.flp *"). Undefined when there is none.
 */
export function projectNameFromTitle(title: string): string | undefined {
  const parts = title
    .split(/\s+[-–—]\s+/)
    .map((part) => part.replace(/^[\s*]+|[\s*]+$/g, ""))
    .filter((part) => part !== "");
  const name = parts.find((part) => !/^FL Studio\b/i.test(part));
  return name?.replace(/\.flp$/i, "") || undefined;
}

interface Listed {
  path: string;
  mtimeMs: number;
}

async function listProjects(folder: string): Promise<Listed[]> {
  const found: Listed[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && entry.name.toLowerCase() !== "backup") await walk(path, depth + 1);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".flp") &&
        found.length < MAX_FILES
      ) {
        try {
          found.push({ path, mtimeMs: (await stat(path)).mtimeMs });
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  await walk(folder, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function read(file: Listed): Promise<FoundProject | undefined> {
  try {
    return { ...file, project: readProjectGroups(await readFile(file.path)) };
  } catch {
    return undefined;
  }
}

/**
 * Is FL's marker name `live` the saved marker `saved`? FL's `getMarkerName` adds the marker's action to the name the
 * file has: "swesyntmaster - marker loop" for a Marker loop marker "swesyntmaster" (seen in FL 2026, 2026-11-05).
 */
export const isMarker = (live: string, saved: string): boolean =>
  live === saved || live.startsWith(`${saved} - `);

/** The saved marker name FL's marker name `live` stands for; `live` itself when no saved one fits. */
export const savedMarkerName = (live: string, saved: readonly string[]): string =>
  saved.filter((name) => isMarker(live, name)).sort((a, b) => b.length - a.length)[0] ?? live;

/** The file's markers are FL's (`live`), whatever their order. */
export function sameMarkers(saved: readonly string[], live: readonly string[]): boolean {
  if (saved.length !== live.length) return false;
  const left = [...saved];
  return live.every((name) => {
    const at = left.findIndex((candidate) => isMarker(name, candidate));
    if (at < 0) return false;
    left.splice(at, 1);
    return true;
  });
}

/**
 * The project file FL has open, by its window title and FL's marker names; undefined when none fits. Of the files
 * with the title's name, one with FL's markers wins, else the newest. Without one, the newest files under the
 * folder are read until one has FL's markers (only when FL has markers: a project without is too common).
 */
export async function findProjectFile(
  title: string,
  markers: readonly string[],
  folder = defaultProjectsFolder(),
): Promise<FoundProject | undefined> {
  const files = await listProjects(folder);
  const name = projectNameFromTitle(title)?.toLowerCase();
  const named = name
    ? files.filter((file) => basename(file.path, ".flp").toLowerCase() === name)
    : [];
  let newest: FoundProject | undefined;
  for (const file of named) {
    const found = await read(file);
    if (!found) continue;
    if (sameMarkers(found.project.markers, markers)) return found;
    newest ??= found;
  }
  if (newest) return newest;
  if (markers.length === 0) return undefined;
  for (const file of files.slice(0, NEWEST_TRIED)) {
    const found = await read(file);
    if (found && sameMarkers(found.project.markers, markers)) return found;
  }
  return undefined;
}

/** Has FL saved the file again since it was read? */
export async function savedSince(found: FoundProject): Promise<boolean> {
  try {
    return (await stat(found.path)).mtimeMs !== found.mtimeMs;
  } catch {
    return false;
  }
}
