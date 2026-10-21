// NAVIGATE overlay (hold SHIFT + VARIATION; display button 1 is its pin tab). Maschine's view
// switcher, for FL's windows: display 2–6 show (or, when focused, hide) the Mixer, Channel rack,
// Playlist, Piano roll and Browser (SHOW_WINDOW 0–4), display 7 opens the selected channel's plug-in
// window (SHOW_EDITOR). The 4D encoder's tilt moves in FL (UI left/right/up/down) and its push is
// enter, so FL can be steered from the MK3 while NAVIGATE is up; turns go on to the page below.
//
// LEDs from UI_STATE: bright = that window has the focus, dim = it is shown, off = hidden; PLUGIN is
// bright while a plug-in window has the focus. Screens: tabs and a tile for each window under its
// own display button (left: Mixer, Rack, Playlist; right: Piano roll, Browser, Plug-in) with a small
// drawing of the window in FL's look (focused: orange outline, shown: bright, hidden: dark), and on
// the left, in the column of the pin tab, the title and which window is focused.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FlState } from "../fl/flState.js";
import { FOCUS_PLUGIN } from "../fl/protocol.js";
import type { Rect } from "../hw/display.js";
import type { HwEvent } from "../hw/events.js";
import type { LedState } from "../hw/leds.js";
import { TAB_HEIGHT, clear, columns, drawTabs, fitText, font, theme } from "../render/widgets.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL } from "./draw.js";
import type { Mode, ModeContext } from "./mode.js";

type WindowKind = "mixer" | "rack" | "playlist" | "piano" | "browser" | "plugin";
type WindowState = "focused" | "shown" | "hidden";

interface WindowDef {
  kind: WindowKind;
  /** The tab over its display button. */
  tab: string;
  /** What the screen calls it. */
  name: string;
  /** Display button (0-based) that shows it. */
  display: number;
}

/** In order of the display buttons 2–7. */
export const WINDOWS: readonly WindowDef[] = [
  { kind: "mixer", tab: "MIXER", name: "Mixer", display: 1 },
  { kind: "rack", tab: "RACK", name: "Channel rack", display: 2 },
  { kind: "playlist", tab: "PLAYLIST", name: "Playlist", display: 3 },
  { kind: "piano", tab: "PIANO", name: "Piano roll", display: 4 },
  { kind: "browser", tab: "BROWSER", name: "Browser", display: 5 },
  { kind: "plugin", tab: "PLUGIN", name: "Plug-in", display: 6 },
];

const PIN_LABEL = "NAVIGATE";
const TILE_TOP = TAB_HEIGHT + 10;
const TILE_HEIGHT = 118;

/** The tilt directions as FL's UI actions. */
const TILTS = { up: "up", down: "down", left: "left", right: "right" } as const;

/** How a window shows now. PLUGIN is `shown` unless it has the focus (FL can't say if it is open). */
export function windowState(def: WindowDef, mc: ModeContext): WindowState {
  const { visible, focused } = mc.fl.uiState;
  if (def.kind === "plugin") {
    if (focused === FOCUS_PLUGIN) return "focused";
    return mc.fl.selectedChannel.index === null ? "hidden" : "shown";
  }
  const index = WINDOWS.indexOf(def);
  if (focused === index) return "focused";
  return visible[index] ? "shown" : "hidden";
}

/** The window that has the focus, undefined if none of the six has. */
function focusedWindow(fl: FlState): WindowDef | undefined {
  const { focused } = fl.uiState;
  if (focused === FOCUS_PLUGIN) return WINDOWS[5];
  return focused < FOCUS_PLUGIN ? WINDOWS[focused] : undefined;
}

export class NavigateOverlay implements Mode {
  readonly name = "navigate";

