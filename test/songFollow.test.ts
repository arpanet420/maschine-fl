import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import {
  channelsOfGroup,
  compareGroupNames,
  groupOfMarker,
  readProjectGroups,
  type ProjectGroups,
} from "../src/fl/flpGroups.js";
import {
  findProjectFile,
  projectNameFromTitle,
  sameMarkers,
  savedMarkerName,
  type FoundProject,
} from "../src/fl/projectFile.js";
import type { FlCommand } from "../src/fl/sysex.js";
import { SongFollow } from "../src/modes/songFollow.js";
import { demoFlState } from "../src/tools/demoState.js";
import { stackHarness } from "../src/tools/stackHarness.js";

// ── A .flp, written the way FL does ──────────────────────────────────────────

type Body = number | string | Uint8Array;

const utf16 = (text: string) => {
  const out = new Uint8Array((text.length + 1) * 2);
  for (let i = 0; i < text.length; i++) {
    out[i * 2] = text.charCodeAt(i) & 0xff;
    out[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  return out;
};

function event(id: number, body: Body): number[] {
  if (typeof body === "number") {
    const size = id < 64 ? 1 : id < 128 ? 2 : 4;
    return [id, ...Array.from({ length: size }, (_, i) => (body >>> (8 * i)) & 0xff)];
  }
  const data = typeof body === "string" ? utf16(body) : body;
  const length: number[] = [];
  let n = data.length;
  do {
    length.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n >>>= 7;
  } while (n > 0);
  return [id, ...length, ...data];
}

const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function flp(events: number[][]): Uint8Array {
  const body = events.flat();
  return Uint8Array.from([
    ...Array.from("FLhd", (c) => c.charCodeAt(0)),
    ...u32(6),
    0,
    0,
    3,
    0,
    96,
    0,
    ...Array.from("FLdt", (c) => c.charCodeAt(0)),
    ...u32(body.length),
    ...body,
  ]);
}

const version = (text: string) =>
  event(199, Uint8Array.from([...Array.from(text, (c) => c.charCodeAt(0)), 0]));

/** A live set the way Skarv splices one: three songs, a group and a marker each, and FL's own groups. */
const liveSet = (options: { markers?: string[]; extended?: boolean } = {}) =>
  flp([
    version("26.1.0.4900"),
    // FL writes them sorted; a file that doesn't still counts in FL's order
    event(231, "3 synplant"),
    event(231, "1 ad4shdtyh"),
    event(231, "Unsorted"),
    event(231, "2 swesyntmaster"),
    ...(options.extended ? [[172, ...u32((0x40 << 24) | 12), 0x34, 0x12]] : []),
    event(64, 0),
    event(145, 0),
    event(203, "Nepheton 2"),
    event(64, 1),
    event(145, 0),
    event(64, 2),
    event(145, 1),
    event(64, 3),
    event(145, 1),
    event(64, 4),
    event(145, 1),
    event(64, 5),
    event(145, 2),
    event(64, 6),
    event(145, 3),
    ...(options.markers ?? ["ad4shdtyh", "swesyntmaster", "synplant"]).map((name) =>
      event(205, name),
    ),
  ]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mk3d-follow-"));
  dirs.push(dir);
  return dir;
};

describe("reading a project's channel groups", () => {
  it("gives the groups in FL's order, each channel's group and the markers", () => {
    const project = readProjectGroups(liveSet());
    expect(project.groups).toEqual(["1 ad4shdtyh", "2 swesyntmaster", "3 synplant", "Unsorted"]);
    expect(project.channelGroups).toEqual([0, 0, 1, 1, 1, 2, 3]);
    expect(project.markers).toEqual(["ad4shdtyh", "swesyntmaster", "synplant"]);
    expect(channelsOfGroup(project, 1)).toEqual([2, 3, 4]);
  });

  it("steps over FL 2026's extended events", () => {
    expect(readProjectGroups(liveSet({ extended: true })).channelGroups).toEqual([
      0, 0, 1, 1, 1, 2, 3,
    ]);
  });

  it("refuses a file that is not a project", () => {
    expect(() => readProjectGroups(Uint8Array.from([1, 2, 3]))).toThrow(/not an FL Studio project/);
  });

  it("sorts group names like FL: case-insensitive, numbers by value", () => {
    const names = ["C10", "Automation", "06benji", "c 9", "5beautiful", "Unsorted", "10 b", "2 a"];
    expect([...names].sort(compareGroupNames)).toEqual([
      "2 a",
      "5beautiful",
      "06benji",
      "10 b",
      "Automation",
      "c 9",
      "C10",
      "Unsorted",
    ]);
  });

  it("matches a marker to the group of its name, with or without a leading number", () => {
    const project: ProjectGroups = {
      groups: ["01_intro", "2 swesyntmaster", "08. funky", "12swing", "Drums", "03"],
      channelGroups: [],
      markers: [],
    };
    expect(groupOfMarker(project, "swesyntmaster")).toBe(1);
    expect(groupOfMarker(project, "SweSyntMaster")).toBe(1);
    expect(groupOfMarker(project, "intro")).toBe(0);
    expect(groupOfMarker(project, "funky")).toBe(2);
    expect(groupOfMarker(project, "swing")).toBe(3);
    expect(groupOfMarker(project, "drums")).toBe(4);
    expect(groupOfMarker(project, "3 drums")).toBe(4);
    expect(groupOfMarker(project, "140")).toBe(-1); // a number alone matches nothing but itself
    expect(groupOfMarker(project, "03")).toBe(5);
    expect(groupOfMarker(project, "")).toBe(-1);
  });
});

describe("finding the project file", () => {
  it("knows FL's marker names by the saved ones, with the action FL adds", () => {
    const saved = ["intro", "intro 2", "verse"];
    expect(savedMarkerName("intro - marker loop", saved)).toBe("intro");
    expect(savedMarkerName("intro 2 - marker skip", saved)).toBe("intro 2");
    expect(savedMarkerName("verse", saved)).toBe("verse");
    expect(savedMarkerName("chorus - marker loop", saved)).toBe("chorus - marker loop");
    expect(sameMarkers(saved, ["verse", "intro 2 - marker loop", "intro - marker loop"])).toBe(
      true,
    );
    expect(sameMarkers(saved, ["verse", "intro - marker loop", "intro - marker skip"])).toBe(false);
    expect(sameMarkers(saved, ["verse", "intro"])).toBe(false);
  });

  it("takes the project's name from FL's title", () => {
    expect(projectNameFromTitle("liveset - FL Studio 2026")).toBe("liveset");
    expect(projectNameFromTitle("FL Studio 2026 - liveset.flp *")).toBe("liveset");
    expect(projectNameFromTitle("my - song - FL Studio 2026")).toBe("my");
    expect(projectNameFromTitle("FL Studio 2026")).toBeUndefined();
    expect(projectNameFromTitle("")).toBeUndefined();
  });

  it("finds the file of that name, the one with FL's markers first, never a backup", async () => {
    const root = tempDir();
    mkdirSync(join(root, "a", "Backup"), { recursive: true });
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "a", "liveset.flp"), liveSet());
    writeFileSync(join(root, "b", "liveset.flp"), liveSet({ markers: ["other"] }));
    writeFileSync(join(root, "a", "Backup", "liveset.flp"), liveSet({ markers: ["backup"] }));
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "b", "liveset.flp"), later, later); // newer, but not FL's markers

    const markers = ["synplant", "ad4shdtyh", "swesyntmaster"];
    const found = await findProjectFile("liveset - FL Studio 2026", markers, root);
    expect(found?.path).toBe(join(root, "a", "liveset.flp"));
    const newest = await findProjectFile("liveset - FL Studio 2026", ["backup"], root);
    expect(newest?.path).toBe(join(root, "b", "liveset.flp"));
  });

  it("without a file of the name, takes the newest project with FL's markers", async () => {
    const root = tempDir();
    writeFileSync(join(root, "spliced.flp"), liveSet());
    writeFileSync(join(root, "plain.flp"), liveSet({ markers: [] }));
    // FL 2026's title has no project name, and FL's marker names carry the marker's action
    const found = await findProjectFile(
      "FL Studio 2026",
      ["ad4shdtyh - marker loop", "swesyntmaster - marker loop", "synplant - marker loop"],
      root,
    );
    expect(found?.path).toBe(join(root, "spliced.flp"));
    expect(await findProjectFile("untitled - FL Studio 2026", [], root)).toBeUndefined();
    expect(await findProjectFile("x", ["nope"], join(root, "missing"))).toBeUndefined();
  });
});

