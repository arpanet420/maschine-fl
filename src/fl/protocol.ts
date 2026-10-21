// Wire protocol between mk3d and the FL Studio script (docs/sysex.md).
// Keep fl-script/MK3Bridge/device_MK3Bridge.py in step with this file.

export const PORT_TO_FL = "MK3 Bridge";
export const PORT_FROM_FL = "MK3 Bridge FB";

/** Notes from the pads in keyboard mode. 0-based MIDI channel (= channel 1). */
export const NOTE_CHANNEL = 0;
/**
 * Pad hits in PAD MODE: note number = the channel's group-local index, on 0-based MIDI channel 1
 * (= channel 2). The FL script plays that channel itself (docs/sysex.md, "Pad notes for channels").
 */
export const CHANNEL_NOTE_CHANNEL = 1;
/** Highest group-local channel index a MIDI note number can carry. */
export const MAX_CHANNEL_NOTE = 127;
/** Our own control messages (CCs). 0-based MIDI channel (= channel 16), apart from the notes. */
export const CONTROL_CHANNEL = 15;

/** Daemon → FL commands sent as CC on CONTROL_CHANNEL, value 127. CCs 102–119 are undefined in MIDI. */
export const CC = {
  play: 102,
  stop: 103,
  record: 104,
  countIn: 105,
  metronome: 106,
  tapTempo: 107,
  restart: 108,
} as const;

/** SysEx: F0 7D 4D 33 <cmd> <payload…> F7. 7D = non-commercial manufacturer ID, 4D 33 = "M3". */
export const SYSEX_HEADER = [0xf0, 0x7d, 0x4d, 0x33] as const;

/** FL → daemon commands (01–3F). Payloads are in docs/sysex.md. */
export const FROM_FL = {
  hello: 0x01,
  transport: 0x02,
  songPos: 0x03,
  goodbye: 0x04,
  alive: 0x05,
  channels: 0x08,
  selectedChannel: 0x09,
  channelDetail: 0x0a,
  mixer: 0x10,
  selectedTrack: 0x11,
  meters: 0x12,
  uiState: 0x13,
  undoState: 0x14,
  presets: 0x15,
  markers: 0x16,
  /** A line of the playlist probe (diagnostic; mk3d only logs it). */
  probe: 0x17,
  pattern: 0x18,
  patterns: 0x19,
  stepGrid: 0x1a,
  /** Up to 16 steps of one channel in the current pattern (ARRANGER's pattern overview). */
  patternGrid: 0x1b,
  /** The song loop range (the playlist time selection): active, start and end in ticks. */
  loopState: 0x1c,
  /** Which hidden FL functions this FL version lacks (the script checks them with `getattr`). */
  features: 0x1d,
  /** The focused node of FL's browser, popup and form state (a TRIAL: the plug-in loader). */
  browserNode: 0x1e,
  plugin: 0x20,
  pluginParams: 0x21,
  paramNames: 0x22,
  /** LIVE overlay header: how many playlist tracks LIVE_TRACK covers, performance mode on or off. */
  liveGrid: 0x23,
  /** Which channels of the selected channel's bank FL is playing now (`channels.getActivityLevel`). */
  activity: 0x24,
  /** One playlist track's row of the LIVE window: name, color, mute/solo, its 16 live blocks. */
  liveTrack: 0x25,
} as const;

