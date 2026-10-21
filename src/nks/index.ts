// The NKS index: every preset file on this Mac grouped by product, with a default knob mapping
// per product, and the lookup from an FL plugin name to a product (docs/nks.md).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { loadCache, saveCache, defaultCachePath } from "./cache.js";
import {
  discoverNksFiles,
  discoverResources,
  productKey,
  type DiscoverOptions,
  type NksFileEntry,
  type NksResources,
} from "./discover.js";
import { FlPluginDb, defaultFlPluginDbDir } from "./flPluginDb.js";
import { parseNksFile, type ParsedNks } from "./nksFile.js";
import type { NksLookup, NksLookupResult, NksPage, NksProduct, Plid } from "./types.js";

/** Bump when the cached product shape or how it is built changes. */
export const INDEX_FORMAT_VERSION = 1;
/** Files parsed between yields to the event loop. */
const YIELD_EVERY = 100;
/** How long a failed lookup is remembered, and the shortest gap between plugin database re-reads. */
const RETRY_MS = 30_000;

export interface NksIndexOptions extends DiscoverOptions {
  /** FL's plugin database folder (the one that holds `Generators` and `Effects`). */
  flDbDir?: string;
  /** Default `~/Library/Caches/mk3d/nks-index.json`. */
  cachePath?: string;
  log?: (line: string) => void;
  /** Clock for the lookup retry timer (tests). */
  now?: () => number;
}

/** What the last build did. */
export interface NksIndexStats {
  products: number;
  presets: number;
  /** Preset files that could not be parsed. */
  skipped: number;
  /** Files parsed in this build (0 on a cache hit). */
  parsed: number;
  cacheHit: boolean;
  ms: number;
}

interface ParsedPreset extends ParsedNks {
  presetName: string;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Signature of the discovered files, for cache validation. */
function signatureOf(files: readonly NksFileEntry[]): string {
  const hash = createHash("sha1");
  hash.update(`v${INDEX_FORMAT_VERSION}\n`);
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${f.path}|${f.size}|${f.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

const plidKey = (p: Plid): string => JSON.stringify([p.vst2, p.vst3, p.name, p.vendor]);

const mappingKey = (pages: readonly NksPage[]): string =>
  JSON.stringify(pages.map((page) => page.map((s) => [s.id, s.name, s.section])));

const INIT_NAME = /\b(init|default)\b/i;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Rank = [negatedCount: number, noInitName: number, firstName: string];
const compareRank = (a: Rank, b: Rank): number =>
  a[0] - b[0] || a[1] - b[1] || compareText(a[2], b[2]);

/** Group parsed presets into products and pick each product's default mapping. */
function buildProducts(presets: readonly ParsedPreset[]): NksProduct[] {
  interface Mapping {
    pages: NksPage[];
    names: string[];
  }
  interface Group {
    vendor: string;
    name: string;
    plids: Map<string, Plid>;
    mappings: Map<string, Mapping>;
    presets: number;
  }
  const groups = new Map<string, Group>();
  for (const p of presets) {
    const key = productKey(p.info.vendor, p.info.product);
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        vendor: p.info.vendor,
        name: p.info.product,
        plids: new Map(),
        mappings: new Map(),
        presets: 0,
      };
      groups.set(key, g);
    }
    g.presets++;
    if (Object.keys(p.plid).length > 0) g.plids.set(plidKey(p.plid), p.plid);
    if (p.pages.length === 0) continue;
    const mk = mappingKey(p.pages);
    const m = g.mappings.get(mk);
    if (m === undefined) g.mappings.set(mk, { pages: p.pages, names: [p.presetName] });
    else m.names.push(p.presetName);
  }
  const products: NksProduct[] = [];
  for (const g of groups.values()) {
    let best: Mapping | undefined;
    let bestRank: Rank | undefined;
    for (const m of g.mappings.values()) {
      const init = m.names.filter((n) => INIT_NAME.test(n));
      const first = [...(init.length > 0 ? init : m.names)].sort(compareText)[0] ?? "";
      // Most presets, then one named like INIT/Default, then the alphabetically first name.
      const rank: Rank = [-m.names.length, init.length > 0 ? 0 : 1, first];
      if (bestRank === undefined || compareRank(rank, bestRank) < 0) {
        best = m;
        bestRank = rank;
      }
    }
    products.push({
      vendor: g.vendor,
      name: g.name,
      plids: [...g.plids.values()],
      defaultMapping: best?.pages ?? [],
      presets: g.presets,
      mappings: g.mappings.size,
    });
  }
  return products;
}

/** The NKS index. Created by `startNksIndex`; `lookup` answers once `ready` is true. */
export class NksIndex implements NksLookup {
  private isReady = false;
  private productList: NksProduct[] = [];
  private byVst3 = new Map<string, NksProduct>();
  private byVst2 = new Map<number, NksProduct>();
  private listeners: Array<() => void> = [];
  private done: Promise<void> = Promise.resolve();
  private flDb: FlPluginDb | undefined;
  private flDbReadAt = 0;
  private results = new Map<string, { result: NksLookupResult | undefined; at: number }>();
  /** Filled in when the build finishes. */
  stats: NksIndexStats | undefined;

  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: NksIndexOptions = {}) {
    this.log = opts.log ?? ((line) => console.log(line));
    this.now = opts.now ?? Date.now;
  }

  get ready(): boolean {
    return this.isReady;
  }

  /** The indexed products (empty until ready). */
  get products(): readonly NksProduct[] {
    return this.productList;
  }

  /** Call `listener` once the index is ready (at once when it already is). */
  onReady(listener: () => void): void {
    if (this.isReady) this.notify(listener);
    else this.listeners.push(listener);
  }

