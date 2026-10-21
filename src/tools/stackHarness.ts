// The real page stack with the real pages and a FlState like FL would report, a clock the caller
// moves and the pad routing of main.ts (pages first, else the global pad handler). For the tests of
// the pages and for `npm run pagepng`.
import { createCanvas } from "@napi-rs/canvas";
import type { FlState } from "../fl/flState.js";
import type { FlCommand, LiveTrack } from "../fl/sysex.js";
import type { HwEvent, PadEvent } from "../hw/events.js";
import { type ButtonId, panelPad } from "../hw/ids.js";
import { LedState, MONO_LEDS } from "../hw/leds.js";
import { ArrangerPage, type ArrangerOptions } from "../modes/arrangerPage.js";
import { BrowserPage } from "../modes/browserPage.js";
import { ChannelMode } from "../modes/channelMode.js";
import { DuplicateOverlay } from "../modes/duplicateOverlay.js";
import { FilePage } from "../modes/filePage.js";
import { GridOverlay } from "../modes/gridOverlay.js";
import { ChordsPage } from "../modes/chordsPage.js";
import { KeyboardPage } from "../modes/keyboardPage.js";
import { LiveOverlay } from "../modes/liveOverlay.js";
import { MixerMode } from "../modes/mixerMode.js";
import type { ModeContext, ViewCommand } from "../modes/mode.js";
import { NavigateOverlay } from "../modes/navigateOverlay.js";
import { NoteRepeatOverlay } from "../modes/noteRepeatOverlay.js";
import { PadModePage } from "../modes/padModePage.js";
import { PadSettings } from "../modes/padSettings.js";
import { PadState } from "../modes/padState.js";
import { PageStack } from "../modes/pageStack.js";
import { LoopOverlay } from "../modes/loopOverlay.js";
import { PatternOverlay } from "../modes/patternOverlay.js";
import { SceneOverlay } from "../modes/sceneOverlay.js";
import { SettingsPage } from "../modes/settingsPage.js";
import { StepPage } from "../modes/stepPage.js";
import { StripControl } from "../strip.js";
import { FakeTime } from "./fakeTime.js";
import { applyMarkers, demoFlState, type DemoOptions } from "./demoState.js";

export const padByte = (pad: number) => 26 + panelPad(pad);

