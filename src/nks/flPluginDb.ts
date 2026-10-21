// Reads FL Studio's plugin database (`.nfo` files) to turn a plugin name into the IDs an NKS
// preset's PLID chunk uses (docs/nks.md). Read-only.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Default `~/Documents/Image-Line/FL Studio/Presets/Plugin database/Installed`. */
export function defaultFlPluginDbDir(): string {
  return path.join(
    os.homedir(),
    "Documents",
    "Image-Line",
    "FL Studio",
    "Presets",
    "Plugin database",
    "Installed",
  );
}

/** One plugin file of an `.nfo` entry (`_0`, `_1`, ...). */
export interface NfoEntry {
  /** `ps_name`. */
  name: string;
  /** 4 = VST2, 7/8 = VST3, 10 = AU, 12 = CLAP. */
  plugClass: number;
  /** VST2 unique ID, when the entry has one. */
  magic?: number;
  /** Class ID as 32 upper-case hex digits. */
  guid?: string;
  /** VST2 unique IDs of the plugins this one replaces, from `ps_compatibility`. */
  compatMagics: number[];
  vendor?: string;
}

/** The IDs FL's database knows for a plugin name. */
export interface FlPluginKeys {
  /** VST3 class IDs (32 upper-case hex digits). */
  vst3: string[];
  /** VST2 unique IDs: compatibility-derived first, then plain ones. */
  vst2: number[];
  vendors: string[];
}

function guidHex(text: string): string | undefined {
  const hex = text.replace(/[{}\-\s]/g, "");
  return /^[0-9a-f]{32}$/i.test(hex) ? hex.toUpperCase() : undefined;
}

/** The VST2 unique ID inside a VST3 wrapper GUID: bytes 0-2 are "VST", bytes 3-6 the ID (big-endian). */
function magicFromCompat(guid: string): number | undefined {
  const hex = guidHex(guid);
  if (hex === undefined || !hex.startsWith("565354")) return undefined;
  return parseInt(hex.slice(6, 14), 16);
}

/** Parse the text of one `.nfo` file into its entries. */
export function parseNfo(text: string): NfoEntry[] {
  const name = { value: "" };
  const fields = new Map<number, Map<string, string>>();
  for (const line of text.replace(/^\u{FEFF}/u, "").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "ps_name") {
      name.value = value;
      continue;
    }
    const m = /^ps_(?:file_)?([a-z]+)_(\d+)$/.exec(key);
    if (m === null) continue;
    const n = Number(m[2]);
    let entry = fields.get(n);
    if (entry === undefined) fields.set(n, (entry = new Map()));
    entry.set(m[1]!, value);
  }
  const entries: NfoEntry[] = [];
  for (const n of [...fields.keys()].sort((a, b) => a - b)) {
    const f = fields.get(n)!;
    const entry: NfoEntry = {
      name: name.value,
      plugClass: Number(f.get("plugclass") ?? NaN),
      compatMagics: [],
    };
    const magic = Number(f.get("magic") ?? NaN);
    if (Number.isInteger(magic) && magic > 0) entry.magic = magic;
    const guid = guidHex(f.get("guid") ?? "");
    if (guid !== undefined) entry.guid = guid;
    for (const g of (f.get("compatibility") ?? "").split(",")) {
      const m = magicFromCompat(g);
      if (m !== undefined) entry.compatMagics.push(m);
    }
    const vendor = f.get("vendorname");
    if (vendor !== undefined && vendor !== "") entry.vendor = vendor;
    entries.push(entry);
  }
  return entries;
}

function* nfoFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* nfoFiles(full);
    else if (e.name.endsWith(".nfo")) yield full;
  }
}

/** FL's plugin database, loaded from `<root>/{Generators,Effects}/**\/*.nfo`. */
export class FlPluginDb {
  private byName = new Map<string, NfoEntry[]>();

  constructor(private readonly root = defaultFlPluginDbDir()) {
    this.reload();
  }

  /** Read all `.nfo` files again (synchronously; a few hundred small files). */
  reload(): void {
    const byName = new Map<string, NfoEntry[]>();
    for (const sub of ["Generators", "Effects"]) {
      for (const file of nfoFiles(path.join(this.root, sub))) {
        let text: string;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        for (const entry of parseNfo(text)) {
          if (entry.name === "") continue;
          const key = entry.name.toLowerCase();
          const list = byName.get(key);
          if (list === undefined) byName.set(key, [entry]);
          else list.push(entry);
        }
      }
    }
    this.byName = byName;
  }

  /** Number of distinct plugin names. */
  get size(): number {
    return this.byName.size;
  }

  /**
   * The IDs of every format of the plugin called `name` (case-insensitive). VST3 class IDs come
   * first, then VST2 IDs derived from VST3 compatibility GUIDs, then plain VST2 IDs; deduped.
   */
  keysForName(name: string): FlPluginKeys {
    const entries = this.byName.get(name.toLowerCase()) ?? [];
    const vst3 = new Set<string>();
    const compat = new Set<number>();
    const plain = new Set<number>();
    const vendors = new Set<string>();
    for (const e of entries) {
      if ((e.plugClass === 7 || e.plugClass === 8) && e.guid !== undefined) vst3.add(e.guid);
      for (const m of e.compatMagics) compat.add(m);
      if (e.plugClass === 4 && e.magic !== undefined) plain.add(e.magic);
      if (e.vendor !== undefined) vendors.add(e.vendor);
    }
    return {
      vst3: [...vst3],
      vst2: [...new Set([...compat, ...plain])],
      vendors: [...vendors],
    };
  }
}
