// ARRANGER (a main page): Maschine's pattern view on the MK3 (docs/workflow.md, "Hard to map" 1).
// FL's script cannot see the playlist's clips or the piano roll's notes, so the page shows what it can
// read: the current pattern as sounds × steps, like the channel rack. The right screen is the step
// grid (up to 8 channel rows × 16 steps of the current page, FL's step colors, the play head's column
// lit, the row cursor outlined), the left screen the rows' channels in the same lines (color bar,
// number, name, dim when muted, `S` when soloed) under the pattern's name and length.
//
// The grid comes from PATTERN_GRID (docs/sysex.md): while this page is shown the VIEW has the
// `patternGrid` flag and `channelOffset` = the channel bank, `stepOffset` = the step page × 16 (the
// script sends that page's chunks first), `patternOffset` = the pattern bank of the pads. A channel
// whose `stepSequencer` flag is off (FL says it has no step row) shows `piano roll`, dimmed.
//
// Controls (everything is drawn on the screen it belongs to):
// - Display 1 `ARRANGER` (title), 2 `SONG` (bright in song mode; press toggles pattern/song,
//   SET_LOOP_MODE). On the right screen 5 `PREV PAT` and 6 `NEXT PAT` select the pattern before and
//   after, 7 `<<` and 8 `>>` page through the pattern's steps (dark at the ends).
// - 4D encoder: a turn moves the row cursor through the bank's 16 channels (the 8 rows scroll with
//   it), a push selects the cursor's channel in FL, tilt ◀ ▶ pages the steps. Knob 5 moves the row
//   cursor too, knob 6 pages the steps. GROUP A–H pick the bank as on every page (the stack selects a
//   channel there and the cursor follows the selection).
// - FOLLOW: while on and FL plays, the step page follows the play head, as on the STEP page (it turns
//   the page when the head enters another one, so paging by hand sticks until then).
// - Pads 1–16 are the patterns of the current pattern bank (colors and LEDs as PATTERN's pads, the
//   bank follows the current pattern); a press selects the pattern. ERASE + pad does nothing (FL has
//   no pattern delete); DUPLICATE and SHIFT + DUPLICATE clone the pattern as on every page.
// - SCENE (hold) is the marker overlay and still works over this page.
//
// Opening the page shows and focuses FL's playlist (SHOW_WINDOW 2) unless it has the focus already.
// A second press of ARRANGER goes home, like MIXER. RUN_PROBE (the playlist probe) is sent only when
// the environment has MK3D_PROBE=1.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlSection, FlState } from "../fl/flState.js";
import { MAX_PATTERN_STEPS } from "../fl/protocol.js";
import type { Rect } from "../hw/display.js";
import type { HwEvent } from "../hw/events.js";
import type { ButtonId } from "../hw/ids.js";
import { PAD_COUNT } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import { LED_OFF } from "../hw/palette.js";
import {
  TAB_HEIGHT,
  clear,
  drawKnobRow,
  drawTabs,
  fitText,
  font,
  theme,
  type KnobProps,
} from "../render/widgets.js";
import { bankFirst, bankLength, bankLetter, bankOf, bankText, groupBank } from "./channelBank.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import { flColorToCss, flColorToPalette } from "./format.js";
import type { Mode, ModeContext, ViewCommand } from "./mode.js";
import { STEPS_PER_PAGE, groupB, pageCount, playHeadStep } from "./stepPage.js";

/** Knob counts that make one detent (a turn is 1000 counts). */
const DETENT_COUNTS = 120;
/** The playlist window in FL's UI_STATE (`ui.getFocused(2)`). */
const SONG_BUTTON = 1;
const PREV_PATTERN_BUTTON = 4;
const NEXT_PATTERN_BUTTON = 5;
const PREV_PAGE_BUTTON = 6;
const NEXT_PAGE_BUTTON = 7;
/** Knobs 5 and 6 (0-based 4 and 5): the first two columns of the right screen. */
const ROW_KNOB = 4;
const PAGE_KNOB = 5;
/** Patterns on the pads. */
const PATTERN_BANK = PAD_COUNT;

