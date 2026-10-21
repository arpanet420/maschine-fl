import {
  CHANNEL_FLAGS,
  CHANNEL_PROPS,
  BROWSE_ACTIONS,
  FEATURE_MISSING,
  FROM_FL,
  MAX_NODE_TEXT,
  NODE_FLAGS,
  NODE_TYPE_BIAS,
  UI_KEYS,
  LIVE_TRACK_FLAGS,
  MAX_LIVE_BLOCKS,
  MAX_PATTERN_GRID_STEPS,
  MAX_PROBE,
  MARKER_TICKS_UNKNOWN,
  MAX_STRING,
  PLAYLIST_VIEWS,
  STRIP_KINDS,
  MIXER_FLAGS,
  NONE,
  NORM_MAX,
  PICKER_NO_MODE,
  PATTERN_FLAGS,
  PATTERN_GRID_FLAGS,
  PEAK_MAX,
  SYSEX_HEADER,
  TEMPO_MAX,
  TEMPO_MIN,
  TO_FL,
  TRACK_PROPS,
  TRANSPORT_FLAGS,
  UI_ACTIONS,
  UI_WINDOWS,
  VIEW_FLAGS,
} from "./protocol.js";

export interface TransportState {
  /** The loop mode is song, not pattern. */
  songMode: boolean;
  playing: boolean;
  recording: boolean;
  metronome: boolean;
  countIn: boolean;
}

export interface SongPosition {
  /** 1-based. */
  bar: number;
  /** 1-based. */
  step: number;
  tick: number;
}

export interface ChannelEntry {
  selected: boolean;
  muted: boolean;
  /** FL's solo flag (`channels.isChannelSolo`). */
  solo: boolean;
  color: number;
  name: string;
}

export interface SelectedChannelInfo {
  /** Null when no channel is selected. */
  index: number | null;
  color: number;
  /** 0–1. */
  volume: number;
  /** −1…1. */
  pan: number;
  name: string;
  /** The generator's plugin name, empty if none. */
  plugin: string;
}

export interface ChannelDetailInfo {
  /** Null when no channel is selected. */
  index: number | null;
  /** −1…1: the pitch knob as a factor of its range. */
  pitch: number;
  /** Semitones. */
  pitchRange: number;
  /** 0–1. */
  cutoff: number;
  /** 0–1. */
  resonance: number;
  /** Mixer track the channel is routed to. */
  mixerTrack: number;
  /** `channels.getChannelType`. */
  channelType: number;
}

export interface MixerEntry {
  selected: boolean;
  muted: boolean;
  solo: boolean;
  armed: boolean;
  color: number;
  volume: number;
  pan: number;
  name: string;
}

export interface PatternInfo {
  /** 1-based. */
  number: number;
  count: number;
  /** In steps. */
  length: number;
  color: number;
  name: string;
}

export interface PatternEntry {
  current: boolean;
  color: number;
  name: string;
}

export interface PluginInfo {
  /** Null when the selected channel has no plugin. */
  channel: number | null;
  valid: boolean;
  /** Index of the last named parameter + 1 (0 while FL's names are still being read). */
  paramCount: number;
  name: string;
}

/** FL's undo history (UNDO_STATE). */
export interface UndoStateInfo {
  /** `general.getUndoHistoryPos()`. */
  position: number;
  /** `general.getUndoHistoryCount()`. */
  count: number;
  /** `general.getUndoLevelHint()`: FL's own short text for the current position. */
  hint: string;
}

/** The song loop range as FL reports it (LOOP_STATE): the playlist time selection, in ticks. */
export interface LoopInfo {
  active: boolean;
  /** Absolute ticks (the unit of MARKERS `ticks`); meaningful while `active`. */
  start: number;
  end: number;
}

/** One live block of a playlist track (`playlist.getLiveBlockStatus`/`getLiveBlockColor`). */
export interface LiveBlock {
  /** `LIVE_BLOCK` bits (filled, scheduled, playing); 0 = empty. */
  status: number;
  /** The clip's color (FL's default gray when it has none set); 0 for an empty block. */
  color: number;
}

/**
 * The LIVE header: `scanned` = how many playlist tracks (1…scanned) LIVE_TRACK rows cover
 * (`LIVE_TRACK_SCAN`, or fewer near the end of `playlist.trackCount()`); `perf` = FL's performance
 * mode is on (blocks read as empty while it is off).
 */
export interface LiveGridInfo {
  scanned: number;
  perf: boolean;
}

/** One playlist track's row of the LIVE window: `blocks[i]` is block `offset + i`. */
export interface LiveTrack {
  offset: number;
  /** 1-based playlist track. */
  track: number;
  name: string;
  color: number;
  muted: boolean;
  solo: boolean;
  /** `playlist.getLiveTrigSnap(track)` as FL returns it (0–127; its meaning is not mapped yet). */
  trigSnap: number;
  blocks: LiveBlock[];
}

/** Hidden FL functions this FL version lacks (FEATURES). */
export interface MissingFeatures {
  /** `patterns.setPatternLength` */
  patternLength: boolean;
  /** `arrangement.selectionSet` / `selectionClear` */
  loop: boolean;
  /** `ui.navigateBrowser` and the other browser functions of the plug-in loader trial */
  browser: boolean;
  /** `ui.showPicker` */
  picker: boolean;
}

/** The focused node of FL's browser and what has the focus (BROWSER_NODE, a trial). */
export interface BrowserNodeInfo {
  /** `ui.getFocusedNodeCaption()` */
  caption: string;
  /** `ui.getFocusedNodeFileType()`; −100 or lower = a folder. */
  fileType: number;
  /** `ui.isInPopupMenu()` */
  popup: boolean;
  /** FL's browser has the focus. */
  browserFocused: boolean;
  /** Another form (the plugin picker?) has the focus. */
  otherFormFocused: boolean;
  /** `ui.getFocusedFormCaption()` */
  formCaption: string;
  /** `ui.getHintMsg()` */
  hint: string;
}

