// DUPLICATE overlay (hold DUPLICATE; display button 1 is its pin tab). Pads 1–16 are the patterns of
// the current bank, like the PATTERN overlay; a pad press clones that pattern (CLONE_PATTERN).
// Display 7 and 8 (`<<` `>>`) page between the banks. SHIFT + DUPLICATE doubles the current pattern
// without a page, as in Maschine: the page stack does that.
import { PatternBankPage } from "./patternOverlay.js";
import type { ModeContext } from "./mode.js";

export class DuplicateOverlay extends PatternBankPage {
  readonly name = "duplicate";
  protected readonly pinLabel = "DUPLICATE";

  protected padPressed(number: number, mc: ModeContext): void {
    this.followNewPattern(mc);
    mc.send({ type: "clonePattern", number });
  }
}
