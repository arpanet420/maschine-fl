import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contentFolders,
  discoverNksFiles,
  discoverResources,
  hfsToPosix,
} from "../src/nks/discover.js";
import { FlPluginDb, parseNfo } from "../src/nks/flPluginDb.js";
import { INDEX_FORMAT_VERSION, startNksIndex, type NksIndexOptions } from "../src/nks/index.js";
import { decodeMsgpack } from "../src/nks/msgpack.js";
import { parseNksFile } from "../src/nks/nksFile.js";
import { readChunks } from "../src/nks/riff.js";
import {
  F64,
  encodeMsgpack,
  nfoText,
  nksf,
  plidVst2,
  plidVst3,
  riffFile,
  versioned,
  type SlotSpec,
} from "./nksFixtures.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mk3d-nks-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bytes = (...b: number[]): Buffer => Buffer.from(b);

describe("decodeMsgpack", () => {
  it("decodes nil, booleans and every integer width", () => {
    expect(decodeMsgpack(bytes(0xc0))).toBeNull();
    expect(decodeMsgpack(bytes(0xc2))).toBe(false);
    expect(decodeMsgpack(bytes(0xc3))).toBe(true);
    expect(decodeMsgpack(bytes(0x7f))).toBe(127);
    expect(decodeMsgpack(bytes(0xe0))).toBe(-32);
    expect(decodeMsgpack(bytes(0xcc, 0xff))).toBe(255);
    expect(decodeMsgpack(bytes(0xcd, 0x01, 0x00))).toBe(256);
    expect(decodeMsgpack(bytes(0xce, 0xff, 0xff, 0xff, 0xff))).toBe(0xffffffff);
    expect(decodeMsgpack(bytes(0xcf, 0, 0, 0, 1, 0, 0, 0, 0))).toBe(2 ** 32);
    expect(decodeMsgpack(bytes(0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))).toBe(
      0xffffffffffffffffn,
    );
    expect(decodeMsgpack(bytes(0xd0, 0x80))).toBe(-128);
    expect(decodeMsgpack(bytes(0xd1, 0x80, 0x00))).toBe(-32768);
    expect(decodeMsgpack(bytes(0xd2, 0xff, 0xff, 0x7f, 0xff))).toBe(-32769);
    expect(decodeMsgpack(bytes(0xd3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe))).toBe(-2);
  });

  it("decodes floats", () => {
    const f32 = Buffer.alloc(5);
    f32[0] = 0xca;
    f32.writeFloatBE(1.5, 1);
    expect(decodeMsgpack(f32)).toBe(1.5);
    expect(decodeMsgpack(encodeMsgpack(new F64(-0.1)))).toBe(-0.1);
  });

  it("decodes strings of every width, as UTF-8", () => {
    expect(decodeMsgpack(bytes(0xa3, 0x61, 0x62, 0x63))).toBe("abc");
    expect(decodeMsgpack(Buffer.concat([bytes(0xd9, 2), Buffer.from("é", "utf8")]))).toBe("é");
    const long = "x".repeat(300);
    expect(decodeMsgpack(Buffer.concat([bytes(0xda, 0x01, 0x2c), Buffer.from(long)]))).toBe(long);
    expect(decodeMsgpack(Buffer.concat([bytes(0xdb, 0, 0, 0, 2), Buffer.from("hi")]))).toBe("hi");
  });

  it("decodes bin as a Buffer", () => {
    const v = decodeMsgpack(bytes(0xc4, 3, 1, 2, 3));
    expect(Buffer.isBuffer(v)).toBe(true);
    expect([...(v as Buffer)]).toEqual([1, 2, 3]);
    expect([...(decodeMsgpack(bytes(0xc5, 0, 1, 9)) as Buffer)]).toEqual([9]);
    expect([...(decodeMsgpack(bytes(0xc6, 0, 0, 0, 1, 7)) as Buffer)]).toEqual([7]);
  });

  it("decodes arrays and maps, nested", () => {
    expect(decodeMsgpack(bytes(0x92, 1, 0x92, 2, 3))).toEqual([1, [2, 3]]);
    expect(decodeMsgpack(bytes(0xdc, 0, 1, 5))).toEqual([5]);
    expect(decodeMsgpack(bytes(0xdd, 0, 0, 0, 1, 5))).toEqual([5]);
    expect(decodeMsgpack(bytes(0x81, 0xa1, 0x6b, 0xa1, 0x76))).toEqual({ k: "v" });
    expect(decodeMsgpack(bytes(0xde, 0, 1, 0xa1, 0x6b, 1))).toEqual({ k: 1 });
    expect(decodeMsgpack(bytes(0xdf, 0, 0, 0, 1, 0xa1, 0x6b, 1))).toEqual({ k: 1 });
    const big = Array.from({ length: 40 }, (_, i) => ({ id: i, tags: ["a", null, true] }));
    expect(decodeMsgpack(encodeMsgpack({ list: big }))).toEqual({ list: big });
  });

  it("keeps a __proto__ key as plain data", () => {
    const v = decodeMsgpack(encodeMsgpack({ ["__proto__"]: 1 })) as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
  });

  it("throws on ext types, truncation and non-string keys", () => {
    expect(() => decodeMsgpack(bytes(0xd4, 1, 0))).toThrow();
    expect(() => decodeMsgpack(bytes(0xc1))).toThrow();
    expect(() => decodeMsgpack(bytes(0xcd, 1))).toThrow();
    expect(() => decodeMsgpack(bytes(0xa5, 0x61))).toThrow();
    expect(() => decodeMsgpack(bytes(0x92, 1))).toThrow();
    expect(() => decodeMsgpack(bytes(0xdd, 0xff, 0xff, 0xff, 0xff))).toThrow();
    expect(() => decodeMsgpack(bytes(0x81, 0x01, 0x01))).toThrow();
    expect(() => decodeMsgpack(Buffer.alloc(0))).toThrow();
  });
});