/** Channel rows on the screens. */
export const ROWS = 8;
/** Where the rows start (under the tab strip and a header line) and how tall each one is. */
const HEADER_TOP = TAB_HEIGHT + 3;
const ROWS_TOP = 48;
const ROW_PITCH = 20;
const ROW_HEIGHT = 18;
const ROWS_BOTTOM = ROWS_TOP + ROWS * ROW_PITCH;
/** The footer line under the rows and the knob row at the bottom of the right screen. */
const FOOTER_Y = ROWS_BOTTOM + 11;
const KNOB_HEIGHT = 44;
const KNOB_ROW: Rect = { ...FULL, y: FULL.height - KNOB_HEIGHT, height: KNOB_HEIGHT };
/** The step cells fill the right screen's width, 16 across. */
const CELLS_X = 4;
const CELLS_WIDTH = FULL.width - 8;
const CELL_PITCH = CELLS_WIDTH / STEPS_PER_PAGE;
const CELL_WIDTH = Math.floor(CELL_PITCH) - 2;

/** Where step cell `column` (0–15) of screen row `row` (0–7) sits on the right screen. */
export function cellRect(row: number, column: number): Rect {
  return {
    x: CELLS_X + Math.round(column * CELL_PITCH),
    y: ROWS_TOP + row * ROW_PITCH,
    width: CELL_WIDTH,
    height: ROW_HEIGHT,
  };
}

/** Steps the script sends for a pattern (longer patterns show their first 256 steps). */
const patternLength = (fl: FlState): number => Math.min(fl.pattern.length, MAX_PATTERN_STEPS);

export interface ArrangerOptions {
  /** Send RUN_PROBE when the page opens; `MK3D_PROBE=1` in the environment by default. */
  probe?: boolean;
}

export class ArrangerPage implements Mode {
  readonly name = "arranger";
  private readonly probe: boolean;
  /** The channel the row cursor is on (a global index). */
  private cursor = 0;
  /** The first of the 8 rows, as an offset into the cursor's bank. */
  private top = 0;
  private page = 0;
  private follow = true;
  /** The page the play head was last on; undefined while stopped. */
  private playPage: number | undefined;
  /** The pattern bank (16 patterns) of the pads. */
  private patternBank = 0;
  /** FL's selected channel as last seen: the cursor follows it when it changes. */
  private lastSelected: number | null = null;
  private lastPattern = 0;
  private rowTurn = 0;
  private pageTurn = 0;
  private lastView: string | undefined;

  constructor(options: ArrangerOptions = {}) {
    this.probe = options.probe ?? process.env.MK3D_PROBE === "1";
  }

  // ── Window ─────────────────────────────────────────────────────────────────

  enter(mc: ModeContext): void {
    const { fl } = mc;
    this.rowTurn = this.pageTurn = 0;
    this.lastSelected = fl.selectedChannel.index;
    this.cursor = this.lastSelected ?? 0;
    this.lastPattern = fl.pattern.number;
    this.patternBank = this.clampPatternBank(
      fl.pattern.number > 0 ? this.bankOfPattern(fl) : 0,
      fl,
    );
    this.playPage = undefined;
    this.page = Math.min(this.page, this.lastPage(fl));
    this.followPlayHead(mc, false);
    this.scrollIntoView(fl);
    this.lastView = undefined;
    this.sendView(mc);
    // A diagnostic: FL answers with what its performance-mode functions return (PROBE lines in the log).
    if (this.probe) mc.send({ type: "runProbe" });
  }

  /** An overlay closed: resend the VIEW and keep everything else. */
  resume(mc: ModeContext): void {
    this.lastView = undefined;
    this.sendView(mc);
  }

  view(): ViewCommand {
    return {
      type: "view",
      channelOffset: bankFirst(bankOf(this.cursor)),
      mixerOffset: 0,
      patternOffset: this.patternBank * PATTERN_BANK,
      stepOffset: this.page * STEPS_PER_PAGE,
      meters: false,
      presets: false,
      patternGrid: true,
      params: [],
    };
  }

  private sendView(mc: ModeContext): void {
    const view = this.view();
    const json = JSON.stringify(view);
    if (json === this.lastView) return;
    this.lastView = json;
    mc.send(view);
  }

  private lastPage(fl: FlState): number {
    return pageCount(patternLength(fl)) - 1;
  }

  private setPage(wanted: number, mc: ModeContext): void {
    const page = Math.min(Math.max(0, wanted), this.lastPage(mc.fl));
    if (page === this.page) return;
    this.page = page;
    this.sendView(mc);
    mc.requestRender();
  }

  // ── Rows and the cursor ────────────────────────────────────────────────────

