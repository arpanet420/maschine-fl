// CHORDS page (a tool page in the pad-mode radio group: CHORDS opens it and sets the pad mode,
// CHORDS again leaves it; SHIFT + CHORDS sets the mode without the page). The pads play chords on
// the selected channel through the global pad handler (PadState, mode `chords`: this page takes no
// pad and leaves the pad LEDs to it). It is the KEYBOARD page with four knobs under the left
// screen (scale, chord mode, chord type, position) and the chord name on every pad of the grid.
// Display buttons 5–8 (OCT- OCT+ SEMI- SEMI+) move the root as on KEYBOARD. The scale and chord
// settings are shared with KEYBOARD (PadState.harmony) and saved with the page state as
// `pages.chords`. USER CHD, PADS ON and strumming are not built.
import type { SKRSContext2D } from "@napi-rs/canvas";
import { TAB_HEIGHT, fitText, font, theme } from "../render/widgets.js";
import {
  CHORD_MODE_NAMES,
  CHORD_TYPES,
  CHROMATIC,
  SCALES,
  chordSetScale,
  pitchName,
} from "./chords.js";
import { FULL } from "./draw.js";
import { KeyboardPage, type KeyboardOptions } from "./keyboardPage.js";
import type { ModeContext } from "./mode.js";
import { noteName, type PadState } from "./padState.js";

export class ChordsPage extends KeyboardPage {
  override readonly name = "chords";
  protected override readonly tab = "CHORDS";

  constructor(pads: PadState, options: KeyboardOptions = {}) {
    super(pads, options, 4);
  }

  /** The settings the stack saves with the page state. */
  readonly persisted = this.pads.harmony.persisted;

  /** `C Minor`; in chord set the scale it actually uses (Major for a pentatonic, Blues, Chromatic). */
  protected override scaleText(): string {
    const { harmony } = this.pads;
    const root = pitchName(this.pads.baseNote);
    if (harmony.mode === "set") return `${root} ${chordSetScale(harmony.scale).name}`;
    return harmony.scale === CHROMATIC
      ? `${root} ${SCALES[CHROMATIC]?.name ?? ""}`
      : `${root} ${SCALES[harmony.scale]?.name ?? ""}`;
  }

  protected override cellName(pad: number): string {
    return this.pads.chordAt(pad).name;
  }

  protected override footer(): string {
    return `root ${noteName(this.pads.baseNote)}  MIDI ${this.pads.baseNote}`;
  }

  protected override renderLeft(ctx: SKRSContext2D, mc: ModeContext, color: string): void {
    const selected = mc.fl.selectedChannel;
    const { harmony } = this.pads;
    const top = TAB_HEIGHT + 8;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    if (selected.index !== null) {
      ctx.fillStyle = color;
      ctx.fillRect(14, top, 6, 44);
      ctx.fillStyle = theme.dimText;
      ctx.font = font(13);
      ctx.fillText(`Channel ${selected.index + 1}`, 34, top - 2);
      ctx.fillStyle = theme.text;
      ctx.font = font(22, "bold");
      ctx.fillText(fitText(ctx, selected.name, FULL.width - 50), 34, top + 14);
    } else {
      ctx.fillStyle = theme.dimText;
      ctx.font = font(20);
      ctx.fillText("No channel", 34, top);
    }
    const y = top + 56;
    ctx.fillStyle = theme.dimText;
    ctx.font = font(13);
    ctx.fillText("Scale", 34, y);
    ctx.fillStyle = theme.accent;
    ctx.font = font(34, "bold");
    ctx.fillText(fitText(ctx, this.scaleText(), FULL.width - 50), 32, y + 12);
    ctx.fillStyle = theme.dimText;
    ctx.font = font(15);
    const type =
      harmony.mode === "set" ? "triads and sevenths" : (CHORD_TYPES[harmony.type]?.name ?? "");
    const position = harmony.position > 0 ? `, position ${harmony.position}` : "";
    ctx.fillText(
      fitText(ctx, `${CHORD_MODE_NAMES[harmony.mode]}: ${type}${position}`, FULL.width - 50),
      34,
      y + 52,
    );
  }
}
