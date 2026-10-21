// The daemon's mirror of FL Studio, built from the messages the FL script sends.
import { EventEmitter } from "node:events";
import type {
  BrowserNodeInfo,
  ChannelDetailInfo,
  ChannelEntry,
  FlMessage,
  LiveGridInfo,
  LiveTrack,
  LoopInfo,
  MarkerEntry,
  MissingFeatures,
  MixerEntry,
  PatternEntry,
  PatternInfo,
  PluginInfo,
  PluginParam,
  PresetsInfo,
  SelectedChannelInfo,
  SongPosition,
  TransportState,
  UiStateInfo,
  UndoStateInfo,
} from "./sysex.js";
import { FOCUS_NONE, UI_WINDOWS } from "./protocol.js";

export type FlSection =
  | "connection"
  | "transport"
  | "songPos"
  | "channels"
  | "selectedChannel"
  | "channelDetail"
  | "mixer"
  | "selectedTrack"
  | "meters"
  | "uiState"
  | "undoState"
  | "presets"
  | "markers"
  | "loop"
  | "features"
  | "browserNode"
  | "pattern"
  | "patterns"
  | "stepGrid"
  | "patternGrid"
  | "plugin"
  | "pluginParams"
  | "paramNames"
  | "liveGrid"
  | "activity";

const SECTIONS: readonly FlSection[] = [
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
];

/** FL's usual timebase (ticks per quarter note), used until MARKERS reports the project's. */
export const DEFAULT_PPQ = 96;

export interface Peak {
  left: number;
  right: number;
}

/** Steps of one channel in one pattern, as far as the step window has shown them. */
export interface StepGrid {
  channel: number | null;
  pattern: number;
  steps: ReadonlyMap<number, boolean>;
}

/** One channel's row of the pattern overview: the steps FL reported, and whether it has a step row. */
export interface ChannelSteps {
  /** Steps by step number, as far as PATTERN_GRID has sent them (a missing step is off). */
  steps: ReadonlyMap<number, boolean>;
  /** False when FL says the channel does not use the step sequencer. True while unknown. */
  stepSequencer: boolean;
}

interface Data {
  connected: boolean;
  version: number;
  transport: TransportState;
  tempo: number;
  swing: number;
  mainVolume: number | undefined;
  songPos: SongPosition;
  /** When the last SONG_POS arrived (the state's clock, ms); undefined before the first. */
  songPosAt: number | undefined;
  channels: Map<number, ChannelEntry>;
  channelTotal: number;
  selectedChannel: SelectedChannelInfo;
  channelDetail: ChannelDetailInfo;
  mixer: Map<number, MixerEntry>;
  mixerTotal: number;
  selectedTrack: number;
  meters: Map<number, Peak>;
  uiState: UiStateInfo;
  undoState: UndoStateInfo;
  /** The last PRESETS message; undefined until one arrived (they only come while BROWSER is shown). */
  presets: PresetsInfo | undefined;
  /** Playlist markers by index (time order), as far as the script has sent them. */
  markers: Map<number, MarkerEntry>;
  markerTotal: number;
  /** FL's ticks per quarter note; `DEFAULT_PPQ` until a MARKERS message says. */
  ppq: number;
  /** The song loop range (LOOP_STATE). */
  loop: LoopInfo;
  /** Hidden FL functions this FL version lacks (FEATURES); all present until it says otherwise. */
  missing: MissingFeatures;
  /** The last BROWSER_NODE (plug-in loader trial); undefined until one arrived. */
  browserNode: BrowserNodeInfo | undefined;
  pattern: PatternInfo;
  patterns: Map<number, PatternEntry>;
  patternCount: number;
  stepGrid: { channel: number | null; pattern: number; steps: Map<number, boolean> };
  /**
   * The current pattern's steps per channel (PATTERN_GRID, only while ARRANGER is shown). The script
   * sends only chunks that changed, so nothing is dropped on a VIEW change; a new pattern number
   * (PATTERN) clears it, and the script then sends every chunk of the new pattern.
   */
  patternGrid: Map<number, { steps: Map<number, boolean>; stepSequencer: boolean }>;
  plugin: PluginInfo;
  pluginParams: Map<number, PluginParam>;
  paramNames: Map<number, string>;
  /** The last LIVE_GRID header (LIVE overlay, SHIFT + SCENE); undefined until one arrived. */
  liveGrid: LiveGridInfo | undefined;
  /** LIVE_TRACK rows by 1-based playlist track (only tracks 1…`liveGrid.scanned` are kept). */
  liveTracks: Map<number, LiveTrack>;
  /** Channels (group-local index) FL is playing now, from the last ACTIVITY. */
  activeChannels: Set<number>;
}