/** FL's windows and snap mode (UI_STATE). */
export interface UiStateInfo {
  /** `ui.getSnapMode()`, 0–127. */
  snap: number;
  /** `ui.getVisible(i)` for the windows in `UI_WINDOWS` (mixer, rack, playlist, piano, browser). */
  visible: boolean[];
  /** The focused window 0–4, `FOCUS_PLUGIN` (5) for a plugin window, `FOCUS_NONE` (127). */
  focused: number;
}

/** The selected channel's plugin presets (PRESETS): the count and a window of names. */
export interface PresetsInfo {
  /** `plugins.getPresetCount`; 0 = none (no plugin, or a plugin without programs). */
  count: number;
  /** Index of the current preset, null when FL's patch name matches none (or it is not known). */
  current: number | null;
  /** Index of `names[0]`. */
  offset: number;
  /** Names of presets `offset … offset + names.length − 1`, at most 8, around `current`. */
  names: string[];
}

/** One playlist marker (MARKERS), in time order. */
export interface MarkerEntry {
  /** Absolute ticks (PPQ ticks per quarter note, see MARKERS `ppq`); null = the script could not tell. */
  ticks: number | null;
  name: string;
}

export interface PluginParam {
  index: number;
  /** 0–1. */
  value: number;
  name: string;
  valueText: string;
}

export type FlMessage =
  | { type: "hello"; version: number }
  /** The script is unloading (FL quits, or the script is reloaded or disabled). */
  | { type: "goodbye" }
  /** Heartbeat, once a second. */
  | { type: "alive" }
  /**
   * `tempo` is in BPM, 0 when the sender sent flags only; `swing` is 0–1, 0 when it is missing.
   * `mainVolume` is FL's main volume (`REC_MainVol`) as 0–1, absent from older senders (unknown).
   */
  | { type: "transport"; state: TransportState; tempo: number; swing: number; mainVolume?: number }
  | ({ type: "songPos" } & SongPosition)
  | { type: "channels"; total: number; offset: number; entries: ChannelEntry[] }
  | ({ type: "selectedChannel" } & SelectedChannelInfo)
  | ({ type: "channelDetail" } & ChannelDetailInfo)
  | { type: "mixer"; total: number; offset: number; entries: MixerEntry[] }
  | { type: "selectedTrack"; index: number }
  | ({ type: "uiState" } & UiStateInfo)
  | ({ type: "undoState" } & UndoStateInfo)
  | ({ type: "loopState" } & LoopInfo)
  | ({ type: "features" } & MissingFeatures)
  | ({ type: "browserNode" } & BrowserNodeInfo)
  | ({ type: "presets" } & PresetsInfo)
  /** Playlist markers `offset … offset + entries.length − 1` of `total`, and FL's PPQ (ticks per quarter note). */
  | { type: "markers"; total: number; offset: number; entries: MarkerEntry[]; ppq: number }
  /** One [left, right] pair of peaks (0–1) per track, starting at `offset`. */
  | { type: "meters"; offset: number; peaks: [number, number][] }
  | ({ type: "pattern" } & PatternInfo)
  | { type: "patterns"; count: number; offset: number; entries: PatternEntry[] }
  /** `steps[i]` is step `offset + i` of `channel` in `pattern`. */
  | { type: "stepGrid"; channel: number; pattern: number; offset: number; steps: boolean[] }
  /**
   * `steps[i]` is step `start + i` (at most 16) of `channel` in the current pattern; `stepSequencer`
   * is false when FL says the channel does not use the step sequencer (a piano roll channel).
   */
  | {
      type: "patternGrid";
      channel: number;
      start: number;
      steps: boolean[];
      stepSequencer: boolean;
    }
  /** Only sent while the LIVE overlay is watching (VIEW's `liveScenes`). */
  | ({ type: "liveGrid" } & LiveGridInfo)
  /** One track's row, at most `MAX_LIVE_BLOCKS` blocks; only while LIVE is watching. */
  | ({ type: "liveTrack" } & LiveTrack)
  /**
   * `active[i]`: FL plays channel `first + i` now (`getActivityLevel > 0`). `first` is the start of
   * the selected channel's bank of 16; sent while FL plays (and once after, to clear).
   */
  | { type: "activity"; first: number; active: boolean[] }
  | ({ type: "plugin" } & PluginInfo)
  | { type: "pluginParams"; params: PluginParam[] }
  /** `names[i]` is the name of parameter `offset + i` ("" = unnamed). */
  | { type: "paramNames"; offset: number; names: string[] }
  /** One line of the playlist probe (a diagnostic): mk3d logs it and does nothing else. */
  | { type: "probe"; text: string }
  | { type: "unknown"; command: number; payload: number[] };

export type ChannelProp = (typeof CHANNEL_PROPS)[number];
export type TrackProp = (typeof TRACK_PROPS)[number];
export type UiAction = (typeof UI_ACTIONS)[number];

