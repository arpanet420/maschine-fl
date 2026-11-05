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
import { AuRanges, auParamHelper } from "./fl/auParams.js";
import { FlState, type FlSection } from "./fl/flState.js";
import { FlPorts, midiBytes } from "./fl/midiPorts.js";
import { CC, PORT_FROM_FL, PORT_TO_FL } from "./fl/protocol.js";
import { describeCommand, describeProbe, describeSection } from "./flLog.js";
import { ChannelMode } from "./modes/channelMode.js";
import { ArrangerPage } from "./modes/arrangerPage.js";
import { BrowserPage } from "./modes/browserPage.js";
import { FilePage } from "./modes/filePage.js";
import { MixerMode } from "./modes/mixerMode.js";
import { PluginMode } from "./modes/pluginMode.js";
import { NksPageSource } from "./nks/nksPages.js";
import { startNksIndex } from "./nks/index.js";
import { drawWaiting } from "./modes/draw.js";
import { GridOverlay } from "./modes/gridOverlay.js";
import { ChordsPage } from "./modes/chordsPage.js";
import { KeyboardPage } from "./modes/keyboardPage.js";
import type { ModeContext } from "./modes/mode.js";
import { MuteOverlay } from "./modes/muteOverlay.js";
import { NavigateOverlay } from "./modes/navigateOverlay.js";
import { NoteRepeatOverlay } from "./modes/noteRepeatOverlay.js";
import { PadModePage } from "./modes/padModePage.js";
import { PadSettings } from "./modes/padSettings.js";
import { FaultReporter } from "./fault.js";
import { PadPeakLog } from "./hw/padPeakLog.js";
import { PadState } from "./modes/padState.js";
import { PageStack, defaultPagesPath } from "./modes/pageStack.js";
import { DuplicateOverlay } from "./modes/duplicateOverlay.js";
import { LiveOverlay } from "./modes/liveOverlay.js";
import { LoopOverlay } from "./modes/loopOverlay.js";
import { PatternOverlay } from "./modes/patternOverlay.js";
import { hitVelocity } from "./modes/repeatScheduler.js";
import { SelectOverlay } from "./modes/selectOverlay.js";
import { SceneOverlay } from "./modes/sceneOverlay.js";
import { SongFollow } from "./modes/songFollow.js";
import { SettingsPage } from "./modes/settingsPage.js";
import { SoloOverlay } from "./modes/soloOverlay.js";
import { StepPage } from "./modes/stepPage.js";
import { FALLBACK_FAMILY, registerFonts } from "./render/fonts.js";
import { RedrawQueue, Screens } from "./render/screens.js";
import { clear } from "./render/widgets.js";
import { StripControl } from "./strip.js";

const REQUEST_STATE_EVERY_MS = 1000;
const FL_SILENT_AFTER_MS = 3500; // the script sends ALIVE every second
/** A USB transfer that hangs must not keep the daemon, and with it the MK3 and the ports, alive. */
const SHUTDOWN_LIMIT_MS = 3000;

// Tuning (the SETTINGS page edits and saves these too; a flag wins over the saved value at start-up):
//   --velocity-full <0–4095>      MK3 hit value that gives velocity 127
//   --velocity-curve <exponent>   below 1 makes soft hits louder
//   --log-pads                    print each hit's velocity
//   --log-buttons                 print each button press
//   --log-fl                      print each command sent to FL
//   --png <dir>                   also write the screens as PNG files after each update
const args = process.argv.slice(2);
const numberArg = (name: string) => {
  const i = args.indexOf(name);
  const value = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(value) ? value : undefined;
};
const LOG_PADS = args.includes("--log-pads");
const LOG_BUTTONS = args.includes("--log-buttons");
const LOG_FL = args.includes("--log-fl");
const padPeaks = new PadPeakLog((line) => log(line));
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
const pads = new PadState(
  (bytes) => fl.send(bytes),
  padSettings,
  () => flState.selectedChannel.index,
);
const strip = new StripControl((bytes) => fl.send(bytes), pads);
const channelMode = new ChannelMode();
const nksIndex = startNksIndex({ log: (line) => log(line) });
const pluginMode = new PluginMode(
  Date.now,
  new NksPageSource(nksIndex, undefined, (line) => log(line)),
  new AuRanges(auParamHelper(), (line) => log(line)),
);
// SCENE's FOLLOW: one song's channels at a time. It hears every FL change, whatever page is up.
const songFollow = new SongFollow({
  fl: flState,
  send: (command) => {
    if (LOG_FL) log(describeCommand(command));
    fl.sendCommand(command);
  },
  log: (line) => log(line),
  changed: () => {
    updateLeds();
    updateScreens();
  },
});
const stack = new PageStack({
  pages: {
    channel: channelMode,
    plugin: pluginMode,
    mixer: new MixerMode(),
    arranger: new ArrangerPage(),
    scene: new SceneOverlay({ follow: songFollow }),
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
    settings: new SettingsPage(padSettings, {
      setScreenBrightness: (level) => device.setScreenBrightness(level),
    }),
  },
  pads,
  strip,
  pinsPath: defaultPagesPath(),
  log: (line) => log(line),
});

