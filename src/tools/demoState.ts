// A FlState filled the way FL would report a small project, for the screen tools and the tests of
// the pages (no FL, no hardware): `npm run pagepng` draws pages from it.
import { FlState } from "../fl/flState.js";
import type { UiStateInfo } from "../fl/sysex.js";

const NAMES = [
  "Kick",
  "Snare",
  "Clap",
  "Hat",
  "Open Hat",
  "Perc",
  "Rim",
  "Tom",
  "Bass",
  "Sub",
  "Lead",
  "Pluck",
  "Arp",
  "Pad",
  "Chords",
  "FX",
];
const COLORS = [0xe0707a, 0xfb9244, 0xeec54e, 0x4ae4a8, 0x5aa9e6, 0xa678de];

export interface DemoOptions {
  /** Channels in the rack. */
  channels?: number;
  /** The selected channel (0-based). */
  selected?: number;
  tempo?: number;
  swing?: number;
  /** The selected channel's volume, 0–1. */
  volume?: number;
  /** FL's main volume (REC_MainVol), 0–1. */
  mainVolume?: number;
  /** The selected channel's pitch knob, −1…1, and its range in semitones. */
  pitch?: number;
  pitchRange?: number;
  ui?: Partial<UiStateInfo>;
  /** Playlist markers (time order); none by default. Sent in messages of 8, like FL's script. */
  markers?: Array<{ ticks: number | null; name: string }>;
  /** FL's PPQ (ticks per quarter note), 96 by default. */
  ppq?: number;
  /** The loop mode is song. */
  songMode?: boolean;
  /** The clock (ms) that stamps SONG_POS messages; `performance.now()` by default. */
  clock?: () => number;
  /** Steps of the current pattern, 64 by default. */
  patternLength?: number;
  /** Patterns in the project, 3 by default. */
  patternCount?: number;
  /** The current pattern (1-based), 1 by default. */
  pattern?: number;
  /**
   * The ARRANGER overview as PATTERN_GRID would send it: the steps that are on per channel (0-based
   * channels), or `{ on, stepSequencer: false }` for a piano roll channel.
   */
  grid?: Record<number, number[] | { on: number[]; stepSequencer?: boolean }>;
  /** Channels (0-based) that are muted / soloed in the channel window. */
  muted?: number[];
  solo?: number[];
}

export const demoChannelName = (index: number): string =>
  `${NAMES[index % NAMES.length] ?? "Channel"}${index >= NAMES.length ? ` ${Math.floor(index / NAMES.length) + 1}` : ""}`;

export const demoChannelColor = (index: number): number =>
  COLORS[index % COLORS.length] ?? 0xfb9244;

export function demoFlState(options: DemoOptions = {}): FlState {
  const total = options.channels ?? 24;
  const selected = options.selected ?? 0;
  const fl = new FlState(options.clock);
  fl.apply({ type: "hello", version: 2 });
  fl.apply({
    type: "transport",
    state: {
      songMode: options.songMode ?? false,
      playing: false,
      recording: false,
      metronome: false,
      countIn: false,
    },
    tempo: options.tempo ?? 120,
    swing: options.swing ?? 0,
    mainVolume: options.mainVolume ?? 0.8,
  });
  const first = Math.floor(selected / 16) * 16;
  fl.apply({
    type: "channels",
    total,
    offset: first,
    entries: Array.from({ length: Math.min(16, total - first) }, (_, i) => ({
      selected: first + i === selected,
      muted: options.muted?.includes(first + i) ?? false,
      solo: options.solo?.includes(first + i) ?? false,
      color: demoChannelColor(first + i),
      name: demoChannelName(first + i),
    })),
  });
  fl.apply({
    type: "selectedChannel",
    index: selected,
    color: demoChannelColor(selected),
    volume: options.volume ?? 0.78,
    pan: 0,
    name: demoChannelName(selected),
    plugin: "Sampler",
  });
  fl.apply({
    type: "channelDetail",
    index: selected,
    pitch: options.pitch ?? 0,
    pitchRange: options.pitchRange ?? 12,
    cutoff: 1,
    resonance: 0,
    mixerTrack: 1,
    channelType: 0,
  });
  fl.apply({
    type: "mixer",
    total: 10,
    offset: 0,
    entries: Array.from({ length: 8 }, (_, i) => ({
      selected: i === 1,
      muted: false,
      solo: false,
      armed: false,
      color: demoChannelColor(i),
      volume: i === 0 ? 0.8 : 0.7,
      pan: 0,
      name: i === 0 ? "Master" : `Insert ${i}`,
    })),
  });
  fl.apply({ type: "selectedTrack", index: 1 });
  const patternCount = options.patternCount ?? 3;
  const current = options.pattern ?? 1;
  const patternFirst = Math.floor((current - 1) / 16) * 16;
  fl.apply({
    type: "patterns",
    count: patternCount,
    offset: patternFirst,
    entries: Array.from({ length: Math.min(16, patternCount - patternFirst) }, (_, i) => ({
      current: patternFirst + i + 1 === current,
      color: demoChannelColor(patternFirst + i),
      name: `Pattern ${patternFirst + i + 1}`,
    })),
  });
  fl.apply({
    type: "pattern",
    number: current,
    count: patternCount,
    length: options.patternLength ?? 64,
    color: demoChannelColor(current - 1),
    name: `Pattern ${current}`,
  });
  for (const [channel, row] of Object.entries(options.grid ?? {})) {
    const { on, stepSequencer } = Array.isArray(row) ? { on: row, stepSequencer: true } : row;
    applyPatternGrid(fl, Number(channel), on, options.patternLength ?? 64, stepSequencer ?? true);
  }
  fl.apply({
    type: "uiState",
    snap: 8,
    visible: [false, true, true, false, false],
    focused: 1,
    ...options.ui,
  });
  applyMarkers(fl, options.markers ?? [], options.ppq ?? 96);
  return fl;
}

/** FL's PATTERN_GRID messages for one channel: chunks of 16 steps, `on` = the steps that are on. */
export function applyPatternGrid(
  fl: FlState,
  channel: number,
  on: readonly number[],
  length: number,
  stepSequencer = true,
): void {
  const steps = Math.min(length, 256);
  for (let start = 0; start < steps; start += 16) {
    fl.apply({
      type: "patternGrid",
      channel,
      start,
      steps: Array.from({ length: Math.min(16, steps - start) }, (_, i) => on.includes(start + i)),
      stepSequencer,
    });
  }
}

/** FL's MARKERS messages for a list: at most 8 per message, at least one (also for no markers). */
export function applyMarkers(
  fl: FlState,
  markers: ReadonlyArray<{ ticks: number | null; name: string }>,
  ppq = 96,
): void {
  const total = markers.length;
  for (let offset = 0; offset === 0 || offset < total; offset += 8) {
    fl.apply({
      type: "markers",
      total,
      offset,
      entries: markers.slice(offset, offset + 8).map((m) => ({ ...m })),
      ppq,
    });
  }
}
