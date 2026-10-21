// SCENE overlay (hold SCENE; display button 1 is its pin tab `SCENE`). Pads = the playlist's
// markers, banks with display 7 and 8 `<<` `>>` (markerPage.ts); a press switches the way Maschine switches scenes: at the next bar while FL plays, at once while it
// is stopped (JUMP_MARKER with `quantized`; the FL script keeps the jump pending until FL's bar
// beat). Display 2 `NOW` toggles quantized and immediate (bright = immediate), saved with the page
// stack's state.
//
// A queued jump shows its pad flashing (pressed variant against dim, and the grid cell outlined in
// mint) until SONG_POS shows the jump happened: the song is in that marker again from an earlier
// position, or FL stopped (the script then jumps at once). SHIFT + SCENE (sections) is not built.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlSection } from "../fl/flState.js";
import type { LedState } from "../hw/leds.js";
import type { LedVariant } from "../hw/palette.js";
import { TAB_HEIGHT, clear, drawTabs, fitText, font, theme } from "../render/widgets.js";
import { FULL } from "./draw.js";
import { flColorToCss } from "./format.js";
import {
  MarkerPadsPage,
  currentMarker,
  drawMarkerGrid,
  drawNoMarkers,
  markerColor,
  markerName,
  markerWindowText,
  positionBeats,
} from "./markerPage.js";
import type { ModeContext } from "./mode.js";
import { GRID_RECT, drawFooter } from "./padGrid.js";
import { realTimers, type RepeatTimers } from "./repeatScheduler.js";

const NOW_BUTTON = 1;
/** A queued pad flashes at this rate. */
const FLASH_MS = 250;

export interface SceneOptions {
  timers?: RepeatTimers;
}

/** A jump that waits for the next bar: the marker, and where the song was when it was queued. */
interface Queued {
  index: number;
  fromMarker: number;
  fromBeats: number;
}

export class SceneOverlay extends MarkerPadsPage {
  readonly name = "scene";
  /** NOW: jump at once instead of at the next bar. */
  immediate = false;
  private queuedJump: Queued | undefined;
  private flashOn = true;
  private flashTimer: unknown;
  private mc: ModeContext | undefined;
  private readonly timers: RepeatTimers;

  constructor(options: SceneOptions = {}) {
    super();
    this.timers = options.timers ?? realTimers;
  }

  readonly persisted = {
    save: () => ({ immediate: this.immediate }),
    load: (data: unknown) => {
      const saved = data as { immediate?: unknown } | null;
      if (typeof saved?.immediate === "boolean") this.immediate = saved.immediate;
    },
  };

  enter(mc: ModeContext): void {
    this.mc = mc;
    super.enter(mc);
    this.settle(mc);
  }

  /** Closed, replaced or the device went away: stop flashing (a queued jump still happens in FL). */
  leave(): void {
    this.stopFlash();
  }

