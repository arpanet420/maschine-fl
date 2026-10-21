// Maschine's page model (docs/workflow.md, "How Maschine works"): a main page (CHANNEL or PLUG-IN
// are the home pages) and at most one overlay or tool page on top of it. Pure: no hardware, no FL;
// the pages draw and send through the ModeContext they are given.
//
// Rules, after Maschine's `Base:onPageButton` and `Page:togglePinState`:
// - A main page's button closes whatever is on top and shows that page. Pressing the button of the
//   page already shown does nothing on the control pages and goes home on the others.
// - An overlay shows while its button is held. Display button 1 on an overlay is its pin tab:
//   pinned overlays stay after the release, and their pin state is remembered (and saved).
// - A tool page is latched: press to open, press again to close.
// - A main page can claim an overlay's button (Mixer: MUTE and SOLO): the page gets it, no overlay.
// - A hold overlay (`hold`: LOOP on SHIFT + RESTART) opens only when its button is held for HOLD_MS; a
//   tap (released sooner) runs the page's `tap` instead (SHIFT + tap RESTART: loop on/off), or, when the
//   stack does not handle the press at all (no SHIFT, FL gone, page not built), the caller's own tap
//   (RESTART restarts). Opened, it works like any overlay: pin tab, closes on release unless pinned.
// - PAD MODE, KEYBOARD and CHORDS are tool pages that also set the pad mode (PadState); SHIFT + the
//   button sets the mode without the page. GROUP A–H pick the channel bank unless a page takes them.
// - SHIFT is read when a page button is pressed; the release goes to what the press opened.
// - The top page gets every event first, then the main page under it. Pads the stack does not
//   handle are left to the caller (main.ts plays them as notes).
// - ERASE is a hold modifier, not a page: the stack tracks it (`mc.erase` for the pages). A pad no
//   page takes while it is held never plays: in PAD MODE it clears the channel's steps in the
//   current pattern, in KEYBOARD and CHORDS it does nothing. The STEP page clears the step itself.
// - SHIFT + DUPLICATE is an action, not a page: clone the current pattern (Maschine's "Double").
// - VOLUME, SWING and TEMPO are the quick edit (src/modes/quickEdit.ts): a radio group that turns the
//   4D encoder into an editor for every page; the stack gives it the turns, the LEDs and the
//   read-out drawn over the page. Push and tilt still go to the pages.
// - SHIFT + pad is Maschine's action row (src/modes/shiftPads.ts): while SHIFT is held the pads run
//   actions instead of playing or reaching a page, unless a page says it uses SHIFT + pad itself
//   (`usesShiftPads`, GRID). A pad held before SHIFT still ends its note. The action runs on the
//   pad's down only; its feedback is shown on the quick-edit card and logged.
// - PITCH, MOD, PERFORM and NOTES are the touch strip's modes (src/strip.ts), a radio group like the
//   quick edit: a press picks the mode, a press on the lit one leaves no mode. The mode is saved with
//   the page state (default PITCH); SHIFT + the button does nothing. A page change ends a note the
//   strip plays. The strip's read-out card is drawn over the page next to the quick edit's.
// - SHIFT + FILE is an action, not a page: save the project (the read-out `SAVED`).
// - FIXED VEL toggles fixed velocity (PadState's settings, saved with the state; its LED is bright
//   while on); SHIFT + FIXED VEL (16 velocities) is not built: the LED is off and nothing happens.
// - ARRANGER (main) and SCENE (overlay) are the playlist's markers on the pads (markerPage.ts); SCENE
//   keeps its NOW setting with the page state. SHIFT + SCENE is LIVE (liveOverlay.ts): FL's
//   performance-mode clip grid, one playlist track's blocks on the pads.
// - A page that is left (closed, replaced, device gone) gets `leave`; pages with `persisted` settings
//   have them saved with the pin states (NOTE REPEAT's rate, gate and swing, SCENE's NOW, the
//   scale and chord settings of KEYBOARD and CHORDS).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlSection } from "../fl/flState.js";
import type { HwEvent } from "../hw/events.js";
import type { ButtonId } from "../hw/ids.js";
import { PAD_COUNT } from "../hw/ids.js";
import { isColorLed, isMonoLed, type LedState, type LightLevel } from "../hw/leds.js";
import { LED_OFF, paletteWhite } from "../hw/palette.js";
import { bringUpWindow } from "./flWindows.js";
import { groupBank, setBankLeds } from "./channelBank.js";
import type { Mode, ModeContext, PageName } from "./mode.js";
import { isPadMode, type PadMode, type PadState } from "./padState.js";
import { QuickEdit, quickModeOf, type HeldTarget } from "./quickEdit.js";
import { realTimers, type RepeatTimers } from "./repeatScheduler.js";
import { isStripMode, NO_STRIP_MODE, stripModeOf, type StripControl } from "../strip.js";
import { runShiftAction, shiftActionAvailable, shiftActionOf } from "./shiftPads.js";

