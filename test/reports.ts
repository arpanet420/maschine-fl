// Builders for synthetic MK3 input reports, laid out as in docs/protocol.md.

export function controlsReport(
  init: {
    bits?: Array<[byte: number, mask: number]>;
    wheel?: number;
    knobs?: number[];
    strip?: number;
  } = {},
): Uint8Array {
  const r = new Uint8Array(42);
  r[0] = 0x01;
  for (const [byte, mask] of init.bits ?? []) r[byte] = (r[byte] ?? 0) | mask;
  r[11] = (init.wheel ?? 0) & 0x0f;
  (init.knobs ?? []).forEach((value, i) => {
    r[12 + i * 2] = value & 0xff;
    r[13 + i * 2] = (value >> 8) & 0xff;
  });
  const strip = init.strip ?? 0;
  r[30] = strip & 0xff;
  r[31] = (strip >> 8) & 0xff;
  return r;
}

const KIND_NIBBLE = { on: 1, off: 3, pressure: 4 } as const;

/**
 * entries: pad index, event kind (or a raw type nibble) and 12-bit value. Slots after the entries
 * stay zero, which ends the list; `stale` fills the bytes after that terminator.
 */
export function padsReport(
  entries: Array<{ pad: number; kind: keyof typeof KIND_NIBBLE | number; value: number }>,
  stale = 0,
): Uint8Array {
  const r = new Uint8Array(64).fill(stale);
  r[0] = 0x02;
  entries.forEach(({ pad, kind, value }, slot) => {
    const o = 1 + slot * 3;
    const nibble = typeof kind === "number" ? kind : KIND_NIBBLE[kind];
    r[o] = pad;
    r[o + 1] = (nibble << 4) | ((value >> 8) & 0x0f);
    r[o + 2] = value & 0xff;
  });
  const end = 1 + entries.length * 3;
  if (end + 2 < r.length) {
    r[end] = 0;
    r[end + 1] = 0;
    r[end + 2] = 0;
  }
  return r;
}