  /** Moves the cursor by `delta` rows inside its bank; the 8 rows scroll to keep it in view. */
  private moveCursor(delta: number, mc: ModeContext): void {
    const { fl } = mc;
    const bank = bankOf(this.cursor);
    const length = bankLength(fl, bank);
    if (length === 0) return;
    const row = Math.min(Math.max(0, this.cursor - bankFirst(bank) + delta), length - 1);
    const cursor = bankFirst(bank) + row;
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.scrollIntoView(fl);
    mc.requestRender();
  }

  /** Keep `top` so the cursor row is one of the 8 rows shown and no row past the bank's end. */
  private scrollIntoView(fl: FlState): void {
    const bank = bankOf(this.cursor);
    const row = this.cursor - bankFirst(bank);
    const last = Math.max(0, bankLength(fl, bank) - ROWS);
    let top = Math.min(this.top, last);
    if (row < top) top = row;
    if (row >= top + ROWS) top = row - ROWS + 1;
    this.top = Math.min(Math.max(0, top), last);
  }

  /** The channel the row cursor is on (a global index). */
  get cursorChannel(): number {
    return this.cursor;
  }

  /** The step page shown (0-based). */
  get stepPage(): number {
    return this.page;
  }

  /** The channels on the rows, top to bottom: global indexes of the channels that exist. */
  rows(fl: FlState): number[] {
    const bank = bankOf(this.cursor);
    const count = Math.min(ROWS, Math.max(0, bankLength(fl, bank) - this.top));
    return Array.from({ length: count }, (_, i) => bankFirst(bank) + this.top + i);
  }

  /** The cursor follows FL's selected channel when that changes (GROUP A–H, a push, FL's own UI). */
  private syncCursor(mc: ModeContext): void {
    const { fl } = mc;
    const selected = fl.selectedChannel.index;
    if (selected === this.lastSelected) return;
    this.lastSelected = selected;
    if (selected === null) return;
    this.cursor = selected;
    this.scrollIntoView(fl);
    this.sendView(mc);
    mc.requestRender();
  }

  // ── Patterns ───────────────────────────────────────────────────────────────

  private bankOfPattern(fl: FlState): number {
    return Math.floor((fl.pattern.number - 1) / PATTERN_BANK);
  }

  private lastPatternBank(fl: FlState): number {
    return Math.max(0, Math.floor((fl.patternCount - 1) / PATTERN_BANK));
  }

  private clampPatternBank(bank: number, fl: FlState): number {
    return Math.min(Math.max(0, bank), this.lastPatternBank(fl));
  }

  /** Pattern number (1-based) behind a pad, undefined past the last pattern. */
  private patternOf(pad: number, fl: FlState): number | undefined {
    const index = this.patternBank * PATTERN_BANK + pad;
    return index < fl.patternCount ? index + 1 : undefined;
  }

  private selectPattern(number: number, mc: ModeContext): void {
    if (number < 1 || number > mc.fl.patternCount) return;
    mc.send({ type: "selectPattern", number });
  }

  private hasPreviousPattern(fl: FlState): boolean {
    return fl.pattern.number > 1;
  }

  private hasNextPattern(fl: FlState): boolean {
    return fl.pattern.number > 0 && fl.pattern.number < fl.patternCount;
  }

  // ── Play head ──────────────────────────────────────────────────────────────

  /** FOLLOW: turn to the play head's page when the head enters a page it was not on before. */
  private followPlayHead(mc: ModeContext, render = true): void {
    const head = this.playHead(mc.fl);
    if (head === undefined) {
      this.playPage = undefined;
      return;
    }
    const page = Math.floor(head / STEPS_PER_PAGE);
    const entered = page !== this.playPage;
    this.playPage = page;
    if (!this.follow || !entered) return;
    if (render) this.setPage(page, mc);
    else this.page = Math.min(page, this.lastPage(mc.fl));
  }

  /** The step the play head is on, undefined while stopped or past the 256 steps the grid has. */
  private playHead(fl: FlState): number | undefined {
    const head = playHeadStep(fl);
    return head === undefined || head >= MAX_PATTERN_STEPS ? undefined : head;
  }

  private toggleFollow(mc: ModeContext): void {
    this.follow = !this.follow;
    this.playPage = undefined; // turning it on while playing turns to the play head at once
    this.followPlayHead(mc);
    mc.requestRender();
  }

  // ── What FL said ───────────────────────────────────────────────────────────