export type FlCommand =
  | { type: "requestState" }
  | {
      type: "view";
      channelOffset: number;
      mixerOffset: number;
      patternOffset: number;
      stepOffset: number;
      meters: boolean;
      /** Watch the selected channel's plugin presets (the BROWSER page is shown). */
      presets: boolean;
      /** Send PATTERN_GRID for the channel bank in view (the ARRANGER page is shown). */
      patternGrid: boolean;
      /** Plugin parameters to watch, at most 8. */
      params: number[];
      /** Send LIVE_GRID (the LIVE overlay is shown); false or absent = not watching. */
      liveScenes?: boolean;
      /** The live block window's first block (LIVE overlay), paged like `stepOffset`. */
      liveOffset?: number;
    }
  | { type: "selectChannel"; index: number }
  /** `value` is the raw 0–1 `norm`, also for pan ((pan + 1) / 2). */
  | { type: "setChannel"; index: number; what: ChannelProp; value: number }
  | { type: "setChannelTrack"; index: number; track: number }
  | { type: "showEditor"; index: number }
  | { type: "setStep"; channel: number; step: number; on: boolean }
  | { type: "selectTrack"; index: number }
  | { type: "setTrack"; index: number; what: TrackProp; value: number }
  | { type: "setParam"; param: number; value: number }
  | { type: "selectPattern"; number: number }
  /** Clone pattern `number` (1-based). */
  | { type: "clonePattern"; number: number }
  /** A new empty pattern, selected. */
  | { type: "newPattern" }
  /** Clear every step of `channel` in the current pattern. */
  | { type: "clearSteps"; channel: number }
  /** Project tempo in BPM (the script clamps it to 10–522). */
  | { type: "setTempo"; bpm: number }
  /** Main swing, 0–1. */
  | { type: "setSwing"; value: number }
  /** FL's main volume (`REC_MainVol`), 0–1. */
  | { type: "setMainVolume"; value: number }
  /** Load the previous or next preset of the selected channel's plugin. */
  | { type: "presetStep"; dir: "prev" | "next" }
  /** Show window `window` (0–4, see `UI_WINDOWS`), or hide it if it has the focus. */
  | { type: "showWindow"; window: number }
  /** Set FL's snap mode (`midi.Snap_*`). */
  | { type: "setSnap"; mode: number }
  | { type: "ui"; action: UiAction }
  /** Go to marker `index` (0-based, time order): now, or at the next bar while playing (`quantized`). */
  | { type: "jumpMarker"; index: number; quantized: boolean }
  /** A marker at the play position (`MK3 n`). */
  | { type: "addMarker" }
  /** Loop mode: song (true) or pattern (false). */
  | { type: "setLoopMode"; song: boolean }
  /** FL's playlist: zoom or scroll by `delta` steps (−64…63). */
  | { type: "playlistView"; what: (typeof PLAYLIST_VIEWS)[number]; delta: number }
  /** Scan the markers again (ARRANGER or SCENE opened); FL answers with MARKERS. */
  | { type: "requestMarkers" }
  /** Move the play position to `ticks` (absolute ticks). */
  | { type: "setSongPos"; ticks: number }
  /** Run the playlist probe: FL answers with PROBE lines, one per service pass (MK3D_PROBE=1 only). */
  | { type: "runProbe" }
  /** Send PRESETS for the names `offset … offset + 7` (`current` stays the loaded preset). */
  | { type: "presetWindow"; offset: number }
  /** Load preset `index` of the selected channel's plugin (FL steps there the short way round). */
  | { type: "presetLoad"; index: number }
  /** Resize pattern `pattern` (1-based, at most 127) to `length` steps. */
  | { type: "setPatternLength"; pattern: number; length: number }
  /** Set the song loop range to `start`…`end` ticks; start = end = 0 clears it. */
  | { type: "setLoop"; start: number; end: number }
  /** Send LOOP_STATE. */
  | { type: "requestLoop" }
  /** Set pattern `pattern`'s color (`0xRRGGBB`, the encoding FL's colors come in). */
  | { type: "setPatternColor"; pattern: number; color: number }
  /** Double pattern `pattern` (1-based, at most 127): twice the length, the grid steps copied. */
  /** `native`: try FL's own (hidden) patterns.duplicatePatternData instead of copying the steps (SHIFT + DOUBLE, a trial). */
  | { type: "doublePattern"; pattern: number; native?: boolean }
  /** Create the pattern `number` (1-based, not yet existing) and select it. */
  | { type: "createPattern"; number: number }
  /**
   * The touch strip's value for the selected channel. `pitch`: 0–16383, centre 8192; `mod`: 0–127;
   * `perform`: 0–16383 = 0…1. `release`: the finger lifted (the value is the last one).
   */
  | { type: "strip"; kind: StripKind; value: number; release: boolean }
  /** Transpose the notes of `channel` in the current pattern by `semitones` (−64…63). */
  | { type: "transpose"; channel: number; semitones: number }
  /** Plug-in loader trial: act on FL's browser; FL answers with BROWSER_NODE. */
  | { type: "browse"; action: BrowseAction }
  /** Plug-in loader trial: a plain FL key for the focused window / menu / picker; FL answers with BROWSER_NODE. */
  | { type: "uiKey"; key: UiKey }
  /** Plug-in loader trial: `ui.showPicker(show)` or, with a `mode` (0–63), `ui.showPicker(show, mode)`. */
  | { type: "picker"; show: boolean; mode: number | null }
  /**
   * Fire scene `block` (null = stop), the way Image-Line's Akai Fire script does: one
   * `playlist.triggerLiveClip(track, block, TLC_MuteOthers | TLC_Fill | TLC_ColumnMode [|
   * TLC_GlobalSnap])` on the first scanned track filled there (ColumnMode is FL's scene trigger).
   * `release` (the pad came up) repeats that call with `TLC_Release`. Null stops every scanned
   * track (`subNum -1`).
   */
  | { type: "triggerLiveClip"; block: number | null; release: boolean };

export type BrowseAction = (typeof BROWSE_ACTIONS)[number];
export type UiKey = (typeof UI_KEYS)[number];

export type StripKind = (typeof STRIP_KINDS)[number];

// ── Framing ──────────────────────────────────────────────────────────────────

export function encodeSysex(command: number, payload: number[] = []): number[] {
  for (const byte of payload) {
    if (byte < 0 || byte > 0x7f) throw new RangeError(`SysEx payload byte ${byte} is not 7-bit`);
  }
  return [...SYSEX_HEADER, command, ...payload, 0xf7];
}

/** Command and payload of one of our frames; undefined for anything else. */
function unframe(bytes: ArrayLike<number>): { command: number; payload: number[] } | undefined {
  const data = Array.from(bytes);
  if (data.length < SYSEX_HEADER.length + 2) return undefined;
  if (!SYSEX_HEADER.every((b, i) => data[i] === b)) return undefined;
  if (data[data.length - 1] !== 0xf7) return undefined;
  return {
    command: data[SYSEX_HEADER.length] ?? 0,
    payload: data.slice(SYSEX_HEADER.length + 1, -1),
  };
}