export type PageKind = "main" | "overlay" | "tool";

export interface PageDef {
  id: PageName;
  /** The name on the panel, also the pin tab of an overlay. */
  label: string;
  kind: PageKind;
  button: ButtonId;
  /** Opened by SHIFT + button instead of the button alone. */
  shift?: boolean;
  /** CHANNEL and PLUG-IN: the home pages. */
  control?: boolean;
  /** PAD MODE, KEYBOARD and CHORDS: the pad mode the button sets. */
  padMode?: PadMode;
  /** Opens only after the button was held for `HOLD_MS`; a tap runs the page's `tap`. */
  hold?: boolean;
}

const def = (
  id: PageName,
  label: string,
  kind: PageKind,
  button: ButtonId,
  extra: { shift?: boolean; control?: boolean; padMode?: PadMode; hold?: boolean } = {},
): PageDef => ({ id, label, kind, button, ...extra });

/** Every page button and what it opens (docs/workflow.md, "Button by button"). */
export const PAGE_DEFS: readonly PageDef[] = [
  def("channel", "CHANNEL", "main", "channel", { control: true }),
  def("plugin", "PLUG-IN", "main", "plugIn", { control: true }),
  def("mixer", "MIXER", "main", "mixer"),
  def("arranger", "ARRANGER", "main", "arranger"),
  def("browser", "BROWSER", "main", "browser"),
  def("sampling", "SAMPLING", "main", "sampling"),
  def("scene", "SCENE", "overlay", "scene"),
  def("liveClips", "LIVE", "overlay", "scene", { shift: true }),
  def("pattern", "PATTERN", "overlay", "pattern"),
  def("events", "EVENTS", "overlay", "events"),
  def("variation", "VARIATION", "overlay", "variation"),
  def("navigate", "NAVIGATE", "overlay", "variation", { shift: true }),
  def("duplicate", "DUPLICATE", "overlay", "duplicate"),
  def("select", "SELECT", "overlay", "select"),
  def("solo", "SOLO", "overlay", "solo"),
  def("mute", "MUTE", "overlay", "mute"),
  def("noteRepeat", "NOTE REPEAT", "overlay", "noteRepeat"),
  def("grid", "GRID", "overlay", "follow", { shift: true }),
  def("step", "STEP", "tool", "step"),
  def("padMode", "PAD MODE", "tool", "padMode", { padMode: "channels" }),
  def("keyboard", "KEYBOARD", "tool", "keyboard", { padMode: "keyboard" }),
  def("chords", "CHORDS", "tool", "chords", { padMode: "chords" }),
  def("file", "FILE", "tool", "file"),
  def("settings", "SETTINGS", "tool", "settings"),
  def("macro", "MACRO", "tool", "macro"),
  def("loop", "LOOP", "overlay", "restart", { shift: true, hold: true }),
];

/** How long a hold overlay's button is held before the overlay opens (Maschine: ~20 ticks of 20 ms). */
export const HOLD_MS = 400;

export function defaultPagesPath(): string {
  return join(homedir(), "Library", "Application Support", "mk3d", "pages.json");
}

export interface PageStackOptions {
  /** The pages that are built, by id. The others are registered but do nothing yet. */
  pages: Partial<Record<PageName, Mode>>;
  /** Where pin states and the pad mode are saved; none = not saved (tests). */
  pinsPath?: string;
  /** The pad mode and channel banks: the stack sets and saves the mode and handles GROUP A–H. */
  pads?: PadState;
  /** The touch strip: the stack handles its mode buttons, LEDs, read-out and saved mode. */
  strip?: StripControl;
  log?: (line: string) => void;
  /** The clock, in ms (tests set their own; it times the quick edit's read-out). */
  now?: () => number;
  /** Timers for the hold overlays (tests pass a fake clock's). */
  timers?: RepeatTimers;
}

