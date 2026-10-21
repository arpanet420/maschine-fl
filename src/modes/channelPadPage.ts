// Base of the pages whose pads are the 16 channels of the current bank (MUTE, SELECT, SOLO and the
// PAD MODE page). They share the window (VIEW `channelOffset` = the bank, merged into the main
// page's VIEW so FL reports these channels' names and colors), GROUP A–H as banks, the 4×4 grid and
// the pad LEDs; a subclass says what a pad press does and how the left screen looks.
// Pad moves and releases are taken too, so no pad plays a note under the page.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlState } from "../fl/flState.js";
import type { ChannelEntry } from "../fl/sysex.js";
import type { HwEvent } from "../hw/events.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState, MonoLedId } from "../hw/leds.js";
import { LED_OFF } from "../hw/palette.js";
import { TAB_HEIGHT, clear, drawTabs } from "../render/widgets.js";
import {
  BANK_SIZE,
  bankFirst,
  bankLength,
  bankText,
  currentBank,
  groupBank,
  setBankLeds,
} from "./channelBank.js";
import { FULL } from "./draw.js";
import { flColorToCss, flColorToPalette } from "./format.js";
import type { Mode, ModeContext, ModeName, ViewCommand } from "./mode.js";
import type { PadState } from "./padState.js";
import { GRID_RECT, drawFooter, drawPadGrid, type PadCell } from "./padGrid.js";

export const DISPLAY_BUTTONS: readonly MonoLedId[] = [
  "display1",
  "display2",
  "display3",
  "display4",
  "display5",
  "display6",
  "display7",
  "display8",
];

/** What a pad shows for a channel: `entry` is undefined past the last channel. */
export interface PadChannel {
  /** 0-based index in the channel rack. */
  index: number;
  entry: ChannelEntry;
  selected: boolean;
}

export abstract class ChannelPadPage implements Mode {
  abstract readonly name: ModeName;
  /** The bank whose window FL was last asked for. */
  private sentBank: number | undefined;

  constructor(protected readonly pads: PadState) {}

  enter(mc: ModeContext): void {
    this.sendView(mc);
  }

  /** The channel window FL reports follows the bank. */
  viewPatch(mc: ModeContext): Partial<ViewCommand> {
    return { channelOffset: bankFirst(currentBank(mc.fl)) };
  }

  onFlChange(section: string, mc: ModeContext): void {
    if (section !== "selectedChannel" && section !== "channels") return;
    if (currentBank(mc.fl) !== this.sentBank) this.sendView(mc);
  }

  private sendView(mc: ModeContext): void {
    this.sentBank = currentBank(mc.fl);
    const base = mc.baseView?.();
    if (base) mc.send({ ...base, ...this.viewPatch(mc) });
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    switch (event.type) {
      case "pad":
        // Down acts; move and up are ours too so no pad ever plays a note under the page.
        if (event.phase === "down") {
          const channel = this.channelAt(event.pad, mc.fl);
          if (channel) this.onPad?.(channel, mc);
        }
        return true;
      case "button": {
        const bank = groupBank(event.id);
        if (bank !== undefined) {
          if (event.pressed) this.pads.selectBank(bank, mc);
          return true;
        }
        const display = DISPLAY_BUTTONS.findIndex((button) => button === event.id);
        if (display < 0) return false;
        // Display buttons never reach the page underneath.
        if (event.pressed) this.displayPressed?.(display, mc);
        return true;
      }
      default:
        return false;
    }
  }

  /** A display button (0–7 for display 1–8) was pressed. By default none does anything. */
  protected displayPressed?(display: number, mc: ModeContext): void;

  /** A pad over an existing channel went down. */
  protected onPad?(channel: PadChannel, mc: ModeContext): void;

  // ── Window ─────────────────────────────────────────────────────────────────

  protected bank(mc: ModeContext): number {
    return currentBank(mc.fl);
  }

  /** The channel under a pad, undefined past the last channel or while FL hasn't reported it. */
  protected channelAt(pad: number, fl: FlState): PadChannel | undefined {
    const index = bankFirst(currentBank(fl)) + pad;
    if (index >= fl.channelTotal) return undefined;
    const entry = fl.channels.get(index);
    return entry && { index, entry, selected: index === fl.selectedChannel.index };
  }

  /** Channels in the bank that exist. */
  protected shown(fl: FlState): number {
    return bankLength(fl, currentBank(fl));
  }

  protected windowText(fl: FlState): string {
    return bankText(fl, currentBank(fl));
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    clear(left, FULL);
    this.renderLeft(left, mc);
    clear(right, FULL);
    drawTabs(right, { ...FULL, height: TAB_HEIGHT }, { tabs: this.rightTabs?.(mc) ?? [] });
    const cells: Array<PadCell | undefined> = [];
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const channel = this.channelAt(pad, mc.fl);
      cells.push(channel && this.cell(channel));
    }
    drawPadGrid(right, GRID_RECT, cells);
    drawFooter(right, this.windowText(mc.fl));
  }

  protected abstract renderLeft(ctx: SKRSContext2D, mc: ModeContext): void;

  /** Tabs of the right screen (display buttons 5–8). */
  protected rightTabs?(mc: ModeContext): readonly string[];

  /** The grid cell of a channel. */
  protected cell(channel: PadChannel): PadCell {
    const { entry, index } = channel;
    return {
      number: index + 1,
      name: entry.name,
      color: flColorToCss(entry.color),
      current: channel.selected,
      muted: entry.muted,
    };
  }

  /** How bright the pad over a channel is lit: the selected channel's bright, the rest dim. */
  protected padLevel(channel: PadChannel): "dim" | "bright" {
    return channel.selected ? "bright" : "dim";
  }

  leds(leds: LedState, mc: ModeContext): void {
    this.padLeds(leds, mc);
    setBankLeds(leds, mc.fl);
    this.displayLeds(leds, mc);
  }

  /** The pad LEDs: the channel's color, `padLevel` bright, off past the last channel. */
  protected padLeds(leds: LedState, mc: ModeContext): void {
    for (let pad = 0; pad < BANK_SIZE; pad++) {
      const channel = this.channelAt(pad, mc.fl);
      leds.setPad(
        pad,
        channel ? flColorToPalette(channel.entry.color, this.padLevel(channel)) : LED_OFF,
      );
    }
  }

  /** Display button LEDs: display 1 is the pin tab (bright when pinned), the rest are off. */
  protected displayLeds(leds: LedState, mc: ModeContext): void {
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
  }
}
