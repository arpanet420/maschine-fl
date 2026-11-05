// NAVIGATE (hold VARIATION; display button 1 is its pin tab). Maschine's
// view switcher, for FL's windows, in the order of FL's toolbar: display 2–5 toggle the Playlist, Piano
// roll, Channel rack and Mixer, display 6 the Browser (a focused window is hidden, any other is shown and
// focused; SHOW_WINDOW), display 7 opens the selected channel's plug-in window (SHOW_EDITOR), display 8
// closes all of FL's windows (CLOSE_ALL_WINDOWS). The 4D
// encoder works this page: turning it or tilting it left and right moves a cursor between the tiles, its
// push does what the tile's display button does.
//
// LEDs from UI_STATE: bright = that window has the focus, dim = it is shown, off = hidden; PLUGIN is
// bright while a plug-in window has the focus. Screens: tabs and a tile for each window under its
// own display button (left: Playlist, Piano roll, Rack; right: Mixer, Browser, Plug-in, Close all) with an icon in
// the manner of FL's toolbar (focused: orange outline, shown: bright, hidden: dark, the cursor: a white
// ring), and on the left, in the first column, which window is focused.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlState } from "../fl/flState.js";
import { FOCUS_PLUGIN } from "../fl/protocol.js";
import type { Rect } from "../hw/display.js";
import type { HwEvent } from "../hw/events.js";
import type { LedState } from "../hw/leds.js";
import { TAB_HEIGHT, clear, columns, drawTabs, fitText, font, theme } from "../render/widgets.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { LED_OFF } from "../hw/palette.js";
import { FULL, NAV_LIT } from "./draw.js";
import type { Mode, ModeContext } from "./mode.js";

type WindowKind = "mixer" | "rack" | "playlist" | "piano" | "browser" | "plugin" | "closeAll";
type WindowState = "focused" | "shown" | "hidden";

interface WindowDef {
  kind: WindowKind;
  /** The tab over its display button. */
  tab: string;
  /** What the screen calls it. */
  name: string;
  /** Display button (0-based) that shows it. */
  display: number;
  /** FL's number for it (`ui.showWindow`, UI_STATE); the plug-in window has none. */
  window?: number;
}

/** In order of the display buttons 2–8: FL's toolbar, left to right, then Close all. */
export const WINDOWS: readonly WindowDef[] = [
  { kind: "playlist", tab: "PLAYLIST", name: "Playlist", display: 1, window: 2 },
  { kind: "piano", tab: "PIANO", name: "Piano roll", display: 2, window: 3 },
  { kind: "rack", tab: "RACK", name: "Channel rack", display: 3, window: 1 },
  { kind: "mixer", tab: "MIXER", name: "Mixer", display: 4, window: 0 },
  { kind: "browser", tab: "BROWSER", name: "Browser", display: 5, window: 4 },
  { kind: "plugin", tab: "PLUGIN", name: "Plug-in", display: 6 },
  { kind: "closeAll", tab: "CLOSE ALL", name: "Close all", display: 7 },
];

const TITLE_TAB = "NAVIGATE";
const TILE_TOP = TAB_HEIGHT + 36;
const TILE_HEIGHT = 118;

/** How a window shows now. PLUGIN is `shown` unless it has the focus (FL can't say if it is open). Close all is no window. */
export function windowState(def: WindowDef, mc: ModeContext): WindowState {
  const { visible, focused } = mc.fl.uiState;
  if (def.kind === "closeAll") return "shown";
  if (def.window === undefined) {
    if (focused === FOCUS_PLUGIN) return "focused";
    return mc.fl.selectedChannel.index === null ? "hidden" : "shown";
  }
  if (focused === def.window) return "focused";
  return visible[def.window] ? "shown" : "hidden";
}

/** The window that has the focus, undefined if none of the six has. */
function focusedWindow(fl: FlState): WindowDef | undefined {
  const { focused } = fl.uiState;
  if (focused === FOCUS_PLUGIN) return WINDOWS.find((def) => def.kind === "plugin");
  return WINDOWS.find((def) => def.window === focused);
}

export class NavigateOverlay implements Mode {
  readonly name = "navigate";

  /** The tile the 4D encoder is on. */
  private cursor = 0;