/** The page on top of the main page. */
export interface TopPage {
  page: PageDef;
  /** The button that opened it. */
  button: ButtonId;
  held: boolean;
  pinned: boolean;
  /** The button was pressed to close an open page: the release closes it. */
  closeOnRelease: boolean;
}

const HOME_PAGE: PageName = "channel";

export class PageStack {
  private readonly defs = PAGE_DEFS;
  private readonly pages: Partial<Record<PageName, Mode>>;
  private readonly log: (line: string) => void;
  private readonly pinsPath: string | undefined;
  private readonly pads: PadState | undefined;
  private readonly strip: StripControl | undefined;
  private readonly timers: RepeatTimers;
  /** Hold overlay buttons that are down: the timer, and whether it fired (the overlay is open). */
  private readonly holds = new Map<ButtonId, { def: PageDef; timer: unknown; opened: boolean }>();
  private readonly pins = new Map<PageName, boolean>();
  /** What each held page button opened, so its release goes to the same place. */
  private readonly pressed = new Map<ButtonId, PageDef>();
  /**
   * Who took each pad's down event: a page, null for "nobody" (the caller plays the note), or
   * "erase" (ERASE was held: the stack took it, and its move and up are swallowed), or "shift"
   * (SHIFT was held: it ran an action, and its move and up are swallowed).
   */
  private readonly padOwner = new Map<number, Mode | null | "erase" | "shift">();
  private eraseHeld = false;
  /** Overlay buttons the main page claimed (Mixer: MUTE, SOLO): who gets their release. */
  private readonly claimed = new Map<ButtonId, Mode>();
  private pinPressed = false;
  private mainDef: PageDef;
  private lastControl: PageDef;
  private topPage: TopPage | undefined;
  /** VOLUME, SWING and TEMPO: the 4D encoder as an editor. */
  readonly quickEdit: QuickEdit;

  constructor(options: PageStackOptions) {
    this.quickEdit = new QuickEdit(options.now);
    this.pages = options.pages;
    this.log = options.log ?? (() => undefined);
    this.pinsPath = options.pinsPath;
    this.pads = options.pads;
    this.strip = options.strip;
    this.timers = options.timers ?? realTimers;
    const home = this.find(HOME_PAGE);
    this.mainDef = home;
    this.lastControl = home;
    this.loadState();
  }

  // ── State ──────────────────────────────────────────────────────────────────

  /** The main page shown (under any overlay). */
  get main(): PageName {
    return this.mainDef.id;
  }

  /** The overlay or tool page on top, if any. */
  get top(): Readonly<TopPage> | undefined {
    return this.topPage;
  }

  isPinned(id: PageName): boolean {
    return this.pins.get(id) ?? false;
  }

  /** The page whose screens and LEDs are shown: the top page, else the main page. */
  get active(): Mode | undefined {
    return this.topMode() ?? this.mainMode();
  }

  private find(id: PageName): PageDef {
    const found = this.defs.find((d) => d.id === id);
    if (!found) throw new Error(`unknown page ${id}`);
    return found;
  }

  private mainMode(): Mode | undefined {
    return this.pages[this.mainDef.id];
  }

  private topMode(): Mode | undefined {
    return this.topPage ? this.pages[this.topPage.page.id] : undefined;
  }

  // ── Contexts ───────────────────────────────────────────────────────────────

  /** The main page's context: a VIEW it sends gets the overlay's changes merged in. */
  private mainContext(mc: ModeContext): ModeContext {
    const erase = () => this.eraseHeld;
    return {
      fl: mc.fl,
      get shift() {
        return mc.shift;
      },
      get erase() {
        return erase();
      },
      touchedKnobs: mc.touchedKnobs,
      requestRender: () => mc.requestRender(),
      reportAction: (flash, line) => {
        this.log(line);
        this.quickEdit.flash(flash, mc);
      },
      send: (command) => {
        if (command.type === "view") {
          mc.send({ ...command, ...this.topMode()?.viewPatch?.(mc) });
        } else {
          mc.send(command);
        }
      },
    };
  }

