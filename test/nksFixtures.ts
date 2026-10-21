// Builders for synthetic NKS fixtures: a tiny msgpack encoder, a RIFF writer and an .nksf builder.
import type { Plid } from "../src/nks/types.js";

/** Force float64 encoding of a number. */
export class F64 {
  constructor(readonly value: number) {}
}

/** Encode `v` as MessagePack (ints in the smallest width, str8/str16, bin8, map/array up to 65535). */
export function encodeMsgpack(v: unknown): Buffer {
  if (v === null || v === undefined) return Buffer.from([0xc0]);
  if (v === true) return Buffer.from([0xc3]);
  if (v === false) return Buffer.from([0xc2]);
  if (v instanceof F64) {
    const b = Buffer.alloc(9);
    b[0] = 0xcb;
    b.writeDoubleBE(v.value, 1);
    return b;
  }
  if (typeof v === "number") {
    if (v >= 0 && v <= 0x7f) return Buffer.from([v]);
    if (v < 0 && v >= -32) return Buffer.from([v & 0xff]);
    if (v >= 0 && v <= 0xff) return Buffer.from([0xcc, v]);
    if (v >= 0 && v <= 0xffff) return Buffer.from([0xcd, v >> 8, v & 0xff]);
    if (v >= 0 && v <= 0xffffffff) {
      const b = Buffer.alloc(5);
      b[0] = 0xce;
      b.writeUInt32BE(v, 1);
      return b;
    }
    const b = Buffer.alloc(9);
    b[0] = 0xd3;
    b.writeBigInt64BE(BigInt(v), 1);
    return b;
  }
  if (typeof v === "string") {
    const body = Buffer.from(v, "utf8");
    const head =
      body.length < 32
        ? Buffer.from([0xa0 | body.length])
        : body.length < 256
          ? Buffer.from([0xd9, body.length])
          : Buffer.from([0xda, body.length >> 8, body.length & 0xff]);
    return Buffer.concat([head, body]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from([0xc4, v.length]), v]);
  const count = (n: number, fix: number, wide: number): Buffer =>
    n < 16 ? Buffer.from([fix | n]) : Buffer.from([wide, n >> 8, n & 0xff]);
  if (Array.isArray(v))
    return Buffer.concat([count(v.length, 0x90, 0xdc), ...v.map(encodeMsgpack)]);
  const entries = Object.entries(v as Record<string, unknown>);
  return Buffer.concat([
    count(entries.length, 0x80, 0xde),
    ...entries.flatMap(([k, val]) => [encodeMsgpack(k), encodeMsgpack(val)]),
  ]);
}

/** A RIFF "NIKS" file: chunks in the given order, each padded to an even size. */
export function riffFile(chunks: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const parts: Buffer[] = [Buffer.from("NIKS", "latin1")];
  for (const [id, body] of chunks) {
    const head = Buffer.alloc(8);
    head.write(id, 0, "latin1");
    head.writeUInt32LE(body.length, 4);
    parts.push(head, body);
    if (body.length & 1) parts.push(Buffer.alloc(1));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** A chunk body: `u32le version` (1) + one msgpack value. */
export const versioned = (v: unknown): Buffer => {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(1, 0);
  return Buffer.concat([head, encodeMsgpack(v)]);
};

export type SlotSpec = { id?: number; name?: string; section?: string; [k: string]: unknown };

export interface NksfSpec {
  vendor?: string;
  product?: string;
  preset?: string;
  /** Pages as NICA slot maps (any length; the file keeps them as given). */
  pages?: SlotSpec[][];
  /** PLID as the msgpack map; use `plidVst2` / `plidVst3` for the common forms. */
  plid?: Record<string, unknown>;
  /** Extra chunks written between the standard ones. */
  extra?: ReadonlyArray<readonly [string, Buffer]>;
}

export const plidVst2 = (magic: number): Record<string, unknown> => ({ "VST.magic": magic });

export const plidVst3 = (
  uid: [number, number, number, number],
  name: string,
  vendor: string,
): Record<string, unknown> => ({
  "VST.magic": 0,
  "VST3.uid": uid,
  pluginName: name,
  pluginVendor: vendor,
});

/** A synthetic .nksf: NISI, an unknown chunk, NICA, PLID, PCHK. */
export function nksf(spec: NksfSpec = {}): Buffer {
  const nisi = {
    name: spec.preset ?? "Preset",
    vendor: spec.vendor ?? "Acme",
    bankchain: [spec.product ?? "Synth", "Bank", ""],
    author: "nobody",
  };
  return riffFile([
    ["NISI", versioned(nisi)],
    ["XXXX", Buffer.from([1, 2, 3])],
    ["NICA", versioned({ ni8: spec.pages ?? [] })],
    ["PLID", versioned(spec.plid ?? plidVst2(0x41424344))],
    ...(spec.extra ?? []),
    ["PCHK", Buffer.from("state blob")],
  ]);
}

/** An `.nfo` file as FL writes it (with a BOM), one entry per element. */
export function nfoText(
  name: string,
  entries: ReadonlyArray<{
    plugClass: number;
    magic?: number;
    guid?: string;
    compat?: string[];
    vendor?: string;
  }>,
): string {
  const lines = ["﻿fileversion=2", `ps_name=${name}`, `ps_files=${entries.length}`];
  entries.forEach((e, i) => {
    lines.push(`ps_file_name_${i}=${name}`, `ps_file_plugclass_${i}=${e.plugClass}`);
    if (e.magic !== undefined) lines.push(`ps_file_magic_${i}=${e.magic}`);
    if (e.guid !== undefined) lines.push(`ps_file_guid_${i}=${e.guid}`);
    if (e.vendor !== undefined) lines.push(`ps_file_vendorname_${i}=${e.vendor}`);
    if (e.compat !== undefined) lines.push(`ps_compatibility_${i}=${e.compat.join(",")}`);
  });
  return lines.join("\r\n") + "\r\n";
}

export type { Plid };