/** FL's windows as far as FL has told us: nothing visible, no focus. */
function emptyUiState(): UiStateInfo {
  return { snap: 0, visible: UI_WINDOWS.map(() => false), focused: FOCUS_NONE };
}

function emptyData(): Data {
  return {
    connected: false,
    version: 0,
    transport: {
      songMode: false,
      playing: false,
      recording: false,
      metronome: false,
      countIn: false,
    },
    tempo: 0,
    swing: 0,
    mainVolume: undefined,
    songPos: { bar: 1, step: 1, tick: 0 },
    songPosAt: undefined,
    channels: new Map(),
    channelTotal: 0,
    selectedChannel: { index: null, color: 0, volume: 0, pan: 0, name: "", plugin: "" },
    channelDetail: {
      index: null,
      pitch: 0,
      pitchRange: 0,
      cutoff: 0,
      resonance: 0,
      mixerTrack: 0,
      channelType: 0,
    },
    mixer: new Map(),
    mixerTotal: 0,
    selectedTrack: 0,
    meters: new Map(),
    uiState: emptyUiState(),
    undoState: { position: 0, count: 0, hint: "" },
    presets: undefined,
    markers: new Map(),
    markerTotal: 0,
    ppq: DEFAULT_PPQ,
    loop: { active: false, start: 0, end: 0 },
    missing: { patternLength: false, loop: false, browser: false, picker: false },
    browserNode: undefined,
    pattern: { number: 0, count: 0, length: 0, color: 0, name: "" },
    patterns: new Map(),
    patternCount: 0,
    stepGrid: { channel: null, pattern: 0, steps: new Map() },
    patternGrid: new Map(),
    plugin: { channel: null, valid: false, paramCount: 0, name: "" },
    pluginParams: new Map(),
    paramNames: new Map(),
    liveGrid: undefined,
    liveTracks: new Map(),
    activeChannels: new Set(),
  };
}

/** Field-by-field comparison of two flat records. */
function same<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((key) => a[key] === b[key]);
}

/** Stores `items` at `offset + i`; true if any entry is new or different. */
function merge<T extends object>(
  map: Map<number, T>,
  offset: number,
  items: T[],
  limit = Infinity,
): boolean {
  let changed = false;
  items.forEach((item, i) => {
    const key = offset + i;
    const old = map.get(key);
    if (key >= limit || (old && same(old, item))) return;
    map.set(key, item);
    changed = true;
  });
  return changed;
}

/** Removes entries at or above `limit`; true if there were any. */
function dropFrom(map: Map<number, unknown>, limit: number): boolean {
  let dropped = false;
  for (const key of map.keys()) {
    if (key < limit) continue;
    map.delete(key);
    dropped = true;
  }
  return dropped;
}

export class FlState extends EventEmitter<{ change: [section: FlSection] }> {
  private data = emptyData();

  /** `clock` (ms) stamps SONG_POS messages; the default is `performance.now()`. */
  constructor(private readonly clock: () => number = () => performance.now()) {
    super();
  }

