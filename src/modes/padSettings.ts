// mk3d's own pad settings (the SETTINGS page edits them, FIXED VEL toggles one of them). They are
// saved with the page stack's state file (`pages.settings`).
//
// - `config` is the PadConfig the pad processor (src/hw/pads.ts) reads: the hit value that gives
//   velocity 127 and the curve exponent. SETTINGS changes the very object the processor holds, so
//   a change counts from the next hit on.
// - Fixed velocity: while it is on, every note a pad plays (KEYBOARD, PAD MODE, NOTE REPEAT, all of
//   which go through PadState) uses the fixed value instead of the hit. SHIFT + FIXED VEL
//   (16 velocities) is not built.
import { DEFAULT_PAD_CONFIG, type PadConfig } from "../hw/pads.js";
import { PAD_PRESSURE_MAX } from "../hw/ids.js";

/** The range of the full-scale hit value (the MK3's hit values go to 4095). */
export const FULL_SCALE_MIN = 300;
export const FULL_SCALE_MAX = PAD_PRESSURE_MAX;
/** The range of the curve exponent. Below 1 makes soft hits louder. */
export const EXPONENT_MIN = 0.25;
export const EXPONENT_MAX = 2;
export const FIXED_VELOCITY_MIN = 1;
export const FIXED_VELOCITY_MAX = 127;
export const DEFAULT_FIXED_VELOCITY = 100;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Settings the command line gave: they win over the saved ones at start-up. */
export interface PadSettingLocks {
  fullScale?: boolean;
  exponent?: boolean;
}

export class PadSettings {
  /** What the pad processor reads (shared, changed in place). */
  readonly config: PadConfig;
  /** FIXED VEL is on. */
  fixedOn = false;
  private fixedExact = DEFAULT_FIXED_VELOCITY;

  constructor(
    config: PadConfig = { ...DEFAULT_PAD_CONFIG },
    private readonly locks: PadSettingLocks = {},
  ) {
    this.config = config;
  }

  get fullScale(): number {
    return this.config.fullScale;
  }

  set fullScale(value: number) {
    this.config.fullScale = clamp(value, FULL_SCALE_MIN, FULL_SCALE_MAX);
  }

  get exponent(): number {
    return this.config.exponent;
  }

  set exponent(value: number) {
    this.config.exponent = clamp(value, EXPONENT_MIN, EXPONENT_MAX);
  }

  /** The fixed velocity, a whole number 1–127. */
  get fixedVelocity(): number {
    return Math.round(this.fixedExact);
  }

  set fixedVelocity(value: number) {
    this.fixedExact = clamp(value, FIXED_VELOCITY_MIN, FIXED_VELOCITY_MAX);
  }

  /** Moves the fixed velocity by `steps` (fractions count: a slow turn adds up). */
  nudgeFixed(steps: number): void {
    this.fixedVelocity = this.fixedExact + steps;
  }

  /** The MIDI velocity a pad note gets: the fixed value while FIXED VEL is on, else the hit's. */
  apply(velocity: number): number {
    return this.fixedOn ? this.fixedVelocity : velocity;
  }

  /** The curve of the current settings: the 0–1 velocity of a hit value (as the pad processor). */
  curve(value: number): number {
    const { fullScale, exponent, minVelocity } = this.config;
    const normalized = clamp(value / Math.max(1, fullScale), 0, 1);
    return Math.max(minVelocity, normalized ** exponent);
  }

  readonly persisted = {
    save: () => ({
      fullScale: this.fullScale,
      exponent: this.exponent,
      fixedVelocity: this.fixedVelocity,
      fixedOn: this.fixedOn,
    }),
    load: (data: unknown) => {
      const saved = data as Record<string, unknown> | null;
      const fullScale = finite(saved?.fullScale);
      const exponent = finite(saved?.exponent);
      const fixed = finite(saved?.fixedVelocity);
      // A value the command line gave (--velocity-full, --velocity-curve) wins at start-up.
      if (fullScale !== undefined && !this.locks.fullScale) this.fullScale = fullScale;
      if (exponent !== undefined && !this.locks.exponent) this.exponent = exponent;
      if (fixed !== undefined) this.fixedVelocity = fixed;
      if (typeof saved?.fixedOn === "boolean") this.fixedOn = saved.fixedOn;
    },
  };
}
