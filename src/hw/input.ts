// Turns raw MK3 HID input reports into typed events. Pure: no device access.
import type { HwEvent } from "./events.js";
import {
  CONTROL_BITS,
  KNOB_COUNT,
  KNOB_FIRST_BYTE,
  KNOB_RANGE,
  NAV_WHEEL_BYTE,
  PAD_COUNT,
  panelPad,
  REPORT_CONTROLS,
  REPORT_PADS,
  STRIP_MAX,
  STRIP_POSITION_BYTE,
} from "./ids.js";
import { PadProcessor, padEntryKind, type PadConfig } from "./pads.js";

const PAD_ENTRY_COUNT = 21;
const NAV_WHEEL_RANGE = 16;

/** Shortest signed distance from `from` to `to` on a counter that wraps at `range`. */
export function wrappedDelta(from: number, to: number, range: number): number {
  const half = range / 2;
  return ((((to - from + half) % range) + range) % range) - half;
}

const u16le = (data: Uint8Array, offset: number) =>
  (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);

export class InputParser {
  private previous: Uint8Array | undefined;
  readonly pads: PadProcessor;

  constructor(padConfig?: PadConfig) {
    this.pads = new PadProcessor(padConfig);
  }

  parse(report: Uint8Array): HwEvent[] {
    switch (report[0]) {
      case REPORT_CONTROLS:
        return this.parseControls(report);
      case REPORT_PADS:
        return this.parsePads(report);
      default:
        return []; // 0x20, 0x40: never sent, and NI's agent ignores them too (docs/protocol.md)
    }
  }

  private parseControls(report: Uint8Array): HwEvent[] {
    const prev = this.previous;
    this.previous = Uint8Array.from(report);
    const events: HwEvent[] = [];

    // Buttons diff against all-released on the first report, so held buttons and plugged jacks show up.
    for (const [byte, mask, target] of CONTROL_BITS) {
      const now = ((report[byte] ?? 0) & mask) !== 0;
      const before = ((prev?.[byte] ?? 0) & mask) !== 0;
      if (now === before) continue;
      switch (target.kind) {
        case "button":
          events.push({ type: "button", id: target.id, pressed: now });
          break;
        case "navPush":
          events.push({ type: "nav", action: "push", pressed: now });
          break;
        case "navTouch":
          events.push({ type: "nav", action: "touch", touched: now });
          break;
        case "navTilt":
          events.push({ type: "nav", action: "tilt", direction: target.direction, pressed: now });
          break;
        case "knobTouch":
          events.push({ type: "encoderTouch", index: target.index, touched: now });
          break;
        case "jack":
          events.push({ type: "jack", jack: target.jack, connected: now });
          break;
      }
    }

    // Counters and positions only become relative once there is a baseline.
    if (prev === undefined) return events;

    const wheelDelta = wrappedDelta(
      (prev[NAV_WHEEL_BYTE] ?? 0) & 0x0f,
      (report[NAV_WHEEL_BYTE] ?? 0) & 0x0f,
      NAV_WHEEL_RANGE,
    );
    if (wheelDelta !== 0) events.push({ type: "nav", action: "turn", delta: wheelDelta });

    for (let index = 0; index < KNOB_COUNT; index++) {
      const offset = KNOB_FIRST_BYTE + index * 2;
      const delta = wrappedDelta(u16le(prev, offset), u16le(report, offset), KNOB_RANGE);
      if (delta !== 0) events.push({ type: "encoder", index, delta });
    }

    const stripBefore = u16le(prev, STRIP_POSITION_BYTE);
    const stripNow = u16le(report, STRIP_POSITION_BYTE);
    if (stripNow !== stripBefore) {
      events.push({
        type: "strip",
        position: Math.min(1, stripNow / STRIP_MAX),
        touched: stripNow !== 0, // unverified: assumes 0 means no finger
      });
    }

    return events;
  }

  // Entries of [pad] [event type nibble | value bits 11–8] [value bits 7–0], as NI's PadHandler
  // reads them: an all-zero entry ends the list (later bytes are stale), and [0, 0, v] is an ON
  // for pad 0 with an 8-bit value.
  private parsePads(report: Uint8Array): HwEvent[] {
    const events: HwEvent[] = [];
    for (let slot = 0; slot < PAD_ENTRY_COUNT; slot++) {
      const offset = 1 + slot * 3;
      if (offset + 2 >= report.length) break;
      const pad = report[offset] ?? 0;
      const typeAndHigh = report[offset + 1] ?? 0;
      const low = report[offset + 2] ?? 0;
      if (pad === 0 && typeAndHigh === 0 && low === 0) break;
      const kind = padEntryKind(typeAndHigh >> 4);
      if (kind === undefined || pad >= PAD_COUNT) continue;
      events.push(...this.pads.process(panelPad(pad), kind, ((typeAndHigh & 0x0f) << 8) | low));
    }
    return events;
  }
}
