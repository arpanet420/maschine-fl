// LED state for the MK3 and a sender that writes only changed reports, at most ~60 times a second.
// Report layouts: docs/protocol.md, output reports 0x80 and 0x81.
import { panelPad } from "./ids.js";
import type { ButtonId, NavDirection } from "./ids.js";
import { LED_OFF } from "./palette.js";

export const REPORT_BUTTON_LEDS = 0x80;
export const REPORT_PAD_LEDS = 0x81;
const BUTTON_LEDS_LENGTH = 63;
const PAD_LEDS_LENGTH = 42;
export const STRIP_LED_COUNT = 25;
const STRIP_FIRST_BYTE = 1;
const PAD_FIRST_BYTE = 26;

/**
 * Button lights show three states, not a smooth range (Checkpoint 2, `ledtest ladder`):
 * 0–1 off, values like 8–24/32–128 dim, values with the low bits set (31, 63, 127, 255) bright.
 */
export type LightLevel = "off" | "dim" | "bright";
const LIGHT_VALUES: Record<LightLevel, number> = { off: 0, dim: 16, bright: 63 };

/** Single-color button LEDs: byte in report 0x80, value = light level (see LightLevel). */
export const MONO_LEDS = {
  channel: 1,
  plugIn: 2,
  arranger: 3,
  mixer: 4,
  browser: 5,
  arrowLeft: 7,
  arrowRight: 8,
  file: 9,
  settings: 10,
  auto: 11,
  macro: 12,
  display1: 13,
  display2: 14,
  display3: 15,
  display4: 16,
  display5: 17,
  display6: 18,
  display7: 19,
  display8: 20,
  volume: 21,
  swing: 22,
  noteRepeat: 23,
  tempo: 24,
  lock: 25,
  pitch: 26,
  mod: 27,
  perform: 28,
  notes: 29,
  restart: 38,
  erase: 39,
  tap: 40,
  follow: 41,
  play: 42,
  rec: 43,
  stop: 44,
  shift: 45,
  fixedVel: 46,
  padMode: 47,
  keyboard: 48,
  chords: 49,
  step: 50,
  scene: 51,
  pattern: 52,
  events: 53,
  variation: 54,
  duplicate: 55,
  select: 56,
  solo: 57,
  mute: 58,
} as const satisfies Partial<Record<ButtonId, number>>;

/** Palette-colored button LEDs: byte in report 0x80, value = palette index. */
export const COLOR_LEDS = {
  sampling: 6,
  groupA: 30,
  groupB: 31,
  groupC: 32,
  groupD: 33,
  groupE: 34,
  groupF: 35,
  groupG: 36,
  groupH: 37,
} as const satisfies Partial<Record<ButtonId, number>>;

export const NAV_LEDS: Record<NavDirection, number> = { up: 59, left: 60, right: 61, down: 62 };

export type MonoLedId = keyof typeof MONO_LEDS;
export type ColorLedId = keyof typeof COLOR_LEDS;

export const isMonoLed = (id: ButtonId): id is MonoLedId => id in MONO_LEDS;
export const isColorLed = (id: ButtonId): id is ColorLedId => id in COLOR_LEDS;

export class LedState {
  readonly buttonLeds = new Uint8Array(BUTTON_LEDS_LENGTH);
  readonly padLeds = new Uint8Array(PAD_LEDS_LENGTH);

  constructor() {
    this.buttonLeds[0] = REPORT_BUTTON_LEDS;
    this.padLeds[0] = REPORT_PAD_LEDS;
  }

  setLight(id: MonoLedId, level: LightLevel): void {
    this.buttonLeds[MONO_LEDS[id]] = LIGHT_VALUES[level];
  }

  setButtonColor(id: ColorLedId, paletteIndex: number): void {
    this.buttonLeds[COLOR_LEDS[id]] = paletteIndex;
  }

  setNav(direction: NavDirection, paletteIndex: number): void {
    this.buttonLeds[NAV_LEDS[direction]] = paletteIndex;
  }

  setPad(pad: number, paletteIndex: number): void {
    if (pad < 0 || pad > 15) throw new RangeError(`pad ${pad} out of range`);
    this.padLeds[PAD_FIRST_BYTE + panelPad(pad)] = paletteIndex;
  }

  /** segment 0–24, left to right */
  setStrip(segment: number, paletteIndex: number): void {
    if (segment < 0 || segment >= STRIP_LED_COUNT)
      throw new RangeError(`strip ${segment} out of range`);
    this.padLeds[STRIP_FIRST_BYTE + segment] = paletteIndex;
  }

  /** Direct byte access, for diagnostics that map unknown addresses. */
  setRaw(
    report: typeof REPORT_BUTTON_LEDS | typeof REPORT_PAD_LEDS,
    byte: number,
    value: number,
  ): void {
    const target = report === REPORT_BUTTON_LEDS ? this.buttonLeds : this.padLeds;
    if (byte < 1 || byte >= target.length) throw new RangeError(`byte ${byte} out of range`);
    target[byte] = value;
  }

  clear(): void {
    this.buttonLeds.fill(LED_OFF, 1);
    this.padLeds.fill(LED_OFF, 1);
  }

  reports(): Uint8Array[] {
    return [this.buttonLeds, this.padLeds];
  }
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

/** Writes changed LED reports, at most once per `minIntervalMs`. Call update() after changing state. */
export class LedSender {
  private readonly lastSent = new Map<number, Uint8Array>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private lastFlushAt = -Infinity;

  constructor(
    private readonly state: LedState,
    private readonly write: (report: Uint8Array) => Promise<void>,
    private readonly minIntervalMs = 16,
    private readonly now: () => number = Date.now,
  ) {}

  update(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastFlushAt + this.minIntervalMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
  }

  /** Forget what the device shows (e.g. after reconnecting) and send everything again. */
  resendAll(): void {
    this.lastSent.clear();
    this.update();
  }

  /** Send pending changes now. Resolves when the writes are done. */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      return this.flush();
    }
    this.flushing = this.sendChanged().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async sendChanged(): Promise<void> {
    this.lastFlushAt = this.now();
    for (const report of this.state.reports()) {
      const id = report[0] ?? 0;
      if (sameBytes(this.lastSent.get(id), report)) continue;
      const copy = Uint8Array.from(report);
      try {
        await this.write(copy);
        this.lastSent.set(id, copy);
      } catch {
        // Not connected; resendAll() runs on reconnect.
      }
    }
  }
}
