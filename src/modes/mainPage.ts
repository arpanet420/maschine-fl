// PLUG-IN's page one for a plugin without NKS pages: the filter on the left screen (Cutoff, Reso, Env Amt,
// Key Amt) and an envelope on the right (Attack, Decay, Sustain, Release), found by parameter name. It is the
// layout the vendors' own NKS page one has for Diva, Repro-1 and Repro-5. The envelope is the filter's when a
// name says so, else the first complete one. The names it was worked out from (out/params, MK3D_PARAM_DUMP=1):
// "Filter - Cutoff" (Atomika), "VCF Cutoff" (TAL-Pha), "Filter/Cutoff" (Repro-1), "Cutoff" (Repro-5), "VCF1:
// Frequency" (Diva).
import type { PluginPage } from "./pluginPages.js";

export const MAIN_PAGE_NAME = "Main";
/** Fewer knobs found than this: no page one (a guess that thin helps no one). */
const MIN_FOUND = 3;
/** An envelope's stages lie at most this far after its attack. */
const STAGE_SPAN = 16;

interface Param {
  index: number;
  /** The part before ": ", " - " or "/", lower case; "" when there is none. */
  group: string;
  words: string[];
}

const SEPARATORS = [/^(.*?):\s+(.*)$/, /^(.*?)\s+-\s*(.*)$/, /^([^/]*)\/(.*)$/];

function parse(index: number, name: string): Param | undefined {
  const text = name.trim();
  if (text === "" || /^midi (cc|channel)\b/i.test(text)) return undefined; // FL's MIDI CC stand-ins
  let group = "";
  for (const separator of SEPARATORS) {
    const match = separator.exec(text);
    if (match?.[1] && match[2]) {
      group = match[1].trim().toLowerCase();
      break;
    }
  }
  return {
    index,
    group,
    words: text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  };
}

const has = (param: Param, ...words: string[]) => words.some((word) => param.words.includes(word));

const HIGH_PASS = ["hpf", "hp", "highpass", "hipass"];
const FILTER = ["filter", "filt", "flt", "vcf", "vcf1", "lpf", "lp", "lowpass", "filter1"];
const ENVELOPE = ["env", "envelope", "eg", "fenv", "env2"];
const NOT_A_KNOB = [
  "mode",
  "source",
  "src",
  "route",
  "polarity",
  "select",
  "type",
  "slop",
  "model",
  "trigger",
];
const NOT_A_KNOB_2 = [
  "velocity",
  "vel",
  "aftertouch",
  "after",
  "sync",
  "on",
  "off",
  "curve",
  "quantise",
];

const isFilter = (param: Param) =>
  !has(param, ...HIGH_PASS) && (has(param, ...FILTER) || param.words.includes("cutoff"));
const plain = (param: Param) => !has(param, ...NOT_A_KNOB, ...NOT_A_KNOB_2);

function isCutoff(param: Param): boolean {
  if (
    has(param, ...HIGH_PASS) ||
    !plain(param) ||
    has(param, "lfo", "mod", "depth", "amount", "amt", "key")
  )
    return false;
  if (has(param, ...ENVELOPE)) return false;
  return has(param, "cutoff") || (isFilter(param) && has(param, "freq", "frequency"));
}

function isResonance(param: Param): boolean {
  if (
    has(param, ...HIGH_PASS) ||
    !plain(param) ||
    has(param, "boost", "bass", "vol", "mod", "depth", "amount")
  )
    return false;
  return has(param, "reso", "resonance", "res", "emphasis") || (isFilter(param) && has(param, "q"));
}

function isEnvAmount(param: Param): boolean {
  if (!plain(param) || has(param, "dco", "osc", "pitch", "pwm", "vca", "amp", "lfo", "key"))
    return false;
  return (
    has(param, ...ENVELOPE) &&
    has(param, "amount", "amt", "mod", "depth", "dept", "int", "intensity")
  );
}

function isKeyAmount(param: Param): boolean {
  if (has(param, ...HIGH_PASS) || !plain(param) || has(param, ...ENVELOPE, "pitched")) return false;
  if (has(param, "keyfollow", "keytrack", "kbdtrack", "keytracking")) return true;
  return (
    has(param, "key", "keyboard", "kbd", "kybd") &&
    has(param, "follow", "track", "tracking", "amount", "amt")
  );
}