/** Daemon → FL commands (40–7F). */
export const TO_FL = {
  /** Please send HELLO and full state (daemon started after FL). */
  requestState: 0x41,
  view: 0x42,
  selectChannel: 0x43,
  setChannel: 0x44,
  setStep: 0x45,
  selectTrack: 0x46,
  setTrack: 0x47,
  setParam: 0x48,
  selectPattern: 0x49,
  ui: 0x4a,
  setChannelTrack: 0x4b,
  showEditor: 0x4c,
  clonePattern: 0x4d,
  newPattern: 0x4e,
  clearSteps: 0x4f,
  setTempo: 0x50,
  setSwing: 0x51,
  showWindow: 0x52,
  setSnap: 0x53,
  setMainVolume: 0x54,
  presetStep: 0x55,
  jumpMarker: 0x56,
  addMarker: 0x57,
  setLoopMode: 0x58,
  playlistView: 0x59,
  requestMarkers: 0x5a,
  setSongPos: 0x5b,
  /** Run the playlist probe (only with MK3D_PROBE=1); FL answers with PROBE lines. */
  runProbe: 0x5c,
  /** Send PRESETS for the names `offset … offset + 7` (BROWSER scrolls its list). */
  presetWindow: 0x5d,
  /** Load preset `index` by stepping next/prev from the current one. */
  presetLoad: 0x5e,
  /** `patterns.setPatternLength(pattern, length)` (hidden; the length is in steps, PATTERN's unit). */
  setPatternLength: 0x5f,
  /** `arrangement.selectionSet(start, end)` in ticks, or `selectionClear()` for start = end = 0. */
  setLoop: 0x60,
  /** Send LOOP_STATE now. */
  requestLoop: 0x61,
  /** `patterns.setPatternColor(pattern, color)`. */
  setPatternColor: 0x62,
  /** Double the pattern: twice the length, the grid steps (and their parameters) copied into the new half. */
  doublePattern: 0x63,
  /** Create the (not yet existing) pattern `number` and select it. */
  createPattern: 0x64,
  /** The touch strip's pitch, mod or perform value for the selected channel (docs/sysex.md, "STRIP"). */
  strip: 0x65,
  /** Transpose the selected channel's notes of the current pattern by `semitones` (docs/sysex.md, "TRANSPOSE"). */
  transpose: 0x66,
  /** FL's browser: show it, step through the tree, open a folder, the node menu, preview (TRIAL, docs/sysex.md). */
  browse: 0x67,
  /** A plain FL key for the focused window, menu or plugin picker (TRIAL). */
  uiKey: 0x68,
  /** `ui.showPicker(show [, mode])`, FL's plugin picker (TRIAL). */
  picker: 0x69,
  /** Fire (or release) LIVE scene `block` via `playlist.triggerLiveClip`, or `block` null to stop. */
  triggerLiveClip: 0x6a,
} as const;

export const CMD = { ...FROM_FL, ...TO_FL } as const;

export const PROTOCOL_VERSION = 2;

/** `u14` value meaning "nothing" (no selected channel, no plugin). */
export const NONE = 0x3fff;
/** Largest `u14` value of a `norm` field; 0–1 maps to 0–16383. */
export const NORM_MAX = 0x3fff;
/** Peak meters are `u7`: 0–1 maps to 0–127. */
export const PEAK_MAX = 127;
/** Longest string in characters; longer ones are cut. */
export const MAX_STRING = 32;
/** Longest PROBE text in characters; longer ones are cut. */
export const MAX_PROBE = 100;
/** The FL script sends at most this many list entries per message. */
export const MAX_LIST = 4;
/** Longest list of plugin parameters in VIEW. */
export const MAX_VIEW_PARAMS = 8;
/** Parameter names per PARAM_NAMES message. */
export const MAX_PARAM_NAMES = 8;
/** Preset names per PRESETS message (the window around the current preset). */
export const MAX_PRESET_NAMES = 8;
/** Markers per MARKERS message. */
export const MAX_MARKERS_PER_MESSAGE = 8;
/** The most markers FL's script lists (`total` is a `u7`). */
export const MAX_MARKERS = 127;
/** MARKERS `ticks` value (the largest `u21`) for a marker whose time the script could not work out. */
export const MARKER_TICKS_UNKNOWN = 0x1fffff;
/** Steps per PATTERN_GRID message. */
export const MAX_PATTERN_GRID_STEPS = 16;
/** Steps of a pattern the script sends as PATTERN_GRID (16 pages of 16). */
export const MAX_PATTERN_STEPS = 256;
/** PATTERN_GRID names channels with a `u7`: channels from 128 up have no overview row. */
export const MAX_PATTERN_GRID_CHANNEL = 127;

export const TRANSPORT_FLAGS = {
  playing: 0x01,
  recording: 0x02,
  metronome: 0x04,
  countIn: 0x08,
  /** The loop mode is song (`transport.getLoopMode() == 1`), not pattern. */
  songMode: 0x10,
} as const;

