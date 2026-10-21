import { describe, expect, it } from "vitest";
import { FlState } from "../src/fl/flState.js";
import { FlParamPages } from "../src/modes/pluginPages.js";
import { AGREEMENT_THRESHOLD, NksPageSource } from "../src/nks/nksPages.js";
import type { NksLookup, NksLookupResult, NksPage, NksProduct, NksSlot } from "../src/nks/types.js";

const slot = (id: number | undefined, name: string, section?: string): NksSlot => ({
  id,
  name: id === undefined ? "" : name,
  ...(section !== undefined ? { section } : {}),
});

/** Pad to 8 slots with unassigned ones. */
const page = (...slots: NksSlot[]): NksPage => [
  ...slots,
  ...Array.from({ length: 8 - slots.length }, () => slot(undefined, "")),
];

function product(defaultMapping: NksPage[], extra: Partial<NksProduct> = {}): NksProduct {
  return {
    vendor: "u-he",
    name: "Diva",
    plids: [],
    defaultMapping,
    presets: 10,
    mappings: 2,
    ...extra,
  };
}

function fakeLookup(
  result: NksLookupResult | undefined,
  state: { ready: boolean } = { ready: true },
): NksLookup {
  return {
    get ready() {
      return state.ready;
    },
    lookup: () => result,
  };
}

/** FL with a plugin on channel 2 and these parameter names. */
function flWith(names: Record<number, string>, paramCount = 300, name = "Diva"): FlState {
  const fl = new FlState();
  fl.apply({ type: "plugin", channel: 2, valid: true, paramCount, name });
  const entries = Object.entries(names).map(([id, text]) => [Number(id), text] as const);
  for (const [id, text] of entries) {
    fl.apply({
      type: "paramNames",
      offset: id,
      names: [text],
    });
  }
  return fl;
}

const FL_NAMES = {
  10: "Filter: Cutoff",
  11: "Filter: Reso",
  12: "AmpEnv: Attack",
  13: "AmpEnv: Release",
  20: "VCF1: Resonance",
  21: "Osc: Wave",
};

/** FL_NAMES without one id. */
const without = (id: number): Record<number, string> =>
  Object.fromEntries(Object.entries(FL_NAMES).filter(([key]) => Number(key) !== id));

const MAPPING: NksPage[] = [
  page(
    slot(10, "Cutoff", "Filter"),
    slot(11, "Reso"),
    slot(12, "Attack", "Amp"),
    slot(13, "Release"),
    slot(20, "Res", "Filter 1"),
    slot(21, "Wave"),
  ),
  page(slot(10, "Cutoff"), slot(11, "Reso"), slot(undefined, "", "Orphan")),
];

const result = (p: NksProduct = product(MAPPING), via: NksLookupResult["via"] = "vst2") => ({
  product: p,
  via,
});

