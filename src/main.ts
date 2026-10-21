// mk3d: drives the Maschine MK3 and bridges it to FL Studio over virtual MIDI ports.
// This file wires the device, the MIDI ports and the screens together and handles the global
// controls (shift, transport, touch strip, pads as a fallback); the page stack in
// src/modes/pageStack.ts owns the page buttons, the page events, the screens and the LEDs, and
// src/modes/padState.ts holds the pad mode (keyboard notes or channels) the fallback plays.
import { Mk3Device } from "./hw/device.js";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, Mk3Display } from "./hw/display.js";
import type { HwEvent } from "./hw/events.js";
import type { ButtonId } from "./hw/ids.js";
import { InputParser } from "./hw/input.js";
import { DEFAULT_PAD_CONFIG } from "./hw/pads.js";
import { LedSender, LedState } from "./hw/leds.js";
import { FlState, type FlSection } from "./fl/flState.js";
import { FlPorts, midiBytes } from "./fl/midiPorts.js";
import { CC, PORT_FROM_FL, PORT_TO_FL } from "./fl/protocol.js";
import { describeProbe, describeSection } from "./flLog.js";
import { ChannelMode } from "./modes/channelMode.js";
import { ArrangerPage } from "./modes/arrangerPage.js";
import { BrowserPage } from "./modes/browserPage.js";
import { FilePage } from "./modes/filePage.js";
import { MixerMode } from "./modes/mixerMode.js";
import { PluginMode } from "./modes/pluginMode.js";
import { NksPageSource } from "./nks/nksPages.js";
import { startNksIndex } from "./nks/index.js";
import { FULL, HEADER_HEIGHT } from "./modes/draw.js";
import { GridOverlay } from "./modes/gridOverlay.js";
import { ChordsPage } from "./modes/chordsPage.js";
import { KeyboardPage } from "./modes/keyboardPage.js";
import type { ModeContext } from "./modes/mode.js";
import { MuteOverlay } from "./modes/muteOverlay.js";
import { NavigateOverlay } from "./modes/navigateOverlay.js";
import { NoteRepeatOverlay } from "./modes/noteRepeatOverlay.js";
import { PadModePage } from "./modes/padModePage.js";
import { PadSettings } from "./modes/padSettings.js";
import { PadState } from "./modes/padState.js";
import { PageStack, defaultPagesPath } from "./modes/pageStack.js";
import { DuplicateOverlay } from "./modes/duplicateOverlay.js";
import { LiveOverlay } from "./modes/liveOverlay.js";
import { LoopOverlay } from "./modes/loopOverlay.js";
import { PatternOverlay } from "./modes/patternOverlay.js";
import { SelectOverlay } from "./modes/selectOverlay.js";
import { SceneOverlay } from "./modes/sceneOverlay.js";
import { SettingsPage } from "./modes/settingsPage.js";
import { SoloOverlay } from "./modes/soloOverlay.js";
import { StepPage } from "./modes/stepPage.js";
import { registerFonts } from "./render/fonts.js";
import { Screens } from "./render/screens.js";
import { clear, drawHeader, font, theme } from "./render/widgets.js";
import { StripControl } from "./strip.js";

const REQUEST_STATE_EVERY_MS = 1000;
const FL_SILENT_AFTER_MS = 3500; // the script sends ALIVE every second

// Tuning (the SETTINGS page edits and saves these too; a flag wins over the saved value at start-up):
//   --velocity-full <0–4095>      MK3 hit value that gives velocity 127
//   --velocity-curve <exponent>   below 1 makes soft hits louder
//   --log-pads                    print each hit's velocity
//   --log-buttons                 print each button press
//   --png <dir>                   also write the screens as PNG files after each update
const args = process.argv.slice(2);
const numberArg = (name: string) => {
  const i = args.indexOf(name);
  const value = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(value) ? value : undefined;
};
const LOG_PADS = args.includes("--log-pads");
const LOG_BUTTONS = args.includes("--log-buttons");
const pngIndex = args.indexOf("--png");
const PNG_DIR = pngIndex >= 0 ? (args[pngIndex + 1] ?? "out") : undefined;
const padConfig = {
  ...DEFAULT_PAD_CONFIG,
  fullScale: numberArg("--velocity-full") ?? DEFAULT_PAD_CONFIG.fullScale,
  exponent: numberArg("--velocity-curve") ?? DEFAULT_PAD_CONFIG.exponent,
};