  /** An overlay's or tool's context: it can ask for the main page's VIEW and knows its pin. */
  private topContext(mc: ModeContext): ModeContext {
    const pinned = () => this.topPage?.pinned ?? false;
    const erase = () => this.eraseHeld;
    return {
      fl: mc.fl,
      get shift() {
        return mc.shift;
      },
      get erase() {
        return erase();
      },
      get pinned() {
        return pinned();
      },
      touchedKnobs: mc.touchedKnobs,
      requestRender: () => mc.requestRender(),
      requestLeds: () => (mc.requestLeds ? mc.requestLeds() : mc.requestRender()),
      saveState: () => this.saveState(),
      reportAction: (flash, line) => {
        this.log(line);
        this.quickEdit.flash(flash, mc);
      },
      send: (command) => mc.send(command),
      baseView: () => this.mainMode()?.view?.(mc),
    };
  }

  private contextFor(page: Mode, mc: ModeContext): ModeContext {
    return page === this.topMode() ? this.topContext(mc) : this.mainContext(mc);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** FL (re)connected: start the main page and the page on top of it again. */
  enter(mc: ModeContext): void {
    this.pads?.observe(mc.fl);
    this.mainMode()?.enter(this.mainContext(mc));
    this.topMode()?.enter(this.topContext(mc));
  }

  onFlChange(section: FlSection, mc: ModeContext): void {
    if (section === "selectedChannel") {
      this.pads?.observe(mc.fl);
      this.strip?.channelChanged(mc);
    }
    this.mainMode()?.onFlChange?.(section, this.mainContext(mc));
    this.topMode()?.onFlChange?.(section, this.topContext(mc));
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /** True = handled; the caller plays an unhandled pad as a note. */
  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type === "pad") return this.onPad(event, mc);
    if (event.type === "button" && this.onHoldButton(event, mc)) return true;
    if (event.type === "button" && quickModeOf(event.id)) return this.onQuickButton(event, mc);
    if (event.type === "button" && this.strip && stripModeOf(event.id)) {
      return this.onStripButton(event, mc);
    }
    if (event.type === "nav" && event.action === "turn" && this.quickEdit.active) {
      // A quick-edit mode is on: turns edit its value, whatever page is shown. Push and tilt go on.
      if (mc.fl.connected) this.quickEdit.turn(event.delta, mc, this.heldTarget(mc));
      return true;
    }
    if (event.type === "button" && event.id === "erase") {
      this.eraseHeld = event.pressed;
      return true;
    }
    if (event.type === "button" && event.id === "fixedVel") return this.onFixedVel(event, mc);
    if (event.type === "button" && event.id !== "shift") {
      if (!event.pressed) {
        const owner = this.claimed.get(event.id);
        if (owner) {
          this.claimed.delete(event.id);
          owner.onEvent(event, this.mainContext(mc));
          return true;
        }
        if (this.release(event.id, mc)) return true;
      } else {
        if (event.id === "display1" && this.togglePin(mc)) return true;
        const target = this.lookup(event.id, mc.shift);
        if (!target && this.setPadModeOnly(event.id, mc)) return true;
        if (!target && this.shiftAction(event.id, mc)) return true;
        if (target && this.claim(target, event, mc)) return true;
        if (target) {
          this.press(target, event.id, mc);
          return true;
        }
      }
    }
    if (this.dispatch(event, mc)) return true;
    return this.pickBank(event, mc);
  }

  /**
   * The button of a hold overlay (SHIFT + RESTART): the press starts the hold timer, the timer opens
   * the overlay, a release before that is a tap. False = not ours (no hold page for this button with
   * this SHIFT state, FL gone, page not built): the caller handles the button as it always did.
   */
  private onHoldButton(event: Extract<HwEvent, { type: "button" }>, mc: ModeContext): boolean {
    const held = this.holds.get(event.id);
    if (!event.pressed) {
      if (!held) return false;
      this.holds.delete(event.id);
      if (held.opened) return this.release(event.id, mc) || true;
      this.timers.clear(held.timer);
      this.pages[held.def.id]?.tap?.(this.topContext(mc));
      return true;
    }
    if (held) return true; // a repeated press
    if (!mc.fl.connected) return false;
    const def = this.defs.find(
      (d) => d.hold && d.button === event.id && (d.shift ?? false) === mc.shift,
    );
    if (!def || !this.pages[def.id]) return false;
    const entry = { def, timer: undefined as unknown, opened: false };
    entry.timer = this.timers.set(() => {
      if (this.holds.get(event.id) !== entry) return;
      entry.opened = true;
      this.press(def, event.id, mc);
    }, HOLD_MS);
    this.holds.set(event.id, entry);
    return true;
  }

