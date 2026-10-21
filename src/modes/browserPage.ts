// BROWSER (a main page; Maschine's browser, here the selected channel's plugin presets): turn to
// choose, push to load. The left screen's display buttons 1-2 pick the source: PRESETS (this) and PLUG-INS
// (FL's Plugin picker, below). Display 3 has no source.
//
// A **cursor** (the highlighted row) is separate from the **loaded** preset (orange, with a marker):
// the 4D turn (and tilt up/down, and knobs 5 and 8 under the list) move the cursor through the list without
// loading anything, and the list scrolls to keep the cursor visible. 4D push loads the cursor's
// preset (PRESET_LOAD: FL's script steps next/prev there), and so does display 8 `LOAD`. Display 5 `PREV` and 6 `NEXT` load the
// previous or next preset at once (PRESET_STEP) and move the cursor along. Every load shows the
// SHIFT + pad read-out card (`LOADED`, the name). The pads play the keyboard or PAD MODE as everywhere else, to audition.
//
// The page watches the presets only while it is shown: its VIEW has the `presets` flag, every other
// page's does not, so FL's script reads nothing for them. FL answers with PRESETS (the count, the
// loaded index and 8 names); mk3d draws from `fl.presets` and asks for another window of names
// (PRESET_WINDOW) when the list scrolls beyond the ones it has.
//
// Left screen: the plugin and channel, `LOADED` and the loaded preset's name big in orange, `n / count`;
// when the cursor is elsewhere `PUSH 4D TO LOAD` and the cursor's name. Right screen: tabs PREV / NEXT / LOAD,
// a list of 7 rows (cursor = filled bar, loaded = orange text and a marker, a scroll bar on the right
// edge with a tick for the loaded preset) and, under it, knobs 5 and 8's `SCROLL`. No plugin or no presets:
// a notice (`No presets for <plugin>`).
//
// PLUG-INS (display 2, verified in FL 2026, docs/fl-ilmcp.md) = FL's own **Plugin picker** (Generators and
// Effects, category tabs at the bottom): display 2 sends BROWSE `pluginPicker` (FPT_F8, a toggle), mk3d
// remembers `pickerOpen`. While it is open the 4D turn = UI_KEY down / up (at most ~15 per second), tilt =
// up / down / left / right (left / right change the category page), 4D push = UI_KEY enter, which adds the
// highlighted plugin as a new channel; display 8 `CLOSE` (or display 2 again) toggles the picker closed.
// FL gives nothing about the highlighted plugin, so the name is not shown here: the user looks at FL.
// After the push mk3d assumes FL closed the picker, goes back to PRESETS and, when FL's channel count grows
// within ~3 s, shows the `ADDED` read-out card with the new channel's name. Leaving the page (or going back
// to PRESETS) while the picker is open sends UI_KEY escape, which closes it without adding anything.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlSection } from "../fl/flState.js";
import { MAX_PRESET_NAMES } from "../fl/protocol.js";
import type { FlCommand } from "../fl/sysex.js";
import type { HwEvent } from "../hw/events.js";
import type { LedState } from "../hw/leds.js";
import { paletteColor } from "../hw/palette.js";
import { TAB_HEIGHT, clear, drawTabs, fitText, font, theme } from "../render/widgets.js";
import { pageStart } from "./channelMode.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL, drawWrapped } from "./draw.js";
import { clamp } from "./knob.js";
import type { Mode, ModeContext, ViewCommand } from "./mode.js";

/** Names the list shows. */
export const LIST_ROWS = 7;
const PREV_BUTTON = 4;
const NEXT_BUTTON = 5;
/** Display 8 loads the cursor's preset, like the 4D push (and closes the picker on PLUG-INS). */
const LOAD_BUTTON = 7;
const CLOSE_BUTTON = 7;
/** Knobs 5 and 8 (0-based 4 and 7) sit under the right screen's list and scroll it. */
const SCROLL_KNOBS = [4, 7];
/** Knob counts that make one detent (a turn is 1000 counts). */
const DETENT_COUNTS = 120;
/** mk3d's own idea of the loaded preset (after PREV / NEXT / push) wins over FL's this long. */
const PROJECTED_MS = 1500;
const TABS = { ...FULL, height: TAB_HEIGHT };

