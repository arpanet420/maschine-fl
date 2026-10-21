// Turns the MK3's own pad events into note on / off / aftertouch.
// The device detects hits itself and tags each pad entry with an event type (docs/protocol.md,
// "Input report 0x02"); this mirrors NI's NHL2::PadHandler.
import type { PadEvent } from "./events.js";
import { PAD_COUNT, PAD_PRESSURE_MAX } from "./ids.js";

export type PadEntryKind = "on" | "off" | "pressure";

/** High nibble of a pad entry's second byte. NI treats 0/1 as on, 2/3 as off, 4 as pressure. */
export function padEntryKind(nibble: number): PadEntryKind | undefined {
  if (nibble === 0 || nibble === 1) return "on";
  if (nibble === 2 || nibble === 3) return "off";
  if (nibble === 4) return "pressure";
  return undefined;
}

export interface PadConfig {
  /** ON value (0–4095) that gives full velocity. */
  fullScale: number;
  /** velocity = (value / fullScale) ^ exponent. Below 1 makes soft hits louder. */
  exponent: number;
  /** Lowest velocity a hit can have (0–1). */
  minVelocity: number;
}

// From the Checkpoint 1 recording: deliberate soft hits gave ON values 60–530, medium
// 1450–2140, hard 3110–3790.
export const DEFAULT_PAD_CONFIG: PadConfig = {
  fullScale: 3600,
  exponent: 0.6,
  minVelocity: 1 / 127,
};

export class PadProcessor {
  private readonly held: boolean[] = new Array<boolean>(PAD_COUNT).fill(false);
  private readonly lastPressure: number[] = new Array<number>(PAD_COUNT).fill(-1);

  constructor(readonly config: PadConfig = DEFAULT_PAD_CONFIG) {}

  velocityFor(value: number): number {
    const { fullScale, exponent, minVelocity } = this.config;
    const normalized = Math.min(1, Math.max(0, value / Math.max(1, fullScale)));
    return Math.max(minVelocity, normalized ** exponent);
  }

  process(pad: number, kind: PadEntryKind, value: number): PadEvent[] {
    if (pad < 0 || pad >= PAD_COUNT) return [];
    switch (kind) {
      case "on": {
        // An ON while already held means the device saw a new hit; close the old note first.
        const events = this.held[pad] ? [this.up(pad)] : [];
        this.held[pad] = true;
        this.lastPressure[pad] = value;
        events.push({
          type: "pad",
          pad,
          phase: "down",
          pressure: value / PAD_PRESSURE_MAX,
          velocity: this.velocityFor(value),
        });
        return events;
      }
      case "off":
        return this.held[pad] ? [this.up(pad)] : [];
      case "pressure":
        // Pressure also arrives just before an ON and after an OFF; only held pads have aftertouch.
        if (!this.held[pad] || value === this.lastPressure[pad]) return [];
        this.lastPressure[pad] = value;
        return [{ type: "pad", pad, phase: "move", pressure: value / PAD_PRESSURE_MAX }];
    }
  }

  private up(pad: number): PadEvent {
    this.held[pad] = false;
    this.lastPressure[pad] = -1;
    return { type: "pad", pad, phase: "up", pressure: 0 };
  }
}