describe("readChunks", () => {
  it("reads chunks in any order, handles padding and unknown ids, returns views", () => {
    const odd = Buffer.from([1, 2, 3]);
    const file = riffFile([
      ["AAAA", odd],
      ["BBBB", Buffer.from([9])],
      ["CCCC", Buffer.from("even")],
    ]);
    const chunks = readChunks(file);
    expect([...chunks.keys()]).toEqual(["AAAA", "BBBB", "CCCC"]);
    expect([...chunks.get("AAAA")!]).toEqual([1, 2, 3]);
    expect([...chunks.get("BBBB")!]).toEqual([9]);
    expect(chunks.get("CCCC")!.toString()).toBe("even");
    expect(chunks.get("CCCC")!.buffer).toBe(file.buffer);
  });

  it("keeps the first of repeated ids and ignores trailing bytes past the RIFF size", () => {
    const file = Buffer.concat([
      riffFile([
        ["AAAA", Buffer.from([1])],
        ["AAAA", Buffer.from([2])],
      ]),
      Buffer.from("garbage!"),
    ]);
    expect([...readChunks(file).get("AAAA")!]).toEqual([1]);
  });

  it("throws on a bad header or a truncated chunk", () => {
    expect(() => readChunks(Buffer.from("nope"))).toThrow();
    const wrongForm = riffFile([]);
    wrongForm.write("WAVE", 8, "latin1");
    expect(() => readChunks(wrongForm)).toThrow();
    const notRiff = riffFile([]);
    notRiff.write("RIFX", 0, "latin1");
    expect(() => readChunks(notRiff)).toThrow();
    const cut = riffFile([["AAAA", Buffer.alloc(20)]]).subarray(0, 24);
    expect(() => readChunks(cut)).toThrow();
  });
});

const slot = (id: number, name: string, section?: string): SlotSpec =>
  section === undefined ? { id, name } : { id, name, section };