/** Where the page gets its list from: the plugin's presets, or FL's Plugin picker. */
export type BrowserSource = "presets" | "plugins";
const SOURCES: readonly BrowserSource[] = ["presets", "plugins"];
/** Left screen tabs (display buttons 1-2). */
export const SOURCE_TABS = ["PRESETS", "PLUG-INS"];
/** Right screen tab of PLUG-INS (display 8). */
export const PICKER_TABS = ["", "", "", "CLOSE"];
/** Help lines of the open picker (left screen) and the notice while it is closed. */
export const PICKER_TITLE = "PLUG-IN PICKER";
export const PICKER_HELP = [
  "Turn 4D: browse",
  "Tilt 4D < >: category",
  "Push 4D: add as new channel",
  "Shown in FL Studio",
];
export const PICKER_CLOSED = "PUSH PLUG-INS (display 2) TO OPEN FL'S PLUGIN PICKER";
/** At most this many picker keys per second (a fast 4D turn), and how many may go at once. */
const COMMANDS_PER_SECOND = 15;
const COMMAND_BURST = 2;
/** How long after the push a growing channel count counts as the added plugin. */
const ADDED_MS = 3000;
/** Left screen while FL's current preset matches none of the names. */
export const UNKNOWN_TEXT = "Current preset unknown \u2014 PREV/NEXT steps from FL's current one";

const ROW_HEIGHT = 31;
const LIST_BOTTOM = TAB_HEIGHT + LIST_ROWS * ROW_HEIGHT;
const KNOB_STRIP = { y: LIST_BOTTOM, width: 120, height: FULL.height - LIST_BOTTOM };
const BAR_WIDTH = 6;
const DARK_TEXT = theme.background;

/** What the page can say about the selected channel's presets. */
export type BrowserState =
  | { kind: "none"; text: string }
  | { kind: "reading" }
  | { kind: "presets"; count: number; current: number | null };

/** One row of the list: the preset's index, its name ("" until FL has sent it) and what it is. */
export interface BrowserRow {
  index: number;
  name: string;
  cursor: boolean;
  loaded: boolean;
}

/** What the list shows now. */
export interface BrowserListing {
  count: number;
  /** Index of the first row. */
  top: number;
  /** The highlighted preset. */
  cursor: number;
  /** The loaded preset, null when it is not known. */
  loaded: number | null;
  rows: BrowserRow[];
}

export class BrowserPage implements Mode {
  readonly name = "browser";
  private lastView: string | undefined;
  /** The cursor; null = on the loaded preset. */
  private cursor: number | null = null;
  /** Index of the first row; undefined = place the list around the cursor. */
  private top: number | undefined;
  /** The loaded preset as it will be once FL has done what we sent. */
  private projected: { index: number; at: number } | undefined;
  /** Which channel, plugin and bank the cursor belongs to. */
  private bank = "";
  /** Every preset name FL has sent for this bank, so rows keep their names when the list scrolls back. */
  private readonly seen = new Map<number, string>();
  private knobTurn = 0;
  /** Which source the left screen's tabs have chosen. */
  private source: BrowserSource = "presets";
  /** The last context the page was entered with, for `leave` (it gets none). */
  private context: ModeContext | undefined;
  /** PLUG-INS: mk3d's idea of whether FL's Plugin picker is open. */
  private pickerOpen = false;
  /** After the push: the channel count then and when, to spot the added channel. */
  private adding: { total: number; at: number } | undefined;
  /** Picker keys left in the burst, and when the bucket was last filled (ms). */
  private tokens = COMMAND_BURST;
  private tokensAt: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  enter(mc: ModeContext): void {
    this.lastView = undefined;
    this.cursor = null;
    this.top = undefined;
    this.projected = undefined;
    this.knobTurn = 0;
    this.bank = "";
    this.seen.clear();
    this.context = mc;
    this.source = "presets";
    this.pickerOpen = false;
    this.adding = undefined;
    this.tokens = COMMAND_BURST;
    this.tokensAt = undefined;
    this.sendView(mc);
  }