const log = (...parts: unknown[]) => {
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  console.log(`${now.toTimeString().slice(0, 8)}.${ms}`, ...parts);
};

const device = new Mk3Device();
const parser = new InputParser(padConfig);
const leds = new LedState();
const ledSender = new LedSender(leds, (report) => device.write(report));
const display = new Mk3Display();
const screens = new Screens(display);
const fl = new FlPorts();
const flState = new FlState();
let shiftHeld = false;
const touchedKnobs = new Set<number>();
let requestTimer: NodeJS.Timeout | undefined;

// ── Modes ────────────────────────────────────────────────────────────────────

// The SETTINGS page and the pad processor share padConfig; flags win over the saved values.
const padSettings = new PadSettings(padConfig, {
  fullScale: numberArg("--velocity-full") !== undefined,
  exponent: numberArg("--velocity-curve") !== undefined,
});
const pads = new PadState((bytes) => fl.send(bytes), padSettings);
const strip = new StripControl((bytes) => fl.send(bytes), pads);
const channelMode = new ChannelMode();
const nksIndex = startNksIndex({ log: (line) => log(line) });
const pluginMode = new PluginMode(
  Date.now,
  new NksPageSource(nksIndex, undefined, (line) => log(line)),
);
const stack = new PageStack({
  pages: {
    channel: channelMode,
    plugin: pluginMode,
    mixer: new MixerMode(),
    arranger: new ArrangerPage(),
    scene: new SceneOverlay(),
    liveClips: new LiveOverlay(),
    browser: new BrowserPage(),
    pattern: new PatternOverlay(),
    duplicate: new DuplicateOverlay(),
    navigate: new NavigateOverlay(),
    grid: new GridOverlay(),
    noteRepeat: new NoteRepeatOverlay(pads, { clock: () => performance.now() }),
    mute: new MuteOverlay(pads),
    select: new SelectOverlay(pads),
    solo: new SoloOverlay(pads),
    loop: new LoopOverlay(),
    padMode: new PadModePage(pads),
    keyboard: new KeyboardPage(pads),
    chords: new ChordsPage(pads),
    step: new StepPage(pads),
    file: new FilePage(),
    settings: new SettingsPage(padSettings),
  },
  pads,
  strip,
  pinsPath: defaultPagesPath(),
  log: (line) => log(line),
});

const modeContext: ModeContext = {
  fl: flState,
  send: (command) => {
    if (command.type === "triggerLiveClip") {
      log(
        `→ FL trigger scene: block ${command.block ?? "none (stop)"}${command.release ? ", release" : ""}`,
      );
    }
    fl.sendCommand(command);
  },
  get shift() {
    return shiftHeld;
  },
  touchedKnobs,
  requestRender: () => {
    updateLeds();
    updateScreens();
  },
  requestLeds: updateLeds,
};

// Plugin mode shows FL's parameter list until the NKS index is loaded, then NKS pages.
nksIndex.onReady(() => {
  pluginMode.sourceChanged();
  if (stack.main === "plugin") {
    stack.onFlChange("plugin", modeContext);
    modeContext.requestRender();
  }
});

// ── LEDs ─────────────────────────────────────────────────────────────────────

function updateLeds(): void {
  const on = flState.connected;
  const transportState = flState.transport;
  leds.setLight("play", !on ? "off" : transportState.playing ? "bright" : "dim");
  leds.setLight("rec", !on ? "off" : transportState.recording ? "bright" : "dim");
  leds.setLight("stop", on ? "dim" : "off");
  // RESTART: dim, bright while FL's song loop is active (SHIFT + RESTART toggles it).
  leds.setLight("restart", !on ? "off" : flState.loop.active ? "bright" : "dim");
  leds.setLight("tap", !on ? "off" : transportState.metronome ? "bright" : "dim");
  leds.setLight("shift", !on ? "off" : shiftHeld ? "bright" : "dim");

  pads.leds(leds, flState); // the fallback: pages that own the pads set theirs below
  stack.leds(leds, modeContext);
  ledSender.update();
}