  /** True after HELLO, until reset(). */
  get connected(): boolean {
    return this.data.connected;
  }
  get version(): number {
    return this.data.version;
  }
  get transport(): Readonly<TransportState> {
    return this.data.transport;
  }
  /** BPM, 0 if unknown. */
  get tempo(): number {
    return this.data.tempo;
  }
  /** FL's main swing, 0–1 (0 while unknown). */
  get swing(): number {
    return this.data.swing;
  }
  /** FL's main volume (`REC_MainVol`), 0–1; undefined until a script that reports it says so. */
  get mainVolume(): number | undefined {
    return this.data.mainVolume;
  }
  /** FL's undo history: position, length and FL's own hint text. */
  get undoState(): Readonly<UndoStateInfo> {
    return this.data.undoState;
  }
  /** FL's snap mode and windows (visible, focused). */
  get uiState(): Readonly<UiStateInfo> {
    return this.data.uiState;
  }
  /**
   * The selected channel's plugin presets as FL last reported them (only while the BROWSER page
   * is shown): the count, the current index and a window of names. Undefined before the first.
   */
  get presets(): Readonly<PresetsInfo> | undefined {
    return this.data.presets;
  }
  /** Playlist markers by index, in time order (the scan runs only while FL is stopped). */
  get markers(): ReadonlyMap<number, MarkerEntry> {
    return this.data.markers;
  }
  get markerTotal(): number {
    return this.data.markerTotal;
  }
  /** Ticks per quarter note (marker ticks and `transport` positions use it). */
  get ppq(): number {
    return this.data.ppq;
  }
  /** The song loop range as FL last reported it. */
  get loop(): Readonly<LoopInfo> {
    return this.data.loop;
  }
  /** Hidden FL functions this FL version lacks. */
  get missing(): Readonly<MissingFeatures> {
    return this.data.missing;
  }
  /** The focused browser node and focus state FL last reported (plug-in loader trial). */
  get browserNode(): Readonly<BrowserNodeInfo> | undefined {
    return this.data.browserNode;
  }
  get songPos(): Readonly<SongPosition> {
    return this.data.songPos;
  }
  /** When the last SONG_POS arrived, on the clock given to the constructor. */
  get songPosAt(): number | undefined {
    return this.data.songPosAt;
  }
  /** Channel window entries by index. */
  get channels(): ReadonlyMap<number, ChannelEntry> {
    return this.data.channels;
  }
  get channelTotal(): number {
    return this.data.channelTotal;
  }
  get selectedChannel(): Readonly<SelectedChannelInfo> {
    return this.data.selectedChannel;
  }
  /** The selected channel's pitch, filter and routing. */
  get channelDetail(): Readonly<ChannelDetailInfo> {
    return this.data.channelDetail;
  }
  /** Mixer window entries by track index. */
  get mixer(): ReadonlyMap<number, MixerEntry> {
    return this.data.mixer;
  }
  get mixerTotal(): number {
    return this.data.mixerTotal;
  }
  get selectedTrack(): number {
    return this.data.selectedTrack;
  }
  /** Latest peaks by track index. */
  get meters(): ReadonlyMap<number, Peak> {
    return this.data.meters;
  }
  get pattern(): Readonly<PatternInfo> {
    return this.data.pattern;
  }
  /** Pattern window entries by 0-based index (entry 0 = pattern 1). */
  get patterns(): ReadonlyMap<number, PatternEntry> {
    return this.data.patterns;
  }
  get patternCount(): number {
    return this.data.patternCount;
  }
  /** Steps by step number. */
  get stepGrid(): StepGrid {
    return this.data.stepGrid;
  }
  /** Steps per channel of the current pattern (the ARRANGER overview); only channels in view. */
  get patternGrid(): ReadonlyMap<number, ChannelSteps> {
    return this.data.patternGrid;
  }
  get plugin(): Readonly<PluginInfo> {
    return this.data.plugin;
  }
  /** Watched plugin parameters by parameter index. */
  get pluginParams(): ReadonlyMap<number, PluginParam> {
    return this.data.pluginParams;
  }
  /** Names of the plugin's named parameters by parameter index (unnamed ones are absent). */
  get paramNames(): ReadonlyMap<number, string> {
    return this.data.paramNames;
  }
  /** The last LIVE_GRID header (LIVE overlay); undefined until one arrived. */
  get liveGrid(): Readonly<LiveGridInfo> | undefined {
    return this.data.liveGrid;
  }
  /** LIVE_TRACK rows by 1-based playlist track; a row's `offset` says which block window it is. */
  get liveTracks(): ReadonlyMap<number, Readonly<LiveTrack>> {
    return this.data.liveTracks;
  }
  /** Is FL playing channel `index` now (ACTIVITY; only the selected channel's bank is reported)? */
  channelActive(index: number): boolean {
    return this.data.activeChannels.has(index);
  }