// ── Field codecs ─────────────────────────────────────────────────────────────

const round = (x: number) => Math.floor(x + 0.5);
const clampInt = (x: number, max: number) => Math.min(max, Math.max(0, round(x)));
const clamp01 = (x: number) => (x > 0 ? Math.min(1, x) : 0);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Writes fields in docs/sysex.md encoding. Out-of-range numbers are clamped. */
class Writer {
  readonly bytes: number[] = [];

  u7(value: number): this {
    this.bytes.push(clampInt(value, 0x7f));
    return this;
  }

  u14(value: number): this {
    const v = clampInt(value, 0x3fff);
    this.bytes.push(v >> 7, v & 0x7f);
    return this;
  }

  u21(value: number): this {
    const v = clampInt(value, 0x1fffff);
    this.bytes.push(v >> 14, (v >> 7) & 0x7f, v & 0x7f);
    return this;
  }

  /** Signed 7-bit: −64…63 sent as 0…127. */
  s7(value: number): this {
    this.bytes.push(Math.min(127, Math.max(0, round(value) + 64)));
    return this;
  }

  /** `u14` or the `none` value for null. */
  index(value: number | null): this {
    return this.u14(value ?? NONE);
  }

  flag(on: boolean): this {
    return this.u7(on ? 1 : 0);
  }

  norm(value: number): this {
    return this.u14(round(clamp01(value) * NORM_MAX));
  }

  /** −1…1. */
  pan(value: number): this {
    return this.norm((value + 1) / 2);
  }

  /** Peak 0–1 as `u7`. */
  peak(value: number): this {
    return this.u7(round(clamp01(value) * PEAK_MAX));
  }

  color(value: number): this {
    const c = value & 0xffffff; // FL's signed colors
    this.bytes.push((c >> 21) & 0x7f, (c >> 14) & 0x7f, (c >> 7) & 0x7f, c & 0x7f);
    return this;
  }

  str(value: string, max = MAX_STRING): this {
    const text = Array.from(value)
      .slice(0, max)
      .filter((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      })
      .join("");
    for (const b of textEncoder.encode(text)) {
      if (b < 0x7f) this.bytes.push(b);
      else this.bytes.push(0x7f, b & 0x7f);
    }
    this.bytes.push(0);
    return this;
  }

  /** A `u7` count followed by the entries. */
  list<T>(items: T[], write: (item: T) => void): this {
    this.u7(items.length);
    items.forEach(write);
    return this;
  }
}

class BadFrame extends Error {}

/** Reads fields from a payload. Throws BadFrame when the payload is too short or not 7-bit. */
class Reader {
  private pos = 0;

  constructor(private readonly bytes: number[]) {}

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  u7(): number {
    const b = this.bytes[this.pos++];
    if (b === undefined || b > 0x7f) throw new BadFrame("truncated or non-7-bit payload");
    return b;
  }

  u14(): number {
    return (this.u7() << 7) | this.u7();
  }

  u21(): number {
    return (this.u7() << 14) | (this.u7() << 7) | this.u7();
  }

  s7(): number {
    return this.u7() - 64;
  }

  /** Null for the `none` value. */
  index(): number | null {
    const v = this.u14();
    return v === NONE ? null : v;
  }

  flag(): boolean {
    return this.u7() !== 0;
  }

  norm(): number {
    return this.u14() / NORM_MAX;
  }

  pan(): number {
    return this.norm() * 2 - 1;
  }

  peak(): number {
    return this.u7() / PEAK_MAX;
  }

  color(): number {
    return ((this.u7() << 21) | (this.u7() << 14) | (this.u7() << 7) | this.u7()) & 0xffffff;
  }

  str(): string {
    const raw: number[] = [];
    for (;;) {
      const b = this.u7();
      if (b === 0) break;
      raw.push(b === 0x7f ? 0x80 | this.u7() : b);
    }
    return textDecoder.decode(Uint8Array.from(raw));
  }

  list<T>(read: () => T): T[] {
    const n = this.u7();
    return Array.from({ length: n }, read);
  }
}

const has = (flags: number, mask: number) => (flags & mask) !== 0;
const flagBits = (...flags: [boolean, number][]) =>
  flags.reduce((bits, [on, mask]) => (on ? bits | mask : bits), 0);

/** Wire value for a name in one of the PROP/ACTION tables. */
const codeOf = (table: readonly string[], name: string) => table.indexOf(name);

function nameOf<T extends string>(table: readonly T[], code: number): T {
  const name = table[code];
  if (name === undefined) throw new BadFrame(`unknown code ${code}`);
  return name;
}

// ── FL → mk3d ────────────────────────────────────────────────────────────────

/** Undefined for anything that isn't one of our frames or is cut short. */
export function decodeSysex(bytes: ArrayLike<number>): FlMessage | undefined {
  const frame = unframe(bytes);
  if (!frame) return undefined;
  try {
    return readFlMessage(frame.command, frame.payload, new Reader(frame.payload));
  } catch (error) {
    if (error instanceof BadFrame) return undefined;
    throw error;
  }
}