// ── FOLLOW ───────────────────────────────────────────────────────────────────

/** Markers every 4 bars (PPQ 96), named like the songs, the way FL names Marker loop markers. */
const songMarkers = [
  "ad4shdtyh - marker loop",
  "swesyntmaster - marker loop",
  "synplant - marker loop",
  "outro",
].map((name, i) => ({
  ticks: i * 16 * 96,
  name,
}));

const settle = () => new Promise((resolve) => setImmediate(resolve));

function follower(
  found: FoundProject | null = {
    path: "/p/liveset.flp",
    mtimeMs: 1,
    project: readProjectGroups(liveSet()),
  },
) {
  const fl = demoFlState({ markers: songMarkers });
  const sent: FlCommand[] = [];
  const log: string[] = [];
  const looked: string[] = [];
  let saved = false;
  let changes = 0;
  const follow = new SongFollow({
    fl,
    send: (command) => sent.push(command),
    log: (line) => log.push(line),
    changed: () => changes++,
    find: async (title) => {
      looked.push(title);
      return found ?? undefined;
    },
    saved: async () => {
      const was = saved;
      saved = false; // read again, the file is as FL saved it
      return was;
    },
  });
  const views = () => sent.flatMap((c) => (c.type === "setChannelView" ? [c.channels] : []));
  const project = (patch: Partial<{ title: string; filtered: boolean; load: number }> = {}) => {
    const base = fl.project.title
      ? fl.project
      : { title: "liveset - FL Studio 2026", filtered: false, load: 0 };
    fl.apply({ type: "project", ...base, ...patch });
    follow.onFlChange("project");
  };
  const at = (bar: number) => {
    fl.apply({ type: "songPos", bar, step: 1, tick: 0 });
    follow.onFlChange("songPos");
  };
  return {
    fl,
    follow,
    views,
    log,
    looked,
    project,
    at,
    get changes() {
      return changes;
    },
    save: () => {
      saved = true;
    },
  };
}