export const CHANNEL_FLAGS = { selected: 0x01, muted: 0x02, solo: 0x04 } as const;
export const MIXER_FLAGS = { selected: 0x01, muted: 0x02, solo: 0x04, armed: 0x08 } as const;
/** FEATURES `missing` bits: a hidden FL function this FL version does not have. */
export const FEATURE_MISSING = {
  patternLength: 0x01,
  loop: 0x02,
  /** Any of the browser functions the plug-in loader trial calls (`ui.navigateBrowser` …). */
  browser: 0x04,
  /** `ui.showPicker` */
  picker: 0x08,
} as const;
/** BROWSE `action` (plug-in loader trial): wire value = index. */
export const BROWSE_ACTIONS = [
  "show",
  "next",
  "prev",
  "toggle",
  "menu",
  "preview",
  "load",
  "itemMenu",
  "pluginPicker",
] as const;
/** UI_KEY `key` (plug-in loader trial): wire value = index. */
export const UI_KEYS = ["up", "down", "left", "right", "enter", "escape", "closePopup"] as const;
/** BROWSER_NODE strings are cut to this many characters. */
export const MAX_NODE_TEXT = 40;
/** BROWSER_NODE `fileType` travels as `fileType + NODE_TYPE_BIAS` in a `u14`. */
export const NODE_TYPE_BIAS = 8192;
/** A node whose file type is this or lower is a folder (docs/sysex.md, BROWSER_NODE). */
export const NODE_FOLDER_TYPE = -100;
/** BROWSER_NODE flags. */
export const NODE_FLAGS = { popup: 0x01, browserFocused: 0x02, otherFormFocused: 0x04 } as const;
/** PICKER `mode` meaning "leave the second argument out". */
export const PICKER_NO_MODE = -1;
/** Longest pattern the length setter and DOUBLE ask for: 32 bars of 16 steps. */
export const MAX_PATTERN_LENGTH_STEPS = 512;
/** The common pattern lengths in steps (1, 2, 4, 8, 16 and 32 bars) the LENGTH knob steps through. */
export const COMMON_PATTERN_LENGTHS: readonly number[] = [16, 32, 64, 128, 256, 512];
/** SET_PATTERN_LENGTH names the pattern with a `u7`: patterns from 128 up cannot be resized. */
export const MAX_LENGTH_PATTERN = 127;
/** SET_LOOP / LOOP_STATE ticks are `u21`. */
export const MAX_LOOP_TICKS = 0x1fffff;

export const PATTERN_FLAGS = { current: 0x01 } as const;
/** `patternGrid`: ARRANGER is shown, the script sends PATTERN_GRID for the channel bank in view. */
export const VIEW_FLAGS = { meters: 0x01, presets: 0x02, patternGrid: 0x04 } as const;
/** PATTERN_GRID flags: bit 0 = the channel uses the step sequencer (`channels.isGridBitAssigned`). */
export const PATTERN_GRID_FLAGS = { stepSequencer: 0x01 } as const;
/** Blocks per LIVE_GRID window (the LIVE overlay's pad bank), matches `PAD_COUNT`. */
export const MAX_LIVE_BLOCKS = 16;
/**
 * LIVE_GRID block status bits (`playlist.getLiveBlockStatus`, `LB_Status_Default`): filled,
 * scheduled (queued for its trigger snap), playing. Each block is the OR over `LIVE_TRACK_SCAN`
 * tracks; 0 = empty.
 */
export const LIVE_BLOCK = { filled: 1, scheduled: 2, playing: 4 } as const;
/** LIVE_TRACK flags: the playlist track is muted, soloed. */
export const LIVE_TRACK_FLAGS = { muted: 0x01, solo: 0x02 } as const;
/** Playlist tracks (1-based) LIVE_TRACK reports (one row each) and STOP stops. */
export const LIVE_TRACK_SCAN = 8;

/** Wire values are the array positions. */
export const CHANNEL_PROPS = [
  "volume",
  "pan",
  "mute",
  "pitch",
  "cutoff",
  "resonance",
  "solo",
] as const;
export const TRACK_PROPS = ["volume", "pan", "mute", "solo", "arm"] as const;
export const UI_ACTIONS = [
  "up",
  "down",
  "left",
  "right",
  "enter",
  "escape",
  "undo",
  "redo",
  "save",
  "cut",
  "copy",
  "paste",
  "quantize",
  "quantizeStarts",
  "saveNew",
] as const;

/** PLAYLIST_VIEW `what`: wire value = index. */
export const PLAYLIST_VIEWS = ["zoom", "scroll"] as const;

/** STRIP `kind`: wire value = index. */
export const STRIP_KINDS = ["pitch", "mod", "perform"] as const;
/** STRIP `value` of the kinds `pitch` (centre 8192) and `perform` is 0–16383; `mod` is 0–127. */
export const STRIP_VALUE_MAX = 0x3fff;
export const STRIP_MOD_MAX = 127;
/**
 * FL's VST wrapper: parameters 4096–4223 are MIDI CC 0–127 (so CC 1, the mod wheel, is 4097); a
 * plugin that reports at least VST_CC_PARAM_COUNT parameters has them.
 */
export const VST_CC_PARAM_BASE = 4096;
export const VST_CC_PARAM_COUNT = 4224;

/** FL windows UI_STATE and SHOW_WINDOW know: wire value = index (`ui.getVisible(i)`). */
export const UI_WINDOWS = ["mixer", "rack", "playlist", "piano", "browser"] as const;
/** UI_STATE `focused`: a plugin window has the focus. */
export const FOCUS_PLUGIN = 5;
/** UI_STATE `focused`: nothing known has the focus. */
export const FOCUS_NONE = 127;
/** Tempo limits FL accepts, in BPM (SET_TEMPO is clamped to them). */
export const TEMPO_MIN = 10;
export const TEMPO_MAX = 522;
