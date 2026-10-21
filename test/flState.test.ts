import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FlState, type FlSection } from "../src/fl/flState.js";
import type { FlMessage } from "../src/fl/sysex.js";

const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/sysex-vectors.json", import.meta.url), "utf8"),
) as { name: string; message: unknown }[];

/** A message from the shared vectors, optionally with fields replaced. */
function msg(name: string, patch: Record<string, unknown> = {}): FlMessage {
  const vector = vectors.find((v) => v.name === name);
  if (!vector) throw new Error(`no vector ${name}`);
  return { ...(vector.message as object), ...patch } as FlMessage;
}

function setup() {
  const state = new FlState();
  const events: FlSection[] = [];
  state.on("change", (section) => events.push(section));
  return { state, events };
}

describe("FlState", () => {
  it("starts empty", () => {
    const { state } = setup();
    expect(state.connected).toBe(false);
    expect(state.tempo).toBe(0);
    expect(state.channels.size).toBe(0);
    expect(state.selectedChannel.index).toBeNull();
    expect(state.plugin.channel).toBeNull();
  });

  it("starts over on hello and forgets FL on goodbye", () => {
    const { state, events } = setup();
    state.apply(msg("channels"));
    state.apply(msg("hello"));
    expect(state.connected).toBe(true);
    expect(state.version).toBe(2);
    expect(state.channels.size).toBe(0); // the script resends everything after HELLO
    expect(events.filter((e) => e === "connection")).toHaveLength(1);
    expect(events).toHaveLength(1 + 25);

    events.length = 0;
    state.apply({ type: "alive" });
    expect(events).toEqual([]);
    expect(state.connected).toBe(true);

    state.apply({ type: "goodbye" });
    expect(state.connected).toBe(false);
    expect(events).toHaveLength(25);
  });

  it("tells a swing change on its own, and keeps FL's windows and snap mode from UI_STATE", () => {
    const { state, events } = setup();
    state.apply(msg("transport"));
    state.apply(msg("transport", { swing: 0.5 }));
    expect(events).toEqual(["transport", "transport"]);
    expect(state.swing).toBe(0.5);

    events.length = 0;
    expect(state.uiState).toEqual({
      snap: 0,
      visible: [false, false, false, false, false],
      focused: 127,
    });
    state.apply(msg("uiState"));
    expect(events).toEqual(["uiState"]);
    expect(state.uiState).toEqual({
      snap: 8,
      visible: [true, true, false, true, false],
      focused: 3,
    });
    state.apply(msg("uiState")); // nothing changed
    expect(events).toHaveLength(1);
    state.apply(msg("uiState", { focused: 5 }));
    state.apply(msg("uiState", { focused: 5, snap: 13 }));
    state.apply(
      msg("uiState", { focused: 5, snap: 13, visible: [false, true, false, true, false] }),
    );
    expect(events).toHaveLength(4);
    state.apply({ type: "goodbye" });
    expect(state.uiState.focused).toBe(127);
  });

  it("emits transport changes once and only for real changes", () => {
    const { state, events } = setup();
    state.apply(msg("transport"));
    expect(events).toEqual(["transport"]);
    expect(state.transport).toEqual({
      songMode: false,
      playing: true,
      recording: false,
      metronome: true,
      countIn: false,
    });
    expect(state.tempo).toBe(128.5);
    expect(state.swing).toBeCloseTo(0.25, 3);

    state.apply(msg("transport"));
    expect(events).toHaveLength(1);

    state.apply(msg("transport", { tempo: 130 }));
    expect(events).toHaveLength(2);
    expect(state.tempo).toBe(130);

    state.apply(msg("transport", { tempo: 130, state: { ...state.transport, playing: false } }));
    expect(events).toHaveLength(3);
    expect(state.transport.playing).toBe(false);
  });

  it("has the new value ready when the event fires", () => {
    const { state } = setup();
    const seen: number[] = [];
    state.on("change", () => seen.push(state.songPos.bar));
    state.apply(msg("songPos"));
    expect(seen).toEqual([12]);
  });

  it("tracks song position, selection, pattern and track", () => {
    const { state, events } = setup();
    for (const name of ["songPos", "selectedChannel", "selectedTrack", "pattern"]) {
      state.apply(msg(name));
      state.apply(msg(name));
    }
    expect(events).toEqual(["songPos", "selectedChannel", "selectedTrack", "pattern"]);
    expect(state.songPos).toEqual({ bar: 12, step: 3, tick: 0 });
    expect(state.selectedChannel).toMatchObject({ index: 4, name: "Diva", plugin: "Diva" });
    expect(state.selectedTrack).toBe(3);
    expect(state.pattern).toMatchObject({ number: 3, count: 5, length: 16, name: "Pattern 3" });

    state.apply(msg("songPos", { tick: 5 }));
    state.apply(msg("selectedChannel", { volume: 0.5 }));
    state.apply(msg("selectedTrack", { index: 4 }));
    state.apply(msg("pattern", { name: "Renamed" }));
    expect(events).toHaveLength(8);

    state.apply(msg("selectedChannelNone"));
    expect(state.selectedChannel.index).toBeNull();
  });

  it("tracks the selected channel's detail and emits only on change", () => {
    const { state, events } = setup();
    expect(state.channelDetail).toEqual({
      index: null,
      pitch: 0,
      pitchRange: 0,
      cutoff: 0,
      resonance: 0,
      mixerTrack: 0,
      channelType: 0,
    });
    state.apply(msg("channelDetail"));
    state.apply(msg("channelDetail"));
    expect(events).toEqual(["channelDetail"]);
    expect(state.channelDetail).toEqual({
      index: 2,
      pitch: -0.5,
      pitchRange: 2,
      cutoff: 1,
      resonance: 0.25,
      mixerTrack: 5,
      channelType: 2,
    });
    expect("type" in state.channelDetail).toBe(false);

    state.apply(msg("channelDetail", { cutoff: 0.5 }));
    expect(events).toHaveLength(2);

    state.apply(msg("channelDetailNone"));
    expect(state.channelDetail.index).toBeNull();
    expect(events).toHaveLength(3);

    state.apply(msg("channelDetail"));
    state.reset();
    expect(state.channelDetail.index).toBeNull();
    expect(state.channelDetail.cutoff).toBe(0);
  });

  it("stores channel windows by index", () => {
    const { state, events } = setup();
    state.apply(msg("channels"));
    expect(events).toEqual(["channels"]);
    expect(state.channelTotal).toBe(20);
    expect([...state.channels.keys()]).toEqual([4, 5]);
    expect(state.channels.get(5)).toMatchObject({ name: "Hö hat", muted: true, solo: true });
    expect(state.channels.get(4)).toMatchObject({ name: "Kick", muted: false, solo: false });

    state.apply(msg("channels"));
    expect(events).toHaveLength(1);

    // A different window leaves the first one alone.
    state.apply(msg("channels", { offset: 8 }));
    expect(events).toHaveLength(2);
    expect([...state.channels.keys()]).toEqual([4, 5, 8, 9]);

    // Only one entry differs.
    const m = msg("channels") as Extract<FlMessage, { type: "channels" }>;
    state.apply({ ...m, entries: [m.entries[0]!, { ...m.entries[1]!, muted: false }] });
    expect(events).toHaveLength(3);

    // The solo flag alone is a change too.
    state.apply({
      ...m,
      entries: [m.entries[0]!, { ...m.entries[1]!, muted: false, solo: false }],
    });
    expect(events).toHaveLength(4);
    expect(state.channels.get(5)?.solo).toBe(false);
    expect(state.channels.get(5)?.muted).toBe(false);
  });

  it("drops channels at or above the total when it shrinks", () => {
    const { state, events } = setup();
    state.apply(msg("channels"));
    state.apply(msg("channels", { offset: 8 }));
    expect([...state.channels.keys()]).toEqual([4, 5, 8, 9]);

    state.apply(msg("channels", { total: 6 }));
    expect(events).toEqual(["channels", "channels", "channels"]);
    expect(state.channelTotal).toBe(6);
    expect([...state.channels.keys()]).toEqual([4, 5]);

    // Entries beyond the total are not stored.
    state.apply(msg("channels", { total: 5 }));
    expect(state.channels.has(5)).toBe(false);
    state.apply(msg("channels", { total: 5 }));
    expect(events).toHaveLength(4);
  });

  it("stores mixer windows and drops tracks when the total shrinks", () => {
    const { state, events } = setup();
    state.apply(msg("mixer"));
    state.apply(msg("mixer"));
    expect(events).toEqual(["mixer"]);
    expect(state.mixerTotal).toBe(127);
    expect(state.mixer.get(1)).toMatchObject({ name: "Insert 1", solo: true, armed: true });

    state.apply(msg("mixer", { total: 1 }));
    expect(events).toHaveLength(2);
    expect([...state.mixer.keys()]).toEqual([0]);
  });

  it("stores meters at offset + i", () => {
    const { state, events } = setup();
    state.apply(msg("meters"));
    state.apply(msg("meters"));
    expect(events).toEqual(["meters"]);
    expect(state.meters.get(8)).toEqual({ left: 1, right: 0.5 });
    expect(state.meters.get(9)).toEqual({ left: 0, right: 0.25 });

    state.apply(msg("meters", { peaks: [[0, 0]], offset: 9 }));
    expect(events).toHaveLength(2);
    expect(state.meters.get(9)).toEqual({ left: 0, right: 0 });
  });

  it("stores the pattern list and drops patterns above the count", () => {
    const { state, events } = setup();
    state.apply(msg("patterns"));
    state.apply(msg("patterns"));
    expect(events).toEqual(["patterns"]);
    expect(state.patternCount).toBe(5);
    expect(state.patterns.get(1)).toMatchObject({ name: "Verse", current: true });

    state.apply(msg("patterns", { count: 1 }));
    expect(events).toHaveLength(2);
    expect([...state.patterns.keys()]).toEqual([0]);
  });

  it("tracks steps of the current channel and pattern", () => {
    const { state, events } = setup();
    state.apply(msg("stepGrid"));
    state.apply(msg("stepGrid"));
    expect(events).toEqual(["stepGrid"]);
    expect(state.stepGrid.channel).toBe(4);
    expect(state.stepGrid.pattern).toBe(3);
    expect(state.stepGrid.steps.get(16)).toBe(true);
    expect(state.stepGrid.steps.get(17)).toBe(false);
    expect(state.stepGrid.steps.get(31)).toBe(true);

    // Another window of the same channel adds to it.
    state.apply(msg("stepGrid", { offset: 0, steps: [true, true] }));
    expect(events).toHaveLength(2);
    expect(state.stepGrid.steps.get(16)).toBe(true);
    expect(state.stepGrid.steps.get(1)).toBe(true);

    // Another pattern invalidates the old steps.
    state.apply(msg("stepGrid", { pattern: 4, steps: [true] }));
    expect(events).toHaveLength(3);
    expect([...state.stepGrid.steps.keys()]).toEqual([16]);
  });

  it("keeps the pattern overview's steps per channel, a chunk at a time", () => {
    const { state, events } = setup();
    state.apply(msg("pattern", { number: 3 }));
    events.length = 0;
    state.apply(msg("patternGrid")); // channel 5, steps 16–31
    state.apply(msg("patternGrid"));
    expect(events).toEqual(["patternGrid"]);
    const row = state.patternGrid.get(5);
    expect(row?.stepSequencer).toBe(true);
    expect(row?.steps.get(16)).toBe(true);
    expect(row?.steps.get(17)).toBe(false);
    expect(row?.steps.get(31)).toBe(true);
    expect(state.patternGrid.has(4)).toBe(false);

    // Another chunk of the same channel adds to it, another channel has its own row.
    state.apply(msg("patternGrid", { start: 0, steps: [true, true] }));
    state.apply(msg("patternGrid", { channel: 6, start: 0, steps: [false] }));
    expect(events).toHaveLength(3);
    expect(state.patternGrid.get(5)?.steps.get(1)).toBe(true);
    expect(state.patternGrid.get(5)?.steps.get(16)).toBe(true);
    expect(state.patternGrid.get(6)?.steps.get(0)).toBe(false);

    // A chunk that turns a step off, and the flag for a piano roll channel, are changes.
    state.apply(msg("patternGrid", { start: 0, steps: [true, false] }));
    expect(state.patternGrid.get(5)?.steps.get(1)).toBe(false);
    state.apply(msg("patternGrid", { channel: 6, steps: [false], stepSequencer: false }));
    expect(state.patternGrid.get(6)?.stepSequencer).toBe(false);
    expect(events).toHaveLength(5);
  });

  it("clears the overview's steps when the pattern number changes, not for other PATTERN changes", () => {
    const { state, events } = setup();
    state.apply(msg("pattern", { number: 3 }));
    state.apply(msg("patternGrid"));
    events.length = 0;
    state.apply(msg("pattern", { number: 3, name: "Renamed", length: 32 }));
    expect(events).toEqual(["pattern"]);
    expect(state.patternGrid.size).toBe(1);
    state.apply(msg("pattern", { number: 4 }));
    expect(events).toEqual(["pattern", "pattern", "patternGrid"]);
    expect(state.patternGrid.size).toBe(0);
    state.apply(msg("pattern", { number: 5 })); // nothing left to clear: no patternGrid change
    expect(events.filter((e) => e === "patternGrid")).toHaveLength(1);
  });

  it("clears plugin parameters when the plugin changes", () => {
    const { state, events } = setup();
    state.apply(msg("plugin"));
    state.apply(msg("pluginParams"));
    state.apply(msg("pluginParams"));
    expect(events).toEqual(["plugin", "pluginParams"]);
    expect(state.plugin).toEqual({ channel: 4, valid: true, paramCount: 4240, name: "Diva" });
    expect(state.pluginParams.get(300)).toEqual({
      index: 300,
      value: 1,
      name: "Res",
      valueText: "100 %",
    });

    // Same plugin, different parameter count: parameters stay.
    state.apply(msg("plugin", { paramCount: 4241 }));
    expect(events).toEqual(["plugin", "pluginParams", "plugin"]);
    expect(state.pluginParams.size).toBe(2);

    // A different channel: parameters go, and both sections tell.
    state.apply(msg("plugin", { channel: 5 }));
    expect(events.slice(3)).toEqual(["plugin", "pluginParams"]);
    expect(state.pluginParams.size).toBe(0);

    // Nothing to clear: only the plugin section changes.
    state.apply(msg("pluginNone"));
    expect(events.slice(5)).toEqual(["plugin"]);
    expect(state.plugin.channel).toBeNull();
  });

  it("keeps parameter names by index and drops them when the plugin changes", () => {
    const { state, events } = setup();
    state.apply(msg("plugin"));
    state.apply(msg("paramNames"));
    expect(events).toEqual(["plugin", "paramNames"]);
    // Offset 300: three named, the empty one is absent.
    expect([...state.paramNames]).toEqual([
      [300, "main: Output"],
      [301, "VCC: Voices"],
      [303, "Filter: Cutoff"],
    ]);

    state.apply(msg("paramNames"));
    expect(events).toHaveLength(2); // same names: no change
    state.apply(msg("paramNames", { offset: 301, names: ["", "x"] }));
    expect(state.paramNames.has(301)).toBe(false);
    expect(state.paramNames.get(302)).toBe("x");

    // Same plugin with another count: names stay.
    state.apply(msg("plugin", { paramCount: 10 }));
    expect(state.paramNames.size).toBe(3);
    // Another channel: names go.
    events.length = 0;
    state.apply(msg("plugin", { channel: 5 }));
    expect(events).toEqual(["plugin", "paramNames"]);
    expect(state.paramNames.size).toBe(0);
  });

  it("merges plugin parameter updates by index", () => {
    const { state, events } = setup();
    state.apply(msg("pluginParams"));
    state.apply(
      msg("pluginParams", { params: [{ index: 12, value: 0.75, name: "Cutoff", valueText: "x" }] }),
    );
    expect(events).toEqual(["pluginParams", "pluginParams"]);
    expect(state.pluginParams.size).toBe(2);
    expect(state.pluginParams.get(12)?.value).toBe(0.75);
  });

  it("keeps FL's main volume: unknown until the script reports it, 0 is a value", () => {
    const { state, events } = setup();
    expect(state.mainVolume).toBeUndefined();
    state.apply({ ...(msg("transport") as object), mainVolume: undefined } as FlMessage);
    expect(state.mainVolume).toBeUndefined();
    events.length = 0;
    state.apply(msg("transport")); // the shared vector has 0.8
    expect(state.mainVolume).toBeCloseTo(0.8, 3);
    expect(events).toEqual(["transport"]);
    state.apply(msg("transport"));
    expect(events).toHaveLength(1);
    state.apply(msg("transport", { mainVolume: 0 }));
    expect(state.mainVolume).toBe(0);
    expect(events).toHaveLength(2);
    state.reset();
    expect(state.mainVolume).toBeUndefined();
  });

  it("stores the undo state and tells about real changes only", () => {
    const { state, events } = setup();
    expect(state.undoState).toEqual({ position: 0, count: 0, hint: "" });
    state.apply(msg("undoState"));
    expect(state.undoState).toEqual({ position: 3, count: 150, hint: "Move step" });
    expect(events).toEqual(["undoState"]);
    state.apply(msg("undoState"));
    expect(events).toHaveLength(1);
    state.apply(msg("undoState", { hint: "Clear" }));
    expect(events).toHaveLength(2);
    state.reset();
    expect(state.undoState).toEqual({ position: 0, count: 0, hint: "" });
  });

  it("stores the presets window, tells about real changes only and forgets it on reset", () => {
    const { state, events } = setup();
    expect(state.presets).toBeUndefined();
    state.apply(msg("presets"));
    expect(state.presets).toEqual({
      count: 300,
      current: 17,
      offset: 14,
      names: ["Init", "Pad A", "Bass 1", "Lead – wide", "Pluck", "Keys", "Strings", "Brass"],
    });
    expect(events).toEqual(["presets"]);
    state.apply(msg("presets"));
    expect(events).toHaveLength(1);
    state.apply(msg("presets", { current: 18 }));
    expect(events).toHaveLength(2);
    state.apply(msg("presetsNone"));
    expect(state.presets).toEqual({ count: 0, current: null, offset: 0, names: [] });
    expect(events).toHaveLength(3);
    state.reset();
    expect(state.presets).toBeUndefined();
  });

  it("keeps playlist markers by index, drops the ones past the total and tracks the PPQ", () => {
    const { state, events } = setup();
    expect(state.markerTotal).toBe(0);
    expect(state.ppq).toBe(96);
    state.apply(msg("markers"));
    expect(events).toEqual(["markers"]);
    expect(state.markerTotal).toBe(3);
    expect([...state.markers]).toEqual([
      [0, { ticks: 0, name: "Intro" }],
      [1, { ticks: 384, name: "Verse" }],
      [2, { ticks: 1536, name: "Drop" }],
    ]);
    state.apply(msg("markers"));
    expect(events).toHaveLength(1); // nothing changed

    // a list that goes out in parts: the second part starts at offset 8
    state.apply({
      type: "markers",
      total: 9,
      offset: 0,
      entries: Array.from({ length: 8 }, (_, i) => ({ ticks: i * 384, name: `M${i}` })),
      ppq: 96,
    });
    expect(state.markers.size).toBe(8);
    state.apply({
      type: "markers",
      total: 9,
      offset: 8,
      entries: [{ ticks: 8 * 384, name: "M8" }],
      ppq: 96,
    });
    expect(state.markerTotal).toBe(9);
    expect(state.markers.get(8)).toEqual({ ticks: 3072, name: "M8" });

    // a shorter list: entries past the total go, and a new PPQ is a change
    state.apply(msg("markersEmpty"));
    expect(state.markerTotal).toBe(0);
    expect(state.markers.size).toBe(0);
    expect(state.ppq).toBe(480);
    state.apply({ type: "markers", total: 0, offset: 0, entries: [], ppq: 0 });
    expect(state.ppq).toBe(96); // an unreadable PPQ falls back
    state.reset();
    expect(state.markerTotal).toBe(0);
    expect(state.ppq).toBe(96);
  });

  it("reads the loop mode from the transport flags", () => {
    const { state, events } = setup();
    state.apply(msg("transport"));
    expect(state.transport.songMode).toBe(false);
    state.apply(msg("transportSongMode"));
    expect(state.transport.songMode).toBe(true);
    expect(events).toEqual(["transport", "transport"]);
  });

  it("ignores unknown messages", () => {
    const { state, events } = setup();
    state.apply({ type: "unknown", command: 0x3f, payload: [] });
    expect(events).toEqual([]);
  });

  it("forgets everything on reset and tells every section", () => {
    const { state, events } = setup();
    for (const name of ["hello", "transport", "channels", "mixer", "plugin", "pluginParams"]) {
      state.apply(msg(name));
    }
    events.length = 0;

    state.reset();
    expect(new Set(events)).toEqual(
      new Set([
        "connection",
        "transport",
        "songPos",
        "channels",
        "selectedChannel",
        "channelDetail",
        "mixer",
        "selectedTrack",
        "meters",
        "uiState",
        "undoState",
        "presets",
        "markers",
        "loop",
        "features",
        "browserNode",
        "pattern",
        "patterns",
        "stepGrid",
        "patternGrid",
        "plugin",
        "pluginParams",
        "paramNames",
        "liveGrid",
        "activity",
      ]),
    );
    expect(events).toHaveLength(25);
    expect(state.connected).toBe(false);
    expect(state.tempo).toBe(0);
    expect(state.transport.playing).toBe(false);
    expect(state.channels.size).toBe(0);
    expect(state.channelTotal).toBe(0);
    expect(state.mixer.size).toBe(0);
    expect(state.plugin.channel).toBeNull();
    expect(state.pluginParams.size).toBe(0);

    // HELLO tells every section again.
    state.apply(msg("hello"));
    expect(events).toHaveLength(50);
  });
});