describe("parseNksFile", () => {
  it("reads info, pages and a VST2 PLID", () => {
    const parsed = parseNksFile(
      nksf({
        vendor: "u-he",
        product: "Diva",
        preset: "Init",
        pages: [[slot(148, "Cutoff", "Filter"), slot(149, "Reso")]],
        plid: plidVst2(0x44695661),
      }),
    );
    expect(parsed.info).toEqual({ vendor: "u-he", product: "Diva", name: "Init" });
    expect(parsed.plid).toEqual({ vst2: 0x44695661 });
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]).toHaveLength(8);
    expect(parsed.pages[0]![0]).toEqual({ id: 148, name: "Cutoff", section: "Filter" });
    expect(parsed.pages[0]![1]).toEqual({ id: 149, name: "Reso" });
    expect(parsed.pages[0]![7]).toEqual({ name: "" });
  });

  it("reads a VST3 PLID as 32 upper-case hex digits", () => {
    const parsed = parseNksFile(
      nksf({
        pages: [],
        plid: plidVst3(
          [0x5653545a, 0x425a554f, 0x7a6f6e65, 0x2050726f],
          "Ozone 12 Equalizer",
          "iZotope",
        ),
      }),
    );
    expect(parsed.plid).toEqual({
      vst3: "5653545A425A554F7A6F6E652050726F",
      name: "Ozone 12 Equalizer",
      vendor: "iZotope",
    });
    const small = parseNksFile(nksf({ plid: plidVst3([1, 2, 3, 4], "X", "Y") }));
    expect(small.plid.vst3).toBe("00000001000000020000000300000004");
  });

  it("blanks unassigned slots, keeps their section, trims long pages and ignores other keys", () => {
    const page: SlotSpec[] = [
      { name: "unassigned", section: "Low", autoname: true },
      { id: 3, name: "unset" },
      { name: "Orphan name" },
      { id: 4, name: "Gain", section: "", vflag: false },
      ...Array.from({ length: 7 }, (_, i) => slot(10 + i, `K${i}`)),
    ];
    const [p] = parseNksFile(nksf({ pages: [page] })).pages;
    expect(p).toHaveLength(8);
    expect(p![0]).toEqual({ name: "", section: "Low" });
    expect(p![1]).toEqual({ id: 3, name: "" });
    expect(p![2]).toEqual({ name: "" });
    expect(p![3]).toEqual({ id: 4, name: "Gain" });
    expect(p![7]).toEqual({ id: 13, name: "K3" });
  });

  it("ignores unknown chunks and a missing PLID, and throws without NISI or NICA", () => {
    const nisi = versioned({ name: "P", vendor: "V", bankchain: ["Prod"] });
    const nica = versioned({ ni8: [] });
    const ok = parseNksFile(
      riffFile([
        ["NICA", nica],
        ["ZZZZ", Buffer.alloc(3)],
        ["NISI", nisi],
      ]),
    );
    expect(ok.plid).toEqual({});
    expect(ok.info.product).toBe("Prod");
    expect(() => parseNksFile(riffFile([["NICA", nica]]))).toThrow();
    expect(() => parseNksFile(riffFile([["NISI", nisi]]))).toThrow();
    expect(() =>
      parseNksFile(
        riffFile([
          ["NISI", nisi],
          ["NICA", versioned({})],
        ]),
      ),
    ).toThrow();
    expect(() => parseNksFile(Buffer.from("not riff at all"))).toThrow();
  });
});

