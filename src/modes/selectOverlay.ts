// SELECT overlay (hold SELECT; display button 1 is its pin tab). Pads 1–16 are the 16 channels of the
// current bank; a pad press selects that channel (SELECT_CHANNEL). GROUP A–H pick the bank. The grid
// outlines the selected channel; the pad of the selected channel is bright, the others dim.
import type { SKRSContext2D } from "@napi-rs/canvas";
import { TAB_HEIGHT, fitText, font, theme } from "../render/widgets.js";
import { bankLetter } from "./channelBank.js";
import { ChannelPadPage, type PadChannel } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import { flColorToCss } from "./format.js";
import type { ModeContext } from "./mode.js";
import { drawPinTab } from "./padGrid.js";

export class SelectOverlay extends ChannelPadPage {
  readonly name = "select";

  protected onPad({ index }: PadChannel, mc: ModeContext): void {
    mc.send({ type: "selectChannel", index });
  }

  protected renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    const { selectedChannel } = fl;
    drawPinTab(ctx, "SELECT", mc.pinned ?? false);
    if (selectedChannel.index === null) {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(20);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No channel", FULL.width / 2, 120);
      return;
    }
    const top = TAB_HEIGHT + 22;
    ctx.fillStyle = flColorToCss(selectedChannel.color);
    ctx.fillRect(14, top, 6, 138);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText("Channel", 34, top);
    ctx.fillStyle = theme.accent;
    ctx.font = font(72, "bold");
    ctx.fillText(String(selectedChannel.index + 1), 32, top + 14);
    ctx.fillStyle = theme.text;
    ctx.font = font(30, "bold");
    ctx.fillText(fitText(ctx, selectedChannel.name, FULL.width - 50), 34, top + 92);
    ctx.fillStyle = theme.dimText;
    ctx.font = font(17);
    ctx.fillText(`Bank ${bankLetter(this.bank(mc))}  ${this.windowText(fl)}`, 34, top + 130);
  }
}