function readFlMessage(command: number, payload: number[], r: Reader): FlMessage {
  switch (command) {
    case FROM_FL.hello:
      return { type: "hello", version: r.u7() };
    case FROM_FL.goodbye:
      return { type: "goodbye" };
    case FROM_FL.alive:
      return { type: "alive" };
    case FROM_FL.transport: {
      const flags = r.u7();
      return {
        type: "transport",
        state: {
          songMode: has(flags, TRANSPORT_FLAGS.songMode),
          playing: has(flags, TRANSPORT_FLAGS.playing),
          recording: has(flags, TRANSPORT_FLAGS.recording),
          metronome: has(flags, TRANSPORT_FLAGS.metronome),
          countIn: has(flags, TRANSPORT_FLAGS.countIn),
        },
        tempo: r.remaining >= 3 ? r.u21() / 100 : 0,
        swing: r.remaining >= 2 ? r.norm() : 0,
        ...(r.remaining >= 2 ? { mainVolume: r.norm() } : {}),
      };
    }
    case FROM_FL.songPos:
      return { type: "songPos", bar: r.u14(), step: r.u7(), tick: r.u14() };
    case FROM_FL.channels:
      return {
        type: "channels",
        total: r.u14(),
        offset: r.u14(),
        entries: r.list(() => {
          const flags = r.u7();
          return {
            selected: has(flags, CHANNEL_FLAGS.selected),
            muted: has(flags, CHANNEL_FLAGS.muted),
            solo: has(flags, CHANNEL_FLAGS.solo),
            color: r.color(),
            name: r.str(),
          };
        }),
      };
    case FROM_FL.selectedChannel:
      return {
        type: "selectedChannel",
        index: r.index(),
        color: r.color(),
        volume: r.norm(),
        pan: r.pan(),
        name: r.str(),
        plugin: r.str(),
      };
    case FROM_FL.channelDetail:
      return {
        type: "channelDetail",
        index: r.index(),
        pitch: r.pan(),
        pitchRange: r.u7(),
        cutoff: r.norm(),
        resonance: r.norm(),
        mixerTrack: r.u14(),
        channelType: r.u7(),
      };
    case FROM_FL.mixer:
      return {
        type: "mixer",
        total: r.u14(),
        offset: r.u14(),
        entries: r.list(() => {
          const flags = r.u7();
          return {
            selected: has(flags, MIXER_FLAGS.selected),
            muted: has(flags, MIXER_FLAGS.muted),
            solo: has(flags, MIXER_FLAGS.solo),
            armed: has(flags, MIXER_FLAGS.armed),
            color: r.color(),
            volume: r.norm(),
            pan: r.pan(),
            name: r.str(),
          };
        }),
      };
    case FROM_FL.selectedTrack:
      return { type: "selectedTrack", index: r.u14() };
    case FROM_FL.uiState: {
      const snap = r.u7();
      const visible = r.u7();
      return {
        type: "uiState",
        snap,
        visible: UI_WINDOWS.map((_, i) => has(visible, 1 << i)),
        focused: r.u7(),
      };
    }
    case FROM_FL.undoState:
      return { type: "undoState", position: r.u14(), count: r.u14(), hint: r.str() };
    case FROM_FL.presets:
      return {
        type: "presets",
        count: r.u14(),
        current: r.index(),
        ...readPresetNames(r),
      };
    case FROM_FL.loopState: {
      const active = r.flag();
      return { type: "loopState", active, start: r.u21(), end: r.u21() };
    }
    case FROM_FL.features: {
      const missing = r.u7();
      return {
        type: "features",
        patternLength: has(missing, FEATURE_MISSING.patternLength),
        loop: has(missing, FEATURE_MISSING.loop),
        browser: has(missing, FEATURE_MISSING.browser),
        picker: has(missing, FEATURE_MISSING.picker),
      };
    }
    case FROM_FL.browserNode: {
      const caption = r.str();
      const fileType = r.u14() - NODE_TYPE_BIAS;
      const flags = r.u7();
      return {
        type: "browserNode",
        caption,
        fileType,
        popup: has(flags, NODE_FLAGS.popup),
        browserFocused: has(flags, NODE_FLAGS.browserFocused),
        otherFormFocused: has(flags, NODE_FLAGS.otherFormFocused),
        formCaption: r.str(),
        hint: r.str(),
      };
    }
    case FROM_FL.markers: {
      const total = r.u7();
      const offset = r.u7();
      const entries = r.list(() => {
        const ticks = r.u21();
        return { ticks: ticks === MARKER_TICKS_UNKNOWN ? null : ticks, name: r.str() };
      });
      return { type: "markers", total, offset, entries, ppq: r.u14() };
    }
    case FROM_FL.probe:
      return { type: "probe", text: r.str() };
    case FROM_FL.meters:
      return {
        type: "meters",
        offset: r.u14(),
        peaks: r.list((): [number, number] => [r.peak(), r.peak()]),
      };
    case FROM_FL.pattern:
      return {
        type: "pattern",
        number: r.u14(),
        count: r.u14(),
        length: r.u14(),
        color: r.color(),
        name: r.str(),
      };
    case FROM_FL.patterns:
      return {
        type: "patterns",
        count: r.u14(),
        offset: r.u14(),
        entries: r.list(() => ({
          current: has(r.u7(), PATTERN_FLAGS.current),
          color: r.color(),
          name: r.str(),
        })),
      };
    case FROM_FL.stepGrid: {
      const channel = r.u14();
      const pattern = r.u14();
      const offset = r.u14();
      const n = r.u7();
      const bits = r.u21();
      return {
        type: "stepGrid",
        channel,
        pattern,
        offset,
        steps: Array.from({ length: n }, (_, i) => has(bits, 1 << i)),
      };
    }
    case FROM_FL.patternGrid: {
      const channel = r.u7();
      const start = r.u14();
      const n = r.u7();
      if (n > MAX_PATTERN_GRID_STEPS) throw new BadFrame(`PATTERN_GRID n ${n} is over 16`);
      const steps: boolean[] = [];
      for (let first = 0; first < n; first += 7) {
        const bits = r.u7();
        for (let i = 0; i < 7 && first + i < n; i++) steps.push(has(bits, 1 << i));
      }
      return {
        type: "patternGrid",
        channel,
        start,
        steps,
        stepSequencer: has(r.u7(), PATTERN_GRID_FLAGS.stepSequencer),
      };
    }
    case FROM_FL.plugin:
      return {
        type: "plugin",
        channel: r.index(),
        valid: r.flag(),
        paramCount: r.u14(),
        name: r.str(),
      };
    case FROM_FL.pluginParams:
      return {
        type: "pluginParams",
        params: r.list(() => ({
          index: r.u14(),
          value: r.norm(),
          name: r.str(),
          valueText: r.str(),
        })),
      };
    case FROM_FL.paramNames:
      return { type: "paramNames", offset: r.u14(), names: r.list(() => r.str()) };
    case FROM_FL.liveGrid:
      return { type: "liveGrid", scanned: r.u7(), perf: r.flag() };
    case FROM_FL.liveTrack: {
      const offset = r.u14();
      const track = r.u7();
      const flags = r.u7();
      const color = r.color();
      const trigSnap = r.u7();
      const name = r.str();
      const blocks = r.list(() => ({ status: r.u7(), color: r.color() }));
      if (blocks.length > MAX_LIVE_BLOCKS)
        throw new BadFrame(`LIVE_TRACK n ${blocks.length} is over 16`);
      return {
        type: "liveTrack",
        offset,
        track,
        name,
        color,
        muted: has(flags, LIVE_TRACK_FLAGS.muted),
        solo: has(flags, LIVE_TRACK_FLAGS.solo),
        trigSnap,
        blocks,
      };
    }
    case FROM_FL.activity: {
      const first = r.u14();
      const active = r.list(() => r.flag());
      if (active.length > 16) throw new BadFrame(`ACTIVITY n ${active.length} is over 16`);
      return { type: "activity", first, active };
    }
    default:
      return { type: "unknown", command, payload };
  }
}