  onFlChange(section: FlSection, mc: ModeContext): void {
    this.mc = mc;
    super.onFlChange(section, mc);
    if (section === "songPos" || section === "transport" || section === "markers") {
      this.settle(mc);
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  protected padPressed(index: number, mc: ModeContext): void {
    const { fl } = mc;
    // Stopped: now. Playing: at the next bar, unless NOW is on.
    const quantized = fl.transport.playing && !this.immediate;
    this.jump(index, quantized, mc);
    if (quantized) {
      this.queuedJump = {
        index,
        fromMarker: currentMarker(fl),
        fromBeats: positionBeats(fl.songPos, fl.ppq),
      };
      this.startFlash(mc);
    } else {
      this.queuedJump = undefined;
      this.stopFlash();
    }
    mc.requestRender();
  }

  protected displayPressed(display: number, mc: ModeContext): void {
    if (display !== NOW_BUTTON) return;
    this.immediate = !this.immediate;
    mc.saveState?.();
    mc.requestRender();
  }

  /** Has the queued jump happened? It has when FL stopped or the song is back in its marker. */
  private settle(mc: ModeContext): void {
    const queued = this.queuedJump;
    if (!queued) return;
    const { fl } = mc;
    const arrived =
      !fl.transport.playing ||
      (currentMarker(fl) === queued.index &&
        (queued.fromMarker !== queued.index ||
          positionBeats(fl.songPos, fl.ppq) < queued.fromBeats));
    if (!arrived) return;
    this.queuedJump = undefined;
    this.stopFlash();
    mc.requestRender();
  }

  // ── Flashing ───────────────────────────────────────────────────────────────

  private startFlash(mc: ModeContext): void {
    this.stopFlash();
    this.flashOn = true;
    const tick = () => {
      this.flashOn = !this.flashOn;
      this.mc?.requestLeds?.();
      this.flashTimer = this.timers.set(tick, FLASH_MS);
    };
    this.flashTimer = this.timers.set(tick, FLASH_MS);
    mc.requestLeds?.();
  }

  private stopFlash(): void {
    if (this.flashTimer !== undefined) this.timers.clear(this.flashTimer);
    this.flashTimer = undefined;
    this.flashOn = true;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  protected queued(): number | undefined {
    return this.queuedJump?.index;
  }

  protected padVariant(index: number, current: number): LedVariant {
    if (index === this.queuedJump?.index) return this.flashOn ? "pressed" : "dim";
    return index === current ? "bright" : "dim";
  }

  protected rightTabs(): readonly [string, string] {
    return ["", ""];
  }

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    this.renderLeft(left, mc);
    const { fl } = mc;
    this.drawRightTabs(right, mc);
    if (fl.markerTotal === 0) {
      drawNoMarkers(right, { ...GRID_RECT, y: TAB_HEIGHT + 4 });
    } else {
      drawMarkerGrid(right, GRID_RECT, fl, this.bank, this.queued());
      drawFooter(right, markerWindowText(fl, this.bank));
    }
  }

  private renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    clear(ctx, FULL);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      {
        tabs: ["SCENE", "NOW"],
        active: [...(mc.pinned ? [0] : []), ...(this.immediate ? [NOW_BUTTON] : [])],
      },
    );
    const x = 24;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.fillText("Scene", x, TAB_HEIGHT + 12);
    const current = currentMarker(fl);
    if (fl.markerTotal === 0) {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(22);
      ctx.fillText("No markers", x, TAB_HEIGHT + 40);
    } else if (current < 0) {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(22);
      ctx.fillText("Before the first marker", x, TAB_HEIGHT + 40);
    } else {
      ctx.fillStyle = flColorToCss(markerColor(current));
      ctx.fillRect(14, TAB_HEIGHT + 36, 6, 76);
      ctx.fillStyle = theme.dimText;
      ctx.font = font(13);
      ctx.fillText(`Marker ${current + 1} of ${fl.markerTotal}`, x + 10, TAB_HEIGHT + 36);
      ctx.fillStyle = theme.text;
      ctx.font = font(32, "bold");
      ctx.fillText(
        fitText(ctx, markerName(fl, current), FULL.width - x - 34),
        x + 10,
        TAB_HEIGHT + 58,
      );
    }
    const queued = this.queuedJump;
    ctx.font = font(18);
    if (queued) {
      ctx.fillStyle = theme.selected;
      ctx.fillText("Queued:", x, TAB_HEIGHT + 130);
      ctx.font = font(24, "bold");
      ctx.fillText(
        fitText(ctx, markerName(fl, queued.index), FULL.width - x - 24),
        x,
        TAB_HEIGHT + 154,
      );
    } else {
      ctx.fillStyle = theme.dimText;
      ctx.fillText(
        this.immediate || !fl.transport.playing ? "A pad jumps now" : "A pad jumps at the next bar",
        x,
        TAB_HEIGHT + 130,
      );
    }
    ctx.fillStyle = theme.dimText;
    ctx.font = font(14);
    ctx.fillText(
      this.immediate ? "NOW is on" : "NOW is off: jumps wait for the bar",
      x,
      TAB_HEIGHT + 190,
    );
  }

  protected displayLeds(leds: LedState, mc: ModeContext): void {
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
    leds.setLight("display2", this.immediate ? "bright" : "dim");
  }
}