  /** An overlay closed: resend the VIEW and keep everything else. */
  resume(mc: ModeContext): void {
    this.context = mc;
    this.lastView = undefined;
    this.sendView(mc);
  }

  /** Leaving the page: an open Plugin picker is closed without adding anything (escape). */
  leave(): void {
    const mc = this.context;
    if (mc) this.closePicker(mc);
  }

  /** Escape closes FL's Plugin picker without adding; nothing is sent when it is not open. */
  private closePicker(mc: ModeContext): void {
    if (!this.pickerOpen) return;
    this.pickerOpen = false;
    if (mc.fl.connected) mc.send({ type: "uiKey", key: "escape" });
  }

  view(mc: ModeContext): ViewCommand {
    const channel = mc.fl.selectedChannel.index;
    return {
      type: "view",
      channelOffset: channel === null ? 0 : pageStart(channel),
      mixerOffset: 0,
      patternOffset: 0,
      stepOffset: 0,
      meters: false,
      presets: this.source === "presets",
      patternGrid: false,
      params: [],
    };
  }

  private sendView(mc: ModeContext): void {
    const view = this.view(mc);
    const json = JSON.stringify(view);
    if (json === this.lastView) return;
    this.lastView = json;
    mc.send(view);
  }

  onFlChange(section: FlSection, mc: ModeContext): void {
    if (section === "selectedChannel") this.sendView(mc);
    if (section === "presets") this.requestWindow(mc, 0);
    if (section === "channels" || section === "selectedChannel") this.checkAdded(mc);
  }

  // ── FL's Plugin picker ────────────────────────────────────────────────────────────────────────

  /** The picker commands; `throttled` ones go at most COMMANDS_PER_SECOND times a second. False = dropped. */
  private send(command: FlCommand, mc: ModeContext, throttled = false): boolean {
    if (!mc.fl.connected) return false;
    if (throttled) {
      const now = this.now();
      const last = this.tokensAt ?? now;
      this.tokens = Math.min(
        COMMAND_BURST,
        this.tokens + ((now - last) * COMMANDS_PER_SECOND) / 1000,
      );
      this.tokensAt = now;
      if (this.tokens < 1) return false;
      this.tokens -= 1;
    }
    mc.send(command);
    return true;
  }

  /** F8 toggles FL's Plugin picker. */
  private togglePicker(mc: ModeContext): void {
    if (!this.send({ type: "browse", action: "pluginPicker" }, mc)) return;
    this.pickerOpen = !this.pickerOpen;
  }

  /** Display 1-2: choose the source. */
  private pickSource(display: number, mc: ModeContext): void {
    const next = SOURCES[display];
    if (!next) return;
    if (next === "presets") {
      this.closePicker(mc);
      if (this.source !== "presets") {
        this.source = "presets";
        this.sendView(mc);
      }
    } else {
      this.source = "plugins";
      this.sendView(mc);
      this.togglePicker(mc); // open it; pressed again while open, close it
    }
    mc.requestRender();
  }

  /** The 4D while the PLUG-INS source is shown. True = handled. */
  private pickerNav(event: Extract<HwEvent, { type: "nav" }>, mc: ModeContext): boolean {
    if (event.action === "turn") {
      if (!this.pickerOpen) return true;
      const key = event.delta > 0 ? "down" : "up";
      for (let i = 0; i < Math.abs(event.delta); i++) {
        if (!this.send({ type: "uiKey", key }, mc, true)) break;
      }
      return true;
    }
    if (event.action === "tilt") {
      if (event.pressed && this.pickerOpen) {
        this.send(
          { type: "uiKey", key: event.direction },
          mc,
          event.direction !== "left" && event.direction !== "right",
        );
      }
      return true;
    }
    if (event.action !== "push") return false;
    if (event.pressed && this.pickerOpen) this.addPlugin(mc);
    return true;
  }