// ── Screens ──────────────────────────────────────────────────────────────────

function drawWaiting(): void {
  const left = screens.left.ctx;
  clear(left, FULL);
  clear(screens.right.ctx, FULL);
  drawHeader(left, { ...FULL, height: HEADER_HEIGHT }, { title: "MK3 Bridge" });
  left.textAlign = "center";
  left.textBaseline = "middle";
  left.fillStyle = theme.dimText;
  left.font = font(24, "bold");
  left.fillText("Waiting for FL Studio…", DISPLAY_WIDTH / 2, 130);
  left.font = font(14);
  left.fillText(`Enable "${PORT_TO_FL}" in FL's MIDI Settings`, DISPLAY_WIDTH / 2, 165);
}

// Coalesce redraws: song position alone arrives every 50 ms while playing.
let screenJob: Promise<void> | undefined;
let screenDirty = false;

function updateScreens(): void {
  if (stopping) return;
  screenDirty = true;
  screenJob ??= (async () => {
    while (screenDirty) {
      screenDirty = false;
      if (flState.connected) stack.render(screens.left.ctx, screens.right.ctx, modeContext);
      else drawWaiting();
      try {
        await screens.flush();
        if (PNG_DIR) await screens.writePngs(PNG_DIR);
      } catch (err) {
        log("screen update failed:", String(err));
      }
    }
    screenJob = undefined;
  })();
}

// ── Input from the MK3 ───────────────────────────────────────────────────────

function sendControl(cc: (typeof CC)[keyof typeof CC], name: string): void {
  fl.send(midiBytes.control(cc));
  log(`→ FL ${name}`);
}

function handlePad(event: Extract<HwEvent, { type: "pad" }>): void {
  if (LOG_PADS && event.phase === "down") {
    const velocity = Math.round((event.velocity ?? 0) * 126) + 1;
    log(
      `pad ${event.pad + 1} velocity ${velocity} (hit value ${Math.round(event.pressure * 4095)})`,
    );
  }
  pads.handlePad(event, modeContext);
  if (event.phase !== "move") {
    updateLeds();
    // A held pad changes what a quick-edit mode edits (and shows).
    if (stack.quickEdit.active) updateScreens();
  }
}

/** Buttons that mean the same on every page. True = handled. */
function handleGlobalButton(id: ButtonId, pressed: boolean): boolean {
  if (id === "shift") {
    shiftHeld = pressed;
    updateLeds();
    return true;
  }
  if (!["play", "stop", "rec", "tap", "restart"].includes(id)) return false;
  // SHIFT + RESTART: a tap toggles the song loop, a hold opens the LOOP overlay (the page stack
  // decides; it leaves the plain RESTART to us).
  if (id === "restart" && stack.onEvent({ type: "button", id, pressed }, modeContext)) return true;
  if (!pressed) return true;
  if (id === "play") sendControl(CC.play, "play/pause");
  else if (id === "stop") sendControl(CC.stop, "stop");
  else if (id === "restart") sendControl(CC.restart, "restart");
  else if (id === "rec") {
    if (shiftHeld) sendControl(CC.countIn, "count-in toggle");
    else sendControl(CC.record, "record toggle");
  } else if (id === "tap") {
    if (shiftHeld) sendControl(CC.metronome, "metronome toggle");
    else sendControl(CC.tapTempo, "tap tempo");
  }
  return true;
}

function handle(event: HwEvent): void {
  switch (event.type) {
    case "pad":
      // A page that uses the pads takes them; otherwise they play notes.
      if (stack.onEvent(event, modeContext)) modeContext.requestRender();
      else handlePad(event);
      return;
    case "strip":
      if (strip.handle(event, modeContext)) updateLeds();
      return;
    case "button":
      if (LOG_BUTTONS && event.pressed) log(`button ${event.id}`);
      if (handleGlobalButton(event.id, event.pressed)) return;
      break;
    case "encoderTouch":
      if (event.touched) touchedKnobs.add(event.index);
      else touchedKnobs.delete(event.index);
      updateScreens();
      break;
  }
  if (stack.onEvent(event, modeContext)) modeContext.requestRender();
}

