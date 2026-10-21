// SOLO overlay (hold SOLO; display button 1 is its pin tab). Pads 1–16 are the 16 channels of the
// current bank; a pad press toggles that channel's solo (SET_CHANNEL solo, from FL's own solo flag).
// Soloed channels are bright on the pads and outlined on the grid. GROUP A–H pick the bank. The
// Mixer page claims the SOLO button and keeps its own solo (mixer tracks).
import type { SKRSContext2D } from "@napi-rs/canvas";
import { font, theme } from "../render/widgets.js";
import { ChannelPadPage, type PadChannel } from "./channelPadPage.js";
import type { ModeContext } from "./mode.js";
import { drawPinTab, type PadCell } from "./padGrid.js";

export class SoloOverlay extends ChannelPadPage {
  readonly name = "solo";

  protected onPad({ index, entry }: PadChannel, mc: ModeContext): void {
    mc.send({ type: "setChannel", index, what: "solo", value: entry.solo ? 0 : 1 });
  }

  protected padLevel({ entry }: PadChannel): "dim" | "bright" {
    return entry.solo ? "bright" : "dim";
  }

  protected cell(channel: PadChannel): PadCell {
    return { ...super.cell(channel), current: false, solo: channel.entry.solo };
  }

  protected renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    const soloed = Array.from({ length: this.shown(fl) }, (_, pad) =>
      this.channelAt(pad, fl),
    ).filter((channel) => channel?.entry.solo).length;
    drawPinTab(ctx, "SOLO", mc.pinned ?? false);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText("Channels", 24, 56);
    ctx.fillStyle = theme.text;
    ctx.font = font(44, "bold");
    ctx.fillText(this.windowText(fl) || "No channels", 24, 78);
    ctx.fillStyle = soloed > 0 ? theme.option : theme.dimText;
    ctx.font = font(20);
    ctx.fillText(soloed > 0 ? `${soloed} solo` : "None solo", 24, 140);
  }
}
