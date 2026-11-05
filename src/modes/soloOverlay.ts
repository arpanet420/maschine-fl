// SOLO overlay (hold SOLO; display button 1 is its pin tab). Pads 1–16 are the 16 channels of the
// current bank. With no channel soloed a pad press solos its channel (SET_CHANNEL solo, from FL's own
// solo flag); while one is, any pad press clears the solo so every channel plays again (the owner's
// wish, 2026-11-05), instead of moving it to the pad's channel. Only the channels FL reports (the bank
// shown) are known: a solo outside it moves to the pad's channel as in FL. For PENDING_MS after a press
// its result counts, so a quick second press undoes the first before FL answers.
// Soloed channels are bright on the pads and outlined on the grid. GROUP A–H pick the bank. The
// Mixer page claims the SOLO button for its strips (mixer tracks); the pads still work from here.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlState } from "../fl/flState.js";
import { font, theme } from "../render/widgets.js";
import { ChannelPadPage, type PadChannel } from "./channelPadPage.js";
import type { ModeContext } from "./mode.js";
import type { PadState } from "./padState.js";
import { PENDING_MS } from "./knob.js";
import { drawPinTab, type PadCell } from "./padGrid.js";

export class SoloOverlay extends ChannelPadPage {
  readonly name = "solo";
  /** The soloed channels after our last press, until FL has had time to answer. */
  private pending: { soloed: number[]; at: number } | undefined;

  constructor(
    pads: PadState,
    private readonly now: () => number = Date.now,
  ) {
    super(pads);
  }

  /** The soloed channels: ours for a moment after a press, then FL's. */
  private soloed(fl: FlState): number[] {
    if (this.pending && this.now() - this.pending.at < PENDING_MS) return this.pending.soloed;
    return [...fl.channels].filter(([, entry]) => entry.solo).map(([index]) => index);
  }

  private isSolo(index: number, fl: FlState): boolean {
    return this.soloed(fl).includes(index);
  }

  protected onPad({ index }: PadChannel, mc: ModeContext): void {
    const soloed = this.soloed(mc.fl);
    if (soloed.length > 0) {
      for (const channel of soloed)
        mc.send({ type: "setChannel", index: channel, what: "solo", value: 0 });
      this.pending = { soloed: [], at: this.now() };
    } else {
      mc.send({ type: "setChannel", index, what: "solo", value: 1 });
      this.pending = { soloed: [index], at: this.now() };
    }
    mc.requestRender();
  }

  protected padLevel({ index }: PadChannel, fl: FlState): "dim" | "bright" {
    return this.isSolo(index, fl) ? "bright" : "dim";
  }

  protected cell(channel: PadChannel, fl: FlState): PadCell {
    return { ...super.cell(channel, fl), current: false, solo: this.isSolo(channel.index, fl) };
  }

  protected renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    const soloed = Array.from({ length: this.shown(fl) }, (_, pad) =>
      this.channelAt(pad, fl),
    ).filter((channel) => channel && this.isSolo(channel.index, fl)).length;
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
