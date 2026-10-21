// Finds NKS preset files and NI's per-product art (logo, color). Everything is read-only; all
// roots can be replaced for tests.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DiscoverOptions {
  /** Where NI's per-product plists live. Default `/Library/Preferences`. */
  preferencesDir?: string;
  /** Default `~/Documents/Native Instruments/User Content`. */
  userContentDir?: string;
  /** More folders to search for presets (tests). */
  extraContentDirs?: readonly string[];
  /** Default `/Users/Shared/NI Resources`. */
  resourcesDir?: string;
  /** Where mounted volumes appear. Default `/Volumes`. */
  volumesDir?: string;
}

/** A preset file on disk. */
export interface NksFileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Art for a product, keyed by lower-cased `vendor|name` (see `productKey`). */
export interface NksResources {
  /** Absolute path of `MST_logo.png`. */
  logo?: string;
  /** "#RRGGBB". */
  color?: string;
}

/** The key products share between NISI and NI Resources: `vendor|name`, lower-cased. */
export function productKey(vendor: string, name: string): string {
  return `${vendor}|${name}`.toLowerCase();
}

/**
 * Turn a plist `ContentDir` (an HFS path such as
 * `Macintosh HD:Library:Application Support:u-he:Diva:NKS:Diva:`) into a POSIX path. The first
 * component is the volume: dropped for the boot volume, else the folder is under `/Volumes/<volume>`.
 */
export function hfsToPosix(hfs: string, volumesDir = "/Volumes"): string | undefined {
  const parts = hfs.split(":").filter((p) => p !== "");
  const volume = parts.shift();
  if (volume === undefined) return undefined;
  const rest = "/" + parts.join("/");
  if (volume === "/") return rest;
  try {
    const mount = path.join(volumesDir, volume);
    // The boot volume shows up in /Volumes as a link to "/".
    if (fs.realpathSync(mount) !== "/") return mount + rest;
  } catch {
    // Not mounted under that name: treat it as the boot volume.
  }
  return rest;
}

async function contentDirOf(plist: string): Promise<string | undefined> {
  try {
    // Binary plists keep key names as plain ASCII, so skip the process for unrelated ones.
    if (!(await fs.promises.readFile(plist)).includes("ContentDir")) return undefined;
    const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", plist]);
    const data: unknown = JSON.parse(stdout);
    const dir = (data as { ContentDir?: unknown } | null)?.ContentDir;
    return typeof dir === "string" && dir !== "" ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** The folders that may hold presets: registered NI products and the user's content. */
export async function contentFolders(opts: DiscoverOptions = {}): Promise<string[]> {
  const prefs = opts.preferencesDir ?? "/Library/Preferences";
  const volumes = opts.volumesDir ?? "/Volumes";
  const user =
    opts.userContentDir ??
    path.join(os.homedir(), "Documents", "Native Instruments", "User Content");
  const out = new Set<string>([user, ...(opts.extraContentDirs ?? [])]);
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(prefs);
  } catch {
    // No preferences folder: nothing registered.
  }
  const plists = names
    .filter((n) => n.startsWith("com.native-instruments.") && n.endsWith(".plist"))
    .sort();
  const dirs = await Promise.all(plists.map((n) => contentDirOf(path.join(prefs, n))));
  for (const hfs of dirs) {
    const posix = hfs === undefined ? undefined : hfsToPosix(hfs, volumes);
    if (posix !== undefined) out.add(posix);
  }
  return [...out];
}

const isPreset = (name: string): boolean => /\.nksfx?$/i.test(name);

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) subdirs.push(full);
    else if (isPreset(e.name) && (e.isFile() || e.isSymbolicLink())) out.push(full);
  }
  for (const sub of subdirs) await walk(sub, out);
}

/** Every `.nksf`/`.nksfx` file in the content folders, any depth, skipping dot-folders. Sorted. */
export async function discoverNksFiles(opts: DiscoverOptions = {}): Promise<NksFileEntry[]> {
  const paths = new Set<string>();
  for (const dir of await contentFolders(opts)) {
    const found: string[] = [];
    await walk(dir, found);
    for (const p of found) paths.add(p);
  }
  const sorted = [...paths].sort();
  const entries: NksFileEntry[] = [];
  const BATCH = 64;
  for (let i = 0; i < sorted.length; i += BATCH) {
    const batch = await Promise.all(
      sorted.slice(i, i + BATCH).map(async (p): Promise<NksFileEntry | undefined> => {
        try {
          const st = await fs.promises.stat(p);
          return st.isFile() ? { path: p, size: st.size, mtimeMs: st.mtimeMs } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    for (const e of batch) if (e !== undefined) entries.push(e);
  }
  return entries;
}

function xmlText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  if (m === null) return undefined;
  return m[1]!
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** "EB4747" or "#eb4747" -> "#EB4747"; anything else undefined. */
function normalizeColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const hex = v.trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? "#" + hex.toUpperCase() : undefined;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const v: unknown = JSON.parse(await fs.promises.readFile(file, "utf8"));
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function productColor(dir: string): Promise<string | undefined> {
  const nks2 = await readJson(path.join(dir, "NKS2_control_color.json"));
  const fromNks2 = normalizeColor(nks2?.["color"]);
  if (fromNks2 !== undefined) return fromNks2;
  const legacy = await readJson(path.join(dir, "color.json"));
  return normalizeColor(legacy?.["NKS2_Control_Color"]) ?? normalizeColor(legacy?.["VB_bgcolor"]);
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Logo and color of every product in NI Resources, keyed by `productKey(vendor, name)` from the
 * `.meta` file in `dist_database/<v>/<p>/` (folder names are not the product names). The logo is
 * `image/<v>/<p>/MST_logo.png` when it exists.
 */
export async function discoverResources(
  opts: DiscoverOptions = {},
): Promise<Map<string, NksResources>> {
  const root = opts.resourcesDir ?? "/Users/Shared/NI Resources";
  const out = new Map<string, NksResources>();
  for (const v of await subdirs(path.join(root, "dist_database"))) {
    for (const p of await subdirs(path.join(root, "dist_database", v))) {
      const dir = path.join(root, "dist_database", v, p);
      let meta: string | undefined;
      try {
        const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".meta")).sort();
        if (files[0] !== undefined)
          meta = await fs.promises.readFile(path.join(dir, files[0]), "utf8");
      } catch {
        continue;
      }
      if (meta === undefined) continue;
      const vendor = xmlText(meta, "vendor");
      const name = xmlText(meta, "name");
      if (vendor === undefined || name === undefined) continue;
      const res: NksResources = {};
      const color = await productColor(dir);
      if (color !== undefined) res.color = color;
      const logo = path.join(root, "image", v, p, "MST_logo.png");
      if (fs.existsSync(logo)) res.logo = logo;
      if (res.color !== undefined || res.logo !== undefined) out.set(productKey(vendor, name), res);
    }
  }
  return out;
}