function releaseHeldNotes(): void {
  pads.releaseAll();
  stack.releasePads();
  strip.release(modeContext);
}

// The strip's play-position LEDs move between SONG_POS messages (the position is estimated from the tempo).
const PLAY_POSITION_EVERY_MS = 40;
setInterval(() => {
  if (flState.connected && strip.playPositionChanged(flState)) updateLeds();
}, PLAY_POSITION_EVERY_MS).unref();

// ── FL Studio ────────────────────────────────────────────────────────────────

function requestStateUntilConnected(): void {
  clearInterval(requestTimer);
  fl.sendCommand({ type: "requestState" });
  requestTimer = setInterval(() => {
    if (flState.connected && Date.now() - lastHeardFromFl > FL_SILENT_AFTER_MS) {
      log("FL Studio stopped responding");
      flState.reset();
    }
    if (!flState.connected) fl.sendCommand({ type: "requestState" });
  }, REQUEST_STATE_EVERY_MS);
}

let lastHeardFromFl = 0;

fl.on("message", (message) => {
  lastHeardFromFl = Date.now();
  if (message.type === "unknown") {
    log(`← FL unknown SysEx command 0x${message.command.toString(16)}`);
    return;
  }
  if (message.type === "probe") {
    log(describeProbe(message.text));
    return;
  }
  if (message.type === "goodbye") log("← FL script unloaded (FL closed or script reloaded)");
  flState.apply(message);
});

// Log what changed, once per burst: a list arrives as several messages.
const changedSections = new Set<FlSection>();
let logTimer: NodeJS.Timeout | undefined;

flState.on("change", (section) => {
  if (section === "connection" && !flState.connected) stack.releasePads();
  if (section === "connection" && flState.connected) stack.enter(modeContext);
  else if (flState.connected) stack.onFlChange(section, modeContext);
  if (section !== "songPos" && section !== "meters") updateLeds();
  else if (section === "songPos" && strip.playPositionChanged(flState)) updateLeds();
  updateScreens();
  if (section === "songPos" || section === "meters") return;
  changedSections.add(section);
  logTimer ??= setTimeout(() => {
    logTimer = undefined;
    for (const changed of changedSections) {
      const line = describeSection(flState, changed);
      if (line) log(`← FL ${line}`);
    }
    changedSections.clear();
  }, 150);
});

// ── Device lifecycle ─────────────────────────────────────────────────────────

device.on("connected", ({ serial }) => {
  log(`Maschine MK3 connected (${serial ?? "?"})`);
  ledSender.resendAll();
  screens.invalidate();
  updateLeds();
  updateScreens();
});
device.on("disconnected", (reason) => {
  log(`Maschine MK3 disconnected: ${reason}`);
  releaseHeldNotes();
  touchedKnobs.clear();
  void display.close();
});
device.on("unavailable", (reason) => log(`Waiting for the MK3: ${reason}`));
device.on("report", (report) => {
  for (const event of parser.parse(report)) handle(event);
});

// Ctrl-C reaches us twice when run through tsx; shut down once.
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("Shutting down…");
  clearInterval(requestTimer);
  releaseHeldNotes();
  leds.clear();
  ledSender.cancel();
  await ledSender.flush();
  const full = { x: 0, y: 0, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };
  for (const screen of screens.screens) clear(screen.ctx, full, "#000");
  await screenJob;
  await screens.flush().catch(() => undefined);
  await display.close();
  await device.stop();
  fl.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

fl.open();
log(
  `Screen font: ${registerFonts() ? "Barlow (from FL Studio)" : "Helvetica Neue (FL Studio fonts not found)"}`,
);
log(`MIDI ports open: "${PORT_TO_FL}" (to FL) and "${PORT_FROM_FL}" (from FL)`);
log(`Pad velocity: full at hit value ${padConfig.fullScale}, curve ${padConfig.exponent}`);
device.start();
requestStateUntilConnected();
