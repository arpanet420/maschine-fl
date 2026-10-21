// LIVE overlay (hold SHIFT + SCENE; display button 1 is its pin tab). FL's performance mode
// (docs/workflow.md, "Playlist probe, 2026-10-20") makes the playlist's live clip grid readable
// once it is switched on: `playlist.getLiveBlockStatus`/`getLiveBlockColor` report real data, and
// `triggerLiveClip` launches clips. A pad fires a "scene" (FL's manual: "any group of Clips, on
// independent tracks, that can be triggered to start playing together"): the FL script makes the
// same call Image-Line's Akai Fire script makes for a scene launch, `TLC_ColumnMode` on one clip
// of that block, and the pad's release sends the matching `TLC_Release` call. Pad 1 = the first
// block of the window (bottom-left, like every other grid). VIEW's `liveScenes`/`liveOffset`
// (this overlay's `viewPatch`) says mk3d is watching; FL then sends the LIVE_GRID header and one
// LIVE_TRACK row per playlist track 1…`LIVE_TRACK_SCAN` (docs/sysex.md), and a scene's status is
// the OR of its column.
//
// The screens are made to be read without looking at FL. Right screen: the clip matrix, one row
// per track and one column per pad (scene), in the clips' colors: playing solid and framed,
// scheduled framed in mint (flashing), idle dimmed; a muted track's row is faded. Left screen: the
// same rows as a track list (color, name, mute/solo badges, the clip it plays or has queued), so
// the names label the matrix, and above them the bar and beat. Pads: playing bright, scheduled
// flashing brightest/off every FLASH_MS whether FL plays or not (as SCENE's queued jump flashes;
// while FL is stopped a hint on screen says queued clips wait for PLAY), idle faint, empty off.
// Owner, 2026-10-21: the earlier half-beat bright/faint blink was too subtle to see.
//
// Pattern names: the API names no clip, but a clip has its pattern's color unless it was
// recolored, and mk3d has the pattern window's colors (PATTERNS). A block whose color exactly one
// known pattern has is labelled with that pattern: `P3` (or the first letters of a renamed
// pattern) in the matrix cell, the full name in the track list. Shared or unknown colors stay
// unlabelled (the track list then shows the block number).
//
// Display 4 `STOP` stops every scanned track's clips (`triggerLiveClip` with `block` null, FL's
// `subNum -1` on each). Display 7 `<<` and 8 `>>` page the block window. Not built yet: a block
// total to stop `>>` at the playlist's end (the API has no such count), more than
// `LIVE_TRACK_SCAN` tracks, the CLIPS layout and the rest of PLAN.md's LIVE redesign.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlSection, FlState } from "../fl/flState.js";
import { LIVE_BLOCK, LIVE_TRACK_SCAN, MAX_LIVE_BLOCKS } from "../fl/protocol.js";
import type { LiveBlock, LiveTrack } from "../fl/sysex.js";
import type { HwEvent } from "../hw/events.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import { LED_OFF, type LedVariant } from "../hw/palette.js";
import { TAB_HEIGHT, clear, drawTabs, fitText, font, theme } from "../render/widgets.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import { flColorToCss, flColorToPalette } from "./format.js";
import { positionBeats } from "./markerPage.js";
import type { Mode, ModeContext, ModeName, ViewCommand } from "./mode.js";
import { realTimers, type RepeatTimers } from "./repeatScheduler.js";

const STOP_BUTTON = 3;
/** A queued scene flashes at this rate (SCENE's rate). */
const FLASH_MS = 250;
const BANK_PREV = 6;
const BANK_NEXT = 7;
const BEATS_PER_BAR = 4;

// Both screens share the row geometry, so the left screen's track names label the right's rows.
const HEADER_TOP = TAB_HEIGHT;
const HEADER_HEIGHT = 24;
const ROWS_TOP = HEADER_TOP + HEADER_HEIGHT;
const ROW_HEIGHT = 28;
const CELL_WIDTH = FULL.width / MAX_LIVE_BLOCKS;
const CELL_GAP = 2;
/** The track list's playing / queued pattern names are cut to this width, so the track name keeps room. */
const CLIP_NAME_WIDTH = 120;

/** One column of the window: the OR of its tracks' status bits, the first filled track's color. */
export interface LiveScene {
  status: number;
  color: number;
}

/**
 * The rows LIVE shows for block window `offset`: index `t - 1` is track `t` (1…scanned), undefined
 * while FL has not sent that track's row for this window yet.
 */