const STAGES = [
  ["attack", "att", "atk"],
  ["decay", "dec"],
  ["sustain", "sus"],
  ["release", "rel"],
] as const;
const STAGE_FILLER = ["time", "level", "rate"];

/** Which stage a parameter is (0–3), and the rest of its name, to pair it with its envelope's other stages. */
function stage(param: Param): { stage: number; stem: string } | undefined {
  if (!plain(param) || has(param, "mod", "depth", "amount", "fold", "jaws")) return undefined;
  const at = STAGES.findIndex((words) => has(param, ...words));
  if (at < 0) return undefined;
  if (at !== 2 && has(param, "level")) return undefined; // "Attack Level" beside "Attack Time"
  const stageWords: readonly string[] = STAGES[at] ?? [];
  const stem = param.words
    .filter((word) => !stageWords.includes(word) && !STAGE_FILLER.includes(word))
    .join(" ");
  return { stage: at, stem };
}

interface Envelope {
  params: number[];
  filter: boolean;
}

/** Complete envelopes (all four stages, the same stem, close after the attack), in index order. */
function envelopes(params: Param[]): Envelope[] {
  const staged = params.flatMap((param) => {
    const found = stage(param);
    return found ? [{ param, ...found }] : [];
  });
  const found: Envelope[] = [];
  for (const attack of staged.filter((entry) => entry.stage === 0)) {
    const rest = [1, 2, 3].map((want) =>
      staged.find(
        (entry) =>
          entry.stage === want &&
          entry.stem === attack.stem &&
          entry.param.index > attack.param.index &&
          entry.param.index <= attack.param.index + STAGE_SPAN,
      ),
    );
    if (rest.some((entry) => entry === undefined)) continue;
    const words = attack.stem.split(" ");
    found.push({
      params: [attack.param.index, ...rest.map((entry) => entry?.param.index ?? 0)],
      filter: words.some((word) => [...FILTER, "fenv", "f", "vcf"].includes(word)),
    });
  }
  return found;
}

/** The parameter nearest `anchor`, one in its group first; undefined when none fits. */
function nearest(
  params: Param[],
  fits: (param: Param) => boolean,
  anchor: Param | undefined,
  used: Set<number>,
) {
  const score = (param: Param) =>
    anchor === undefined
      ? param.index
      : (param.group === anchor.group ? 0 : 100_000) + Math.abs(param.index - anchor.index);
  return params
    .filter((param) => !used.has(param.index) && fits(param))
    .sort((a, b) => score(a) - score(b) || a.index - b.index)[0];
}

/** Page one from the plugin's parameter names, or undefined when too little of it is there. */
export function mainPage(names: ReadonlyMap<number, string>): PluginPage | undefined {
  const params = [...names]
    .sort(([a], [b]) => a - b)
    .flatMap(([index, name]) => parse(index, name) ?? []);
  const used = new Set<number>();
  const cutoffs = params.filter(isCutoff);
  const cutoff = cutoffs.find(isFilter) ?? cutoffs[0];
  if (cutoff) used.add(cutoff.index);
  const filter = [cutoff];
  for (const fits of [isResonance, isEnvAmount, isKeyAmount]) {
    const found = nearest(params, fits, cutoff, used);
    if (found) used.add(found.index);
    filter.push(found);
  }
  const found = envelopes(params);
  const envelope = found.find((entry) => entry.filter) ?? found[0];
  const slots = [
    ...filter.map((param) => param?.index),
    ...(envelope?.params ?? [undefined, undefined, undefined, undefined]),
  ];
  if (slots.filter((slot) => slot !== undefined).length < MIN_FOUND) return undefined;
  return {
    name: MAIN_PAGE_NAME,
    params: slots,
    labels: ["Cutoff", "Reso", "Env Amt", "Key Amt", "Attack", "Decay", "Sustain", "Release"],
    sections: [
      filter.some(Boolean) ? "Filter" : undefined,
      undefined,
      undefined,
      undefined,
      envelope ? (envelope.filter ? "Filter Env" : "Envelope") : undefined,
      undefined,
      undefined,
      undefined,
    ],
  };
}
