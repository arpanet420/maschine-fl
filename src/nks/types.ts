// What the NKS index knows about a plugin, and how Plugin mode asks for it (docs/nks.md).

/** A plugin ID from an NKS preset's PLID chunk. */
export interface Plid {
  /** VST2 unique ID (`VST.magic`), when non-zero. */
  vst2?: number;
  /** VST3 class ID as 32 upper-case hex digits (`VST3.uid`). */
  vst3?: string;
  name?: string;
  vendor?: string;
}

/** One knob of an NKS page (a NICA slot). */
export interface NksSlot {
  /** Plugin parameter ID; undefined = unassigned slot. */
  id?: number;
  /** Knob label; "" for an unassigned slot. */
  name: string;
  /** Section that starts at this slot; undefined = continues the one to its left. */
  section?: string;
}

/** Always 8 slots. */
export type NksPage = readonly NksSlot[];

export interface NksProduct {
  /** NISI `vendor` and `bankchain[0]`, e.g. "u-he" / "Diva". */
  vendor: string;
  name: string;
  plids: Plid[];
  /** The most common complete NICA across the product's presets. */
  defaultMapping: NksPage[];
  /** How many presets the index read, and how many different NICAs they had. */
  presets: number;
  mappings: number;
  /** Absolute path of `MST_logo.png`, when there is one. */
  logo?: string;
  /** Accent color as "#RRGGBB" (NKS2 control color, else VB_bgcolor). */
  color?: string;
}

/** How a lookup found the product: by an ID from FL's plugin database, or by name only. */
export type NksMatch = "vst2" | "vst3" | "name";

export interface NksLookupResult {
  product: NksProduct;
  via: NksMatch;
}

export interface NksLookup {
  /** True once the index is loaded (from the cache or a fresh scan). */
  readonly ready: boolean;
  /** The NKS product for the plugin name FL reports, if any. */
  lookup(flName: string): NksLookupResult | undefined;
}
