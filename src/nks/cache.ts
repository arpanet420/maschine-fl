// On-disk cache of the NKS index, so a restart doesn't re-read thousands of preset files.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NksProduct } from "./types.js";

/** Default `~/Library/Caches/mk3d/nks-index.json`. */
export function defaultCachePath(): string {
  return path.join(os.homedir(), "Library", "Caches", "mk3d", "nks-index.json");
}

interface CacheFile {
  version: number;
  signature: string;
  products: NksProduct[];
}

/** The cached products when the file exists and matches `version` and `signature`, else undefined. */
export async function loadCache(
  file: string,
  version: number,
  signature: string,
): Promise<NksProduct[] | undefined> {
  try {
    const data = JSON.parse(await fs.promises.readFile(file, "utf8")) as Partial<CacheFile> | null;
    if (data?.version !== version || data.signature !== signature) return undefined;
    return Array.isArray(data.products) ? data.products : undefined;
  } catch {
    return undefined;
  }
}

/** Write the cache atomically (temp file + rename), creating the folder. Throws on failure. */
export async function saveCache(
  file: string,
  version: number,
  signature: string,
  products: NksProduct[],
): Promise<void> {
  const data: CacheFile = { version, signature, products };
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(data));
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}