  onFlChange(section: FlSection, mc: ModeContext): void {
    const { fl } = mc;
    switch (section) {
      case "selectedChannel":
        this.syncCursor(mc);
        break;
      case "channels": {
        // The channel count can shrink under the cursor.
        const last = Math.max(0, fl.channelTotal - 1);
        if (this.cursor > last) {
          this.cursor = last;
          this.scrollIntoView(fl);
          this.sendView(mc);
        } else {
          this.scrollIntoView(fl);
        }
        break;
      }
      case "pattern": {
        const changed = fl.pattern.number !== this.lastPattern;
        this.lastPattern = fl.pattern.number;
        // The pad bank follows the current pattern; a shorter pattern may end before the page.
        if (changed && fl.pattern.number > 0) {
          this.patternBank = this.clampPatternBank(this.bankOfPattern(fl), fl);
        }
        this.page = Math.min(this.page, this.lastPage(fl));
        this.sendView(mc);
        this.followPlayHead(mc);
        break;
      }
      case "patterns": {
        const bank = this.clampPatternBank(this.patternBank, fl);
        if (bank !== this.patternBank) {
          this.patternBank = bank;
          this.sendView(mc);
        }
        break;
      }
      case "transport":
      case "songPos":
        this.followPlayHead(mc);
        break;
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    switch (event.type) {
      case "pad":
        // Down selects; move and up are ours too, so no pad plays a note under the page. ERASE +
        // pad does nothing: FL's script cannot delete a pattern.
        if (event.phase === "down" && !mc.erase) {
          const number = this.patternOf(event.pad, mc.fl);
          if (number !== undefined) this.selectPattern(number, mc);
        }
        return true;
      case "encoder":
        if (event.index === ROW_KNOB)
          this.rowTurn = this.turnKnob(this.rowTurn, event.delta, mc, true);
        else if (event.index === PAGE_KNOB) {
          this.pageTurn = this.turnKnob(this.pageTurn, event.delta, mc, false);
        } else return false;
        return true;
      case "nav":
        return this.onNav(event, mc);
      case "button":
        return this.onButton(event.id, event.pressed, mc);
      default:
        return false;
    }
  }

  private onNav(event: Extract<HwEvent, { type: "nav" }>, mc: ModeContext): boolean {
    if (event.action === "turn") {
      this.moveCursor(event.delta, mc);
      return true;
    }
    if (event.action === "push") {
      if (event.pressed && mc.fl.connected && this.cursor < mc.fl.channelTotal) {
        mc.send({ type: "selectChannel", index: this.cursor });
      }
      return true;
    }
    if (event.action === "tilt" && (event.direction === "left" || event.direction === "right")) {
      if (event.pressed) this.setPage(this.page + (event.direction === "left" ? -1 : 1), mc);
      return true;
    }
    return false;
  }

  private onButton(id: ButtonId, pressed: boolean, mc: ModeContext): boolean {
    // GROUP A–H: the stack picks the bank, the cursor follows the selection.
    if (groupBank(id) !== undefined) return false;
    if (id === "follow") {
      if (pressed) this.toggleFollow(mc);
      return true;
    }
    const display = DISPLAY_BUTTONS.findIndex((button) => button === id);
    if (display < 0) return false;
    // Display buttons never reach a page underneath.
    if (!pressed) return true;
    const { fl } = mc;
    if (display === SONG_BUTTON) mc.send({ type: "setLoopMode", song: !fl.transport.songMode });
    else if (display === PREV_PATTERN_BUTTON) this.selectPattern(fl.pattern.number - 1, mc);
    else if (display === NEXT_PATTERN_BUTTON) this.selectPattern(fl.pattern.number + 1, mc);
    else if (display === PREV_PAGE_BUTTON) this.setPage(this.page - 1, mc);
    else if (display === NEXT_PAGE_BUTTON) this.setPage(this.page + 1, mc);
    return true;
  }

  /** Knob 5 (rows) or 6 (pages): whole detents move by one. Returns the leftover counts. */
  private turnKnob(turn: number, delta: number, mc: ModeContext, rows: boolean): number {
    const total = turn + delta;
    const detents = Math.trunc(total / DETENT_COUNTS);
    if (detents !== 0) {
      if (rows) this.moveCursor(detents, mc);
      else this.setPage(this.page + detents, mc);
    }
    return total - detents * DETENT_COUNTS;
  }

  ownsButtonLed(id: ButtonId): boolean {
    return id === "follow";
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    this.renderLeft(left, mc);
    this.renderRight(right, mc);
  }

  private rowRect(row: number): Rect {
    return { x: 0, y: ROWS_TOP + row * ROW_PITCH, width: FULL.width, height: ROW_HEIGHT };
  }

  private renderLeft(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    clear(ctx, FULL);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      { tabs: ["ARRANGER", "SONG"], active: fl.transport.songMode ? [SONG_BUTTON] : [] },
    );
    // The pattern's name and length above the rows.
    ctx.textBaseline = "middle";
    const { pattern } = fl;
    const headerY = HEADER_TOP + 10;
    if (pattern.number <= 0) {
      ctx.textAlign = "left";
      ctx.fillStyle = theme.dimText;
      ctx.font = font(16);
      ctx.fillText("No pattern", 12, headerY);
    } else {
      ctx.textAlign = "right";
      ctx.fillStyle = theme.dimText;
      ctx.font = font(14);
      const length = pattern.length > 0 ? `${pattern.length} steps` : "no steps";
      ctx.fillText(length, FULL.width - 12, headerY);
      const room = FULL.width - 24 - ctx.measureText(length).width - 12;
      ctx.textAlign = "left";
      ctx.fillStyle = flColorToCss(pattern.color);
      ctx.fillRect(4, headerY - 9, 5, 18);
      ctx.fillStyle = theme.text;
      ctx.font = font(16, "bold");
      ctx.fillText(
        fitText(ctx, `${pattern.number}  ${pattern.name || `Pattern ${pattern.number}`}`, room),
        16,
        headerY,
      );
    }
    const rows = this.rows(fl);
    if (rows.length === 0) {
      ctx.textAlign = "left";
      ctx.fillStyle = theme.dimText;
      ctx.font = font(18);
      ctx.fillText("No channels", 12, ROWS_TOP + 14);
    }
    rows.forEach((channel, row) => this.drawChannelRow(ctx, mc, channel, row));
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13);
    const bank = bankOf(this.cursor);
    const range = bankText(fl, bank);
    if (range) ctx.fillText(`Group ${bankLetter(bank)}   ${range}`, 12, FOOTER_Y);
  }

  private drawChannelRow(ctx: SKRSContext2D, mc: ModeContext, channel: number, row: number): void {
    const { fl } = mc;
    const rect = this.rowRect(row);
    const entry = fl.channels.get(channel);
    const isCursor = channel === this.cursor;
    clear(
      ctx,
      { ...rect, x: 2, width: rect.width - 4 },
      isCursor ? theme.panelRaised : theme.panel,
    );
    const muted = entry?.muted ?? false;
    ctx.globalAlpha = muted ? 0.45 : 1;
    ctx.fillStyle = flColorToCss(entry?.color ?? 0);
    ctx.fillRect(4, rect.y + 1, 5, rect.height - 2);
    ctx.globalAlpha = 1;
    ctx.textBaseline = "middle";
    const y = rect.y + rect.height / 2;
    ctx.textAlign = "right";
    ctx.font = font(13, "bold");
    ctx.fillStyle = isCursor ? theme.accent : theme.dimText;
    ctx.fillText(String(channel + 1), 36, y);
    ctx.textAlign = "left";
    ctx.font = font(15, isCursor ? "bold" : "normal");
    ctx.fillStyle = muted ? theme.dimText : theme.text;
    const solo = entry?.solo ?? false;
    ctx.fillText(
      fitText(ctx, entry?.name ?? `Channel ${channel + 1}`, FULL.width - 48 - (solo ? 28 : 12)),
      46,
      y,
    );
    if (solo) {
      ctx.textAlign = "right";
      ctx.font = font(13, "bold");
      ctx.fillStyle = theme.option;
      ctx.fillText("S", FULL.width - 12, y);
    }
    if (isCursor) {
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(3, rect.y + 0.5, rect.width - 6, rect.height - 1);
    }
  }

  private renderRight(ctx: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    clear(ctx, FULL);
    drawTabs(
      ctx,
      { ...FULL, height: TAB_HEIGHT },
      {
        tabs: [
          "PREV PAT",
          "NEXT PAT",
          this.page > 0 ? "<<" : "",
          this.page < this.lastPage(fl) ? ">>" : "",
        ],
      },
    );
    this.drawRuler(ctx);
    const head = this.playHead(fl);
    const length = patternLength(fl);
    this.rows(fl).forEach((channel, row) => {
      const rect = this.rowRect(row);
      const grid = fl.patternGrid.get(channel);
      if (grid && !grid.stepSequencer) {
        clear(ctx, { ...rect, x: CELLS_X, width: CELLS_WIDTH }, theme.background);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = theme.dimText;
        ctx.globalAlpha = 0.6;
        ctx.font = font(14);
        ctx.fillText("piano roll", FULL.width / 2, rect.y + rect.height / 2);
        ctx.globalAlpha = 1;
      } else {
        this.drawCells(ctx, row, fl, channel, length, head);
      }
      if (channel === this.cursor) {
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(CELLS_X - 2, rect.y - 0.5, CELLS_WIDTH + 4, rect.height + 1);
      }
    });
    this.drawFooter(ctx, fl);
    const touched = (knob: number) => mc.touchedKnobs.has(knob);
    const bank = bankOf(this.cursor);
    const knobs: KnobProps[] = [
      {
        label: "Rows",
        valueText: bankLength(fl, bank) > 0 ? `${this.cursor + 1}/${fl.channelTotal}` : "–",
        touched: touched(ROW_KNOB),
      },
      {
        label: "Steps",
        valueText: `${this.page + 1}/${this.lastPage(fl) + 1}`,
        touched: touched(PAGE_KNOB),
      },
    ];
    drawKnobRow(ctx, KNOB_ROW, knobs);
  }

  /** The step numbers over the groups of 4: `1 5 9 13` on page 1, `17 21 25 29` on page 2. */
  private drawRuler(ctx: SKRSContext2D): void {
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = font(12);
    ctx.fillStyle = theme.dimText;
    for (let pad = 0; pad < STEPS_PER_PAGE; pad += 4) {
      const x = CELLS_X + Math.round(pad * CELL_PITCH) + 2;
      ctx.fillText(String(this.page * STEPS_PER_PAGE + pad + 1), x, HEADER_TOP + 10);
    }
  }

  private drawCells(
    ctx: SKRSContext2D,
    row: number,
    fl: FlState,
    channel: number,
    length: number,
    head: number | undefined,
  ): void {
    const steps = fl.patternGrid.get(channel)?.steps;
    const color = flColorToCss(fl.channels.get(channel)?.color ?? 0);
    for (let i = 0; i < STEPS_PER_PAGE; i++) {
      const step = this.page * STEPS_PER_PAGE + i;
      const cell = cellRect(row, i);
      if (step >= length) {
        clear(ctx, cell, theme.background);
        continue;
      }
      const on = steps?.get(step) ?? false;
      ctx.fillStyle = on ? color : groupB(i) ? theme.stepOffB : theme.stepOffA;
      ctx.beginPath();
      ctx.roundRect(cell.x, cell.y, cell.width, cell.height, 3);
      ctx.fill();
      if (head === step) {
        // The play head lights its column up, like the white pad.
        ctx.fillStyle = "#ffffff";
        ctx.globalAlpha = 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawFooter(ctx: SKRSContext2D, fl: FlState): void {
    const length = patternLength(fl);
    const first = this.page * STEPS_PER_PAGE;
    const last = Math.min(first + STEPS_PER_PAGE, length);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13);
    const total = fl.pattern.length > length ? `${length}+` : String(length);
    ctx.fillText(
      length > 0 ? `steps ${first + 1}–${last} of ${total}` : "no steps",
      FULL.width - 8,
      FOOTER_Y,
    );
  }

  leds(leds: LedState, mc: ModeContext): void {
    const { fl } = mc;
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const number = this.patternOf(pad, fl);
      if (number === undefined) {
        leds.setPad(pad, LED_OFF);
        continue;
      }
      const entry = fl.patterns.get(number - 1);
      leds.setPad(
        pad,
        flColorToPalette(entry?.color ?? 0, number === fl.pattern.number ? "bright" : "dim"),
      );
    }
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display2", fl.transport.songMode ? "bright" : "dim");
    leds.setLight("display5", this.hasPreviousPattern(fl) ? "dim" : "off");
    leds.setLight("display6", this.hasNextPattern(fl) ? "dim" : "off");
    leds.setLight("display7", this.page > 0 ? "dim" : "off");
    leds.setLight("display8", this.page < this.lastPage(fl) ? "dim" : "off");
    leds.setLight("follow", this.follow ? "bright" : "dim");
  }
}
