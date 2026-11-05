// What SCENE's FOLLOW needs from a saved FL Studio project (.flp): the channel rack's filter groups,
// each channel's group, and the playlist markers' names. FL's scripting API has no way to read the
// groups, so mk3d reads them from the file FL saved (docs/fl-api-notes.md, "Channel groups").
//
// The format, as read from many saved projects (the same parser as Skarv's, github.com/arpanet420/skarv):
// "FLhd" <u32 length> <header> "FLdt" <u32 length> <events>. An event is an id byte and a body: ids 0–63
// carry a byte, 64–127 a u16, 128–191 a u32, 192–255 a varint length and that many bytes. From FL 2026 on
// (version event 199 says 26 or more), id 172 is a prefix: a u32 whose top byte gives the body's kind.
//   64  a new channel: every channel's events follow it, in FL's channel order (its global index)
//   145 the channel's filter group, an index into the group names in FL's sorted order
//   231 a filter group's name (UTF-16)
//   205 a playlist marker's name
//   199 FL's version, as text

const EV = {
  CH_NEW: 64,
  CH_GROUP: 145,
  EXT_PREFIX: 172,
  VERSION: 199,
  MARKER_NAME: 205,
  GROUP_NAME: 231,
} as const;

export interface ProjectGroups {
  /** The filter group names in FL's order (the one FL shows and event 145 counts in). */
  groups: string[];
  /** Each channel's group, an index into `groups` (−1: none), by global channel index. */
  channelGroups: number[];
  /** The playlist markers' names, in the file's order. */
  markers: string[];
}

/** Reads the groups, channels and markers of a .flp. Throws on a file that is not one. */
export function readProjectGroups(bytes: Uint8Array): ProjectGroups {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 22 || tag(0) !== "FLhd") throw new Error("not an FL Studio project (no FLhd)");
  let p = 8 + view.getUint32(4, true);
  if (tag(p) !== "FLdt") throw new Error("not an FL Studio project (no FLdt)");
  const end = Math.min(bytes.length, p + 8 + view.getUint32(p + 4, true));
  p += 8;
  const names: string[] = [];
  const channelGroups: number[] = [];
  const markers: string[] = [];
  let extended = false;
  while (p < end) {
    let id = bytes[p++] ?? 0;
    let kind = id < 64 ? 1 : id < 128 ? 2 : id < 192 ? 4 : 0;
    if (id === EV.EXT_PREFIX && extended) {
      const x = view.getUint32(p, true);
      p += 4;
      const top = x >>> 24;
      kind = top === 0 ? 1 : top === 0x40 ? 2 : top === 0x80 ? 4 : 0;
      id = -1; // an extended event: none of the ones read here
    }
    let value = 0;
    let body: Uint8Array | undefined;
    if (kind === 1) value = bytes[p] ?? 0;
    else if (kind === 2) value = view.getUint16(p, true);
    else if (kind === 4) value = view.getUint32(p, true);
    if (kind > 0) p += kind;
    else {
      let length = 0;
      for (let shift = 0; ; shift += 7) {
        const b = bytes[p++] ?? 0;
        length += (b & 0x7f) * 2 ** shift;
        if (b < 0x80 || p >= end) break;
      }
      body = bytes.subarray(p, p + length);
      p += length;
    }
    if (id === EV.VERSION && body) extended = parseInt(ascii(body), 10) >= 26;
    else if (id === EV.CH_NEW) channelGroups.push(-1);
    else if (id === EV.CH_GROUP && channelGroups.length > 0)
      channelGroups[channelGroups.length - 1] = value;
    else if (id === EV.GROUP_NAME && body) names.push(text(body));
    else if (id === EV.MARKER_NAME && body) markers.push(text(body));
  }
  // FL reads event 145 as an index into the names sorted its way, whatever order the file has them in.
  const groups = [...names].sort(compareGroupNames);
  return {
    groups,
    channelGroups: channelGroups.map((group) => (group < groups.length ? group : -1)),
    markers,
  };
}

/** The global indexes of the channels in group `group` (an index into `groups`). */
export const channelsOfGroup = (project: ProjectGroups, group: number): number[] =>
  project.channelGroups.flatMap((g, index) => (g === group ? [index] : []));

/**
 * The group that goes with a marker: the one with its name, ignoring case and a leading number ("2 swesyntmaster",
 * Skarv's way, or "12swing", "08. funky", "01_intro") on either. −1 when none does.
 */
export function groupOfMarker(project: ProjectGroups, marker: string): number {
  const key = (name: string) => name.trim().toLowerCase();
  const bare = (name: string) => key(name).replace(/^\d+[\s._-]*/, "");
  const wanted = key(marker);
  if (!wanted) return -1;
  const exact = project.groups.findIndex((name) => key(name) === wanted);
  if (exact >= 0 || !bare(marker)) return exact;
  return project.groups.findIndex((name) => bare(name) !== "" && bare(name) === bare(marker));
}

/**
 * FL's order for filter group names, read from every saved project at hand: case-insensitive, character by
 * character, and runs of digits compare by value ("5beautiful" < "06benji", "C 9" < "C10").
 */
export function compareGroupNames(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (digit(x[i]) && digit(y[j])) {
      let i2 = i;
      let j2 = j;
      while (i2 < x.length && digit(x[i2])) i2++;
      while (j2 < y.length && digit(y[j2])) j2++;
      const d = Number(x.slice(i, i2)) - Number(y.slice(j, j2));
      if (d) return d;
      i = i2;
      j = j2;
      continue;
    }
    if (x[i] !== y[j]) return (x[i] ?? "") < (y[j] ?? "") ? -1 : 1;
    i++;
    j++;
  }
  return x.length - i - (y.length - j);
}

function ascii(body: Uint8Array): string {
  let s = "";
  for (const b of body) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/** FL's text: UTF-16LE, or single bytes in very old files. */
function text(body: Uint8Array): string {
  if (body.length < 2 || body.length % 2 !== 0 || body[1] !== 0) return ascii(body);
  let s = "";
  for (let i = 0; i + 1 < body.length; i += 2) {
    const c = (body[i] ?? 0) | ((body[i + 1] ?? 0) << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