/** `u7 n`, `u14 offset`, n × `str name` (PRESETS). */
function readPresetNames(r: Reader): { offset: number; names: string[] } {
  const n = r.u7();
  const offset = r.u14();
  return { offset, names: Array.from({ length: n }, () => r.str()) };
}

/** The bytes FL's script would send. Used for tests; the daemon only decodes these. */
export function encodeFlMessage(message: FlMessage): number[] {
  if (message.type === "unknown") return encodeSysex(message.command, message.payload);
  const w = new Writer();
  switch (message.type) {
    case "hello":
      w.u7(message.version);
      break;
    case "goodbye":
    case "alive":
      break;
    case "transport": {
      const s = message.state;
      w.u7(
        flagBits(
          [s.playing, TRANSPORT_FLAGS.playing],
          [s.recording, TRANSPORT_FLAGS.recording],
          [s.metronome, TRANSPORT_FLAGS.metronome],
          [s.countIn, TRANSPORT_FLAGS.countIn],
          [s.songMode, TRANSPORT_FLAGS.songMode],
        ),
      )
        .u21(message.tempo * 100)
        .norm(message.swing);
      if (message.mainVolume !== undefined) w.norm(message.mainVolume);
      break;
    }
    case "songPos":
      w.u14(message.bar).u7(message.step).u14(message.tick);
      break;
    case "channels":
      w.u14(message.total)
        .u14(message.offset)
        .list(message.entries, (e) =>
          w
            .u7(
              flagBits(
                [e.selected, CHANNEL_FLAGS.selected],
                [e.muted, CHANNEL_FLAGS.muted],
                [e.solo, CHANNEL_FLAGS.solo],
              ),
            )
            .color(e.color)
            .str(e.name),
        );
      break;
    case "selectedChannel":
      w.index(message.index)
        .color(message.color)
        .norm(message.volume)
        .pan(message.pan)
        .str(message.name)
        .str(message.plugin);
      break;
    case "channelDetail":
      w.index(message.index)
        .pan(message.pitch)
        .u7(message.pitchRange)
        .norm(message.cutoff)
        .norm(message.resonance)
        .u14(message.mixerTrack)
        .u7(message.channelType);
      break;
    case "mixer":
      w.u14(message.total)
        .u14(message.offset)
        .list(message.entries, (e) =>
          w
            .u7(
              flagBits(
                [e.selected, MIXER_FLAGS.selected],
                [e.muted, MIXER_FLAGS.muted],
                [e.solo, MIXER_FLAGS.solo],
                [e.armed, MIXER_FLAGS.armed],
              ),
            )
            .color(e.color)
            .norm(e.volume)
            .pan(e.pan)
            .str(e.name),
        );
      break;
    case "selectedTrack":
      w.u14(message.index);
      break;
    case "uiState":
      w.u7(message.snap)
        .u7(message.visible.reduce((bits, on, i) => (on ? bits | (1 << i) : bits), 0))
        .u7(message.focused);
      break;
    case "undoState":
      w.u14(message.position).u14(message.count).str(message.hint);
      break;
    case "loopState":
      w.flag(message.active).u21(message.start).u21(message.end);
      break;
    case "features":
      w.u7(
        flagBits(
          [message.patternLength, FEATURE_MISSING.patternLength],
          [message.loop, FEATURE_MISSING.loop],
          [message.browser, FEATURE_MISSING.browser],
          [message.picker, FEATURE_MISSING.picker],
        ),
      );
      break;
    case "browserNode":
      w.str(message.caption, MAX_NODE_TEXT)
        .u14(message.fileType + NODE_TYPE_BIAS)
        .u7(
          flagBits(
            [message.popup, NODE_FLAGS.popup],
            [message.browserFocused, NODE_FLAGS.browserFocused],
            [message.otherFormFocused, NODE_FLAGS.otherFormFocused],
          ),
        )
        .str(message.formCaption, MAX_NODE_TEXT)
        .str(message.hint, MAX_NODE_TEXT);
      break;
    case "presets":
      w.u14(message.count).index(message.current).u7(message.names.length).u14(message.offset);
      message.names.forEach((name) => w.str(name));
      break;
    case "markers":
      w.u7(message.total)
        .u7(message.offset)
        .list(message.entries, (e) => w.u21(e.ticks ?? MARKER_TICKS_UNKNOWN).str(e.name))
        .u14(message.ppq);
      break;
    case "probe":
      w.str(message.text, MAX_PROBE);
      break;
    case "meters":
      w.u14(message.offset).list(message.peaks, ([left, right]) => w.peak(left).peak(right));
      break;
    case "pattern":
      w.u14(message.number)
        .u14(message.count)
        .u14(message.length)
        .color(message.color)
        .str(message.name);
      break;
    case "patterns":
      w.u14(message.count)
        .u14(message.offset)
        .list(message.entries, (e) =>
          w
            .u7(flagBits([e.current, PATTERN_FLAGS.current]))
            .color(e.color)
            .str(e.name),
        );
      break;
    case "stepGrid":
      w.u14(message.channel)
        .u14(message.pattern)
        .u14(message.offset)
        .u7(message.steps.length)
        .u21(message.steps.reduce((bits, on, i) => (on ? bits | (1 << i) : bits), 0));
      break;
    case "patternGrid": {
      const steps = message.steps.slice(0, MAX_PATTERN_GRID_STEPS);
      w.u7(message.channel).u14(message.start).u7(steps.length);
      for (let first = 0; first < steps.length; first += 7) {
        w.u7(
          steps.slice(first, first + 7).reduce((bits, on, i) => (on ? bits | (1 << i) : bits), 0),
        );
      }
      w.u7(flagBits([message.stepSequencer, PATTERN_GRID_FLAGS.stepSequencer]));
      break;
    }
    case "plugin":
      w.index(message.channel).flag(message.valid).u14(message.paramCount).str(message.name);
      break;
    case "pluginParams":
      w.list(message.params, (p) => w.u14(p.index).norm(p.value).str(p.name).str(p.valueText));
      break;
    case "paramNames":
      w.u14(message.offset).list(message.names, (name) => w.str(name));
      break;
    case "liveGrid":
      w.u7(message.scanned).flag(message.perf);
      break;
    case "liveTrack":
      w.u14(message.offset)
        .u7(message.track)
        .u7(
          flagBits([message.muted, LIVE_TRACK_FLAGS.muted], [message.solo, LIVE_TRACK_FLAGS.solo]),
        )
        .color(message.color)
        .u7(message.trigSnap)
        .str(message.name)
        .list(message.blocks.slice(0, MAX_LIVE_BLOCKS), (b) => w.u7(b.status).color(b.color));
      break;
    case "activity":
      w.u14(message.first).list(message.active, (on) => w.flag(on));
      break;
  }
  return encodeSysex(FROM_FL[message.type], w.bytes);
}

