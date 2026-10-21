// A small MessagePack decoder for NKS chunk bodies (docs/nks.md). Only decoding; no dependency.

const MAX_DEPTH = 64;

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error("msgpack: truncated data");
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  take(n: number): Buffer {
    this.need(n);
    const view = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return view;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
}

/** A 64-bit integer as a number when it is exactly representable, else a bigint. */
function wide(v: bigint): number | bigint {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v;
}

function readStr(r: Reader, len: number): string {
  return r.take(len).toString("utf8");
}

function readArray(r: Reader, len: number, depth: number): unknown[] {
  // Every element takes at least one byte, so a larger count cannot be valid.
  if (len > r.buf.length - r.pos) throw new Error("msgpack: truncated data");
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) out.push(readValue(r, depth + 1));
  return out;
}

function readMap(r: Reader, len: number, depth: number): Record<string, unknown> {
  if (len * 2 > r.buf.length - r.pos) throw new Error("msgpack: truncated data");
  const out: Record<string, unknown> = {};
  for (let i = 0; i < len; i++) {
    const key = readValue(r, depth + 1);
    if (typeof key !== "string") throw new Error("msgpack: map key is not a string");
    const value = readValue(r, depth + 1);
    // defineProperty so a "__proto__" key stays an ordinary property.
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function readValue(r: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("msgpack: nested too deeply");
  const t = r.u8();
  if (t <= 0x7f) return t;
  if (t >= 0xe0) return t - 0x100;
  if (t >= 0xa0 && t <= 0xbf) return readStr(r, t & 0x1f);
  if (t >= 0x90 && t <= 0x9f) return readArray(r, t & 0x0f, depth);
  if (t >= 0x80 && t <= 0x8f) return readMap(r, t & 0x0f, depth);
  switch (t) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc4:
      return r.take(r.u8());
    case 0xc5:
      return r.take(r.u16());
    case 0xc6:
      return r.take(r.u32());
    case 0xca: {
      const v = r.take(4).readFloatBE(0);
      return v;
    }
    case 0xcb:
      return r.take(8).readDoubleBE(0);
    case 0xcc:
      return r.u8();
    case 0xcd:
      return r.u16();
    case 0xce:
      return r.u32();
    case 0xcf:
      return wide(r.take(8).readBigUInt64BE(0));
    case 0xd0:
      return r.take(1).readInt8(0);
    case 0xd1:
      return r.take(2).readInt16BE(0);
    case 0xd2:
      return r.take(4).readInt32BE(0);
    case 0xd3:
      return wide(r.take(8).readBigInt64BE(0));
    case 0xd9:
      return readStr(r, r.u8());
    case 0xda:
      return readStr(r, r.u16());
    case 0xdb:
      return readStr(r, r.u32());
    case 0xdc:
      return readArray(r, r.u16(), depth);
    case 0xdd:
      return readArray(r, r.u32(), depth);
    case 0xde:
      return readMap(r, r.u16(), depth);
    case 0xdf:
      return readMap(r, r.u32(), depth);
    default:
      throw new Error(`msgpack: unsupported type 0x${t.toString(16)}`);
  }
}

/**
 * Decode one MessagePack value from the start of `buf`. Maps become plain objects with string
 * keys, `bin` becomes a Buffer view, 64-bit integers a number (a bigint when not exactly
 * representable). Throws on truncated data, non-string map keys and ext types. Bytes after the
 * value are ignored.
 */
export function decodeMsgpack(buf: Buffer): unknown {
  return readValue(new Reader(buf), 0);
}
