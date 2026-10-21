// Channel banks ("groups"): Maschine's groups A–H are banks of 16 channels here, bank A = channels
// 1–16, B = 17–32, and so on (docs/workflow.md). The current bank is the one that holds the selected
// channel. Pure helpers shared by the pad pages, the overlays, the page stack and main.ts.
import type { FlState } from "../fl/flState.js";
import type { ButtonId } from "../hw/ids.js";
import type { ColorLedId, LedState } from "../hw/leds.js";
import { LED_OFF, paletteWhite } from "../hw/palette.js";
import { WINDOW } from "./channelMode.js";

/** Channels per bank: one per pad. */
export const BANK_SIZE = WINDOW;

/** GROUP A–H in bank order. */
export const GROUP_BUTTONS: readonly ColorLedId[] = [
  "groupA",
  "groupB",
  "groupC",
  "groupD",
  "groupE",
  "groupF",
  "groupG",
  "groupH",
];

/** The bank (0-based) a GROUP button stands for, undefined for any other button. */
export const groupBank = (id: ButtonId): number | undefined => {
  const bank = GROUP_BUTTONS.findIndex((group) => group === id);
  return bank >= 0 ? bank : undefined;
};

export const bankOf = (channel: number): number => Math.floor(channel / BANK_SIZE);

/** First channel of a bank. */
export const bankFirst = (bank: number): number => bank * BANK_SIZE;

/** `A`, `B`, … `H`, then on to `I`. */
export const bankLetter = (bank: number): string => String.fromCharCode(65 + bank);

/** How many banks the channels fill (0 without channels). */
export const bankCount = (fl: FlState): number => Math.ceil(fl.channelTotal / BANK_SIZE);

/** The bank of the selected channel, bank A while nothing is selected. */
export function currentBank(fl: FlState): number {
  const selected = fl.selectedChannel.index;
  return selected === null ? 0 : bankOf(selected);
}

/** Channels of a bank that exist. */
export const bankLength = (fl: FlState, bank: number): number =>
  Math.max(0, Math.min(BANK_SIZE, fl.channelTotal - bankFirst(bank)));

/** `1–16 of 20`, or nothing while the bank is empty. */
export function bankText(fl: FlState, bank: number): string {
  const shown = bankLength(fl, bank);
  return shown > 0 ? `${bankFirst(bank) + 1}–${bankFirst(bank) + shown} of ${fl.channelTotal}` : "";
}

/**
 * GROUP A–H as bank buttons: the current bank bright white, the other banks that exist dim white,
 * the rest off. Only banks A–H have a button.
 */
export function setBankLeds(leds: LedState, fl: FlState): void {
  const current = fl.connected ? currentBank(fl) : -1;
  const count = fl.connected ? bankCount(fl) : 0;
  GROUP_BUTTONS.forEach((id, bank) => {
    leds.setButtonColor(
      id,
      bank >= count ? LED_OFF : paletteWhite(bank === current ? "bright" : "dim"),
    );
  });
}
