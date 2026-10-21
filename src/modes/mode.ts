// A mode decides what the buttons, knobs and screens do. Modes are pure: they read FlState,
// send FL commands through the context and draw on the canvases they are given.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import type { ButtonId } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import type { FlSection, FlState } from "../fl/flState.js";
import type { FlCommand } from "../fl/sysex.js";
import type { ActionFlash } from "./quickEdit.js";

/** Every page the stack knows (src/modes/pageStack.ts), built or not. */
export type PageName =
  | "channel"
  | "plugin"
  | "mixer"
  | "arranger"
  | "browser"
  | "sampling"
  | "scene"
  | "liveClips"
  | "pattern"
  | "events"
  | "variation"
  | "navigate"
  | "duplicate"
  | "select"
  | "solo"
  | "mute"
  | "noteRepeat"
  | "grid"
  | "step"
  | "padMode"
  | "keyboard"
  | "chords"
  | "file"
  | "settings"
  | "macro"
  | "loop";
export type ModeName = PageName;

/** The VIEW command: what FL's script watches. */
export type ViewCommand = Extract<FlCommand, { type: "view" }>;

export interface ModeContext {
  readonly fl: FlState;
  send(command: FlCommand): void;
  /** Shift is held right now. */
  readonly shift: boolean;
  /** ERASE is held right now (the page stack sets it; absent in a bare test context). */
  readonly erase?: boolean;
  /** Knobs (0–7) with a finger on them. */
  readonly touchedKnobs: ReadonlySet<number>;
  /** Redraw the screens and LEDs after a change the mode made itself. */
  requestRender(): void;
  /** Redraw only the LEDs (cheap; a pad flashing with a repeat). Absent in a bare test context. */
  requestLeds?(): void;
  /** Only for overlays: write the page stack's saved state now (after a setting changed). */
  saveState?(): void;
  /**
   * Only for overlays, tool pages and BROWSER: show the read-out card of an action the page just did (the
   * one SHIFT + pad actions show) and write `log` to the daemon log.
   */
  reportAction?(flash: ActionFlash, log: string): void;
  /** Only for overlays: the page is pinned (its pin tab is on). */
  readonly pinned?: boolean;
  /**
   * Only for overlays: the VIEW the main page underneath wants right now, so the overlay can
   * change one field of it (e.g. `patternOffset`) without dropping the rest.
   */
  baseView?(): ViewCommand | undefined;
}

export interface Mode {
  readonly name: ModeName;
  /** On entering the mode, and again whenever FL (re)connects. */
  enter(mc: ModeContext): void;
  /**
   * A main page whose overlay just closed: resend its VIEW without resetting its state.
   * Without it the stack calls `enter`.
   */
  resume?(mc: ModeContext): void;
  /**
   * The page on top is closed, replaced by another, or the device went away: stop what it started
   * (held notes, timers). Pages that only draw and send need none.
   */
  leave?(): void;
  /** Settings the page remembers: the stack saves them with the pin states and loads them back. */
  persisted?: { save(): unknown; load(data: unknown): void };
  /** A main page's current VIEW, for overlays that need another window of FL's data. */
  view?(mc: ModeContext): ViewCommand | undefined;
  /**
   * An overlay's change to the VIEW of the page underneath (e.g. `patternOffset`). The stack
   * merges it into every VIEW the main page sends while the overlay is on top.
   */
  viewPatch?(mc: ModeContext): Partial<ViewCommand> | undefined;
  /**
   * A main page can claim an overlay's button (e.g. the Mixer takes MUTE and SOLO while it is
   * shown): the stack then gives the press and the release to the page instead of opening the
   * overlay.
   */
  claimsPageButton?(id: ButtonId): boolean;
  /**
   * A page on top that lights a button the stack would otherwise light as a page button (the STEP
   * page owns FOLLOW's LED, which is GRID's button): the stack leaves that LED alone.
   */
  ownsButtonLed?(id: ButtonId): boolean;
  /**
   * A page that uses SHIFT + pad itself (GRID: its pads are held with SHIFT still down from opening
   * it): the stack then leaves the pads to it instead of running the SHIFT + pad actions.
   */
  usesShiftPads?(): boolean;
  /**
   * A hold-opened overlay (LOOP: SHIFT + RESTART): its button was tapped, released before the hold
   * time, so the page never opened. The page runs its tap action (the page is not on top).
   */
  tap?(mc: ModeContext): void;
  /** Called for every FL change; optional. */
  onFlChange?(section: FlSection, mc: ModeContext): void;
  /** Controls that are not global. True = handled. */
  onEvent(event: HwEvent, mc: ModeContext): boolean;
  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void;
  /** Set every LED the mode owns (off included): the previous frame is not cleared. */
  leds(leds: LedState, mc: ModeContext): void;
}