describe("FOLLOW", () => {
  it("sends nothing while it is off", async () => {
    const f = follower();
    f.project();
    f.at(5);
    await settle();
    expect(f.views()).toEqual([]);
    expect(f.looked).toEqual([]); // no file is read either
  });

  it("shows the channels of the group named like the marker the song is in", async () => {
    const f = follower();
    f.project();
    f.follow.setEnabled(true);
    await settle();
    expect(f.views()).toEqual([[0, 1]]);
    expect(f.follow.current).toEqual({ group: "1 ad4shdtyh" });
    f.at(3); // the same song
    f.at(5);
    expect(f.views()).toEqual([
      [0, 1],
      [2, 3, 4],
    ]);
    f.at(9);
    expect(f.views().at(-1)).toEqual([5]);
    f.at(13); // "outro": no group of its name, every channel
    expect(f.views().at(-1)).toEqual([]);
    expect(f.follow.current).toEqual({});
    expect(
      f.log.some((line) =>
        line.includes('swesyntmaster - marker loop → group "2 swesyntmaster", 3 channels'),
      ),
    ).toBe(true);
  });

  it("gives every channel back when it is turned off", async () => {
    const f = follower();
    f.project();
    f.follow.setEnabled(true);
    await settle();
    f.follow.setEnabled(false);
    expect(f.views()).toEqual([[0, 1], []]);
    f.at(5);
    expect(f.views()).toHaveLength(2);
  });

  it("sends the view again to a new script, and reads the file again after a project load", async () => {
    const f = follower();
    f.project();
    f.follow.setEnabled(true);
    await settle();
    f.fl.reset();
    f.follow.onFlChange("connection");
    f.fl.apply({ type: "hello", version: 2 });
    f.follow.onFlChange("connection");
    // FlState forgot the markers and the title: FL sends them again
    f.fl.apply({
      type: "markers",
      total: songMarkers.length,
      offset: 0,
      entries: songMarkers,
      ppq: 96,
    });
    f.follow.onFlChange("markers");
    f.project({ title: "liveset - FL Studio 2026" });
    await settle();
    expect(f.views()).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(f.looked).toHaveLength(1); // the same title and markers: the same file
    f.project({ load: 1 }); // the same project loaded again
    await settle();
    expect(f.looked).toHaveLength(2);
    expect(f.views()).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
  });

  it("reads the file again when FL saved it, at the next marker", async () => {
    const f = follower();
    f.project();
    f.follow.setEnabled(true);
    await settle();
    expect(f.looked).toHaveLength(1);
    f.save();
    f.at(5);
    await settle();
    expect(f.looked).toHaveLength(2);
  });

  it("says why it can't: no project file, or FL's filter on a group", async () => {
    const f = follower(null);
    f.project();
    f.follow.setEnabled(true);
    await settle();
    expect(f.follow.current).toEqual({ problem: "No project file" });
    expect(f.views()).toEqual([]);
    expect(f.log).toContain(
      'FOLLOW: no project file found for FL\'s title "liveset - FL Studio 2026"',
    );

    const g = follower();
    g.project({ filtered: true });
    g.follow.setEnabled(true);
    await settle();
    expect(g.follow.current.problem).toBe("FL's channel filter isn't \"All\"");
    expect(g.views()).toEqual([[0, 1]]); // the script puts it in place once the filter is on "All"
    expect(g.changes).toBeGreaterThan(0);
  });
});

