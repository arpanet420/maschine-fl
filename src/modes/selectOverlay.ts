// SELECT overlay (hold SELECT; display button 1 is its pin tab). Pads 1–16 are the 16 channels of the
// current bank; a pad press selects that channel (SELECT_CHANNEL). GROUP A–H pick the bank. The grid
// outlines the selected channel; the pad of the selected channel is bright, the others dim. Knob 1 is
// that channel's COLOR (SET_CHANNEL_COLOR), so a pad and then the knob colour any channel.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import { TAB_HEIGHT, drawKnobRow, fitText, font, theme } from "../render/widgets.js";
import { bankLetter } from "./channelBank.js";
import { ChannelPadPage, type PadChannel } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import { flColorToCss } from "./format.js";
import { isLive, type PendingValue } from "./knob.js";
import type { ModeContext } from "./mode.js";
import { COLOR_DETENT_COUNTS, colorKnob, nextNamedColor } from "./namedColors.js";
import type { PadState } from "./padState.js";
import { drawPinTab } from "./padGrid.js";

const KNOB_ROW = { ...FULL, y: FULL.height - 100, height: 100 };
const COLOR_KNOB = 0;

export class SelectOverlay extends ChannelPadPage {
  readonly name = "select";
  private turned = 0;
  private pending: (PendingValue<number> & { index: number }) | undefined;

  constructor(
    pads: PadState,
    private readonly clock: () => number = Date.now,
  ) {
    super(pads);
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type !== "encoder") return super.onEvent(event, mc);
    if (event.index !== COLOR_KNOB) return false;
    const total = this.turned + event.delta;
    const detents = Math.trunc(total / COLOR_DETENT_COUNTS);
    this.turned = total - detents * COLOR_DETENT_COUNTS;
    const index = mc.fl.selectedChannel.index;
    if (detents === 0 || index === null) return true;
    const color = nextNamedColor(this.color(index, mc), detents);
    this.pending = { index, value: color, at: this.clock() };
    mc.send({ type: "setChannelColor", index, color });
    mc.requestRender();
    return true;
  }

  /** The channel's colour shown: ours for a moment after a turn, else FL's. */
  private color(index: number, mc: ModeContext): number {
    const { pending } = this;
    const ours = pending?.index === index && isLive(pending, this.clock());
    return ours ? pending.value : mc.fl.selectedChannel.color;
  }

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
    const top = TAB_HEIGHT + 10;
    const color = this.color(selectedChannel.index, mc);
    ctx.fillStyle = flColorToCss(color);
    ctx.fillRect(14, top, 6, 112);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText("Channel", 34, top);
    ctx.fillStyle = theme.accent;
    ctx.font = font(54, "bold");
    ctx.fillText(String(selectedChannel.index + 1), 32, top + 10);
    ctx.fillStyle = theme.text;
    ctx.font = font(26, "bold");
    ctx.fillText(fitText(ctx, selectedChannel.name, FULL.width - 50), 34, top + 66);
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText(`Bank ${bankLetter(this.bank(mc))}  ${this.windowText(fl)}`, 34, top + 98);
    drawKnobRow(ctx, KNOB_ROW, [colorKnob(color, mc.touchedKnobs.has(COLOR_KNOB))]);
  }
}