describe(".nfo parsing", () => {
  const COMPAT = "{56535444-6956-6164-6976-610000000000}";

  it("derives the VST2 magic from a compatibility GUID", () => {
    const [entry] = parseNfo(
      nfoText("Diva", [
        {
          plugClass: 8,
          guid: "{d39d5b69-d6af-42fa-1234-567844695661}",
          compat: [COMPAT, "{00000000-0000-0000-0000-000000000000}", "bad"],
          vendor: "u-he",
        },
      ]),
    );
    expect(entry).toEqual({
      name: "Diva",
      plugClass: 8,
      guid: "D39D5B69D6AF42FA1234567844695661",
      compatMagics: [0x44695661],
      vendor: "u-he",
    });
  });

  it("reads several entries, a BOM and plain VST2 fields", () => {
    const entries = parseNfo(
      nfoText("Two", [
        { plugClass: 4, magic: 1147754081, guid: COMPAT },
        { plugClass: 10, guid: "{55486658-6D75-6175-6156-694400000000}" },
      ]),
    );
    expect(entries.map((e) => [e.plugClass, e.magic])).toEqual([
      [4, 1147754081],
      [10, undefined],
    ]);
    expect(entries[0]!.name).toBe("Two");
  });

  it("merges formats in keysForName: VST3 ids, then compat magics, then plain magics", () => {
    const root = path.join(tmp, "Installed");
    fs.mkdirSync(path.join(root, "Generators", "VST"), { recursive: true });
    fs.mkdirSync(path.join(root, "Generators", "VST3"), { recursive: true });
    fs.mkdirSync(path.join(root, "Effects", "VST"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "Generators", "VST", "Diva.nfo"),
      nfoText("Diva", [{ plugClass: 4, magic: 1111, vendor: "u-he" }]),
    );
    fs.writeFileSync(
      path.join(root, "Generators", "VST3", "Diva.nfo"),
      nfoText("Diva", [
        {
          plugClass: 8,
          guid: "{D39D5B69-D6AF-42FA-1234-567844695661}",
          compat: [COMPAT],
          vendor: "u-he",
        },
      ]),
    );
    fs.writeFileSync(
      path.join(root, "Generators", "VST3", "Diva 2.nfo"),
      nfoText("diva", [
        {
          plugClass: 8,
          guid: "{D39D5B69-D6AF-42FA-1234-567844695661}",
          compat: [COMPAT],
          vendor: "u-he",
        },
      ]),
    );
    fs.writeFileSync(
      path.join(root, "Effects", "VST", "Other.nfo"),
      nfoText("Other", [{ plugClass: 4, magic: 2222 }]),
    );
    const db = new FlPluginDb(root);
    expect(db.size).toBe(2);
    expect(db.keysForName("DIVA")).toEqual({
      vst3: ["D39D5B69D6AF42FA1234567844695661"],
      vst2: [0x44695661, 1111],
      vendors: ["u-he"],
    });
    expect(db.keysForName("Other").vst2).toEqual([2222]);
    expect(db.keysForName("Nothing")).toEqual({ vst3: [], vst2: [], vendors: [] });
    expect(new FlPluginDb(path.join(tmp, "missing")).size).toBe(0);
  });
});