describe("SCENE's FOLLOW tab", () => {
  const found: FoundProject = {
    path: "/p/liveset.flp",
    mtimeMs: 1,
    project: readProjectGroups(liveSet()),
  };

  const texts = (
    draw: (ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => void,
  ) => {
    const ctx = createCanvas(480, 272).getContext("2d");
    const out: string[] = [];
    const original = ctx.fillText.bind(ctx);
    ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      out.push(text);
      original(text, x, y, maxWidth);
    };
    draw(ctx);
    return out;
  };

  it("display 4 turns it on and off, lit while on, and the left screen says whose channels", async () => {
    const h = stackHarness({ markers: songMarkers, findProject: async () => found });
    h.fl.apply({ type: "project", title: "liveset - FL Studio 2026", filtered: false, load: 0 });
    h.follow?.onFlChange("project");
    h.press("scene");
    expect(h.light("display4")).toBe("dim");
    h.tap("display4");
    await settle();
    expect(h.follow?.enabled).toBe(true);
    expect(h.light("display4")).toBe("bright");
    const right = createCanvas(480, 272).getContext("2d");
    const left = texts((ctx) => h.stack.render(ctx, right, h.mc));
    expect(left).toContain("FOLLOW");
    expect(left).toContain("Channels: 1 ad4shdtyh");
    expect(h.sentOf("setChannelView")).toEqual([{ type: "setChannelView", channels: [0, 1] }]);
    h.tap("display4");
    expect(h.follow?.enabled).toBe(false);
    expect(
      texts((ctx) => h.stack.render(ctx, right, h.mc)).some((t) => t.startsWith("Channels")),
    ).toBe(false);
  });

  it("is saved with the page stack's state", () => {
    const pinsPath = join(tempDir(), "pages.json");
    const h = stackHarness({ markers: songMarkers, findProject: async () => found, pinsPath });
    h.press("scene");
    h.tap("display4");
    h.release("scene");
    const again = stackHarness({ markers: songMarkers, findProject: async () => found, pinsPath });
    expect(again.follow?.enabled).toBe(true);
  });

  it("has no tab without a FOLLOW to drive", () => {
    const h = stackHarness({ markers: songMarkers });
    h.press("scene");
    const right = createCanvas(480, 272).getContext("2d");
    expect(texts((ctx) => h.stack.render(ctx, right, h.mc))).not.toContain("FOLLOW");
  });
});