// ── mk3d → FL ────────────────────────────────────────────────────────────────

export function encodeCommand(command: FlCommand): number[] {
  const w = new Writer();
  switch (command.type) {
    case "requestState":
      break;
    case "view":
      w.u14(command.channelOffset)
        .u14(command.mixerOffset)
        .u14(command.patternOffset)
        .u14(command.stepOffset)
        .u7(
          flagBits(
            [command.meters, VIEW_FLAGS.meters],
            [command.presets, VIEW_FLAGS.presets],
            [command.patternGrid, VIEW_FLAGS.patternGrid],
          ),
        )
        .list(command.params, (p) => w.u14(p))
        .flag(command.liveScenes ?? false)
        .u14(command.liveOffset ?? 0);
      break;
    case "selectChannel":
    case "selectTrack":
    case "showEditor":
      w.u14(command.index);
      break;
    case "setChannelTrack":
      w.u14(command.index).u14(command.track);
      break;
    case "setChannel":
    case "setTrack":
      w.u14(command.index)
        .u7(codeOf(command.type === "setChannel" ? CHANNEL_PROPS : TRACK_PROPS, command.what))
        .norm(command.value);
      break;
    case "setStep":
      w.u14(command.channel).u14(command.step).flag(command.on);
      break;
    case "setParam":
      w.u14(command.param).norm(command.value);
      break;
    case "selectPattern":
    case "clonePattern":
      w.u14(command.number);
      break;
    case "newPattern":
      break;
    case "clearSteps":
      w.u14(command.channel);
      break;
    case "setTempo":
      w.u21(Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, command.bpm)) * 100);
      break;
    case "setSwing":
    case "setMainVolume":
      w.norm(command.value);
      break;
    case "showWindow":
      w.u7(command.window);
      break;
    case "presetStep":
      w.u7(command.dir === "next" ? 1 : 0);
      break;
    case "presetWindow":
      w.u14(command.offset);
      break;
    case "presetLoad":
      w.u14(command.index);
      break;
    case "setSnap":
      w.u7(command.mode);
      break;
    case "ui":
      w.u7(codeOf(UI_ACTIONS, command.action));
      break;
    case "jumpMarker":
      w.u7(command.index).flag(command.quantized);
      break;
    case "addMarker":
    case "requestMarkers":
    case "runProbe":
      break;
    case "setLoopMode":
      w.flag(command.song);
      break;
    case "playlistView":
      w.u7(codeOf(PLAYLIST_VIEWS, command.what)).s7(command.delta);
      break;
    case "setSongPos":
      w.u21(command.ticks);
      break;
    case "setPatternLength":
      w.u7(command.pattern).u14(command.length);
      break;
    case "setLoop":
      w.u21(command.start).u21(command.end);
      break;
    case "requestLoop":
      break;
    case "strip":
      w.u7(codeOf(STRIP_KINDS, command.kind)).u14(command.value).flag(command.release);
      break;
    case "transpose":
      w.u14(command.channel).s7(command.semitones);
      break;
    case "browse":
      w.u7(codeOf(BROWSE_ACTIONS, command.action));
      break;
    case "uiKey":
      w.u7(codeOf(UI_KEYS, command.key));
      break;
    case "picker":
      w.flag(command.show).s7(command.mode ?? PICKER_NO_MODE);
      break;
    case "triggerLiveClip":
      w.index(command.block).flag(command.release);
      break;
    case "setPatternColor":
      w.u14(command.pattern).color(command.color);
      break;
    case "doublePattern":
      w.u7(command.pattern);
      if (command.native) w.u7(1); // optional trailing mode byte; absent = copy the steps
      break;
    case "createPattern":
      w.u14(command.number);
      break;
  }
  return encodeSysex(TO_FL[command.type], w.bytes);
}

