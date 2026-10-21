// Parses one NKS preset file (.nksf / .nksfx): preset info, controller pages and plugin ID.
import { decodeMsgpack } from "./msgpack.js";
import { readChunks } from "./riff.js";
import type { NksPage, NksSlot, Plid } from "./types.js";

/** Slots per page. */
const SLOTS = 8;

/** What the NISI chunk says about the preset. */
export interface NksInfo {
  /** NISI `vendor`. */
  vendor: string;
  /** `bankchain[0]`: the product, e.g. "Diva". */
  product: string;
  /** The preset's own name. */
  name: string;
}

export interface ParsedNks {
  info: NksInfo;
  pages: NksPage[];
  plid: Plid;
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/** Chunk body: `u32le version` + one msgpack value. */
function chunkValue(body: Buffer): unknown {
  if (body.length < 4) throw new Error("chunk too short");
  return decodeMsgpack(body.subarray(4));
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parseInfo(body: Buffer): NksInfo {
  const v = chunkValue(body);
  if (!isDict(v)) throw new Error("NISI is not a map");
  const chain = Array.isArray(v["bankchain"]) ? v["bankchain"] : [];
  return { vendor: str(v["vendor"]), product: str(chain[0]), name: str(v["name"]) };
}

function parseSlot(raw: unknown): NksSlot {
  if (!isDict(raw)) return { name: "" };
  const section = raw["section"];
  const id = raw["id"];
  const hasId = typeof id === "number" && Number.isInteger(id);
  const rawName = str(raw["name"]);
  const unnamed = !hasId || /^(unassigned|unset)$/i.test(rawName.trim());
  const slot: NksSlot = { name: unnamed ? "" : rawName };
  if (hasId) slot.id = id;
  if (typeof section === "string" && section !== "") slot.section = section;
  return slot;
}

function parsePages(body: Buffer): NksPage[] {
  const v = chunkValue(body);
  const pages = isDict(v) ? v["ni8"] : undefined;
  if (!Array.isArray(pages)) throw new Error("NICA has no ni8 pages");
  return pages.map((raw): NksPage => {
    const slots = Array.isArray(raw) ? raw.slice(0, SLOTS) : [];
    while (slots.length < SLOTS) slots.push(undefined);
    return slots.map(parseSlot);
  });
}

function hex32(uid: unknown): string | undefined {
  if (!Array.isArray(uid) || uid.length !== 4) return undefined;
  let out = "";
  for (const part of uid) {
    if (typeof part !== "number" || !Number.isInteger(part) || part < 0 || part > 0xffffffff) {
      return undefined;
    }
    out += part.toString(16).toUpperCase().padStart(8, "0");
  }
  return out;
}

function parsePlid(body: Buffer): Plid {
  const v = chunkValue(body);
  const plid: Plid = {};
  if (!isDict(v)) return plid;
  const magic = v["VST.magic"];
  if (typeof magic === "number" && magic !== 0) plid.vst2 = magic;
  const vst3 = hex32(v["VST3.uid"]);
  if (vst3 !== undefined) plid.vst3 = vst3;
  if (typeof v["pluginName"] === "string" && v["pluginName"] !== "") plid.name = v["pluginName"];
  if (typeof v["pluginVendor"] === "string" && v["pluginVendor"] !== "") {
    plid.vendor = v["pluginVendor"];
  }
  return plid;
}

/**
 * Read an NKS preset file. Needs the NISI and NICA chunks (throws without them or on malformed
 * data); a missing PLID gives an empty `plid`. Unknown chunks and keys are ignored, every page is
 * padded or trimmed to 8 slots.
 */
export function parseNksFile(buf: Buffer): ParsedNks {
  const chunks = readChunks(buf);
  const nisi = chunks.get("NISI");
  const nica = chunks.get("NICA");
  if (nisi === undefined) throw new Error("no NISI chunk");
  if (nica === undefined) throw new Error("no NICA chunk");
  const plid = chunks.get("PLID");
  return {
    info: parseInfo(nisi),
    pages: parsePages(nica),
    plid: plid === undefined ? {} : parsePlid(plid),
  };
}