  enter(): void {
    // Nothing to ask FL for: UI_STATE follows the windows by itself.
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type === "nav") {
      // Tilt and push steer FL; the turn is not ours (the page below, or the quick edit, takes it).
      if (event.action === "tilt") {
        if (event.pressed) mc.send({ type: "ui", action: TILTS[event.direction] });
        return true;
      }
      if (event.action === "push") {
        if (event.pressed) mc.send({ type: "ui", action: "enter" });
        return true;
      }
      return false;
    }
    if (event.type !== "button") return false;
    const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
    if (display < 0) return false;
    // Display buttons never reach the page underneath.
    if (!event.pressed) return true;
    const index = WINDOWS.findIndex((def) => def.display === display);
    const def = WINDOWS[index];
    if (!def) return true;
    if (def.kind === "plugin") {
      const channel = mc.fl.selectedChannel.index;
      if (channel !== null) mc.send({ type: "showEditor", index: channel });
    } else {
      mc.send({ type: "showWindow", window: index });
    }
    return true;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const screens = [left, right] as const;
    screens.forEach((ctx, screen) => {
      clear(ctx, FULL);
      // Left: the pin tab and the first three windows; right: the other three.
      const defs = WINDOWS.slice(screen * 3, screen * 3 + 3);
      const offset = screen === 0 ? 1 : 0; // columns; the pin tab takes the left screen's first
      const tabs: string[] = screen === 0 ? [PIN_LABEL] : [];
      const active: number[] = screen === 0 && mc.pinned ? [0] : [];
      defs.forEach((def, i) => {
        tabs.push(def.tab);
        if (windowState(def, mc) === "focused") active.push(offset + i);
      });
      drawTabs(ctx, { ...FULL, height: TAB_HEIGHT }, { tabs, active });
      const cells = columns({ ...FULL, y: TILE_TOP, height: TILE_HEIGHT + 56 }, 4);
      defs.forEach((def, i) => {
        const cell = cells[offset + i];
        if (cell) drawTile(ctx, cell, def, windowState(def, mc));
      });
    });
    this.drawTitle(left, mc);
    this.drawHelp(left, right);
  }

  /** In the pin tab's column on the left screen: the title and which window has the focus. */
  private drawTitle(ctx: SKRSContext2D, mc: ModeContext): void {
    const x = 12;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.text;
    ctx.font = font(22, "bold");
    ctx.fillText("Navigate", x, TILE_TOP);
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13);
    ctx.fillText("Focus", x, TILE_TOP + 44);
    const focused = focusedWindow(mc.fl);
    ctx.fillStyle = focused ? theme.accent : theme.dimText;
    ctx.font = font(18, "bold");
    ctx.fillText(fitText(ctx, focused?.name ?? "none", 104), x, TILE_TOP + 62);
  }

  /** The 4D encoder's job, and what the tiles mean. */
  private drawHelp(left: SKRSContext2D, right: SKRSContext2D): void {
    left.textAlign = "left";
    left.textBaseline = "top";
    left.fillStyle = theme.dimText;
    left.font = font(14);
    left.fillText("4D tilt: move in FL", 12, 214);
    left.fillText("4D push: enter", 12, 236);

    // Right screen, in the free column: what a tile's look means.
    const keys: Array<[string, WindowState]> = [
      ["focused", "focused"],
      ["shown", "shown"],
      ["hidden", "hidden"],
    ];
    keys.forEach(([label, state], i) => {
      const y = TILE_TOP + 4 + i * 34;
      const swatch = { x: 372, y, width: 26, height: 22 };
      drawTileBody(right, swatch, state, 3);
      right.textAlign = "left";
      right.textBaseline = "middle";
      right.fillStyle = theme.dimText;
      right.font = font(14);
      right.fillText(label, swatch.x + swatch.width + 8, y + swatch.height / 2);
    });
  }

  leds(leds: LedState, mc: ModeContext): void {
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display1", mc.pinned ? "bright" : "dim");
    for (const def of WINDOWS) {
      const id = DISPLAY_BUTTONS[def.display];
      if (!id) continue;
      // PLUGIN is dim wherever a channel's plug-in could open, bright while one has the focus.
      const state = windowState(def, mc);
      leds.setLight(id, state === "focused" ? "bright" : state === "shown" ? "dim" : "off");
    }
  }
}

// ── Tiles ────────────────────────────────────────────────────────────────────

function drawTile(ctx: SKRSContext2D, cell: Rect, def: WindowDef, state: WindowState): void {
  const tile = { x: cell.x + 5, y: cell.y, width: cell.width - 10, height: TILE_HEIGHT };
  drawTileBody(ctx, tile, state, 6);
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
      // five fader slots with caps at different heights
      const caps = [0.2, 0.45, 0.3, 0.6, 0.35];
      caps.forEach((fraction, i) => {
        const x = r.x + 6 + i * ((r.width - 12) / 4);
        ctx.fillRect(x - 1, r.y, 2, r.height);
        ctx.fillRect(x - 6, r.y + r.height * fraction, 12, 7);
      });
      break;
    }
    case "rack": {
      // channel rows of steps
      for (let row = 0; row < 4; row++) {
        for (let step = 0; step < 8; step++) {
          const on = (row * 3 + step * 5) % 4 === 0;
          ctx.globalAlpha = on ? 1 : 0.4;
          ctx.fillRect(
            r.x + step * (r.width / 8),
            r.y + row * (r.height / 4) + 4,
            r.width / 8 - 3,
            14,
          );
        }
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "playlist": {
      // tracks with clips
      const clips: Array<[number, number, number]> = [
        [0, 0, 0.5],
        [0.55, 0, 0.45],
        [0.2, 1, 0.6],
        [0, 2, 0.35],
        [0.5, 2, 0.5],
      ];
      for (const [start, row, length] of clips) {
        ctx.fillRect(
          r.x + start * r.width,
          r.y + 6 + row * (r.height / 3),
          length * r.width - 3,
          r.height / 3 - 10,
        );
      }
      break;
    }
    case "piano": {
      // keys down the left, notes to the right
      const keyHeight = r.height / 6;
      for (let key = 0; key < 6; key++) {
        ctx.globalAlpha = key % 2 === 0 ? 1 : 0.5;
        ctx.fillRect(r.x, r.y + key * keyHeight + 1, r.width * 0.22, keyHeight - 3);
      }
      ctx.globalAlpha = 1;
      const notes: Array<[number, number, number]> = [
        [0.3, 1, 0.2],
        [0.55, 3, 0.25],
        [0.35, 4, 0.3],
        [0.7, 2, 0.2],
      ];
      for (const [start, key, length] of notes) {
        ctx.fillRect(
          r.x + start * r.width,
          r.y + key * keyHeight + 3,
          length * r.width,
          keyHeight - 7,
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