  private clearHolds(): void {
    for (const held of this.holds.values()) this.timers.clear(held.timer);
    this.holds.clear();
  }

  /**
   * VOLUME, SWING and TEMPO: press = that quick-edit mode on, or off when it is the one on. SHIFT +
   * the button does nothing (the second labels are not built). The release is ignored.
   */
  private onQuickButton(event: Extract<HwEvent, { type: "button" }>, mc: ModeContext): boolean {
    const mode = quickModeOf(event.id);
    if (mode && event.pressed && mc.fl.connected && !mc.shift) this.quickEdit.press(mode, mc);
    return true;
  }

  /**
   * PITCH, MOD, PERFORM and NOTES: press = that strip mode on, or off when it is the one on. SHIFT +
   * the button does nothing. The release is ignored.
   */
  private onStripButton(event: Extract<HwEvent, { type: "button" }>, mc: ModeContext): boolean {
    const mode = stripModeOf(event.id);
    if (mode && event.pressed && mc.fl.connected && !mc.shift) {
      this.strip?.press(mode, mc);
      this.saveState();
    }
    return true;
  }

  /** FIXED VEL: press = fixed velocity on or off. SHIFT + FIXED VEL (16 velocities) is not built. */
  private onFixedVel(event: Extract<HwEvent, { type: "button" }>, mc: ModeContext): boolean {
    const settings = this.pads?.settings;
    if (!settings || !event.pressed || mc.shift || !mc.fl.connected) return !!settings;
    settings.fixedOn = !settings.fixedOn;
    this.saveState();
    this.log(`fixed velocity ${settings.fixedOn ? `on (${settings.fixedVelocity})` : "off"}`);
    this.quickEdit.flash(
      {
        title: settings.fixedOn ? "FIXED VEL ON" : "FIXED VEL OFF",
        detail: settings.fixedOn ? String(settings.fixedVelocity) : "",
        source: "PAD VELOCITY",
      },
      mc,
    );
    return true;
  }

  /** Which pads are held, and the channel they stand for (for the quick edit). */
  private heldTarget(mc: ModeContext): HeldTarget {
    const pad = [...this.padOwner.values()].some((owner) => owner !== "erase" && owner !== "shift");
    return {
      pad,
      channel: pad ? (this.pads?.heldChannel() ?? mc.fl.selectedChannel.index) : null,
    };
  }

  /** The device went away or mk3d is stopping: no pad is held any more. */
  releasePads(): void {
    this.clearHolds();
    this.topMode()?.leave?.();
    this.padOwner.clear();
    this.quickEdit.reset();
    this.strip?.release();
  }

  /** Does a page on top, or the main page, use SHIFT + pad itself? */
  private pageUsesShiftPads(): boolean {
    return (
      (this.topMode()?.usesShiftPads?.() ?? false) || (this.mainMode()?.usesShiftPads?.() ?? false)
    );
  }

  /** GROUP A–H that no page took: select the channel last selected in that bank. */
  private pickBank(event: HwEvent, mc: ModeContext): boolean {
    if (event.type !== "button" || !this.pads || !mc.fl.connected) return false;
    const bank = groupBank(event.id);
    if (bank === undefined) return false;
    if (event.pressed) this.pads.selectBank(bank, mc);
    return true;
  }

  /** SHIFT + PAD MODE, KEYBOARD or CHORDS: set the pad mode, open nothing. True = handled. */
  private setPadModeOnly(button: ButtonId, mc: ModeContext): boolean {
    const mode = this.defs.find((d) => d.button === button && d.padMode)?.padMode;
    if (!mode || !mc.shift || !this.pads) return false;
    this.setPadMode(mode, mc);
    return true;
  }

  /**
   * SHIFT + DUPLICATE: clone the current pattern ("Double"; FL can't double), no page. SHIFT + FILE:
   * save the project, no page. True = handled.
   */
  private shiftAction(button: ButtonId, mc: ModeContext): boolean {
    if (!mc.shift || !mc.fl.connected) return false;
    if (button === "duplicate") {
      const number = mc.fl.pattern.number;
      if (number > 0) mc.send({ type: "clonePattern", number });
      return true;
    }
    if (button === "file") {
      mc.send({ type: "ui", action: "save" });
      this.log("→ FL save project");
      this.quickEdit.flash({ title: "SAVED", detail: "", source: "SHIFT + FILE" }, mc);
      return true;
    }
    return false;
  }