  enter(mc: ModeContext): void {
    // UI_STATE follows the windows by itself; the cursor starts on the focused window.
    const focused = focusedWindow(mc.fl);
    if (focused) this.cursor = WINDOWS.indexOf(focused);
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type === "nav") {
      if (event.action === "turn") this.moveCursor(event.delta);
      else if (event.action === "tilt") {
        if (event.pressed && event.direction === "left") this.moveCursor(-1);
        if (event.pressed && event.direction === "right") this.moveCursor(1);
      } else if (event.action === "push") {
        if (event.pressed) this.toggle(WINDOWS[this.cursor], mc);
      } else return false;
      return true;
    }
    if (event.type !== "button") return false;
    const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
    if (display < 0) return false;
    // Display buttons never reach the page underneath.
    if (!event.pressed) return true;
    const index = WINDOWS.findIndex((def) => def.display === display);
    if (index >= 0) {
      this.cursor = index;
      this.toggle(WINDOWS[index], mc);
    }
    return true;
  }

  private moveCursor(steps: number): void {
    this.cursor = Math.min(WINDOWS.length - 1, Math.max(0, this.cursor + steps));
  }

  private toggle(def: WindowDef | undefined, mc: ModeContext): void {
    if (!def) return;
    if (def.kind === "closeAll") {
      mc.send({ type: "closeAllWindows" });
    } else if (def.window === undefined) {
      const channel = mc.fl.selectedChannel.index;
      if (channel !== null) mc.send({ type: "showEditor", index: channel });
    } else {
      mc.send({ type: "showWindow", window: def.window });
    }
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const screens = [left, right] as const;
    screens.forEach((ctx, screen) => {
      clear(ctx, FULL);
      // Left: the title and the first three windows; right: the other three and Close all.
      const defs = screen === 0 ? WINDOWS.slice(0, 3) : WINDOWS.slice(3);
      const offset = screen === 0 ? 1 : 0; // columns; the title takes the left screen's first
      const tabs: string[] = screen === 0 ? [TITLE_TAB] : [];
      const active: number[] = screen === 0 && mc.pinned ? [0] : [];
      defs.forEach((def, i) => {
        tabs.push(def.tab);
        if (windowState(def, mc) === "focused") active.push(offset + i);
      });
      drawTabs(ctx, { ...FULL, height: TAB_HEIGHT }, { tabs, active });
      const cells = columns({ ...FULL, y: TILE_TOP, height: TILE_HEIGHT + 56 }, 4);
      defs.forEach((def, i) => {
        const cell = cells[offset + i];
        if (cell) {
          drawTile(ctx, cell, def, windowState(def, mc), WINDOWS.indexOf(def) === this.cursor);
        }
      });
    });
  }

  leds(leds: LedState, mc: ModeContext): void {
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    for (const def of WINDOWS) {
      const id = DISPLAY_BUTTONS[def.display];
      if (!id) continue;
      // PLUGIN is dim wherever a channel's plug-in could open, bright while one has the focus.
      const state = windowState(def, mc);
      leds.setLight(id, state === "focused" ? "bright" : state === "shown" ? "dim" : "off");
    }
    leds.setNav("left", this.cursor > 0 ? NAV_LIT : LED_OFF);
    leds.setNav("right", this.cursor < WINDOWS.length - 1 ? NAV_LIT : LED_OFF);
  }
}

// ── Tiles ────────────────────────────────────────────────────────────────────

function drawTile(
  ctx: SKRSContext2D,
  cell: Rect,
  def: WindowDef,
  state: WindowState,
  cursor: boolean,
): void {
  const tile = { x: cell.x + 5, y: cell.y, width: cell.width - 10, height: TILE_HEIGHT };
  drawTileBody(ctx, tile, state, 6);
  if (cursor) {
    ctx.strokeStyle = theme.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(tile.x - 3, tile.y - 3, tile.width + 6, tile.height + 6, 9);
    ctx.stroke();
  }
  const inner = {
    x: tile.x + 12,
    y: tile.y + 12,
    width: tile.width - 24,
    height: tile.height - 24,
  };
  ctx.globalAlpha = state === "hidden" ? 0.35 : 1;
  drawGlyph(ctx, def.kind, inner, state === "focused" ? theme.text : theme.dimText);
  ctx.globalAlpha = 1;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = font(15, state === "focused" ? "bold" : "normal");
  ctx.fillStyle = state === "hidden" ? theme.dimText : theme.text;
  const x = cell.x + cell.width / 2;
  ctx.fillText(fitText(ctx, def.name, cell.width - 8), x, tile.y + TILE_HEIGHT + 8);
  if (def.kind === "closeAll") return;
  ctx.font = font(13);
  ctx.fillStyle = state === "focused" ? theme.accent : theme.dimText;
  ctx.fillText(state === "shown" ? "shown" : state, x, tile.y + TILE_HEIGHT + 28);
}

/** Focused: raised, outlined in orange; shown: raised; hidden: sunk into the screen. */
function drawTileBody(ctx: SKRSContext2D, rect: Rect, state: WindowState, radius: number): void {
  ctx.fillStyle = state === "hidden" ? theme.background : theme.panelRaised;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  ctx.fill();
  if (state === "focused") {
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(rect.x + 1.5, rect.y + 1.5, rect.width - 3, rect.height - 3, radius);
    ctx.stroke();
  }
}

