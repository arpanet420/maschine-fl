// SHIFT + pad: Maschine's 16-action row (docs/workflow.md). While SHIFT is held the pads don't play:
// each is an action, and the pad LEDs show the row (available actions dim white, the one pressed
// bright white, the rest off). The page stack runs this for every page except those that use SHIFT +
// pad themselves (`Mode.usesShiftPads`, GRID today).
//
// Pad numbers are Maschine's (1 = bottom-left):
//   1 undo        2 redo        3 step undo*   4 step redo*
//   5 quantize    6 quant. starts  7 nudge ◀*  8 nudge ▶*
//   9 clear       10 clear automation*  11 copy  12 paste
//   13 semitone − 14 semitone +  15 octave −   16 octave +
// (* no FL equivalent: the LED stays off and nothing happens.) Clear empties the selected channel's
// steps in the current pattern; copy and paste work on a step clipboard in the FL script (the
// selected channel's steps of the current pattern); the last four transpose the selected channel's
// recorded notes in the current pattern (TRANSPOSE), in every pad mode; the KEYBOARD base note has
// its own controls (display buttons 5–8). Each action runs once, on the pad's down (the stack ignores its move and up),
// and reports what it did: the stack shows that on the left screen and writes it to the log.
import type { ActionFlash } from "./quickEdit.js";
import type { ModeContext } from "./mode.js";

export type ShiftAction =
  | "undo"
  | "redo"
  | "quantize"
  | "quantizeStarts"
  | "clear"
  | "copy"
  | "paste"
  | "semitoneDown"
  | "semitoneUp"
  | "octaveDown"
  | "octaveUp";

/** Index = pad (0-based, pad 1 bottom-left). */
const ROW: ReadonlyArray<ShiftAction | undefined> = [
  "undo",
  "redo",
  undefined,
  undefined,
  "quantize",
  "quantizeStarts",
  undefined,
  undefined,
  "clear",
  undefined,
  "copy",
  "paste",
  "semitoneDown",
  "semitoneUp",
  "octaveDown",
  "octaveUp",
];

/** Semitones the transpose actions move the recorded notes by. */
const TRANSPOSE: Partial<Record<ShiftAction, number>> = {
  semitoneDown: -1,
  semitoneUp: 1,
  octaveDown: -12,
  octaveUp: 12,
};

/** The action of a pad, undefined for the pads FL has no equivalent for. */
export const shiftActionOf = (pad: number): ShiftAction | undefined => ROW[pad];

/** Can the action do something now? (Its LED is lit only then.) */
export function shiftActionAvailable(action: ShiftAction | undefined, mc: ModeContext): boolean {
  if (!action || !mc.fl.connected) return false;
  if (action === "undo" || action === "redo" || action === "copy" || action === "paste") {
    return true;
  }
  return mc.fl.selectedChannel.index !== null; // quantize and clear act on the selected channel
}

/** What a SHIFT + pad action did: the card to show and the line for the daemon log. */
export interface ShiftReport {
  flash: ActionFlash;
  log: string;
}

const TITLE: Record<ShiftAction, string> = {
  undo: "UNDO",
  redo: "REDO",
  quantize: "QUANTIZE",
  quantizeStarts: "QUANT. STARTS",
  clear: "CLEAR",
  copy: "COPY",
  paste: "PASTE",
  semitoneDown: "TRANSPOSE",
  semitoneUp: "TRANSPOSE",
  octaveDown: "TRANSPOSE",
  octaveUp: "TRANSPOSE",
};

/** What the action in FL is called in the log (`→ FL undo`). */
const LOG_NAME: Partial<Record<ShiftAction, string>> = {
  undo: "undo",
  redo: "redo",
  quantize: "quantize",
  quantizeStarts: "quantize starts",
  clear: "clear steps",
  copy: "copy steps",
  paste: "paste steps",
};

/** Does what the pad's action says (nothing if it isn't available). Returns what it did. */
export function runShiftAction(pad: number, mc: ModeContext): ShiftReport | undefined {
  const action = shiftActionOf(pad);
  if (!action || !shiftActionAvailable(action, mc)) return undefined;
  const title = TITLE[action];
  const channel = mc.fl.selectedChannel.index;
  const name = mc.fl.selectedChannel.name || (channel === null ? "" : `Channel ${channel + 1}`);
  const semitones = TRANSPOSE[action];
  if (semitones !== undefined) {
    if (channel === null) return undefined;
    mc.send({ type: "transpose", channel, semitones });
    const amount = `${semitones > 0 ? "+" : "\u2212"}${Math.abs(semitones)} st`;
    return {
      flash: { title, detail: amount, source: name },
      log: `→ FL transpose ${semitones > 0 ? "+" : ""}${semitones} (${name})`,
    };
  }
  switch (action) {
    case "undo":
    case "redo":
      mc.send({ type: "ui", action });
      return { flash: { title, detail: "", undo: true }, log: `→ FL ${LOG_NAME[action]}` };
    case "quantize":
    case "quantizeStarts":
      mc.send({ type: "ui", action });
      return { flash: { title, detail: name }, log: `→ FL ${LOG_NAME[action]} (${name})` };
    case "copy": {
      mc.send({ type: "ui", action });
      const steps = mc.fl.pattern.length;
      const detail = steps > 0 ? `${steps} steps of ${name}` : name;
      return { flash: { title, detail }, log: `→ FL ${LOG_NAME[action]} (${detail})` };
    }
    case "paste":
      mc.send({ type: "ui", action });
      return { flash: { title, detail: name }, log: `→ FL ${LOG_NAME[action]} (${name})` };
    case "clear":
      if (channel === null) return undefined;
      mc.send({ type: "clearSteps", channel });
      return { flash: { title, detail: name }, log: `→ FL ${LOG_NAME[action]} (${name})` };
    default:
      return undefined;
  }
}