  private setPadMode(mode: PadMode, mc: ModeContext): void {
    if (!this.pads || this.pads.mode === mode) return;
    this.pads.mode = mode;
    this.saveState();
    mc.requestRender();
  }

  /** The top page first, then the main page under it. */
  private dispatch(event: HwEvent, mc: ModeContext): boolean {
    if (!mc.fl.connected) return false;
    const top = this.topMode();
    if (top?.onEvent(event, this.topContext(mc))) return true;
    return this.mainMode()?.onEvent(event, this.mainContext(mc)) ?? false;
  }

  private onPad(event: Extract<HwEvent, { type: "pad" }>, mc: ModeContext): boolean {
    if (!mc.fl.connected) return false;
    if (event.phase === "down") {
      if (mc.shift && !this.pageUsesShiftPads()) {
        // SHIFT held: the pad is an action, never a note or a page's pad.
        this.padOwner.set(event.pad, "shift");
        const report = runShiftAction(event.pad, mc);
        if (report) {
          this.log(report.log);
          this.quickEdit.flash(report.flash, mc);
        }
        return true;
      }
      const top = this.topMode();
      const main = this.mainMode();
      let owner: Mode | null = null;
      if (top?.onEvent(event, this.topContext(mc))) owner = top;
      else if (main?.onEvent(event, this.mainContext(mc))) owner = main;
      if (owner === null && this.eraseHeld && this.pads) {
        // ERASE held and no page wants the pad: it must not play a note either.
        this.padOwner.set(event.pad, "erase");
        this.pads.erase(event.pad, mc);
        return true;
      }
      this.padOwner.set(event.pad, owner);
      return owner !== null;
    }
    // move and up follow the page that took the down, even after it closed: nothing is left held
    const owner = this.padOwner.get(event.pad);
    if (event.phase === "up") this.padOwner.delete(event.pad);
    if (owner === "erase" || owner === "shift") return true;
    if (!owner) return false;
    owner.onEvent(event, this.contextFor(owner, mc));
    return true;
  }

  /**
   * The main page takes an overlay's button (`claimsPageButton`): no overlay opens, the page gets
   * the press now and the release later. Only while FL is connected, like every page event.
   */
  private claim(target: PageDef, event: Extract<HwEvent, { type: "button" }>, mc: ModeContext) {
    if (target.kind !== "overlay" || !mc.fl.connected) return false;
    const main = this.mainMode();
    if (!main?.claimsPageButton?.(event.id)) return false;
    this.claimed.set(event.id, main);
    main.onEvent(event, this.mainContext(mc));
    return true;
  }

  private lookup(button: ButtonId, shift: boolean): PageDef | undefined {
    return this.defs.find((d) => !d.hold && d.button === button && (d.shift ?? false) === shift);
  }

  // ── Page buttons ───────────────────────────────────────────────────────────

  private press(target: PageDef, button: ButtonId, mc: ModeContext): void {
    this.pressed.set(button, target);
    if (!this.pages[target.id]) {
      this.log(`page "${target.id}" is not built yet`);
      return;
    }
    // Opening PAD MODE, KEYBOARD or CHORDS sets the pad mode; pressing it again to leave keeps the mode.
    if (target.padMode && this.topPage?.page !== target) this.setPadMode(target.padMode, mc);
    if (target.kind === "main") this.pressMain(target, mc);
    else if (target.kind === "overlay") this.pressOverlay(target, button, mc);
    else this.pressTool(target, button, mc);
  }

  private release(button: ButtonId, mc: ModeContext): boolean {
    if (button === "display1" && this.pinPressed) {
      this.pinPressed = false;
      return true;
    }
    const target = this.pressed.get(button);
    if (!target) return false;
    this.pressed.delete(button);
    const top = this.topPage;
    if (target.kind === "main" || !top || top.page !== target || top.button !== button) return true;
    top.held = false;
    if (top.closeOnRelease || (target.kind === "overlay" && !top.pinned)) this.closeTop(mc);
    return true;
  }

  private pressMain(target: PageDef, mc: ModeContext): void {
    if (target === this.mainDef && !this.topPage) {
      if (!target.control) this.showMain(this.lastControl, mc);
      return;
    }
    this.closeTop(mc, false);
    this.showMain(target, mc);
  }

