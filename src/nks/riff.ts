// Minimal RIFF reader for NKS files: "RIFF" u32 "NIKS" followed by chunks (docs/nks.md).

/**
 * The chunks of an NKS (RIFF "NIKS") file by 4-character ID. Bodies are subarray views of `buf`,
 * not copies. When an ID repeats, the first chunk wins. Throws on a bad header or a chunk that
 * runs past the end of the data.
 */
export function readChunks(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF")
    throw new Error("not a RIFF file");
  if (buf.toString("latin1", 8, 12) !== "NIKS") throw new Error("not an NKS file");
  const end = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks = new Map<string, Buffer>();
  let pos = 12;
  while (pos + 8 <= end) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (start + size > buf.length) throw new Error(`RIFF chunk ${id} is truncated`);
    if (!chunks.has(id)) chunks.set(id, buf.subarray(start, start + size));
    pos = start + size + (size & 1);
  }
  return chunks;
}