  /** 4D push: Enter adds the highlighted plugin as a new channel; FL closes the picker, back to PRESETS. */
  private addPlugin(mc: ModeContext): void {
    if (!this.send({ type: "uiKey", key: "enter" }, mc)) return;
    this.pickerOpen = false;
    this.adding = { total: mc.fl.channelTotal, at: this.now() };
    this.source = "presets";
    this.sendView(mc);
    mc.requestRender();
  }

  /** FL's channel count grew within ADDED_MS of the push: show the `ADDED` card. */
  private checkAdded(mc: ModeContext): void {
    const adding = this.adding;
    if (!adding) return;
    if (this.now() - adding.at > ADDED_MS) {
      this.adding = undefined;
      return;
    }
    const { fl } = mc;
    if (fl.channelTotal <= adding.total) return;
    this.adding = undefined;
    const last = fl.channelTotal - 1;
    const name = fl.selectedChannel.index === last ? fl.selectedChannel.name : "";
    const label = name || fl.channels.get(last)?.name || `Channel ${fl.channelTotal}`;
    mc.reportAction?.(
      { title: "ADDED", detail: label, source: "BROWSER" },
      `→ FL added plugin as channel ${fl.channelTotal} ${JSON.stringify(label)}`,
    );
  }

  // ── Input ──────────────────────────────────────────────────────────────────────────────

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type === "button") {
      const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
      if (display >= 0 && display <= 2) {
        if (event.pressed && display < SOURCES.length) this.pickSource(display, mc);
        return true;
      }
      if (this.source === "plugins" && display === CLOSE_BUTTON) {
        if (event.pressed && this.pickerOpen) this.togglePicker(mc);
        mc.requestRender();
        return true;
      }
    }
    if (this.source === "plugins" && event.type === "nav") return this.pickerNav(event, mc);
    if (this.source === "plugins" && event.type === "encoder") return false;

    switch (event.type) {
      case "nav":
        if (event.action === "turn") {
          this.moveCursor(event.delta, mc);
          return true;
        }
        if (event.action === "tilt") {
          if (event.direction !== "up" && event.direction !== "down") return false;
          if (event.pressed) this.moveCursor(event.direction === "down" ? 1 : -1, mc);
          return true;
        }
        if (event.action !== "push") return false;
        if (event.pressed) this.load(mc);
        return true;
      case "encoder": {
        if (!SCROLL_KNOBS.includes(event.index)) return false;
        this.knobTurn += event.delta;
        const detents = Math.trunc(this.knobTurn / DETENT_COUNTS);
        if (detents !== 0) {
          this.knobTurn -= detents * DETENT_COUNTS;
          this.moveCursor(detents, mc);
        }
        return true;
      }
      case "button": {
        const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
        if (display === LOAD_BUTTON) {
          if (event.pressed) this.load(mc);
          return true;
        }
        if (display !== PREV_BUTTON && display !== NEXT_BUTTON) return false;
        if (event.pressed) this.step(display === NEXT_BUTTON, mc);
        return true;
      }
      default:
        return false;
    }
  }

  /** The cursor moves by `delta` rows (it stops at both ends); nothing is loaded. */
  private moveCursor(delta: number, mc: ModeContext): void {
    const state = this.state(mc);
    if (state.kind !== "presets" || delta === 0) return;
    this.cursor = clamp(this.cursorIndex(mc) + delta, 0, state.count - 1);
    this.requestWindow(mc, Math.sign(delta));
    mc.requestRender();
  }

  /** 4D push or display 8: load the preset under the cursor. */
  private load(mc: ModeContext): void {
    const state = this.state(mc);
    if (state.kind !== "presets" || !mc.fl.connected || this.cursor === null) return;
    const target = this.cursor;
    const loaded = this.loadedIndex(mc);
    if (target === loaded) return;
    mc.send({ type: "presetLoad", index: target });
    if (loaded !== null) this.loadedNow(target, "load", mc);
    mc.requestRender();
  }

  /** Load the previous or next preset (only when the selected channel has a plugin). */
  private step(next: boolean, mc: ModeContext): void {
    if (!mc.fl.connected || mc.fl.selectedChannel.index === null) return;
    mc.send({ type: "presetStep", dir: next ? "next" : "prev" });
    const state = this.state(mc);
    const loaded = this.loadedIndex(mc);
    if (state.kind !== "presets" || loaded === null) {
      this.cursor = null; // FL steps from where it is; the cursor follows once FL says where that is
      mc.requestRender();
      return;
    }
    const target = (loaded + (next ? 1 : -1) + state.count) % state.count;
    this.cursor = target;
    this.requestWindow(mc, next ? 1 : -1);
    this.loadedNow(target, next ? "next" : "prev", mc);
    mc.requestRender();
  }

  /** mk3d has told FL to load `index`: remember it and show the read-out card. */
  private loadedNow(index: number, how: "load" | "next" | "prev", mc: ModeContext): void {
    this.projected = { index, at: this.now() };
    const count = mc.fl.presets?.count ?? 0;
    const name = this.nameAt(mc, index);
    mc.reportAction?.(
      { title: "LOADED", detail: name || `${index + 1} / ${count}`, source: "BROWSER" },
      `→ FL ${how === "load" ? "load" : `${how} preset:`} ${index + 1} ${JSON.stringify(name)}`,
    );
  }

  // ── What FL said ───────────────────────────────────────────────────────────

  state(mc: ModeContext): BrowserState {
    const { fl } = mc;
    const plugin = fl.selectedChannel.plugin;
    if (fl.selectedChannel.index === null) return { kind: "none", text: "No channel selected" };
    if (!plugin) return { kind: "none", text: "No presets for this channel" };
    const presets = fl.presets;
    if (!presets) return { kind: "reading" };
    if (presets.count === 0) return { kind: "none", text: `No presets for ${plugin}` };
    return { kind: "presets", count: presets.count, current: presets.current };
  }

  /** Forget the cursor and the scroll position when the channel, plugin or bank changes. */
  private syncBank(mc: ModeContext): void {
    const { fl } = mc;
    const bank = `${fl.selectedChannel.index}|${fl.selectedChannel.plugin}|${fl.presets?.count ?? 0}`;
    if (bank === this.bank) return;
    this.bank = bank;
    this.seen.clear();
    this.cursor = null;
    this.top = undefined;
    this.projected = undefined;
  }

  /** The loaded preset: what we are about to load, else what FL says (null = not known). */
  private loadedIndex(mc: ModeContext): number | null {
    this.syncBank(mc);
    const current = mc.fl.presets?.current ?? null;
    const projected = this.projected;
    if (projected) {
      if (current === projected.index || this.now() - projected.at >= PROJECTED_MS) {
        this.projected = undefined;
      } else {
        return projected.index;
      }
    }
    return current;
  }

  private cursorIndex(mc: ModeContext): number {
    const count = mc.fl.presets?.count ?? 0;
    const index = this.cursor ?? this.loadedIndex(mc) ?? 0;
    return clamp(index, 0, Math.max(0, count - 1));
  }

  /** Remember the names of FL's last PRESETS (of the current bank). */
  private learn(mc: ModeContext): void {
    this.syncBank(mc);
    const presets = mc.fl.presets;
    presets?.names.forEach((name, i) => this.seen.set(presets.offset + i, name));
  }

  private nameAt(mc: ModeContext, index: number): string {
    this.learn(mc);
    return this.seen.get(index) ?? "";
  }

  /** The list now: scrolled so the cursor is visible (the position is kept for the next call). */
  listing(mc: ModeContext): BrowserListing {
    const count = mc.fl.presets?.count ?? 0;
    const loaded = this.loadedIndex(mc);
    const cursor = this.cursorIndex(mc);
    const maxTop = Math.max(0, count - LIST_ROWS);
    let top = this.top;
    if (top === undefined) {
      top = cursor - 3;
    } else if (this.cursor === null) {
      // on the loaded preset: leave the list alone while it is in view, else centre it
      if (cursor < top || cursor >= top + LIST_ROWS) top = cursor - 3;
    } else if (cursor < top) {
      top = cursor;
    } else if (cursor >= top + LIST_ROWS) {
      top = cursor - LIST_ROWS + 1;
    }
    top = clamp(top, 0, maxTop);
    this.top = top;
    const rows: BrowserRow[] = [];
    for (let index = top; index < Math.min(count, top + LIST_ROWS); index++) {
      rows.push({
        index,
        name: this.nameAt(mc, index),
        cursor: index === cursor,
        loaded: index === loaded,
      });
    }
    return { count, top, cursor, loaded, rows };
  }

  /** The names the list shows: `[index, name]` (the name is "" until FL has sent it). */
  rows(mc: ModeContext): [number, string][] {
    return this.listing(mc).rows.map((row) => [row.index, row.name]);
  }

  /**
   * Ask FL for another window of names when the rows (and, in the direction of travel, one more)
   * are not all in the ones mk3d has. FL answers with PRESETS.
   */
  private requestWindow(mc: ModeContext, direction: number): void {
    const presets = mc.fl.presets;
    if (!presets || presets.count === 0 || this.state(mc).kind !== "presets") return;
    const { top, count } = this.listing(mc);
    const first = Math.max(0, direction < 0 ? top - 1 : top);
    const last = Math.min(count, direction > 0 ? top + LIST_ROWS + 1 : top + LIST_ROWS);
    this.learn(mc);
    let covered = true;
    for (let index = first; index < last; index++) covered &&= this.seen.has(index);
    if (covered) return;
    const offset = clamp(first, 0, Math.max(0, count - MAX_PRESET_NAMES));
    if (offset === presets.offset) return;
    mc.send({ type: "presetWindow", offset });
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    if (this.source === "plugins") this.renderPicker(left, right, mc);
    else this.renderPresets(left, right, mc);
  }

  private drawSourceTabs(left: SKRSContext2D): void {
    drawTabs(left, TABS, { tabs: SOURCE_TABS, active: [SOURCES.indexOf(this.source)] });
  }

  private renderPicker(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const width = FULL.width - 48;
    clear(left, FULL);
    this.drawSourceTabs(left);
    clear(right, FULL);
    left.textAlign = "left";
    left.textBaseline = "top";
    if (!this.pickerOpen) {
      drawTabs(right, TABS, { tabs: [] });
      left.fillStyle = theme.text;
      left.font = font(22, "bold");
      drawWrapped(left, PICKER_CLOSED, 24, TAB_HEIGHT + 60, width, 28, 4);
      return;
    }
    drawTabs(right, TABS, { tabs: PICKER_TABS });
    left.fillStyle = theme.accent;
    left.font = font(26, "bold");
    left.fillText(PICKER_TITLE, 24, TAB_HEIGHT + 24);
    PICKER_HELP.forEach((line, i) => {
      left.fillStyle = i === PICKER_HELP.length - 1 ? theme.dimText : theme.text;
      left.font = font(i === PICKER_HELP.length - 1 ? 16 : 18);
      left.fillText(fitText(left, line, width), 24, TAB_HEIGHT + 76 + i * 32);
    });
    const { fl } = mc;
    const index = fl.selectedChannel.index;
    right.textAlign = "left";
    right.textBaseline = "top";
    right.fillStyle = theme.dimText;
    right.font = font(13, "bold");
    right.fillText("SELECTED CHANNEL", 24, TAB_HEIGHT + 24);
    right.fillStyle = theme.text;
    right.font = font(22, "bold");
    const name = index === null ? "\u2013" : fl.selectedChannel.name || `Channel ${index + 1}`;
    right.fillText(fitText(right, name, width), 24, TAB_HEIGHT + 46);
    right.fillStyle = theme.dimText;
    right.font = font(18);
    right.fillText(`${fl.channelTotal} channels`, 24, TAB_HEIGHT + 86);
  }

  private renderPresets(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const state = this.state(mc);
    const { fl } = mc;

    clear(left, FULL);
    this.drawSourceTabs(left);
    left.textAlign = "left";
    left.textBaseline = "top";
    const index = fl.selectedChannel.index;
    const plugin = fl.selectedChannel.plugin;
    const where = [plugin, index === null ? "" : `Channel ${index + 1}`]
      .filter(Boolean)
      .join("  ·  ");
    left.fillStyle = theme.dimText;
    left.font = font(15);
    left.fillText(fitText(left, where || "BROWSER", FULL.width - 48), 24, TAB_HEIGHT + 14);

    clear(right, FULL);
    if (state.kind !== "presets") {
      drawTabs(right, TABS, { tabs: [] });
      left.fillStyle = theme.text;
      left.font = font(26, "bold");
      const text = state.kind === "reading" ? "Reading presets…" : state.text;
      drawWrapped(left, text, 24, TAB_HEIGHT + 60, FULL.width - 48, 32, 3);
      return;
    }

    const list = this.listing(mc);
    this.drawLeft(left, list, mc);
    drawTabs(right, TABS, { tabs: ["PREV", "NEXT", "", "LOAD"] });
    this.drawList(right, list);
    for (const knob of SCROLL_KNOBS) this.drawKnob(right, list, (knob - 4) * KNOB_STRIP.width);
  }

  private drawLeft(ctx: SKRSContext2D, list: BrowserListing, mc: ModeContext): void {
    const width = FULL.width - 48;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13, "bold");
    ctx.fillText("LOADED", 24, TAB_HEIGHT + 50);
    if (list.loaded === null) {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(34, "bold");
      ctx.fillText("–", 24, TAB_HEIGHT + 66);
      ctx.fillStyle = theme.text;
      ctx.font = font(18);
      drawWrapped(ctx, UNKNOWN_TEXT, 24, TAB_HEIGHT + 118, width, 24, 3);
      ctx.fillStyle = theme.dimText;
      ctx.font = font(14);
      ctx.fillText(`${list.count} presets`, 24, TAB_HEIGHT + 196);
      return;
    }
    ctx.fillStyle = theme.accent;
    ctx.font = font(34, "bold");
    const name = this.nameAt(mc, list.loaded);
    ctx.fillText(fitText(ctx, name || "…", width), 24, TAB_HEIGHT + 66);
    ctx.fillStyle = theme.dimText;
    ctx.font = font(20);
    ctx.fillText(`${list.loaded + 1} / ${list.count}`, 24, TAB_HEIGHT + 114);
    if (list.cursor === list.loaded) return;
    ctx.fillStyle = theme.selected;
    ctx.font = font(14, "bold");
    ctx.fillText("PUSH 4D TO LOAD", 24, TAB_HEIGHT + 162);
    ctx.fillStyle = theme.text;
    ctx.font = font(24, "bold");
    ctx.fillText(fitText(ctx, this.nameAt(mc, list.cursor) || "…", width), 24, TAB_HEIGHT + 184);
    ctx.fillStyle = theme.dimText;
    ctx.font = font(16);
    ctx.fillText(`${list.cursor + 1} / ${list.count}`, 24, TAB_HEIGHT + 216);
  }

  private drawList(ctx: SKRSContext2D, list: BrowserListing): void {
    const textRight = FULL.width - BAR_WIDTH - 14;
    list.rows.forEach((row, i) => {
      const y = TAB_HEIGHT + i * ROW_HEIGHT;
      const mid = y + ROW_HEIGHT / 2;
      if (row.cursor) {
        ctx.fillStyle = theme.selected;
        ctx.fillRect(0, y, FULL.width - BAR_WIDTH - 6, ROW_HEIGHT - 1);
      }
      if (row.loaded) {
        // the marker: a small triangle in front of the number
        ctx.fillStyle = row.cursor ? DARK_TEXT : theme.accent;
        ctx.beginPath();
        ctx.moveTo(9, mid - 6);
        ctx.lineTo(9, mid + 6);
        ctx.lineTo(19, mid);
        ctx.closePath();
        ctx.fill();
      }
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      ctx.font = font(14);
      ctx.fillStyle = row.cursor ? DARK_TEXT : row.loaded ? theme.accent : theme.dimText;
      ctx.fillText(String(row.index + 1), 58, mid);
      ctx.textAlign = "left";
      ctx.font = font(18, row.cursor || row.loaded ? "bold" : "normal");
      ctx.fillStyle = row.cursor ? DARK_TEXT : row.loaded ? theme.accent : theme.text;
      ctx.fillText(fitText(ctx, row.name || "…", textRight - 70), 70, mid);
    });
    this.drawScrollBar(ctx, list);
  }

  /** The window's position in the bank on the right edge, with a tick where the loaded preset is. */
  private drawScrollBar(ctx: SKRSContext2D, list: BrowserListing): void {
    if (list.count <= LIST_ROWS) return;
    const x = FULL.width - BAR_WIDTH - 2;
    const height = LIST_ROWS * ROW_HEIGHT - 2;
    const y = TAB_HEIGHT + 1;
    ctx.fillStyle = theme.line;
    ctx.fillRect(x, y, BAR_WIDTH, height);
    const thumb = Math.max(14, Math.round((height * LIST_ROWS) / list.count));
    const travel = height - thumb;
    ctx.fillStyle = theme.dimText;
    ctx.fillRect(
      x,
      y + Math.round((travel * list.top) / (list.count - LIST_ROWS)),
      BAR_WIDTH,
      thumb,
    );
    if (list.loaded !== null) {
      const at = y + Math.round(((height - 3) * list.loaded) / Math.max(1, list.count - 1));
      ctx.fillStyle = theme.accent;
      ctx.fillRect(x - 3, at, BAR_WIDTH + 3, 3);
    }
  }

  /** A scroll knob's label and the cursor's number, in its column (`x`) of the right screen. */
  private drawKnob(ctx: SKRSContext2D, list: BrowserListing, x: number): void {
    const cx = x + KNOB_STRIP.width / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13);
    ctx.fillText("SCROLL", cx, KNOB_STRIP.y + 3);
    ctx.textBaseline = "bottom";
    ctx.fillStyle = theme.text;
    ctx.font = font(15, "bold");
    ctx.fillText(`${list.cursor + 1} / ${list.count}`, cx, KNOB_STRIP.y + KNOB_STRIP.height - 2);
  }

  leds(leds: LedState, mc: ModeContext): void {
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    SOURCES.forEach((source, i) => {
      const id = DISPLAY_BUTTONS[i];
      if (id) leds.setLight(id, source === this.source ? "bright" : "dim");
    });
    if (this.source === "plugins") {
      const id = DISPLAY_BUTTONS[CLOSE_BUTTON];
      if (id) leds.setLight(id, this.pickerOpen ? "dim" : "off");
      const lit = this.pickerOpen ? paletteColor(1, "dim") : 0;
      for (const direction of ["up", "down", "left", "right"] as const) leds.setNav(direction, lit);
      return;
    }
    const usable = this.state(mc).kind === "presets";
    for (const display of [PREV_BUTTON, NEXT_BUTTON]) {
      const id = DISPLAY_BUTTONS[display];
      if (id) leds.setLight(id, usable ? "dim" : "off");
    }
    // LOAD: usable while the cursor is on a preset other than the loaded one
    const load = DISPLAY_BUTTONS[LOAD_BUTTON];
    const cursor = usable ? this.cursorIndex(mc) : null;
    if (load)
      leds.setLight(load, cursor !== null && cursor !== this.loadedIndex(mc) ? "dim" : "off");
    // 4D: tilt up/down move the cursor like the turn; left/right are unused
    const lit = usable ? paletteColor(1, "dim") : 0;
    leds.setNav("up", lit);
    leds.setNav("down", lit);
    leds.setNav("left", 0);
    leds.setNav("right", 0);
  }
}