describe("discovery", () => {
  it("converts HFS paths", () => {
    expect(
      hfsToPosix(
        "Macintosh HD:Library:Application Support:u-he:Diva:NKS:Diva:",
        path.join(tmp, "Volumes"),
      ),
    ).toBe("/Library/Application Support/u-he/Diva/NKS/Diva");
    expect(hfsToPosix("/:Library:Foo:nks:")).toBe("/Library/Foo/nks");
    // An external volume that is mounted gets its /Volumes prefix; the boot volume link does not.
    fs.mkdirSync(path.join(tmp, "Volumes", "Samples"), { recursive: true });
    fs.symlinkSync("/", path.join(tmp, "Volumes", "Boot"));
    expect(hfsToPosix("Samples:Content:NKS:", path.join(tmp, "Volumes"))).toBe(
      path.join(tmp, "Volumes", "Samples") + "/Content/NKS",
    );
    expect(hfsToPosix("Boot:Content:NKS:", path.join(tmp, "Volumes"))).toBe("/Content/NKS");
  });

  it("reads ContentDir from NI plists and finds presets at any depth, skipping dot-folders", async () => {
    const prefs = path.join(tmp, "prefs");
    const content = path.join(tmp, "content");
    fs.mkdirSync(prefs);
    const plist = (dir: string): string =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>ContentDir</key><string>${dir}</string></dict></plist>\n`;
    const hfs = "/:" + content.split("/").filter(Boolean).join(":") + ":";
    fs.writeFileSync(path.join(prefs, "com.native-instruments.Test.plist"), plist(hfs));
    fs.writeFileSync(
      path.join(prefs, "com.native-instruments.NoDir.plist"),
      plist("").replace("ContentDir", "Other"),
    );
    fs.writeFileSync(path.join(prefs, "com.other.plist"), plist("/:x:"));
    fs.mkdirSync(path.join(content, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(content, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(content, "top.nksf"), "x");
    fs.writeFileSync(path.join(content, "a", "b", "deep.nksfx"), "xy");
    fs.writeFileSync(path.join(content, "a", "readme.txt"), "x");
    fs.writeFileSync(path.join(content, ".hidden", "no.nksf"), "x");
    fs.writeFileSync(path.join(content, "a", "._top.nksf"), "x");
    const opts = {
      preferencesDir: prefs,
      userContentDir: path.join(tmp, "none"),
      volumesDir: path.join(tmp, "v"),
    };
    expect(await contentFolders(opts)).toContain(content);
    const files = await discoverNksFiles(opts);
    expect(files.map((f) => path.relative(content, f.path))).toEqual([
      "a/b/deep.nksfx",
      "top.nksf",
    ]);
    expect(files[0]!.size).toBe(2);
    expect(files[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it("indexes NI Resources by the vendor and name in the .meta, with color and logo", async () => {
    const res = path.join(tmp, "res");
    const meta = (vendor: string, name: string): string =>
      `<?xml version="1.0"?><resource><vendor>${vendor}</vendor><name>${name}</name></resource>`;
    const add = (
      v: string,
      p: string,
      vendor: string,
      name: string,
      files: Record<string, string>,
      logo: boolean,
    ): void => {
      const dir = path.join(res, "dist_database", v, p);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${p}.meta`), meta(vendor, name));
      for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
      if (logo) {
        fs.mkdirSync(path.join(res, "image", v, p), { recursive: true });
        fs.writeFileSync(path.join(res, "image", v, p, "MST_logo.png"), "png");
      }
    };
    add(
      "u-he",
      "diva",
      "u-he",
      "Diva",
      { "NKS2_control_color.json": '{"color": "EB4747"}', "color.json": '{"VB_bgcolor":"111111"}' },
      true,
    );
    add(
      "acme",
      "synth_abc123",
      "Acme",
      "Synth (x64)",
      { "color.json": '{ "VB_bgcolor": "252525", "NKS2_Control_Color": "#dfad55" }' },
      false,
    );
    add("acme", "plain", "Acme", "Plain", { "color.json": '{"VB_bgcolor" : "09b2de"}' }, false);
    add("acme", "bare", "Acme", "Bare", {}, false);
    const map = await discoverResources({ resourcesDir: res });
    expect(map.get("u-he|diva")).toEqual({
      color: "#EB4747",
      logo: path.join(res, "image", "u-he", "diva", "MST_logo.png"),
    });
    expect(map.get("acme|synth (x64)")).toEqual({ color: "#DFAD55" });
    expect(map.get("acme|plain")).toEqual({ color: "#09B2DE" });
    expect(map.has("acme|bare")).toBe(false);
    expect((await discoverResources({ resourcesDir: path.join(tmp, "missing") })).size).toBe(0);
  });
});