  /** Updates the mirror; emits `change` once per affected section, only if a value differs. */
  apply(message: FlMessage): void {
    const d = this.data;
    switch (message.type) {
      case "hello":
        // The script (re)started or answers REQUEST_STATE; it sends everything again after this.
        this.data = { ...emptyData(), connected: true, version: message.version };
        for (const section of SECTIONS) this.emit("change", section);
        break;
      case "goodbye":
        this.reset();
        break;
      case "alive":
        break;
      case "transport": {
        const changed =
          !same(d.transport, message.state) ||
          d.tempo !== message.tempo ||
          d.swing !== message.swing ||
          d.mainVolume !== message.mainVolume;
        d.transport = { ...message.state };
        d.tempo = message.tempo;
        d.swing = message.swing;
        d.mainVolume = message.mainVolume;
        this.changed("transport", changed);
        break;
      }
      case "songPos": {
        const songPos = { bar: message.bar, step: message.step, tick: message.tick };
        const changed = !same(d.songPos, songPos);
        d.songPos = songPos;
        d.songPosAt = this.clock();
        this.changed("songPos", changed);
        break;
      }
      case "channels": {
        let changed = d.channelTotal !== message.total;
        d.channelTotal = message.total;
        changed = dropFrom(d.channels, message.total) || changed;
        changed = merge(d.channels, message.offset, message.entries, message.total) || changed;
        this.changed("channels", changed);
        break;
      }
      case "selectedChannel": {
        const selected = {
          index: message.index,
          color: message.color,
          volume: message.volume,
          pan: message.pan,
          name: message.name,
          plugin: message.plugin,
        };
        const changed = !same(d.selectedChannel, selected);
        d.selectedChannel = selected;
        this.changed("selectedChannel", changed);
        break;
      }
      case "channelDetail": {
        const detail = {
          index: message.index,
          pitch: message.pitch,
          pitchRange: message.pitchRange,
          cutoff: message.cutoff,
          resonance: message.resonance,
          mixerTrack: message.mixerTrack,
          channelType: message.channelType,
        };
        const changed = !same(d.channelDetail, detail);
        d.channelDetail = detail;
        this.changed("channelDetail", changed);
        break;
      }
      case "mixer": {
        let changed = d.mixerTotal !== message.total;
        d.mixerTotal = message.total;
        changed = dropFrom(d.mixer, message.total) || changed;
        changed = merge(d.mixer, message.offset, message.entries, message.total) || changed;
        this.changed("mixer", changed);
        break;
      }
      case "selectedTrack": {
        const changed = d.selectedTrack !== message.index;
        d.selectedTrack = message.index;
        this.changed("selectedTrack", changed);
        break;
      }
      case "uiState": {
        const ui = { snap: message.snap, visible: [...message.visible], focused: message.focused };
        const changed =
          d.uiState.snap !== ui.snap ||
          d.uiState.focused !== ui.focused ||
          d.uiState.visible.length !== ui.visible.length ||
          d.uiState.visible.some((on, i) => on !== ui.visible[i]);
        d.uiState = ui;
        this.changed("uiState", changed);
        break;
      }
      case "undoState": {
        const undo = { position: message.position, count: message.count, hint: message.hint };
        const changed = !same(d.undoState, undo);
        d.undoState = undo;
        this.changed("undoState", changed);
        break;
      }
      case "presets": {
        const old = d.presets;
        const presets = {
          count: message.count,
          current: message.current,
          offset: message.offset,
          names: [...message.names],
        };
        const changed =
          !old ||
          old.count !== presets.count ||
          old.current !== presets.current ||
          old.offset !== presets.offset ||
          old.names.length !== presets.names.length ||
          old.names.some((name, i) => name !== presets.names[i]);
        d.presets = presets;
        this.changed("presets", changed);
        break;
      }
      case "markers": {
        const ppq = message.ppq > 0 ? message.ppq : DEFAULT_PPQ;
        let changed = d.markerTotal !== message.total || d.ppq !== ppq;
        d.markerTotal = message.total;
        d.ppq = ppq;
        changed = dropFrom(d.markers, message.total) || changed;
        changed = merge(d.markers, message.offset, message.entries, message.total) || changed;
        this.changed("markers", changed);
        break;
      }
      case "loopState": {
        const loop = { active: message.active, start: message.start, end: message.end };
        const changed = !same(d.loop, loop);
        d.loop = loop;
        this.changed("loop", changed);
        break;
      }
      case "features": {
        const missing = {
          patternLength: message.patternLength,
          loop: message.loop,
          browser: message.browser,
          picker: message.picker,
        };
        const changed = !same(d.missing, missing);
        d.missing = missing;
        this.changed("features", changed);
        break;
      }
      case "browserNode": {
        const node: BrowserNodeInfo = {
          caption: message.caption,
          fileType: message.fileType,
          popup: message.popup,
          browserFocused: message.browserFocused,
          otherFormFocused: message.otherFormFocused,
          formCaption: message.formCaption,
          hint: message.hint,
        };
        const changed = !d.browserNode || !same(d.browserNode, node);
        d.browserNode = node;
        this.changed("browserNode", changed);
        break;
      }
      case "meters": {
        const peaks = message.peaks.map(([left, right]) => ({ left, right }));
        this.changed("meters", merge(d.meters, message.offset, peaks));
        break;
      }
      case "pattern": {
        const pattern = {
          number: message.number,
          count: message.count,
          length: message.length,
          color: message.color,
          name: message.name,
        };
        const changed = !same(d.pattern, pattern);
        // The overview shows the current pattern: another one makes the stored steps stale.
        const other = d.pattern.number !== pattern.number;
        const hadSteps = d.patternGrid.size > 0;
        if (other) d.patternGrid.clear();
        d.pattern = pattern;
        this.changed("pattern", changed);
        this.changed("patternGrid", other && hadSteps);
        break;
      }
      case "patterns": {
        let changed = d.patternCount !== message.count;
        d.patternCount = message.count;
        changed = dropFrom(d.patterns, message.count) || changed;
        changed = merge(d.patterns, message.offset, message.entries, message.count) || changed;
        this.changed("patterns", changed);
        break;
      }
      case "stepGrid": {
        const grid = d.stepGrid;
        // Steps of another channel or pattern are stale.
        let changed = grid.channel !== message.channel || grid.pattern !== message.pattern;
        if (changed) grid.steps.clear();
        grid.channel = message.channel;
        grid.pattern = message.pattern;
        message.steps.forEach((on, i) => {
          const step = message.offset + i;
          if (grid.steps.get(step) === on) return;
          grid.steps.set(step, on);
          changed = true;
        });
        this.changed("stepGrid", changed);
        break;
      }
      case "patternGrid": {
        const row = d.patternGrid.get(message.channel) ?? {
          steps: new Map<number, boolean>(),
          stepSequencer: true,
        };
        const isNew = !d.patternGrid.has(message.channel);
        d.patternGrid.set(message.channel, row);
        let changed = isNew || row.stepSequencer !== message.stepSequencer;
        row.stepSequencer = message.stepSequencer;
        message.steps.forEach((on, i) => {
          const step = message.start + i;
          if (row.steps.get(step) === on) return;
          row.steps.set(step, on);
          changed = true;
        });
        this.changed("patternGrid", changed);
        break;
      }
      case "plugin": {
        const plugin = {
          channel: message.channel,
          valid: message.valid,
          paramCount: message.paramCount,
          name: message.name,
        };
        // Parameter indexes mean something else in another plugin.
        const other = d.plugin.channel !== plugin.channel || d.plugin.name !== plugin.name;
        const hadParams = d.pluginParams.size > 0;
        const hadNames = d.paramNames.size > 0;
        if (other) {
          d.pluginParams.clear();
          d.paramNames.clear();
        }
        const changed = !same(d.plugin, plugin);
        d.plugin = plugin;
        this.changed("plugin", changed);
        this.changed("pluginParams", other && hadParams);
        this.changed("paramNames", other && hadNames);
        break;
      }
      case "pluginParams": {
        let changed = false;
        for (const param of message.params) {
          const old = d.pluginParams.get(param.index);
          if (old && same(old, param)) continue;
          d.pluginParams.set(param.index, param);
          changed = true;
        }
        this.changed("pluginParams", changed);
        break;
      }
      case "paramNames": {
        let changed = false;
        message.names.forEach((name, i) => {
          const index = message.offset + i;
          if (name === "") {
            changed = d.paramNames.delete(index) || changed;
          } else if (d.paramNames.get(index) !== name) {
            d.paramNames.set(index, name);
            changed = true;
          }
        });
        this.changed("paramNames", changed);
        break;
      }
      case "liveGrid": {
        d.liveGrid = { scanned: message.scanned, perf: message.perf };
        for (const track of [...d.liveTracks.keys()]) {
          if (track > message.scanned) d.liveTracks.delete(track);
        }
        this.changed("liveGrid", true);
        break;
      }
      case "liveTrack": {
        d.liveTracks.set(message.track, {
          offset: message.offset,
          track: message.track,
          name: message.name,
          color: message.color,
          muted: message.muted,
          solo: message.solo,
          trigSnap: message.trigSnap,
          blocks: message.blocks,
        });
        this.changed("liveGrid", true);
        break;
      }
      case "activity": {
        const active = new Set<number>();
        message.active.forEach((on, i) => {
          if (on) active.add(message.first + i);
        });
        const before = d.activeChannels;
        const changed =
          active.size !== before.size || [...active].some((index) => !before.has(index));
        d.activeChannels = active;
        this.changed("activity", changed);
        break;
      }
      case "probe": // a diagnostic line: logged by main.ts, not part of the state
      case "unknown":
        break;
    }
  }

  /** FL went away: forget everything and tell every section. */
  reset(): void {
    this.data = emptyData();
    for (const section of SECTIONS) this.emit("change", section);
  }

  private changed(section: FlSection, changed: boolean): void {
    if (changed) this.emit("change", section);
  }
}