/** What the FL script would receive. Used for tests; the daemon only encodes these. */
export function decodeCommand(bytes: ArrayLike<number>): FlCommand | undefined {
  const frame = unframe(bytes);
  if (!frame) return undefined;
  try {
    return readCommand(frame.command, new Reader(frame.payload));
  } catch (error) {
    if (error instanceof BadFrame) return undefined;
    throw error;
  }
}

function readCommand(command: number, r: Reader): FlCommand | undefined {
  switch (command) {
    case TO_FL.requestState:
      return { type: "requestState" };
    case TO_FL.view: {
      const channelOffset = r.u14();
      const mixerOffset = r.u14();
      const patternOffset = r.u14();
      const stepOffset = r.u14();
      const flags = r.u7();
      return {
        type: "view",
        channelOffset,
        mixerOffset,
        patternOffset,
        stepOffset,
        meters: has(flags, VIEW_FLAGS.meters),
        presets: has(flags, VIEW_FLAGS.presets),
        patternGrid: has(flags, VIEW_FLAGS.patternGrid),
        params: r.list(() => r.u14()),
        liveScenes: r.flag(),
        liveOffset: r.u14(),
      };
    }
    case TO_FL.selectChannel:
      return { type: "selectChannel", index: r.u14() };
    case TO_FL.setChannel:
      return {
        type: "setChannel",
        index: r.u14(),
        what: nameOf(CHANNEL_PROPS, r.u7()),
        value: r.norm(),
      };
    case TO_FL.setChannelTrack:
      return { type: "setChannelTrack", index: r.u14(), track: r.u14() };
    case TO_FL.showEditor:
      return { type: "showEditor", index: r.u14() };
    case TO_FL.setStep:
      return { type: "setStep", channel: r.u14(), step: r.u14(), on: r.flag() };
    case TO_FL.selectTrack:
      return { type: "selectTrack", index: r.u14() };
    case TO_FL.setTrack:
      return {
        type: "setTrack",
        index: r.u14(),
        what: nameOf(TRACK_PROPS, r.u7()),
        value: r.norm(),
      };
    case TO_FL.setParam:
      return { type: "setParam", param: r.u14(), value: r.norm() };
    case TO_FL.selectPattern:
      return { type: "selectPattern", number: r.u14() };
    case TO_FL.clonePattern:
      return { type: "clonePattern", number: r.u14() };
    case TO_FL.newPattern:
      return { type: "newPattern" };
    case TO_FL.clearSteps:
      return { type: "clearSteps", channel: r.u14() };
    case TO_FL.setTempo:
      return { type: "setTempo", bpm: r.u21() / 100 };
    case TO_FL.setSwing:
      return { type: "setSwing", value: r.norm() };
    case TO_FL.setMainVolume:
      return { type: "setMainVolume", value: r.norm() };
    case TO_FL.showWindow:
      return { type: "showWindow", window: r.u7() };
    case TO_FL.presetStep:
      return { type: "presetStep", dir: r.u7() === 0 ? "prev" : "next" };
    case TO_FL.setSnap:
      return { type: "setSnap", mode: r.u7() };
    case TO_FL.ui:
      return { type: "ui", action: nameOf(UI_ACTIONS, r.u7()) };
    case TO_FL.jumpMarker:
      return { type: "jumpMarker", index: r.u7(), quantized: r.flag() };
    case TO_FL.addMarker:
      return { type: "addMarker" };
    case TO_FL.setLoopMode:
      return { type: "setLoopMode", song: r.flag() };
    case TO_FL.playlistView:
      return { type: "playlistView", what: nameOf(PLAYLIST_VIEWS, r.u7()), delta: r.s7() };
    case TO_FL.requestMarkers:
      return { type: "requestMarkers" };
    case TO_FL.setSongPos:
      return { type: "setSongPos", ticks: r.u21() };
    case TO_FL.runProbe:
      return { type: "runProbe" };
    case TO_FL.presetWindow:
      return { type: "presetWindow", offset: r.u14() };
    case TO_FL.presetLoad:
      return { type: "presetLoad", index: r.u14() };
    case TO_FL.setPatternLength:
      return { type: "setPatternLength", pattern: r.u7(), length: r.u14() };
    case TO_FL.setLoop:
      return { type: "setLoop", start: r.u21(), end: r.u21() };
    case TO_FL.requestLoop:
      return { type: "requestLoop" };
    case TO_FL.setPatternColor:
      return { type: "setPatternColor", pattern: r.u14(), color: r.color() };
    case TO_FL.doublePattern: {
      const pattern = r.u7();
      return r.remaining >= 1 && r.u7() === 1
        ? { type: "doublePattern", pattern, native: true }
        : { type: "doublePattern", pattern };
    }
    case TO_FL.createPattern:
      return { type: "createPattern", number: r.u14() };
    case TO_FL.strip:
      return {
        type: "strip",
        kind: nameOf(STRIP_KINDS, r.u7()),
        value: r.u14(),
        release: r.flag(),
      };
    case TO_FL.transpose:
      return { type: "transpose", channel: r.u14(), semitones: r.s7() };
    case TO_FL.browse:
      return { type: "browse", action: nameOf(BROWSE_ACTIONS, r.u7()) };
    case TO_FL.uiKey:
      return { type: "uiKey", key: nameOf(UI_KEYS, r.u7()) };
    case TO_FL.picker: {
      const show = r.flag();
      const mode = r.s7();
      return { type: "picker", show, mode: mode === PICKER_NO_MODE ? null : mode };
    }
    case TO_FL.triggerLiveClip:
      return { type: "triggerLiveClip", block: r.index(), release: r.flag() };
    default:
      return undefined;
  }
}