describe("NksIndex", () => {
  const OZONE_UID: [number, number, number, number] = [
    0x5653545a, 0x425a554f, 0x7a6f6e65, 0x2050726f,
  ];
  const OZONE_VST3 = "5653545A425A554F7A6F6E652050726F";

  let content: string;
  let cachePath: string;
  let lines: string[];
  let clock: number;

  const write = (rel: string, spec: Parameters<typeof nksf>[0], mtime?: number): string => {
    const file = path.join(content, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, nksf(spec));
    if (mtime !== undefined) fs.utimesSync(file, mtime, mtime);
    return file;
  };
  const nfo = (rel: string, name: string, entries: Parameters<typeof nfoText>[1]): void => {
    const file = path.join(tmp, "db", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, nfoText(name, entries));
  };
  const opts = (): NksIndexOptions => ({
    preferencesDir: path.join(tmp, "prefs"),
    userContentDir: path.join(tmp, "none"),
    extraContentDirs: [content],
    resourcesDir: path.join(tmp, "res"),
    flDbDir: path.join(tmp, "db"),
    cachePath,
    log: (l) => lines.push(l),
    now: () => clock,
  });
  const pageA = [slot(1, "A", "Sec")];
  const pageB = [slot(2, "B", "Sec")];
  const pageC = [slot(3, "C", "Sec")];

  beforeEach(() => {
    content = path.join(tmp, "content");
    cachePath = path.join(tmp, "cache", "nks-index.json");
    lines = [];
    clock = 1_000_000;
    fs.mkdirSync(content);
    // Diva-like VST2 product, Ozone-like VST3 product, and a product only matched by name.
    write("diva/z.nksf", {
      vendor: "u-he",
      product: "Diva",
      preset: "Zed",
      pages: [pageA],
      plid: plidVst2(0x44695661),
    });
    write("diva/y.nksf", {
      vendor: "u-he",
      product: "Diva",
      preset: "Why",
      pages: [pageA],
      plid: plidVst2(0x44695661),
    });
    write("diva/b.nksf", {
      vendor: "u-he",
      product: "Diva",
      preset: "Bee",
      pages: [pageB],
      plid: plidVst2(0x44695661),
    });
    write("diva/a.nksf", {
      vendor: "u-he",
      product: "Diva",
      preset: "Abe",
      pages: [pageB],
      plid: plidVst2(0x44695661),
    });
    write("diva/c.nksf", {
      vendor: "u-he",
      product: "Diva",
      preset: "Init",
      pages: [pageC],
      plid: plidVst2(0x44695661),
    });
    fs.writeFileSync(path.join(content, "diva", "broken.nksf"), "not a riff file");
    write("ozone/eq.nksfx", {
      vendor: "iZotope",
      product: "Ozone 12 Equalizer",
      preset: "Flat",
      pages: [pageA],
      plid: plidVst3(OZONE_UID, "Ozone 12 Equalizer", "iZotope"),
    });
    write("name/n.nksf", {
      vendor: "Nameco",
      product: "Namer",
      preset: "N",
      pages: [pageA],
      plid: { pluginName: "Namer Pro", pluginVendor: "Nameco" },
    });
    write("name/m.nksf", {
      vendor: "Other",
      product: "Namer",
      preset: "M",
      pages: [pageB],
      plid: { pluginName: "Namer Pro", pluginVendor: "Other" },
    });
    nfo("Installed/Generators/VST/Diva.nfo", "Diva", [
      {
        plugClass: 4,
        magic: 0x44695661,
        guid: "{56535444-6956-6164-6976-610000000000}",
        vendor: "u-he",
      },
    ]);
    nfo("Installed/Generators/VST3/Diva.nfo", "Diva", [
      {
        plugClass: 8,
        guid: "{D39D5B69-D6AF-42FA-1234-567844695661}",
        compat: ["{56535444-6956-6164-6976-610000000000}"],
        vendor: "u-he",
      },
    ]);
    nfo("Installed/Effects/VST3/Ozone.nfo", "Ozone 12 Equalizer", [
      {
        plugClass: 8,
        guid: `{${OZONE_VST3.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")}}`,
        vendor: "iZotope",
      },
    ]);
    nfo("Installed/Effects/AudioUnit/Namer.nfo", "Namer Pro", [
      { plugClass: 10, vendor: "Nameco" },
    ]);
    // Point FL's database root at <tmp>/db/Installed (the folder with Generators and Effects).
  });

  const start = async (): Promise<ReturnType<typeof startNksIndex>> => {
    const index = startNksIndex({ ...opts(), flDbDir: path.join(tmp, "db", "Installed") });
    expect(index.ready).toBe(false);
    expect(index.lookup("Diva")).toBeUndefined();
    await index.whenReady();
    return index;
  };

  it("builds products with counts, default mapping and tie rules", async () => {
    const index = await start();
    expect(index.ready).toBe(true);
    expect(index.stats).toMatchObject({ cacheHit: false, skipped: 1, parsed: 9, products: 4 });
    expect(lines.some((l) => l.includes("4 products") && l.includes("scanned"))).toBe(true);
    const diva = index.lookup("Diva")!.product;
    expect(diva.presets).toBe(5);
    expect(diva.mappings).toBe(3);
    // A, B and C each have a different count: A 2 (Zed, Why), B 2 (Bee, Abe), C 1 (Init).
    // A and B tie on count; neither has an INIT-like name, so the alphabetically first preset
    // name decides: "Abe" (page B).
    expect(diva.defaultMapping).toHaveLength(1);
    expect(diva.defaultMapping[0]![0]).toEqual({ id: 2, name: "B", section: "Sec" });
    expect(diva.defaultMapping[0]).toHaveLength(8);
    expect(diva.plids).toEqual([{ vst2: 0x44695661 }]);
  });

  it("prefers a preset named init/default among tied mappings", async () => {
    write("diva/i1.nksf", {
      vendor: "u-he",
      product: "Diva",
      preset: "Default Sound",
      pages: [pageC],
      plid: plidVst2(0x44695661),
    });
    const index = await start();
    // C now has 2 presets too (Init, Default Sound): three-way tie, C has INIT-like names.
    expect(index.lookup("Diva")!.product.defaultMapping[0]![0]).toEqual({
      id: 3,
      name: "C",
      section: "Sec",
    });
  });

  it("uses the most common mapping even without an init name", async () => {
    write("diva/m1.nksf", {
      vendor: "u-he",
      product: "Diva",
      preset: "More",
      pages: [pageA],
      plid: plidVst2(0x44695661),
    });
    const index = await start();
    expect(index.lookup("Diva")!.product.defaultMapping[0]![0]!.id).toBe(1);
  });

  it("looks up by VST3 class id, VST2 magic, name and misses", async () => {
    const index = await start();
    // Diva: the FL name has both a VST3 class id (not in any preset) and VST2 magics.
    expect(index.lookup("diva")).toMatchObject({ via: "vst2", product: { name: "Diva" } });
    // Ozone: VST3 class id from the .nfo equals the PLID's uid.
    expect(index.lookup("Ozone 12 Equalizer")).toMatchObject({
      via: "vst3",
      product: { name: "Ozone 12 Equalizer" },
    });
    // Namer Pro: only a PLID name matches; the product whose vendor equals the .nfo's wins.
    const named = index.lookup("Namer Pro")!;
    expect(named.via).toBe("name");
    expect(named.product.vendor).toBe("Nameco");
    expect(index.lookup("Namer")!.via).toBe("name");
    expect(index.lookup("No Such Plugin")).toBeUndefined();
  });

  it("prefers VST3 class ids over VST2 magics", async () => {
    write("diva3/v3.nksf", {
      vendor: "u-he",
      product: "Diva VST3",
      preset: "V",
      pages: [pageA],
      plid: plidVst3([0xd39d5b69, 0xd6af42fa, 0x12345678, 0x44695661], "Diva", "u-he"),
    });
    const index = await start();
    expect(index.lookup("Diva")).toMatchObject({ via: "vst3", product: { name: "Diva VST3" } });
  });

  it("remembers a miss for 30 s, then re-reads FL's database", async () => {
    write("late/l.nksf", {
      vendor: "Late",
      product: "Late Plugin",
      pages: [pageA],
      plid: plidVst2(0x4c415445),
    });
    const index = await start();
    expect(index.lookup("Late Plugin")).toMatchObject({ via: "name" });
    expect(index.lookup("Fresh")).toBeUndefined();
    nfo("Installed/Generators/VST/Fresh.nfo", "Fresh", [
      { plugClass: 4, magic: 0x4c415445, vendor: "Late" },
    ]);
    expect(index.lookup("Fresh")).toBeUndefined(); // remembered miss
    clock += 31_000;
    expect(index.lookup("Fresh")).toMatchObject({ via: "vst2", product: { name: "Late Plugin" } });
  });

  it("attaches logo and color from NI Resources", async () => {
    const dir = path.join(tmp, "res", "dist_database", "u-he", "diva");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "diva.meta"),
      "<resource><vendor>u-he</vendor><name>Diva</name></resource>",
    );
    fs.writeFileSync(path.join(dir, "NKS2_control_color.json"), '{"color":"EB4747"}');
    fs.mkdirSync(path.join(tmp, "res", "image", "u-he", "diva"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "res", "image", "u-he", "diva", "MST_logo.png"), "x");
    const index = await start();
    const diva = index.lookup("Diva")!.product;
    expect(diva.color).toBe("#EB4747");
    expect(diva.logo).toBe(path.join(tmp, "res", "image", "u-he", "diva", "MST_logo.png"));
    expect(index.lookup("Ozone 12 Equalizer")!.product.color).toBeUndefined();
  });

  it("calls onReady listeners, also late ones", async () => {
    const index = startNksIndex({ ...opts(), flDbDir: path.join(tmp, "db", "Installed") });
    let early = 0;
    index.onReady(() => early++);
    index.onReady(() => {
      throw new Error("listener bug");
    });
    await index.whenReady();
    expect(early).toBe(1);
    let late = 0;
    index.onReady(() => late++);
    expect(late).toBe(1);
  });

  it("starts from the cache the second time, and rescans when a file's mtime changes", async () => {
    const first = await start();
    expect(first.stats!.cacheHit).toBe(false);
    expect(fs.existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      version: number;
      products: unknown[];
    };
    expect(cached.version).toBe(INDEX_FORMAT_VERSION);
    expect(cached.products).toHaveLength(4);

    const second = await start();
    expect(second.stats).toMatchObject({ cacheHit: true, parsed: 0, products: 4 });
    expect(lines.at(-1)).toContain("cache hit");
    expect(second.lookup("Diva")!.product.defaultMapping).toEqual(
      first.lookup("Diva")!.product.defaultMapping,
    );
    expect(second.lookup("Ozone 12 Equalizer")!.via).toBe("vst3");

    const t = Date.now() / 1000 + 100;
    fs.utimesSync(path.join(content, "diva", "a.nksf"), t, t);
    const third = await start();
    expect(third.stats).toMatchObject({ cacheHit: false, parsed: 9 });

    write("extra/new.nksf", { vendor: "New", product: "Newer", pages: [pageA] });
    const fourth = await start();
    expect(fourth.stats).toMatchObject({ cacheHit: false, products: 5 });
  });

  it("treats a corrupt or old cache as a miss", async () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "{ not json");
    expect((await start()).stats!.cacheHit).toBe(false);
    fs.writeFileSync(cachePath, JSON.stringify({ version: 0, signature: "x", products: [] }));
    expect((await start()).stats!.cacheHit).toBe(false);
  });

  it("works with no preset files at all", async () => {
    fs.rmSync(content, { recursive: true });
    const index = await start();
    expect(index.ready).toBe(true);
    expect(index.products).toHaveLength(0);
    expect(index.lookup("Diva")).toBeUndefined();
  });
});
