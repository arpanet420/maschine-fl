// MUTE overlay (hold MUTE; display button 1 is its pin tab). Pads 1–16 are the 16 channels of the
// current bank; a pad press toggles that channel's mute. GROUP A–H pick the bank (channelPadPage).
import type { SKRSContext2D } from "@napi-rs/canvas";
import { font, theme } from "../render/widgets.js";
import { ChannelPadPage, type PadChannel } from "./channelPadPage.js";
import type { ModeContext } from "./mode.js";
import { drawPinTab } from "./padGrid.js";

export class MuteOverlay extends ChannelPadPage {
  readonly name = "mute";

  protected onPad({ index, entry }: PadChannel, mc: ModeContext): void {
    mc.send({ type: "setChannel", index, what: "mute", value: entry.muted ? 0 : 1 });
  }

  protected padLevel({ entry }: PadChannel): "dim" | "bright" {
    return entry.muted ? "dim" : "bright";
  }

  protected renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    const first = Array.from({ length: this.shown(fl) }, (_, pad) => this.channelAt(pad, fl));
    const muted = first.filter((channel) => channel?.entry.muted).length;
    drawPinTab(ctx, "MUTE", mc.pinned ?? false);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText("Channels", 24, 56);
    ctx.fillStyle = theme.text;
    ctx.font = font(44, "bold");
    ctx.fillText(this.windowText(fl) || "No channels", 24, 78);
    ctx.fillStyle = muted > 0 ? theme.option : theme.dimText;
    ctx.font = font(20);
    ctx.fillText(muted > 0 ? `${muted} muted` : "None muted", 24, 140);
  }
}
