// Plugin mode's pages from NKS data (docs/nks.md): the product's default mapping, used when it
// fits what FL reports for the plugin, else FL's own parameter list.
import type { FlState } from "../fl/flState.js";
import { FlParamPages, PAGE_SIZE } from "../modes/pluginPages.js";
import type { PageSource, PluginPage } from "../modes/pluginPages.js";
import type { NksLookup, NksLookupResult, NksPage } from "./types.js";

/** Smallest share of countable slots whose NKS words match FL's parameter names. */
export const AGREEMENT_THRESHOLD = 0.5;

/** Words of a label: lower-cased runs of letters and digits, split at lower→upper case changes. */
function words(text: string): string[] {
  return text
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** A word that says something: at least 3 letters. */
const meaningful = (word: string): boolean => word.replace(/[^\p{L}]/gu, "").length >= 3;

/** The section each slot of a page is in: its own, else the nearest one to its left. */
function inheritedSections(page: NksPage): Array<string | undefined> {
  let current: string | undefined;
  return page.map((slot) => {
    if (slot.section) current = slot.section;
    return current;
  });
}

interface Evaluation {
  coverage: number;
  /** Smallest assigned id FL has no name for, if any. */
  firstMissing: number | undefined;
  agreement: number;
  use: boolean;
}

/** How well `pages` fit the plugin FL reports. */
function evaluate(pages: readonly NksPage[], fl: FlState): Evaluation {
  let assigned = 0;
  let covered = 0;
  let firstMissing: number | undefined;
  let countable = 0;
  let agreeing = 0;
  for (const page of pages) {
    const sections = inheritedSections(page);
    page.forEach((slot, i) => {
      if (slot.id === undefined) return;
      assigned++;
      const flName = fl.paramNames.get(slot.id);
      if (slot.id < fl.plugin.paramCount && flName !== undefined && flName.trim() !== "") {
        covered++;
      } else if (firstMissing === undefined || slot.id < firstMissing) {
        firstMissing = slot.id;
      }
      const own = words(`${slot.name} ${sections[i] ?? ""}`).filter(meaningful);
      if (own.length === 0) return;
      countable++;
      const theirs = words(flName ?? "");
      if (own.some((word) => theirs.some((other) => other.startsWith(word)))) agreeing++;
    });
  }
  const coverage = assigned === 0 ? 0 : covered / assigned;
  const agreement = countable === 0 ? 1 : agreeing / countable;
  return {
    coverage,
    firstMissing,
    agreement,
    use: assigned > 0 && coverage === 1 && agreement >= AGREEMENT_THRESHOLD,
  };
}

/** NKS pages as Plugin mode pages: tab name = first section on the page, repeats get " 2"… */
function toPluginPages(pages: readonly NksPage[]): PluginPage[] {
  const seen = new Map<string, number>();
  return pages.map((page, index) => {
    const first = page.find((slot) => slot.section)?.section;
    let name = first ?? `Page ${index + 1}`;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count > 1) name = `${name} ${count}`;
    return {
      name,
      params: Array.from({ length: PAGE_SIZE }, (_, i) => page[i]?.id),
      labels: Array.from({ length: PAGE_SIZE }, (_, i) => {
        const slot = page[i];
        return slot?.id === undefined ? undefined : slot.name || undefined;
      }),
      sections: Array.from({ length: PAGE_SIZE }, (_, i) => page[i]?.section || undefined),
    };
  });
}

interface Decision {
  match: NksLookupResult | undefined;
  evaluation: Evaluation | undefined;
  pages: PluginPage[] | undefined;
}

const percent = (share: number): string => `${Math.floor(share * 100)} %`;

/**
 * Pages from NKS data for the selected channel's plugin when the product's default mapping fits
 * what FL reports (every parameter exists and has a name, and the names agree); otherwise the
 * fallback source's pages.
 */
export class NksPageSource implements PageSource {
  /** Last decision per `${channel}:${name}:${paramCount}`, to log only changes. */
  private readonly logged = new Map<string, string>();
  private memo: { key: string; match: NksLookupResult | undefined; decision: Decision } | undefined;

  constructor(
    private readonly lookup: NksLookup,
    private readonly fallback: PageSource = new FlParamPages(),
    private readonly log: (line: string) => void = (line) => console.log(line),
  ) {}

  pages(fl: FlState): PluginPage[] {
    return this.decide(fl)?.pages ?? this.fallback.pages(fl);
  }

  header(fl: FlState): { logo?: string; color?: string } | undefined {
    const decision = this.decide(fl);
    if (!decision?.pages || !decision.match) return undefined;
    const { logo, color } = decision.match.product;
    if (logo === undefined && color === undefined) return undefined;
    return { ...(logo !== undefined ? { logo } : {}), ...(color !== undefined ? { color } : {}) };
  }

  /** The decision for the plugin FL reports now; undefined without a plugin. */
  private decide(fl: FlState): Decision | undefined {
    const { plugin } = fl;
    if (!plugin.valid || plugin.channel === null || plugin.name === "") return undefined;
    const key = `${plugin.channel}:${plugin.name}:${plugin.paramCount}`;
    const match = this.lookup.ready ? this.lookup.lookup(plugin.name) : undefined;
    // The decision depends on the names FL has sent so far, which arrive in frames.
    const memoKey = `${key}:${fl.paramNames.size}`;
    if (this.memo?.key === memoKey && this.memo.match === match) return this.memo.decision;

    const decision: Decision = { match, evaluation: undefined, pages: undefined };
    if (match && match.product.defaultMapping.length > 0) {
      decision.evaluation = evaluate(match.product.defaultMapping, fl);
      if (decision.evaluation.use) decision.pages = toPluginPages(match.product.defaultMapping);
    }
    this.memo = { key: memoKey, match, decision };
    if (fl.paramNames.size > 0) this.report(key, plugin.name, decision, match);
    return decision;
  }

  private report(
    key: string,
    name: string,
    decision: Decision,
    match: NksLookupResult | undefined,
  ) {
    const { evaluation } = decision;
    let kind: string;
    let line: string;
    if (decision.pages && match && evaluation) {
      const { product } = match;
      kind = `nks:${product.vendor}|${product.name}`;
      line =
        `NKS: ${name} → ${product.vendor} ${product.name} via ${match.via}, ` +
        `${decision.pages.length} pages (coverage ${percent(evaluation.coverage)}, ` +
        `agreement ${percent(evaluation.agreement)})`;
    } else if (!evaluation) {
      kind = "fallback:none";
      line = `NKS: ${name} → FL parameters (no NKS data)`;
    } else if (evaluation.coverage < 1) {
      kind = "fallback:coverage";
      const missing =
        evaluation.firstMissing === undefined
          ? ""
          : `, first missing id ${evaluation.firstMissing}`;
      line = `NKS: ${name} → FL parameters (coverage ${percent(evaluation.coverage)}${missing})`;
    } else {
      kind = "fallback:agreement";
      line = `NKS: ${name} → FL parameters (agreement ${percent(evaluation.agreement)})`;
    }
    if (this.logged.get(key) === kind) return;
    this.logged.set(key, kind);
    this.log(line);
  }
}
