// The FL window each page brings up when its button opens it, so the computer screen follows the
// MK3 the way Maschine's software follows its controller: MIXER shows FL's mixer, ARRANGER the
// playlist, CHANNEL, STEP and PAD MODE the channel rack, KEYBOARD, CHORDS and SAMPLING (which has no
// page: it only does this) the piano roll, BROWSER the selected channel's plugin window. Overlays (held, peeked) and PLUG-IN
// bring up nothing. RAISE_WINDOW is always sent and FL's script looks at the focus itself: mk3d's copy of
// it is about 200 ms old, and a press must neither hide a window nor do nothing because of that (bug 11).
// SHOW_EDITOR toggles, so a plugin that has the focus is left alone.
//
// Pressing the button again closes the window: CHANNEL and SAMPLING, which stay where they are, toggle it
// (SHOW_WINDOW: one open behind another comes up instead), the others leave their page and close it.

import { FOCUS_PLUGIN } from "../fl/protocol.js";
import type { ModeContext, PageName } from "./mode.js";

/** UI_STATE window numbers (`ui.showWindow`). */
const MIXER = 0;
const CHANNEL_RACK = 1;
const PLAYLIST = 2;
const PIANO_ROLL = 3;

/** The FL window a page brings up: a window number, or `editor` for the selected channel's plugin. */
export const PAGE_WINDOWS: Partial<Record<PageName, number | "editor">> = {
  channel: CHANNEL_RACK,
  mixer: MIXER,
  arranger: PLAYLIST,
  step: CHANNEL_RACK,
  padMode: CHANNEL_RACK,
  keyboard: PIANO_ROLL,
  chords: PIANO_ROLL,
  sampling: PIANO_ROLL,
  browser: "editor",
};

/** Bring up `page`'s FL window (the page was just opened by its button). */
export function bringUpWindow(page: PageName, mc: ModeContext): void {
  const window = PAGE_WINDOWS[page];
  if (window === undefined || !mc.fl.connected) return;
  if (window === "editor") {
    const index = mc.fl.selectedChannel.index;
    if (index !== null && mc.fl.uiState.focused !== FOCUS_PLUGIN) {
      mc.send({ type: "showEditor", index });
    }
    return;
  }
  mc.send({ type: "raiseWindow", window });
}

/** The button of a page that stays was pressed again: its window closes, or comes up if it has no focus. */
export function toggleWindow(page: PageName, mc: ModeContext): void {
  const window = PAGE_WINDOWS[page];
  if (typeof window !== "number" || !mc.fl.connected) return;
  mc.send({ type: "showWindow", window });
}

/** The button of a page that goes was pressed again: its window closes. */
export function closeWindow(page: PageName, mc: ModeContext): void {
  const window = PAGE_WINDOWS[page];
  if (window === undefined || !mc.fl.connected) return;
  if (window === "editor") {
    const index = mc.fl.selectedChannel.index;
    if (index !== null && mc.fl.uiState.focused === FOCUS_PLUGIN) {
      mc.send({ type: "showEditor", index });
    }
    return;
  }
  mc.send({ type: "closeWindow", window });
}
