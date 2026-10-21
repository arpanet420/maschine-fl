// PAD MODE page (a tool page: PAD MODE opens it, PAD MODE again leaves it; the pad mode itself is
// set by the press, or by SHIFT + PAD MODE without the page). The pads are the 16 channels of the
// current bank and play them (the global pad handler in main.ts does that: this page takes no pad
// and leaves the pad LEDs to it); the page shows the bank. Display buttons 7 and 8 (`<<` `>>`) and
// GROUP A–H pick the bank.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import type { LedState } from "../hw/leds.js";
import { TAB_HEIGHT, drawTabs, fitText, font, theme } from "../render/widgets.js";
import { bankCount, bankLetter, currentBank } from "./channelBank.js";
import { ChannelPadPage } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import { flColorToCss } from "./format.js";
import type { ModeContext } from "./mode.js";

/** Display 7 and 8 (0-based 6 and 7): `<<` and `>>`. */
const PREVIOUS = 6;
const NEXT = 7;

export class PadModePage extends ChannelPadPage {
  readonly name = "padMode";

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type === "pad") return false; // the pads play their channels
    return super.onEvent(event, mc);
  }

  protected displayPressed(display: number, mc: ModeContext): void {
    if (display === PREVIOUS) this.pads.selectBank(this.bank(mc) - 1, mc);
    if (display === NEXT) this.pads.selectBank(this.bank(mc) + 1, mc);
  }

  protected padLeds(): void {
    // The global fallback lights the pads (held ones pressed).
  }

  private hasPrevious(mc: ModeContext): boolean {
    return this.bank(mc) > 0;
  }

  private hasNext(mc: ModeContext): boolean {
    return this.bank(mc) + 1 < bankCount(mc.fl);
  }

  protected rightTabs(mc: ModeContext): readonly string[] {
    return ["", "", this.hasPrevious(mc) ? "<<" : "", this.hasNext(mc) ? ">>" : ""];
  }

  protected renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    drawTabs(ctx, { ...FULL, height: TAB_HEIGHT }, { tabs: ["PAD MODE"], active: [0] });
    const bank = currentBank(fl);
    const top = TAB_HEIGHT + 14;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.accent;
    ctx.font = font(130, "bold");
    ctx.fillText(bankLetter(bank), 26, top - 8);
    ctx.fillStyle = theme.dimText;
    ctx.font = font(17);
    const text = this.windowText(fl);
    ctx.fillText(text ? `channels ${text}` : "no channels", 160, top + 22);
    const selected = fl.selectedChannel;
    if (selected.index === null) return;
    const y = top + 150;
    ctx.fillStyle = flColorToCss(selected.color);
    ctx.fillRect(14, y, 6, 52);
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText(`Selected  ${selected.index + 1}`, 34, y);
    ctx.fillStyle = theme.text;
    ctx.font = font(30, "bold");
    ctx.fillText(fitText(ctx, selected.name, FULL.width - 50), 34, y + 20);
  }

  protected displayLeds(leds: LedState, mc: ModeContext): void {
    super.displayLeds(leds, mc);
    leds.setLight("display1", "bright"); // a tool page is always latched
    leds.setLight("display7", this.hasPrevious(mc) ? "dim" : "off");
    leds.setLight("display8", this.hasNext(mc) ? "dim" : "off");
  }
}
