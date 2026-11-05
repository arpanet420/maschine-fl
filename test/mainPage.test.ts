import { describe, expect, it } from "vitest";
import { mainPage } from "../src/modes/mainPage.js";

// Excerpts of what FL reported for these plugins (MK3D_PARAM_DUMP=1, 2026-11-05), distractors kept.
const names = (entries: Record<number, string>) =>
  new Map(Object.entries(entries).map(([index, name]) => [Number(index), name]));

const ATOMIKA = names({
  0: "Echo - Off",
  4: "Reverb - Off",
  17: "Filter - Attack",
  18: "Filter - Decay",
  19: "Filter - Sustain",
  20: "Filter - Release",
  21: "Amp - Attack",
  22: "Amp - Decay",
  41: "Filter - Cutoff",
  42: "Filter - Resonance",
  43: "Filter - Keyboard Tracking",
  44: "Filter - Envelope Generator Mode",
  45: "Amp - Sustain",
  46: "Amp - Release",
  51: "Reverb - Decay",
  90: "Filter - Envelope Generator Dept",
  92: "Filter - Mod Depth",
  176: "MIDI CC #72 (Release time)",
  177: "MIDI CC #73 (Attack time)",
});

const TAL_PHA = names({
  2: "VCF Env. Mode",
  10: "HPF Cutoff",
  13: "DCO ENV Mod",
  17: "VCF Cutoff",
  18: "VCF Resonance",
  19: "VCF LFO Mod",
  20: "VCF ENV Mod",
  21: "VCF Key Follow",
  27: "Attack Time",
  28: "Attack Level",
  29: "Break Time",
  31: "Decay Time",
  32: "Sustain Level",
  33: "Release Time",
  34: "ENV Key Follow",
  51: "Resonance Boost",
});

// Flat names, two envelopes: the vendor's NKS page one has the first (60 61 63 62 / 22 23 24 25).
const REPRO_5 = names({
  7: "Frequency",
  22: "Attack",
  23: "Decay",
  24: "Sustain",
  25: "Release",
  26: "Attack",
  27: "Decay",
  28: "Sustain",
  29: "Release",
  53: "Filter Env Amount",
  59: "Key Tracking Source",
  60: "Cutoff",
  61: "Resonance",
  62: "Keyboard Amount",
  63: "Envelope Amount",
  90: "Bass Vol (Res)",
  97: "Q/Resonance",
  100: "Decay",
});

// Its NKS page one: 248 249 251 250 / 209 210 211 212.
const REPRO_1 = names({
  209: "FEnv/Attack",
  210: "FEnv/Decay",
  211: "FEnv/Sustain",
  212: "FEnv/Release",
  213: "AEnv/Attack",
  214: "AEnv/Decay",
  215: "AEnv/Sustain",
  216: "AEnv/Release",
  239: "Mod/Filter Env Amount",
  247: "Filter/Key Tracking Source",
  248: "Filter/Cutoff",
  249: "Filter/Resonance",
  250: "Filter/Keyboard Amount",
  251: "Filter/Envelope Amount",
  260: "Jaws/Fold Mod Attack",
  261: "Jaws/Fold Mod Release",
  287: "Filter/Envelope Polarity",
});

const DIVA = names({
  21: "OPT: CutoffSlop",
  33: "ENV1: Attack",
  34: "ENV1: Decay",
  35: "ENV1: Sustain",
  36: "ENV1: Release",
  43: "ENV1: KeyFollow",
  140: "HPF: Frequency",
  141: "HPF: Resonance",
  143: "HPF: KeyFollow",
  148: "VCF1: Frequency",
  149: "VCF1: Resonance",
  150: "VCF1: FreqModSrc",
  151: "VCF1: FreqModDepth",
  154: "VCF1: KeyFollow",
  176: "Scope1: Frequency",
});

// Each knob is followed by its own LFO and envelope (15 parameters), so the stages lie 15 apart.
const OB_1 = names({
  264: "Keyboard Tracking",
  265: "VCF Frequency",
  273: "VCF Frequency Env Attack",
  274: "VCF Frequency Env Decay",
  277: "VCF Frequency Env Release",
  295: "VCF Resonance",
  310: "VCF Env Mod",
  342: "VCA Attack",
  350: "VCA Attack Env Attack",
  351: "VCA Attack Env Decay",
  354: "VCA Attack Env Release",
  357: "VCA Decay",
  372: "VCA Sustain",
  387: "VCA Release",
  402: "VCF Attack",
  417: "VCF Decay",
  432: "VCF Sustain",
  447: "VCF Release",
  748: "HPF Frequency",
});

describe("mainPage", () => {
  it("puts Atomika's filter and its envelope on page one", () => {
    const page = mainPage(ATOMIKA);
    expect(page?.params).toEqual([41, 42, 90, 43, 17, 18, 19, 20]);
    expect(page?.name).toBe("Main");
    expect(page?.labels).toEqual([
      "Cutoff",
      "Reso",
      "Env Amt",
      "Key Amt",
      "Attack",
      "Decay",
      "Sustain",
      "Release",
    ]);
    expect(page?.sections).toEqual([
      "Filter",
      undefined,
      undefined,
      undefined,
      "Filter Env",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("leaves out the high-pass filter and the envelope's levels", () => {
    expect(mainPage(TAL_PHA)?.params).toEqual([17, 18, 20, 21, 27, 31, 32, 33]);
    expect(mainPage(TAL_PHA)?.sections?.[4]).toBe("Envelope");
  });

  it("finds what the vendors' NKS page one has, in flat and grouped names", () => {
    expect(mainPage(REPRO_5)?.params).toEqual([60, 61, 63, 62, 22, 23, 24, 25]);
    expect(mainPage(REPRO_1)?.params).toEqual([248, 249, 251, 250, 209, 210, 211, 212]);
  });

  it("finds an envelope whose stages lie far apart, and not a stage's own envelope", () => {
    expect(mainPage(OB_1)?.params).toEqual([265, 295, 310, 264, 402, 417, 432, 447]);
    expect(mainPage(OB_1)?.sections?.[4]).toBe("Filter Env");
  });

  it("leaves a knob empty when nothing fits", () => {
    // Diva routes its filter envelope through a modulation slot; its NKS pages are used anyway.
    expect(mainPage(DIVA)?.params).toEqual([148, 149, undefined, 154, 33, 34, 35, 36]);
  });

  it("makes no page from names that say nothing", () => {
    expect(
      mainPage(names({ 0: "Parameter 1", 1: "Parameter 2", 2: "Parameter 3" })),
    ).toBeUndefined();
    expect(mainPage(names({ 0: "Cutoff", 1: "Resonance" }))).toBeUndefined();
    expect(mainPage(new Map())).toBeUndefined();
  });
});