  private showMain(target: PageDef, mc: ModeContext): void {
    if (target === this.mainDef) {
      this.resumeMain(mc);
      return;
    }
    this.strip?.silence();
    this.mainMode()?.leave?.(); // BROWSER closes a popup it opened in FL
    this.mainDef = target;
    if (target.control) this.lastControl = target;
    this.log(`page: ${target.id}`);
    if (mc.fl.connected) this.mainMode()?.enter(this.mainContext(mc));
    bringUpWindow(target.id, mc);
    mc.requestRender();
  }

  private pressOverlay(target: PageDef, button: ButtonId, mc: ModeContext): void {
    const top = this.topPage;
    if (top?.page === target) {
      // Already open: pinned (not held), or a repeated press while held.
      if (!top.held) {
        top.held = true;
        top.button = button;
        top.closeOnRelease = true;
      }
      return;
    }
    this.openTop(target, button, this.isPinned(target.id), mc);
  }

  private pressTool(target: PageDef, button: ButtonId, mc: ModeContext): void {
    const top = this.topPage;
    if (top?.page === target) {
      top.held = true;
      top.button = button;
      top.closeOnRelease = true;
      return;
    }
    this.openTop(target, button, false, mc);
  }

  private openTop(target: PageDef, button: ButtonId, pinned: boolean, mc: ModeContext): void {
    const before = this.topMode();
    this.strip?.silence();
    if (before && before !== this.pages[target.id]) before.leave?.();
    this.topPage = { page: target, button, held: true, pinned, closeOnRelease: false };
    const page = this.topMode();
    if (mc.fl.connected) {
      page?.enter(this.topContext(mc));
      // Leaving a page that changed the main page's VIEW for one that doesn't.
      if (before?.viewPatch && !page?.viewPatch) this.resumeMain(mc);
      if (target.kind === "tool") bringUpWindow(target.id, mc);
    }
    mc.requestRender();
  }

  /** Close the page on top; the main page under it picks up again (unless another page opens). */
  private closeTop(mc: ModeContext, resume = true): void {
    if (!this.topPage) return;
    this.strip?.silence();
    this.topMode()?.leave?.();
    this.topPage = undefined;
    if (resume) this.resumeMain(mc);
    mc.requestRender();
  }

  private resumeMain(mc: ModeContext): void {
    if (!mc.fl.connected) return;
    const main = this.mainMode();
    if (!main) return;
    const ctx = this.mainContext(mc);
    if (main.resume) main.resume(ctx);
    else main.enter(ctx);
  }

  /** Display button 1 on an overlay: toggle its pin. True = handled. */
  private togglePin(mc: ModeContext): boolean {
    const top = this.topPage;
    if (!top || top.page.kind !== "overlay") return false;
    top.pinned = !top.pinned;
    this.pins.set(top.page.id, top.pinned);
    this.saveState();
    this.pinPressed = true;
    if (!top.pinned && !top.held) this.closeTop(mc);
    mc.requestRender();
    return true;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const top = this.topMode();
    if (top) top.render(left, right, this.topContext(mc));
    else this.mainMode()?.render(left, right, this.mainContext(mc));
    this.quickEdit.render(left, mc, this.heldTarget(mc));
    this.strip?.render(left, mc);
  }

  /** The main page's LEDs, the top page's over them, then the page buttons. */
  leds(leds: LedState, mc: ModeContext): void {
    if (this.pads) setBankLeds(leds, mc.fl);
    this.mainMode()?.leds(leds, this.mainContext(mc));
    this.topMode()?.leds(leds, this.topContext(mc));
    this.pageButtonLeds(leds, mc.fl.connected);
    this.quickEdit.leds(leds, mc.fl.connected);
    this.strip?.leds(leds, mc);
    if (mc.shift && mc.fl.connected && !this.pageUsesShiftPads()) this.shiftPadLeds(leds, mc);
    // FIXED VEL: bright while on, off with SHIFT (16 velocities is not built).
    if (this.pads) {
      const on = this.pads.settings.fixedOn;
      leds.setLight("fixedVel", !mc.fl.connected || mc.shift ? "off" : on ? "bright" : "dim");
    }
    // ERASE: bright while held.
    leds.setLight("erase", !mc.fl.connected ? "off" : this.eraseHeld ? "bright" : "dim");
  }