export function liveRows(fl: FlState, offset: number): Array<Readonly<LiveTrack> | undefined> {
  const scanned = fl.liveGrid?.scanned ?? 0;
  return Array.from({ length: Math.min(scanned, LIVE_TRACK_SCAN) }, (_, i) => {
    const row = fl.liveTracks.get(i + 1);
    return row && row.offset === offset ? row : undefined;
  });
}

/** Scene `index` of the window (a column across `rows`). */
export function liveScene(
  rows: ReadonlyArray<Readonly<LiveTrack> | undefined>,
  index: number,
): LiveScene {
  let status = 0;
  let color: number | undefined;
  for (const row of rows) {
    const block: LiveBlock | undefined = row?.blocks[index];
    if (!block) continue;
    status |= block.status;
    if (color === undefined && block.status & LIVE_BLOCK.filled) color = block.color;
  }
  return { status, color: color ?? 0 };
}

const isPlaying = (status: number) => (status & LIVE_BLOCK.playing) !== 0;
/** Queued and not playing yet. */
const isScheduled = (status: number) => !isPlaying(status) && (status & LIVE_BLOCK.scheduled) !== 0;

/** A pattern a clip color stands for. */
export interface ClipPattern {
  /** 1-based. */
  number: number;
  name: string;
}

/**
 * The known patterns by color (0xRRGGBB), only for colors exactly one of them has: a clip of that
 * color is (most likely) that pattern. FL sends the pattern window around the current pattern.
 */
export function patternsByColor(fl: FlState): Map<number, ClipPattern> {
  const found = new Map<number, ClipPattern | null>();
  for (const [index, entry] of fl.patterns) {
    const color = entry.color & 0xffffff;
    found.set(color, found.has(color) ? null : { number: index + 1, name: entry.name });
  }
  const unique = new Map<number, ClipPattern>();
  for (const [color, pattern] of found) if (pattern) unique.set(color, pattern);
  return unique;
}

/** A matrix cell's label: `P3` for FL's default "Pattern 3", else the name (cut to fit). */
export function patternLabel(pattern: ClipPattern): string {
  return /^Pattern \d+$/.test(pattern.name) ? `P${pattern.number}` : pattern.name;
}

/** Dark text on a light clip color, light text on a dark one. */
function textOn(color: number): string {
  const luma =
    0.299 * ((color >> 16) & 0xff) + 0.587 * ((color >> 8) & 0xff) + 0.114 * (color & 0xff);
  return luma > 150 ? theme.background : theme.text;
}

/** The song position as bar (1-based) and beat in the bar (1–4). */
function beatClock(fl: FlState): { bar: number; beat: number } {
  const whole = Math.floor(positionBeats(fl.songPos, fl.ppq));
  return { bar: Math.floor(whole / BEATS_PER_BAR) + 1, beat: (whole % BEATS_PER_BAR) + 1 };
}

export interface LiveOptions {
  timers?: RepeatTimers;
}

export class LiveOverlay implements Mode {
  readonly name: ModeName = "liveClips";
  private bank = 0;
  /** Pads that are down: pad -> the block its press fired (the release goes to the same block). */
  private readonly held = new Map<number, number>();
  /** The bar and beat last drawn: the overlay redraws when the clock moves on. */
  private lastClock = "";
  /** The flash phase of queued scenes; the timer runs only while one is queued. */
  private flashOn = true;
  private flashTimer: unknown;
  private mc: ModeContext | undefined;
  private readonly timers: RepeatTimers;

  constructor(options: LiveOptions = {}) {
    this.timers = options.timers ?? realTimers;
  }

  enter(mc: ModeContext): void {
    this.mc = mc;
    this.sendView(mc);
    this.syncFlash(mc);
  }

  /** Closed, replaced or the device went away: stop flashing. */
  leave(): void {
    this.stopFlash();
  }

  viewPatch(): Partial<ViewCommand> {
    return { liveScenes: true, liveOffset: this.offset };
  }

  private get offset(): number {
    return this.bank * MAX_LIVE_BLOCKS;
  }

  onFlChange(section: FlSection, mc: ModeContext): void {
    this.mc = mc;
    if (section === "liveGrid" || section === "patterns") {
      this.syncFlash(mc);
      mc.requestRender();
      return;
    }
    if (section === "songPos" || section === "transport") {
      const clock = beatClock(mc.fl);
      const key = `${mc.fl.transport.playing}:${clock.bar}:${clock.beat}`;
      if (key !== this.lastClock) {
        this.lastClock = key;
        mc.requestRender();
      }
    }
  }