/** A few strokes that say what the window looks like in FL. */
function drawGlyph(ctx: SKRSContext2D, kind: WindowKind, r: Rect, color: string): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  switch (kind) {
    case "mixer": {
      // two faders with their caps at different heights
      [
        [0.3, 0.2],
        [0.7, 0.55],
      ].forEach(([place = 0, cap = 0]) => {
        const x = r.x + r.width * place;
        ctx.fillRect(x - 1.5, r.y, 3, r.height);
        const y = r.y + (r.height - 22) * cap;
        ctx.fillStyle = theme.panelRaised;
        ctx.fillRect(x - 11, y, 22, 22);
        ctx.fillStyle = color;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x - 11, y, 22, 22);
        ctx.fillRect(x - 11, y + 10, 22, 2.5);
      });
      break;
    }
    case "rack": {
      // three channels: a small box and a wide one
      ctx.lineWidth = 2.5;
      for (let row = 0; row < 3; row++) {
        const height = r.height / 3 - 6;
        const y = r.y + 3 + row * (r.height / 3);
        ctx.strokeRect(r.x + r.width * 0.12, y, r.width * 0.2, height);
        ctx.strokeRect(r.x + r.width * 0.38, y, r.width * 0.5, height);
      }
      break;
    }
    case "playlist": {
      // a window with a notch in its title bar, and clips going down in steps
      ctx.lineWidth = 2.5;
      ctx.strokeRect(r.x, r.y + 8, r.width, r.height - 8);
      ctx.fillRect(r.x, r.y + 8, r.width, 6);
      ctx.beginPath();
      ctx.moveTo(r.x + r.width * 0.5 - 9, r.y);
      ctx.lineTo(r.x + r.width * 0.5 + 9, r.y);
      ctx.lineTo(r.x + r.width * 0.5, r.y + 9);
      ctx.fill();
      for (let clip = 0; clip < 3; clip++) {
        ctx.fillRect(
          r.x + 8 + clip * (r.width * 0.28),
          r.y + 22 + clip * ((r.height - 36) / 2),
          r.width * 0.26,
          8,
        );
      }
      break;
    }
    case "piano": {
      // a column of keys, and notes going down in steps
      const keys = r.width * 0.34;
      ctx.fillRect(r.x, r.y, keys, r.height);
      ctx.fillStyle = theme.panelRaised;
      for (let key = 0; key < 3; key++) {
        ctx.fillRect(r.x + keys * 0.5, r.y + 5 + key * (r.height / 3), keys * 0.5, r.height / 6);
      }
      ctx.fillStyle = color;
      for (let note = 0; note < 3; note++) {
        ctx.fillRect(
          r.x + keys + 8 + note * (r.width * 0.2),
          r.y + 8 + note * ((r.height - 24) / 2),
          r.width * 0.18,
          10,
        );
      }
      break;
    }
    case "browser": {
      // a tree: folders and files
      for (let line = 0; line < 5; line++) {
        const indent = line % 3 === 0 ? 0 : 14;
        ctx.fillRect(r.x + indent, r.y + 6 + line * (r.height / 5), 8, 8);
        ctx.globalAlpha = 0.6;
        ctx.fillRect(r.x + indent + 14, r.y + 8 + line * (r.height / 5), r.width * 0.5 - indent, 4);
        ctx.globalAlpha = 1;
      }
      break;
    }
    case "closeAll": {
      // a window, crossed out
      ctx.lineWidth = 2.5;
      ctx.strokeRect(r.x, r.y + 8, r.width, r.height - 8);
      ctx.fillRect(r.x, r.y + 8, r.width, 6);
      const cx = r.x + r.width / 2;
      const cy = r.y + 14 + (r.height - 14) / 2;
      const arm = Math.min(r.width, r.height - 14) * 0.26;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx - arm, cy - arm);
      ctx.lineTo(cx + arm, cy + arm);
      ctx.moveTo(cx + arm, cy - arm);
      ctx.lineTo(cx - arm, cy + arm);
      ctx.stroke();
      ctx.lineCap = "butt";
      break;
    }
    case "plugin": {
      // a big knob and two small ones
      const knob = (cx: number, cy: number, radius: number) => {
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, Math.PI * 0.75, Math.PI * 2.25);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + radius * 0.6, cy - radius * 0.6);
        ctx.stroke();
      };
      knob(r.x + r.width * 0.5, r.y + r.height * 0.4, r.height * 0.3);
      knob(r.x + r.width * 0.2, r.y + r.height * 0.85, r.height * 0.12);
      knob(r.x + r.width * 0.8, r.y + r.height * 0.85, r.height * 0.12);
      break;
    }
  }
}
