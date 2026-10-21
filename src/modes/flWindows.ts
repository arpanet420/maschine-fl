// The FL window each page brings up when its button opens it, so the computer screen follows the
// MK3 the way Maschine's software follows its controller: MIXER shows FL's mixer, ARRANGER the
// playlist, STEP and PAD MODE the channel rack, KEYBOARD and CHORDS the piano roll, BROWSER the
// selected channel's plugin window. Overlays (held, peeked) and CHANNEL / PLUG-IN (editor follow does
// that) bring up nothing. A window that already has the focus is left alone: SHOW_WINDOW and
// SHOW_EDITOR toggle in FL's script, so sending them again would hide it.

import { FOCUS_PLUGIN } from "../fl/protocol.js";
import type { ModeContext, PageName } from "./mode.js";

/** UI_STATE window numbers (`ui.showWindow`). */
const MIXER = 0;
const CHANNEL_RACK = 1;
const PLAYLIST = 2;
const PIANO_ROLL = 3;

/** The FL window a page brings up: a window number, or `editor` for the selected channel's plugin. */
export const PAGE_WINDOWS: Partial<Record<PageName, number | "editor">> = {
  mixer: MIXER,
  arranger: PLAYLIST,
  step: CHANNEL_RACK,
  padMode: CHANNEL_RACK,
  keyboard: PIANO_ROLL,
  chords: PIANO_ROLL,
  browser: "editor",
};

/** Bring up `page`'s FL window (the page was just opened by its button). */
export function bringUpWindow(page: PageName, mc: ModeContext): void {
  const window = PAGE_WINDOWS[page];
  if (window === undefined || !mc.fl.connected) return;
  const focused = mc.fl.uiState.focused;
  if (window === "editor") {
    const index = mc.fl.selectedChannel.index;
    if (index !== null && focused !== FOCUS_PLUGIN) mc.send({ type: "showEditor", index });
    return;
  }
  if (focused !== window) mc.send({ type: "showWindow", window });
}