  private sendView(mc: ModeContext): void {
    const base = mc.baseView?.();
    if (base) mc.send({ ...base, ...this.viewPatch() });
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    switch (event.type) {
      case "pad":
        if (event.phase === "down" && !mc.erase) {
          const block = this.offset + event.pad;
          this.held.set(event.pad, block);
          mc.send({ type: "triggerLiveClip", block, release: false });
        } else if (event.phase === "up") {
          const block = this.held.get(event.pad);
          if (block !== undefined) {
            this.held.delete(event.pad);
            mc.send({ type: "triggerLiveClip", block, release: true });
          }
        }
        return true;
      case "button": {
        const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
        if (display < 0) return false;
        if (!event.pressed) return true;
        if (display === STOP_BUTTON) {
          this.held.clear();
          mc.send({ type: "triggerLiveClip", block: null, release: false });
        } else if (display === BANK_PREV) this.setBank(this.bank - 1, mc);
        else if (display === BANK_NEXT) this.setBank(this.bank + 1, mc);
        return true;
      }
      default:
        return false;
    }
  }

  private setBank(wanted: number, mc: ModeContext): void {
    const bank = Math.max(0, wanted);
    if (bank === this.bank) return;
    this.bank = bank;
    this.sendView(mc);
    this.syncFlash(mc);
    mc.requestRender();
  }

  // ── Flashing ───────────────────────────────────────────────────────────────

  /** Run the flash timer while a scene of the window is queued, and only then. */
  private syncFlash(mc: ModeContext): void {
    const queued = liveRows(mc.fl, this.offset).some((row) =>
      row?.blocks.some((b) => isScheduled(b.status)),
    );
    if (!queued) this.stopFlash();
    else if (this.flashTimer === undefined) {
      this.flashOn = true;
      const tick = () => {
        this.flashOn = !this.flashOn;
        this.mc?.requestRender();
        this.flashTimer = this.timers.set(tick, FLASH_MS);
      };
      this.flashTimer = this.timers.set(tick, FLASH_MS);
    }
  }

  private stopFlash(): void {
    if (this.flashTimer !== undefined) this.timers.clear(this.flashTimer);
    this.flashTimer = undefined;
    this.flashOn = true;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const rows = liveRows(mc.fl, this.offset);
    const patterns = patternsByColor(mc.fl);
    this.renderLeft(left, mc, rows, patterns);
    this.renderRight(right, rows, patterns);
  }