  /** Resolves when the build has finished, whether it worked or not (check `ready`). */
  whenReady(): Promise<void> {
    return this.done;
  }

  /** Begin building in the background. Called by `startNksIndex`. */
  start(): void {
    this.done = this.build().catch((err: unknown) => {
      this.log(`NKS: index build failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private notify(listener: () => void): void {
    try {
      listener();
    } catch (err) {
      this.log(`NKS: onReady listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async build(): Promise<void> {
    const t0 = performance.now();
    const [files, resources] = await Promise.all([
      discoverNksFiles(this.opts),
      discoverResources(this.opts),
    ]);
    const signature = signatureOf(files);
    const cachePath = this.opts.cachePath ?? defaultCachePath();
    let products = await loadCache(cachePath, INDEX_FORMAT_VERSION, signature);
    const cacheHit = products !== undefined;
    let skipped = 0;
    let parsed = 0;
    if (products === undefined) {
      const presets: ParsedPreset[] = [];
      for (let i = 0; i < files.length; i += YIELD_EVERY) {
        const batch = files.slice(i, i + YIELD_EVERY);
        const results = await Promise.all(batch.map((f) => this.parseFile(f)));
        for (const r of results) {
          if (r === undefined) skipped++;
          else presets.push(r);
        }
        parsed += batch.length;
        await yieldToEventLoop();
      }
      products = buildProducts(presets);
      try {
        await saveCache(cachePath, INDEX_FORMAT_VERSION, signature, products);
      } catch (err) {
        this.log(`NKS: could not write cache: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    attachResources(products, resources);
    this.install(products);
    const ms = Math.round(performance.now() - t0);
    const presetCount = products.reduce((n, p) => n + p.presets, 0);
    this.stats = { products: products.length, presets: presetCount, skipped, parsed, cacheHit, ms };
    this.log(
      `NKS: index ready: ${products.length} products, ${presetCount} presets in ${ms} ms ` +
        `(${cacheHit ? "cache hit" : "scanned"}${skipped > 0 ? `, ${skipped} unreadable files` : ""})`,
    );
    const listeners = this.listeners;
    this.listeners = [];
    for (const l of listeners) this.notify(l);
  }

  private async parseFile(f: NksFileEntry): Promise<ParsedPreset | undefined> {
    try {
      const parsed = parseNksFile(await fs.promises.readFile(f.path));
      return { ...parsed, presetName: parsed.info.name };
    } catch {
      return undefined;
    }
  }

  private install(products: NksProduct[]): void {
    this.productList = products;
    this.byVst3.clear();
    this.byVst2.clear();
    for (const p of products) {
      for (const id of p.plids) {
        if (id.vst3 !== undefined && !this.byVst3.has(id.vst3)) this.byVst3.set(id.vst3, p);
        if (id.vst2 !== undefined && !this.byVst2.has(id.vst2)) this.byVst2.set(id.vst2, p);
      }
    }
    this.results.clear();
    this.isReady = true;
  }

  lookup(flName: string): NksLookupResult | undefined {
    if (!this.isReady) return undefined;
    const now = this.now();
    const cached = this.results.get(flName);
    if (cached !== undefined && (cached.result !== undefined || now - cached.at < RETRY_MS)) {
      return cached.result;
    }
    const result = this.find(flName, now);
    this.results.set(flName, { result, at: now });
    return result;
  }

  private find(flName: string, now: number): NksLookupResult | undefined {
    const dbDir = this.opts.flDbDir ?? defaultFlPluginDbDir();
    if (this.flDb === undefined) {
      this.flDb = new FlPluginDb(dbDir);
      this.flDbReadAt = now;
    }
    let keys = this.flDb.keysForName(flName);
    const known = keys.vst3.length > 0 || keys.vst2.length > 0 || keys.vendors.length > 0;
    if (!known && now - this.flDbReadAt >= RETRY_MS) {
      this.flDb.reload();
      this.flDbReadAt = now;
      keys = this.flDb.keysForName(flName);
    }
    for (const id of keys.vst3) {
      const product = this.byVst3.get(id);
      if (product !== undefined) return { product, via: "vst3" };
    }
    for (const id of keys.vst2) {
      const product = this.byVst2.get(id);
      if (product !== undefined) return { product, via: "vst2" };
    }
    const wanted = flName.toLowerCase();
    const vendors = new Set(keys.vendors.map((v) => v.toLowerCase()));
    let found: NksProduct | undefined;
    for (const p of this.productList) {
      const nameMatch =
        p.name.toLowerCase() === wanted || p.plids.some((i) => i.name?.toLowerCase() === wanted);
      if (!nameMatch) continue;
      const vendorMatch =
        vendors.has(p.vendor.toLowerCase()) ||
        p.plids.some((i) => i.vendor !== undefined && vendors.has(i.vendor.toLowerCase()));
      if (vendorMatch) return { product: p, via: "name" };
      found ??= p;
    }
    return found === undefined ? undefined : { product: found, via: "name" };
  }
}

function attachResources(products: NksProduct[], resources: Map<string, NksResources>): void {
  for (const p of products) {
    delete p.logo;
    delete p.color;
    const r = resources.get(productKey(p.vendor, p.name));
    if (r?.logo !== undefined) p.logo = r.logo;
    if (r?.color !== undefined) p.color = r.color;
  }
}

/** Create the index and start loading it in the background; returns at once (not ready yet). */
export function startNksIndex(opts: NksIndexOptions = {}): NksIndex {
  const index = new NksIndex(opts);
  index.start();
  return index;
}