  /** While SHIFT is held the pads show the action row: available dim white, pressed bright. */
  private shiftPadLeds(leds: LedState, mc: ModeContext): void {
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const available = shiftActionAvailable(shiftActionOf(pad), mc);
      const pressed = this.padOwner.get(pad) === "shift";
      leds.setPad(pad, available ? paletteWhite(pressed ? "bright" : "dim") : LED_OFF);
    }
  }

  /**
   * The button of the page on top is bright, a main page under an overlay too, the other built
   * pages dim, unbuilt pages off. CHANNEL and PLUG-IN: the current control page is bright.
   */
  private pageButtonLeds(leds: LedState, connected: boolean): void {
    // Hold overlays (RESTART) are not page buttons: the button keeps the LED main.ts gives it.
    const buttons = new Set(this.defs.filter((d) => !d.hold).map((d) => d.button));
    const main = this.mainMode();
    for (const button of buttons) {
      // A button the main page claimed keeps the LED the page gave it.
      if (main?.claimsPageButton?.(button)) continue;
      // A button the page on top lights itself (STEP: FOLLOW) too, and so does a main page with
      // nothing over it (ARRANGER: FOLLOW).
      if ((this.topMode() ?? main)?.ownsButtonLed?.(button)) continue;
      let level: LightLevel = "off";
      for (const d of this.defs) {
        if (d.button !== button || !this.pages[d.id] || !connected) continue;
        // SHIFT + button pages (NAVIGATE, GRID) light the button while open, not before: the button
        // alone (VARIATION) can still be unbuilt.
        if (d.shift && this.topPage?.page !== d) continue;
        const bright =
          this.topPage?.page === d || d === this.mainDef || (d.control && d === this.lastControl);
        if (bright) level = "bright";
        else if (level === "off") level = "dim";
      }
      // PAD MODE, KEYBOARD and CHORDS are a radio group: the current pad mode is bright, whatever page is open.
      const radio = this.defs.find((d) => d.button === button && d.padMode);
      if (radio?.padMode && this.pads && level !== "off") {
        level = this.pads.mode === radio.padMode ? "bright" : "dim";
      }
      if (isMonoLed(button)) leds.setLight(button, level);
      else if (isColorLed(button)) {
        leds.setButtonColor(button, level === "off" ? LED_OFF : paletteWhite(level));
      }
    }
  }

  // ── Pin states ─────────────────────────────────────────────────────────────

  private loadState(): void {
    if (!this.pinsPath) return;
    try {
      const data = JSON.parse(readFileSync(this.pinsPath, "utf8")) as {
        pinned?: Record<string, unknown>;
        padMode?: unknown;
        stripMode?: unknown;
        pages?: unknown;
      } | null;
      if (this.pads && isPadMode(data?.padMode)) this.pads.mode = data.padMode;
      if (this.strip && (isStripMode(data?.stripMode) || data?.stripMode === NO_STRIP_MODE)) {
        this.strip.loadMode(data?.stripMode);
      }
      const saved = data?.pages;
      if (saved && typeof saved === "object") {
        for (const [id, page] of Object.entries(this.pages)) {
          if (page?.persisted && id in saved)
            page.persisted.load((saved as Record<string, unknown>)[id]);
        }
      }
      const pinned = data?.pinned;
      if (!pinned || typeof pinned !== "object") return;
      for (const d of this.defs) {
        if (d.kind === "overlay" && pinned[d.id] === true) this.pins.set(d.id, true);
      }
    } catch {
      // No file yet, or not readable: nothing is pinned and the pad mode stays as it is.
    }
  }

  private saveState(): void {
    if (!this.pinsPath) return;
    const pinned: Record<string, boolean> = {};
    for (const [id, on] of this.pins) if (on) pinned[id] = true;
    try {
      mkdirSync(dirname(this.pinsPath), { recursive: true });
      const temp = `${this.pinsPath}.tmp`;
      const pages: Record<string, unknown> = {};
      for (const [id, page] of Object.entries(this.pages)) {
        if (page?.persisted) pages[id] = page.persisted.save();
      }
      const state = {
        pinned,
        ...(this.pads ? { padMode: this.pads.mode } : {}),
        ...(this.strip ? { stripMode: this.strip.savedMode() } : {}),
        ...(Object.keys(pages).length > 0 ? { pages } : {}),
      };
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(temp, this.pinsPath);
    } catch (err) {
      this.log(`could not save the page state: ${String(err)}`);
    }
  }
}