  private renderLeft(
    ctx: SKRSContext2D,
    mc: ModeContext,
    rows: ReadonlyArray<Readonly<LiveTrack> | undefined>,
    patterns: ReadonlyMap<number, ClipPattern>,
  ): void {
    const { fl } = mc;
    clear(ctx, FULL);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      { tabs: ["LIVE", "", "", "STOP"], active: mc.pinned ? [0] : [] },
    );
    this.drawClock(ctx, fl, rows);
    if (!fl.liveGrid) {
      this.note(ctx, "Reading FL's playlist…");
      return;
    }
    if (rows.length === 0) {
      this.note(ctx, "The playlist has no tracks");
      return;
    }
    rows.forEach((row, i) =>
      this.drawTrackRow(ctx, ROWS_TOP + i * ROW_HEIGHT, i + 1, row, patterns),
    );
  }

  /** The header row: bar and beat (or why nothing will play), as wide as the right's column numbers. */
  private drawClock(
    ctx: SKRSContext2D,
    fl: FlState,
    rows: ReadonlyArray<Readonly<LiveTrack> | undefined>,
  ): void {
    clear(ctx, { x: 0, y: HEADER_TOP, width: FULL.width, height: HEADER_HEIGHT }, theme.background);
    const cy = HEADER_TOP + HEADER_HEIGHT / 2;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    if (fl.liveGrid && !fl.liveGrid.perf) {
      ctx.fillStyle = theme.accent;
      ctx.font = font(15, "bold");
      ctx.fillText("Performance mode is off in FL", 10, cy);
      return;
    }
    const playing = fl.transport.playing;
    triangle(ctx, 10, cy, 12, playing ? theme.play : theme.ledOff, true);
    const { bar, beat } = beatClock(fl);
    ctx.fillStyle = theme.text;
    ctx.font = font(16, "bold");
    const position = `Bar ${bar}`;
    ctx.fillText(position, 30, cy);
    let x = 30 + ctx.measureText(position).width + 12;
    for (let b = 1; b <= BEATS_PER_BAR; b++) {
      ctx.fillStyle = playing && b === beat ? theme.accent : theme.knobRim;
      ctx.beginPath();
      ctx.arc(x + 5, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      x += 16;
    }
    const queued = rows.some((row) => row?.blocks.some((b) => isScheduled(b.status)));
    if (queued && !playing) {
      ctx.fillStyle = theme.selected;
      ctx.font = font(14, "bold");
      ctx.textAlign = "right";
      ctx.fillText("Queued — press PLAY", FULL.width - 10, cy);
    }
  }

  private drawTrackRow(
    ctx: SKRSContext2D,
    y: number,
    track: number,
    row: Readonly<LiveTrack> | undefined,
    patterns: ReadonlyMap<number, ClipPattern>,
  ): void {
    const cy = y + ROW_HEIGHT / 2;
    if (track % 2 === 0)
      clear(ctx, { x: 0, y, width: FULL.width, height: ROW_HEIGHT }, theme.panelRaised);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    if (!row) {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(14);
      ctx.fillText(`Track ${track}`, 18, cy);
      return;
    }
    ctx.globalAlpha = row.muted ? 0.4 : 1;
    ctx.fillStyle = flColorToCss(row.color);
    ctx.fillRect(6, y + 4, 6, ROW_HEIGHT - 8);
    // Right to left: what the track plays or has queued (its pattern's name, else the block
    // number), then the badges, then the name in what is left.
    let right = FULL.width - 8;
    const clip = (index: number) => {
      const block = row.blocks[index];
      const pattern = block && patterns.get(block.color & 0xffffff);
      return pattern?.name || String(this.offset + index + 1);
    };
    const playing = row.blocks.findIndex((b) => isPlaying(b.status));
    const queued = row.blocks.findIndex((b) => isScheduled(b.status));
    ctx.font = font(15, "bold");
    ctx.textAlign = "right";
    for (const [index, color, filled] of [
      [queued, theme.selected, false],
      [playing, theme.accent, true],
    ] as const) {
      if (index < 0) continue;
      const text = fitText(ctx, clip(index), CLIP_NAME_WIDTH);
      ctx.fillStyle = color;
      ctx.fillText(text, right, cy);
      right -= ctx.measureText(text).width + 6;
      triangle(ctx, right - 10, cy, 10, color, filled);
      right -= 20;
    }
    for (const [on, label, color] of [
      [row.solo, "S", theme.option],
      [row.muted, "M", theme.dimText],
    ] as const) {
      if (!on) continue;
      ctx.fillStyle = color;
      ctx.fillRect(right - 18, y + 5, 18, ROW_HEIGHT - 10);
      ctx.fillStyle = theme.background;
      ctx.font = font(13, "bold");
      ctx.textAlign = "center";
      ctx.fillText(label, right - 9, cy);
      right -= 24;
    }
    ctx.fillStyle = theme.text;
    ctx.font = font(15);
    ctx.textAlign = "left";
    ctx.fillText(fitText(ctx, row.name || `Track ${track}`, right - 22), 20, cy);
    ctx.globalAlpha = 1;
  }

  private note(ctx: SKRSContext2D, text: string): void {
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(text, 18, ROWS_TOP + 12);
  }

  private renderRight(
    ctx: SKRSContext2D,
    rows: ReadonlyArray<Readonly<LiveTrack> | undefined>,
    patterns: ReadonlyMap<number, ClipPattern>,
  ): void {
    const blink = this.flashOn;
    clear(ctx, FULL);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      { tabs: ["", "", this.bank > 0 ? "<<" : "", ">>"] },
    );
    // Column numbers (the scenes the pads fire), colored by what the column does.
    clear(ctx, { x: 0, y: HEADER_TOP, width: FULL.width, height: HEADER_HEIGHT }, theme.background);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = font(13, "bold");
    for (let i = 0; i < MAX_LIVE_BLOCKS; i++) {
      const { status } = liveScene(rows, i);
      ctx.fillStyle = isPlaying(status)
        ? theme.accent
        : isScheduled(status) && blink
          ? theme.selected
          : status & LIVE_BLOCK.filled
            ? theme.text
            : theme.dimText;
      ctx.fillText(
        String(this.offset + i + 1),
        i * CELL_WIDTH + CELL_WIDTH / 2,
        HEADER_TOP + HEADER_HEIGHT / 2,
      );
    }
    rows.forEach((row, t) => {
      const y = ROWS_TOP + t * ROW_HEIGHT;
      if (t % 2 === 1)
        clear(ctx, { x: 0, y, width: FULL.width, height: ROW_HEIGHT }, theme.panelRaised);
      if (!row) return;
      ctx.globalAlpha = row.muted ? 0.35 : 1;
      row.blocks.slice(0, MAX_LIVE_BLOCKS).forEach((block, i) => {
        this.drawCell(ctx, i * CELL_WIDTH, y, block, blink, patterns.get(block.color & 0xffffff));
      });
      ctx.globalAlpha = 1;
    });
  }

  private drawCell(
    ctx: SKRSContext2D,
    x: number,
    y: number,
    block: LiveBlock,
    blink: boolean,
    pattern: ClipPattern | undefined,
  ): void {
    const cell = {
      x: x + CELL_GAP,
      y: y + CELL_GAP,
      width: CELL_WIDTH - 2 * CELL_GAP,
      height: ROW_HEIGHT - 2 * CELL_GAP,
    };
    if (!(block.status & LIVE_BLOCK.filled)) {
      ctx.fillStyle = theme.background;
      ctx.fillRect(cell.x + 8, cell.y + cell.height / 2 - 1, cell.width - 16, 2);
      return;
    }
    const playing = isPlaying(block.status);
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * (playing ? 1 : 0.45);
    ctx.fillStyle = flColorToCss(block.color);
    ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
    ctx.globalAlpha = alpha;
    const frame = playing
      ? theme.text
      : isScheduled(block.status) && blink
        ? theme.selected
        : undefined;
    if (frame) {
      ctx.strokeStyle = frame;
      ctx.lineWidth = 2;
      ctx.strokeRect(cell.x + 1, cell.y + 1, cell.width - 2, cell.height - 2);
    }
    if (pattern) {
      // On a solid (playing) cell the text follows the clip color; a dimmed cell is dark.
      ctx.fillStyle = playing ? textOn(block.color) : theme.text;
      ctx.font = font(11, "bold");
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Whole letters, no ellipsis: a cell fits about three ("Bas" for "Bassline").
      let label = patternLabel(pattern);
      while (label.length > 1 && ctx.measureText(label).width > cell.width - 4)
        label = label.slice(0, -1);
      ctx.fillText(label, cell.x + cell.width / 2, cell.y + cell.height / 2);
    } else if (playing)
      triangle(
        ctx,
        cell.x + cell.width / 2 - 5,
        cell.y + cell.height / 2,
        10,
        theme.background,
        true,
      );
  }

  leds(leds: LedState, mc: ModeContext): void {
    const rows = liveRows(mc.fl, this.offset);
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const scene = liveScene(rows, pad);
      const variant =
        scene.status & LIVE_BLOCK.filled ? sceneVariant(scene.status, this.flashOn) : "off";
      leds.setPad(pad, variant === "off" ? LED_OFF : flColorToPalette(scene.color, variant));
    }
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
    leds.setLight("display2", "off");
    leds.setLight("display3", "off");
    leds.setLight("display4", "dim");
    leds.setLight("display5", "off");
    leds.setLight("display6", "off");
    leds.setLight("display7", this.bank > 0 ? "dim" : "off");
    leds.setLight("display8", "dim");
  }
}

/**
 * A filled scene pad's brightness: playing bright; scheduled flashing brightest/off (`flashOn` is
 * the flash phase), whether FL plays or waits for PLAY; idle faint.
 */
export function sceneVariant(status: number, flashOn: boolean): LedVariant | "off" {
  if (isPlaying(status)) return "bright";
  if (isScheduled(status)) return flashOn ? "pressed" : "off";
  return "faint";
}

/** A play triangle pointing right, `size` tall, its left edge at `x`; filled or outlined. */
function triangle(
  ctx: SKRSContext2D,
  x: number,
  cy: number,
  size: number,
  color: string,
  filled: boolean,
): void {
  ctx.beginPath();
  ctx.moveTo(x, cy - size / 2);
  ctx.lineTo(x + size * 0.85, cy);
  ctx.lineTo(x, cy + size / 2);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}