const modeContext: ModeContext = {
  fl: flState,
  send: (command) => {
    if (LOG_FL) log(describeCommand(command));
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
const nksChanged = () => {
  pluginMode.sourceChanged();
  if (stack.main === "plugin") {
    stack.onFlChange("plugin", modeContext);
    modeContext.requestRender();
  }
};
nksIndex.onReady(nksChanged);
nksIndex.onUpdate(nksChanged);

// ── LEDs ─────────────────────────────────────────────────────────────────────

function updateLeds(): void {
  // Every frame is drawn from nothing, so a light only the last page used does not stay on. The
  // sender compares whole reports, so an LED that stays the same sends nothing.
  leds.clear();
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

const faults = new FaultReporter(log, undefined, () => updateScreens());

// Coalesced: song position alone arrives every 50 ms while playing.
let lastScreenError: string | undefined;
const redraw = new RedrawQueue(
  async () => {
    faults.guard(
      "screen",
      () => {
        if (flState.connected) stack.render(screens.left.ctx, screens.right.ctx, modeContext);
        else drawWaiting(screens.left.ctx, screens.right.ctx);
      },
      undefined,
    );
    faults.guard("fault bar", () => faults.draw(screens.left.ctx), undefined);
    try {
      // While the MK3 is away there is nothing to send to; `connected` redraws everything.
      if (device.connected) await screens.flush();
      if (PNG_DIR) await screens.writePngs(PNG_DIR);
      lastScreenError = undefined;
    } catch (err) {
      // On Windows without access to the screens every frame fails the same way: say it once.
      if (String(err) !== lastScreenError) log("screen update failed:", String(err));
      lastScreenError = String(err);
    }
  },
  (err) => faults.report("screen", err),
);

function updateScreens(): void {
  if (!stopping) redraw.request();
}

// ── Input from the MK3 ───────────────────────────────────────────────────────

function sendControl(cc: (typeof CC)[keyof typeof CC], name: string): void {
  fl.send(midiBytes.control(cc));
  log(`→ FL ${name}`);
}

function handlePad(event: Extract<HwEvent, { type: "pad" }>): void {
  if (LOG_PADS && event.phase === "down") {
    const velocity = hitVelocity(event.velocity ?? 0);
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
      // A page that uses the pads takes them; otherwise they play notes. A page that fails does
      // not take the pad, so the pads always play.
      if (LOG_PADS) padPeaks.onPad(event.pad, event.phase, event.pressure);
      if (faults.guard("pad", () => stack.onEvent(event, modeContext), false)) {
        modeContext.requestRender();
      } else handlePad(event);
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
  faults.guard(
    `FL ${section}`,
    () => {
      songFollow.onFlChange(section);
      if (section === "connection" && !flState.connected) stack.releasePads();
      if (section === "connection" && flState.connected) stack.enter(modeContext);
      else if (flState.connected) stack.onFlChange(section, modeContext);
      if (section !== "songPos" && section !== "meters") updateLeds();
      else if (section === "songPos" && strip.playPositionChanged(flState)) updateLeds();
    },
    undefined,
  );
  // ACTIVITY and PLAYED_NOTES only light pads, and they arrive up to 25 times a second.
  if (section !== "activity") updateScreens();
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
  device.setScreenBrightness(padSettings.screenBrightness);
  updateLeds();
  updateScreens();
});
device.on("disconnected", (reason) => {
  log(`Maschine MK3 disconnected: ${reason}`);
  releaseHeldNotes();
  touchedKnobs.clear();
  parser.deviceLost();
  void display.close();
});
device.on("unavailable", (reason) => log(`Waiting for the MK3: ${reason}`));
device.on("brightness", (line) => log(`Screen backlight ${line}`));
device.on("report", (report) => {
  for (const event of parser.parse(report)) faults.guard("input", () => handle(event), undefined);
});

// Ctrl-C reaches us twice when run through tsx; shut down once.
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("Shutting down…");
  setTimeout(() => {
    log("Shutdown is stuck: leaving anyway");
    process.exit(1);
  }, SHUTDOWN_LIMIT_MS).unref();
  clearInterval(requestTimer);
  releaseHeldNotes();
  leds.clear();
  ledSender.cancel();
  await ledSender.flush();
  const full = { x: 0, y: 0, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };
  for (const screen of screens.screens) clear(screen.ctx, full, "#000");
  await redraw.settled();
  await screens.flush().catch(() => undefined);
  await display.close();
  await device.stop();
  fl.close();
  process.exit(0);
}
// SIGHUP: the terminal mk3d runs in was closed (a screen transfer must not be cut off midway, only a
// power cycle gets the screens back from that; docs/protocol.md).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void shutdown());
}

try {
  fl.open();
} catch (err) {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
log(
  `Screen font: ${registerFonts() ? "Barlow (from FL Studio)" : `${FALLBACK_FAMILY} (FL Studio fonts not found)`}`,
);
log(`MIDI ports open: "${PORT_TO_FL}" (to FL) and "${PORT_FROM_FL}" (from FL)`);
log(`Pad velocity: full at hit value ${padConfig.fullScale}, curve ${padConfig.exponent}`);
device.start();
requestStateUntilConnected();
// From here on nothing may stop the daemon: timers and promises report as the pages do.
process.on("uncaughtException", (err) => faults.report("uncaught", err));
process.on("unhandledRejection", (err) => faults.report("rejected", err));