describe("NksPageSource decision", () => {
  const fallback = new FlParamPages();

  const use = (fl: FlState, p = product(MAPPING)) => {
    const lines: string[] = [];
    const source = new NksPageSource(fakeLookup(result(p)), fallback, (line) => lines.push(line));
    return { source, lines, pages: source.pages(fl) };
  };

  it("falls back without a plugin, while the index is not ready, and without a match", () => {
    const fl = flWith(FL_NAMES);
    const expected = fallback.pages(fl);
    expect(expected.length).toBeGreaterThan(0);

    const none = new NksPageSource(fakeLookup(undefined), fallback, () => {});
    expect(none.pages(fl)).toEqual(expected);
    expect(none.header(fl)).toBeUndefined();

    const loading = new NksPageSource(fakeLookup(result(), { ready: false }), fallback, () => {});
    expect(loading.pages(fl)).toEqual(expected);
    expect(loading.header(fl)).toBeUndefined();

    const bare = new NksPageSource(fakeLookup(result()), fallback, () => {});
    expect(bare.pages(new FlState())).toEqual([]);
    expect(bare.header(new FlState())).toBeUndefined();
  });

  it("falls back when an assigned parameter is missing, unnamed or out of range", () => {
    const withoutTwenty = without(20);
    expect(use(flWith(withoutTwenty)).pages).toEqual(fallback.pages(flWith(withoutTwenty)));
    expect(use(flWith({ ...FL_NAMES, 20: "  " })).pages).toEqual(
      fallback.pages(flWith({ ...FL_NAMES, 20: "  " })),
    );
    // id 21 is not below paramCount
    expect(use(flWith(FL_NAMES, 21)).pages).toEqual(fallback.pages(flWith(FL_NAMES, 21)));
  });

  it("falls back when the names disagree, and uses NKS at the threshold", () => {
    expect(AGREEMENT_THRESHOLD).toBe(0.5);
    const names = Object.fromEntries(Object.keys(FL_NAMES).map((id) => [id, `Zzz: Param ${id}`]));
    const fl = flWith(names);
    expect(use(fl).pages).toEqual(fallback.pages(fl));

    // 2 countable slots: one agrees, one does not → 50 %
    const half = product([page(slot(10, "Cutoff"), slot(11, "Volume"))]);
    const halfFl = flWith({ 10: "Filter: Cutoff", 11: "Other: Thing" });
    expect(use(halfFl, half).pages).toHaveLength(1);
    // 1 of 3 → 33 %
    const third = product([page(slot(10, "Cutoff"), slot(11, "Volume"), slot(12, "Pitch"))]);
    const thirdFl = flWith({ 10: "Filter: Cutoff", 11: "Other: A", 12: "Other: B" });
    expect(use(thirdFl, third).pages).toEqual(fallback.pages(thirdFl));
  });

  it("converts NKS pages: params, labels, sections and tab names", () => {
    const fl = flWith(FL_NAMES);
    const { pages } = use(fl);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual({
      name: "Filter",
      params: [10, 11, 12, 13, 20, 21, undefined, undefined],
      labels: ["Cutoff", "Reso", "Attack", "Release", "Res", "Wave", undefined, undefined],
      sections: [
        "Filter",
        undefined,
        "Amp",
        undefined,
        "Filter 1",
        undefined,
        undefined,
        undefined,
      ],
    });
    // a section on an unassigned slot still names the page and is kept
    expect(pages[1]?.name).toBe("Orphan");
    expect(pages[1]?.sections?.[2]).toBe("Orphan");
    expect(pages[1]?.params[2]).toBeUndefined();
    expect(pages[1]?.labels?.[2]).toBeUndefined();
  });

  it("names pages without a section Page n and numbers repeated names", () => {
    const names = {
      10: "Filter: Cutoff",
      11: "Filter: Reso",
      12: "Filter: Gain",
      13: "Filter: Pan",
    };
    const mapping = [
      page(slot(10, "Cutoff", "Filter")),
      page(slot(11, "Reso")),
      page(slot(12, "Cutoff", "Filter")),
      page(slot(13, "Cutoff", "Filter")),
    ];
    const { pages } = use(flWith(names), product(mapping));
    expect(pages.map((p) => p.name)).toEqual(["Filter", "Page 2", "Filter 2", "Filter 3"]);
  });

  it("counts words of 3+ letters, split at case changes, with inherited sections", () => {
    // "AmpEnv" → amp, env; "VCF1: Resonance" → vcf1, resonance; "LP" / "2" do not count.
    const mapping = [
      page(
        slot(1, "AmpEnv"),
        slot(2, "LP 2"),
        slot(3, "x", "VCF1: Resonance"),
        slot(4, "y"), // inherits "VCF1: Resonance"
      ),
    ];
    const flNames = { 1: "Env2: Attack", 2: "Totally different", 3: "Resonance", 4: "Other" };
    const lines: string[] = [];
    const source = new NksPageSource(fakeLookup(result(product(mapping))), fallback, (l) =>
      lines.push(l),
    );
    // slot 2 does not count; slots 1 (env), 3 (resonance) agree; slot 4 inherits resonance
    // but FL's "Other" has no such word → 3 of 4 countable... slot 1,3 agree, 4 not = 2/3
    const pages = source.pages(flWith(flNames));
    expect(pages).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("agreement 66 %");
  });

  it("counts no slots as full agreement", () => {
    const mapping = [page(slot(1, "LP"), slot(2, ""))];
    const { pages } = use(flWith({ 1: "Whatever", 2: "Else" }), product(mapping));
    expect(pages).toHaveLength(1);
  });

  it("does not use an empty mapping", () => {
    const fl = flWith(FL_NAMES);
    expect(use(fl, product([])).pages).toEqual(fallback.pages(fl));
    expect(use(fl, product([page(slot(undefined, ""))])).pages).toEqual(fallback.pages(fl));
  });

  it("logs once per decision change", () => {
    const state = { ready: false };
    const lines: string[] = [];
    const source = new NksPageSource(fakeLookup(result(), state), fallback, (l) => lines.push(l));
    const fl = flWith(FL_NAMES);
    source.pages(fl);
    source.pages(fl);
    expect(lines).toEqual(["NKS: Diva → FL parameters (no NKS data)"]);
    state.ready = true;
    source.pages(fl);
    source.pages(fl);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "NKS: Diva → u-he Diva via vst2, 2 pages (coverage 100 %, agreement 100 %)",
    );
    source.header(fl);
    expect(lines).toHaveLength(2);
  });

  it("logs the coverage failure with the first missing id", () => {
    const rest = without(20);
    const { lines } = use(flWith(rest));
    expect(lines).toEqual(["NKS: Diva → FL parameters (coverage 87 %, first missing id 20)"]);
  });

  it("does not log before FL has sent any names", () => {
    const { lines } = use(flWith({}));
    expect(lines).toEqual([]);
  });

  it("logs a flip from fallback to NKS as the names arrive", () => {
    const lines: string[] = [];
    const source = new NksPageSource(fakeLookup(result()), fallback, (l) => lines.push(l));
    const fl = flWith({ 10: FL_NAMES[10] });
    source.pages(fl);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/coverage 25 %/);
    for (const [id, name] of Object.entries(FL_NAMES)) {
      fl.apply({ type: "paramNames", offset: Number(id), names: [name] });
      source.pages(fl);
    }
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("via vst2");
  });
});

describe("NksPageSource header", () => {
  const fl = flWith(FL_NAMES);
  const header = (p: NksProduct, f = fl) =>
    new NksPageSource(fakeLookup(result(p)), new FlParamPages(), () => {}).header(f);

  it("gives the product's logo and color when NKS pages are in use", () => {
    expect(header(product(MAPPING, { logo: "/x/MST_logo.png", color: "#EB4747" }))).toEqual({
      logo: "/x/MST_logo.png",
      color: "#EB4747",
    });
    expect(header(product(MAPPING, { color: "#EB4747" }))).toEqual({ color: "#EB4747" });
    expect(header(product(MAPPING))).toBeUndefined();
  });

  it("gives nothing when the fallback is in use", () => {
    const names = Object.fromEntries(Object.keys(FL_NAMES).map((id) => [id, `Zzz: ${id}`]));
    expect(header(product(MAPPING, { color: "#EB4747" }), flWith(names))).toBeUndefined();
  });
});
