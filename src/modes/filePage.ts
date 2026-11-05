// FILE (a tool page, latched: FILE opens it, FILE again leaves it; SHIFT + FILE saves the project
// without a page, in the page stack). Display button 1 is the page's tab `FILE`, 2 `SAVE`
// (FPT_Save), 3 `NEW VER` (FPT_SaveNew, UI action `saveNew`), 5 `UNDO` and 6 `REDO` (FL's undo
// history, the same actions as SHIFT + pad 1 and 2). Each press shows the read-out card the SHIFT +
// pad actions show.
//
// Right screen, under UNDO and REDO: FL's undo state (position / count, FL's hint).
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import type { LedState } from "../hw/leds.js";
import { TAB_HEIGHT, clear, drawTabs, font, theme } from "../render/widgets.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";
import { FULL, drawWrapped } from "./draw.js";
import type { Mode, ModeContext } from "./mode.js";
import type { ActionFlash } from "./quickEdit.js";

type FileAction = "save" | "saveNew" | "undo" | "redo";

/** The display button (0–7) each action sits on. */
const BUTTON: Record<FileAction, number> = { save: 1, saveNew: 2, undo: 4, redo: 5 };

const TITLE: Record<FileAction, string> = {
  save: "SAVED",
  saveNew: "NEW VERSION",
  undo: "UNDO",
  redo: "REDO",
};

/** What the action in FL is called in the log (`→ FL save project`). */
const LOG: Record<FileAction, string> = {
  save: "save project",
  saveNew: "save new version",
  undo: "undo",
  redo: "redo",
};

const TABS = { ...FULL, height: TAB_HEIGHT };

export class FilePage implements Mode {
  readonly name = "file";

  enter(): void {
    // The undo state is always reported (UNDO_STATE); nothing to ask FL for.
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    if (event.type !== "button") return false;
    const display = DISPLAY_BUTTONS.findIndex((id) => id === event.id);
    if (display < 0) return false;
    const action = (Object.keys(BUTTON) as FileAction[]).find((a) => BUTTON[a] === display);
    if (action && event.pressed) this.run(action, mc);
    return true; // display buttons never reach the page underneath
  }

  private run(action: FileAction, mc: ModeContext): void {
    mc.send({ type: "ui", action });
    const flash: ActionFlash = { title: TITLE[action], detail: "", source: "FILE" };
    if (action === "undo" || action === "redo") flash.undo = true;
    mc.reportAction?.(flash, `→ FL ${LOG[action]}`);
    mc.requestRender();
  }

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const undo = mc.fl.undoState;

    clear(left, FULL);
    drawTabs(left, TABS, { tabs: ["FILE", "SAVE", "NEW VER"], active: [0] });

    clear(right, FULL);
    drawTabs(right, TABS, { tabs: ["UNDO", "REDO"] });
    right.textAlign = "left";
    right.textBaseline = "top";
    right.fillStyle = theme.accent;
    right.font = font(46, "bold");
    right.fillText(undo.count > 0 ? `${undo.position} / ${undo.count}` : "–", 22, TAB_HEIGHT + 24);
    if (!undo.hint) return;
    right.fillStyle = theme.text;
    right.font = font(26, "bold");
    drawWrapped(right, undo.hint, 24, TAB_HEIGHT + 92, FULL.width - 48, 34, 3);
  }

  leds(leds: LedState): void {
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display1", "bright"); // a tool page is always latched
    for (const action of Object.keys(BUTTON) as FileAction[]) {
      const id = DISPLAY_BUTTONS[BUTTON[action]];
      if (id) leds.setLight(id, "dim");
    }
  }
}