export function stackHarness(
  options: DemoOptions & {
    pinsPath?: string;
    arranger?: ArrangerOptions;
    /** The arpeggiator's Random. */
    random?: () => number;
  } = {},
) {
  const time = new FakeTime(1_000_000);
  const fl: FlState = demoFlState({ clock: time.clock, ...options });
  const midi: number[][] = [];
  const padSettings = new PadSettings();
  const pads = new PadState((bytes) => midi.push(bytes), padSettings);
  const pages = {
    channel: new ChannelMode(time.clock),
    mixer: new MixerMode(time.clock),
    arranger: new ArrangerPage(options.arranger),
    scene: new SceneOverlay({ timers: time.timers }),
    liveClips: new LiveOverlay({ timers: time.timers }),
    browser: new BrowserPage(time.clock),
    pattern: new PatternOverlay({ clock: time.clock }),
    duplicate: new DuplicateOverlay(),
    padMode: new PadModePage(pads),
    keyboard: new KeyboardPage(pads, { timers: time.timers }),
    chords: new ChordsPage(pads, { timers: time.timers }),
    step: new StepPage(pads),
    navigate: new NavigateOverlay(),
    grid: new GridOverlay(),
    noteRepeat: new NoteRepeatOverlay(pads, {
      clock: time.clock,
      timers: time.timers,
      random: options.random,
    }),
    loop: new LoopOverlay({ clock: time.clock, timers: time.timers }),
    file: new FilePage(),
    settings: new SettingsPage(padSettings, { timers: time.timers }),
  };
  const strip = new StripControl((bytes) => midi.push(bytes), pads, time.clock, time.timers);
  const log: string[] = [];
  const stack = new PageStack({
    pages,
    pads,
    strip,
    pinsPath: options.pinsPath,
    now: time.clock,
    timers: time.timers,
    log: (line) => log.push(line),
  });
  const sent: FlCommand[] = [];
  /** Every VIEW sent (they are not in `sent`). */
  const views: ViewCommand[] = [];
  const state = { shift: false, renders: 0 };
  /** Knobs (0–7) with a finger on them. */
  const touched = new Set<number>();
  const mc: ModeContext = {
    fl,
    send: (command) => {
      if (command.type === "view") views.push(command);
      else sent.push(command);
      if (command.type === "selectChannel") select(command.index); // FL answers at once
    },
    get shift() {
      return state.shift;
    },
    touchedKnobs: touched,
    requestRender: () => state.renders++,
  };
  const select = (index: number) => {
    fl.apply({
      type: "selectedChannel",
      index,
      color: 0x4ae4a8,
      volume: 0.78,
      pan: 0,
      name: `Ch ${index + 1}`,
      plugin: "",
    });
    stack.onFlChange("selectedChannel", mc);
  };
  stack.enter(mc);
  sent.length = 0;

  const button = (id: ButtonId, pressed: boolean) =>
    stack.onEvent({ type: "button", id, pressed }, mc);
  const press = (id: ButtonId) => button(id, true);
  const release = (id: ButtonId) => button(id, false);
  const tap = (id: ButtonId) => {
    press(id);
    release(id);
  };
  /** A pad event the way main.ts routes it: pages first, else the global pad handler. */
  const pad = (
    index: number,
    phase: PadEvent["phase"] = "down",
    extra: { pressure?: number; velocity?: number } = {},
  ) => {
    const event: HwEvent = {
      type: "pad",
      pad: index,
      phase,
      pressure: extra.pressure ?? 0.5,
      velocity: extra.velocity ?? 0.5,
    };
    if (!stack.onEvent(event, mc)) pads.handlePad(event, mc);
  };
  const turn = (delta: number) => stack.onEvent({ type: "nav", action: "turn", delta }, mc);
  const push = (pressed = true) => stack.onEvent({ type: "nav", action: "push", pressed }, mc);
  const tilt = (direction: "up" | "down" | "left" | "right", pressed = true) =>
    stack.onEvent({ type: "nav", action: "tilt", direction, pressed }, mc);
  const advance = (ms: number) => time.advance(ms);
  const ledState = () => {
    const leds = new LedState();
    pads.leds(leds, fl); // the global fallback first, as in main.ts
    stack.leds(leds, mc);
    return leds;
  };
  const light = (id: keyof typeof MONO_LEDS) => {
    const value = ledState().buttonLeds[MONO_LEDS[id]];
    return value === 0 ? "off" : value === 16 ? "dim" : value === 63 ? "bright" : `?${value}`;
  };
  const padLed = (index: number) => ledState().padLeds[padByte(index)] ?? 0;
  const render = () => {
    const left = createCanvas(480, 272).getContext("2d");
    const right = createCanvas(480, 272).getContext("2d");
    stack.render(left, right, mc);
    return { left, right };
  };
  /** FL reports a different UI_STATE. */
  const ui = (patch: Partial<{ snap: number; visible: boolean[]; focused: number }>) => {
    fl.apply({
      type: "uiState",
      snap: fl.uiState.snap,
      visible: [...fl.uiState.visible],
      focused: fl.uiState.focused,
      ...patch,
    });
    stack.onFlChange("uiState", mc);
  };
  /** FL reports another tempo, swing and/or main volume (after a SET_TEMPO, SET_SWING ...). */
  const transport = (patch: { tempo?: number; swing?: number; mainVolume?: number }) => {
    fl.apply({
      type: "transport",
      state: { ...fl.transport },
      tempo: fl.tempo,
      swing: fl.swing,
      mainVolume: fl.mainVolume,
      ...patch,
    });
    stack.onFlChange("transport", mc);
  };
  /** FL reports the transport running or stopped (the tempo stays). */
  const playing = (on: boolean) => {
    fl.apply({
      type: "transport",
      state: { ...fl.transport, playing: on },
      tempo: fl.tempo,
      swing: fl.swing,
      mainVolume: fl.mainVolume,
    });
    stack.onFlChange("transport", mc);
  };
  /** FL reports a SONG_POS (stamped with the harness clock). */
  const songPos = (bar: number, step: number, tick = 0) => {
    fl.apply({ type: "songPos", bar, step, tick });
    stack.onFlChange("songPos", mc);
  };
  /** A touch strip report: position 0–1, touched. The result says whether LEDs or read-out changed. */
  const stripAt = (position: number, touchedNow = true) =>
    strip.handle({ type: "strip", position, touched: touchedNow }, mc);
  /** A knob turn. */
  const knob = (index: number, delta: number) =>
    stack.onEvent({ type: "encoder", index, delta }, mc);
  /** FL reports the selected channel's presets (PRESETS). */
  const presets = (count: number, current: number | null, names: string[], offset = 0) => {
    fl.apply({ type: "presets", count, current, offset, names });
    stack.onFlChange("presets", mc);
  };
  /** FL reports another undo history (UNDO_STATE). */
  const undoState = (position: number, count: number, hint: string) => {
    fl.apply({ type: "undoState", position, count, hint });
    stack.onFlChange("undoState", mc);
  };
  /** FL reports the playlist markers (MARKERS, in messages of 8) and its PPQ. */
  const markers = (list: Array<{ ticks: number; name: string }>, ppq = 96) => {
    applyMarkers(fl, list, ppq);
    stack.onFlChange("markers", mc);
  };
  /** FL reports the LIVE header (the LIVE overlay). */
  const liveGrid = (patch: { scanned?: number; perf?: boolean } = {}) => {
    fl.apply({ type: "liveGrid", scanned: 8, perf: true, ...patch });
    stack.onFlChange("liveGrid", mc);
  };
  /** FL reports one LIVE_TRACK row (`blocks` short of 16 are padded with empty ones). */
  const liveTrack = (
    track: number,
    blocks: Array<{ status: number; color: number }>,
    patch: Partial<Omit<LiveTrack, "track" | "blocks">> = {},
  ) => {
    fl.apply({
      type: "liveTrack",
      offset: 0,
      track,
      name: `Track ${track}`,
      color: 0x39454c,
      muted: false,
      solo: false,
      trigSnap: 0,
      ...patch,
      blocks: [
        ...blocks,
        ...Array.from({ length: 16 - blocks.length }, () => ({ status: 0, color: 0 })),
      ],
    });
    stack.onFlChange("liveGrid", mc);
  };
  /** FL reports the loop mode (TRANSPORT's song flag). */
  const songMode = (on: boolean) => {
    fl.apply({
      type: "transport",
      state: { ...fl.transport, songMode: on },
      tempo: fl.tempo,
      swing: fl.swing,
      mainVolume: fl.mainVolume,
    });
    stack.onFlChange("transport", mc);
  };
  /** FL reports the song loop (LOOP_STATE). */
  const loopState = (active: boolean, start = 0, end = 0) => {
    fl.apply({ type: "loopState", active, start, end });
    stack.onFlChange("loop", mc);
  };
  /** FL reports another current pattern (PATTERN): the given fields change, the rest stays. */
  const patternInfo = (patch: Partial<Omit<FlState["pattern"], never>>) => {
    fl.apply({ type: "pattern", ...fl.pattern, ...patch });
    stack.onFlChange("pattern", mc);
  };
  /** FL reports which hidden functions it lacks (FEATURES). */
  const features = (missing: {
    patternLength?: boolean;
    loop?: boolean;
    browser?: boolean;
    picker?: boolean;
  }) => {
    fl.apply({
      type: "features",
      patternLength: false,
      loop: false,
      browser: false,
      picker: false,
      ...missing,
    });
    stack.onFlChange("features", mc);
  };
  /** The commands sent so far of one type. */
  const sentOf = <T extends FlCommand["type"]>(type: T) =>
    sent.filter((c): c is Extract<FlCommand, { type: T }> => c.type === type);
  return {
    fl,
    pads,
    pages,
    stack,
    mc,
    sent,
    views,
    padSettings,
    presets,
    markers,
    liveGrid,
    liveTrack,
    songMode,
    loopState,
    patternInfo,
    features,
    log,
    midi,
    strip,
    stripAt,
    state,
    touched,
    press,
    release,
    tap,
    pad,
    turn,
    push,
    tilt,
    advance,
    time,
    playing,
    songPos,
    knob,
    ledState,
    light,
    padLed,
    render,
    select,
    ui,
    transport,
    undoState,
    sentOf,
  };
}

export type StackHarness = ReturnType<typeof stackHarness>;
