// Where Plugin mode gets its pages from: FL's own parameter list (FlParamPages), or NKS pages
// (src/nks/nksPages.ts) that implement the same interface.
import type { FlState } from "../fl/flState.js";

export const PAGE_SIZE = 8;

export interface PluginPage {
  /** Shown on the tab and the right screen. */
  name: string;
  /** FL parameter index of each of the page's 8 knobs; undefined = unused knob. */
  params: readonly (number | undefined)[];
  /** The part before ": " that all parameter names on the page share; knob labels drop it. */
  prefix?: string;
  /**
   * Knob label per slot (an NKS name); undefined = FL's parameter name (shortened by `prefix`,
   * see `paramLabel`).
   */
  labels?: readonly (string | undefined)[];
  /**
   * The section that starts at each slot; undefined = the section to its left continues.
   * Plugin mode draws a section row above the knobs when a page has this.
   */
  sections?: readonly (string | undefined)[];
}

export interface PageSource {
  /** Pages of the selected channel's plugin, from what `fl` knows now. */
  pages(fl: FlState): PluginPage[];
  /** Art for the left screen when the pages come with their own: a logo file and an accent color. */
  header?(fl: FlState): { logo?: string; color?: string } | undefined;
}

const SEPARATOR = ": ";

/** The knob label for `name` on `page`: the name without the page's shared prefix. */
export function paramLabel(page: PluginPage, name: string): string {
  const prefix = page.prefix === undefined ? undefined : page.prefix + SEPARATOR;
  return prefix !== undefined && name.startsWith(prefix) && name.length > prefix.length
    ? name.slice(prefix.length)
    : name;
}

/**
 * FL's parameter list as pages: the named parameters in index order, 8 per page. A page is named
 * after the prefix all its names share ("Filter: Cutoff" → "Filter"), else "Page n".
 */
export class FlParamPages implements PageSource {
  pages(fl: FlState): PluginPage[] {
    const named = [...fl.paramNames]
      .filter(([, name]) => name.trim() !== "")
      .sort(([a], [b]) => a - b);
    const pages: PluginPage[] = [];
    for (let first = 0; first < named.length; first += PAGE_SIZE) {
      const entries = named.slice(first, first + PAGE_SIZE);
      const prefixes = entries.map(([, name]) => {
        const at = name.indexOf(SEPARATOR);
        return at > 0 ? name.slice(0, at) : undefined;
      });
      const common = prefixes[0] !== undefined && prefixes.every((p) => p === prefixes[0]);
      pages.push({
        name: common ? (prefixes[0] as string) : `Page ${pages.length + 1}`,
        params: Array.from({ length: PAGE_SIZE }, (_, i) => entries[i]?.[0]),
        ...(common ? { prefix: prefixes[0] } : {}),
      });
    }
    return pages;
  }
}
