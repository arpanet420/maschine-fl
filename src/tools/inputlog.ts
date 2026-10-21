// Logs MK3 input as readable events (default) or as hex dumps with changed bytes marked (--raw).
//
//   npm run inputlog                 events; pad aftertouch summarized on release
//   npm run inputlog -- --moves      also print every aftertouch change
//   npm run inputlog -- --raw        hex dump per report, changed bytes inverted
//   npm run inputlog -- --record test/fixtures/session.jsonl   save raw reports for tests
//   npm run inputlog -- --reset      USB-reset the MK3 first (wakes it after NI's agent)
import { createWriteStream, type WriteStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { Mk3Device, resetMk3Usb } from "../hw/device.js";
import type { HwEvent } from "../hw/events.js";
import {
  BUTTON_BYTES,
  CONTROL_BITS,
  KNOB_FIRST_BYTE,
  NAV_WHEEL_BYTE,
  PAD_PRESSURE_MAX,
  REPORT_CONTROLS,
} from "../hw/ids.js";
import { InputParser } from "../hw/input.js";
import { hex2 } from "../hw/usbIds.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const RAW = flag("--raw");
const MOVES = flag("--moves");
const RECORD = option("--record");
const INVERSE = (s: string) => `\x1b[7m${s}\x1b[0m`;
const SILENCE_HINT_MS = 10_000;

// Bits of the controls report that CONTROL_BITS does not name.
const MAPPED_MASK = new Map<number, number>();
for (const [byte, mask] of CONTROL_BITS) MAPPED_MASK.set(byte, (MAPPED_MASK.get(byte) ?? 0) | mask);

const start = performance.now();
const now = () => performance.now() - start;
const lastById = new Map<number, Uint8Array>();
const parser = new InputParser();
const padPeak = new Map<number, number>();
const unknownSeen = new Set<number>();
let recordStream: WriteStream | undefined;
let reportCount = 0;

const u16 = (r: Uint8Array, o: number) => (r[o] ?? 0) | ((r[o + 1] ?? 0) << 8);
const stamp = () => (now() / 1000).toFixed(3).padStart(8);

function hexDump(report: Uint8Array, previous: Uint8Array | undefined): string {
  const cells = Array.from(report, (b, i) => {
    const text = b.toString(16).padStart(2, "0");
    return previous && previous[i] !== b ? INVERSE(text) : text;
  });
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 16) {
    rows.push(`  ${i.toString().padStart(2)}: ${cells.slice(i, i + 16).join(" ")}`);
  }
  return rows.join("\n");
}

function describe(event: HwEvent, report: Uint8Array): string | undefined {
  switch (event.type) {
    case "button":
      return `button ${event.id} ${event.pressed ? "down" : "up"}`;
    case "encoder":
      return `knob ${event.index + 1} ${event.delta > 0 ? "+" : ""}${event.delta}  (raw ${u16(report, KNOB_FIRST_BYTE + event.index * 2)})`;
    case "encoderTouch":
      return `knob ${event.index + 1} ${event.touched ? "touched" : "released"}`;
    case "nav":
      switch (event.action) {
        case "turn":
          return `4D turn ${event.delta > 0 ? "+" : ""}${event.delta}  (raw ${(report[NAV_WHEEL_BYTE] ?? 0) & 0x0f})`;
        case "push":
          return `4D push ${event.pressed ? "down" : "up"}`;
        case "touch":
          return `4D ${event.touched ? "touched" : "released"}`;
        case "tilt":
          return `4D tilt ${event.direction} ${event.pressed ? "down" : "up"}`;
      }
      return undefined;
    case "strip":
      return `strip ${event.touched ? event.position.toFixed(3) : "released"}  (raw ${u16(report, 30)}, second value ${u16(report, 32)})`;
    case "jack":
      return `jack ${event.jack} ${event.connected ? "plugged" : "unplugged"}`;
    case "pad": {
      const raw = Math.round(event.pressure * PAD_PRESSURE_MAX);
      if (event.phase === "down") {
        padPeak.set(event.pad, 0); // the hit value is the ON strength, not pressure
        return `pad ${event.pad} down  velocity ${Math.round((event.velocity ?? 0) * 126) + 1}  (hit value ${raw})`;
      }
      if (event.phase === "move") {
        padPeak.set(event.pad, Math.max(padPeak.get(event.pad) ?? 0, raw));
        return MOVES ? `pad ${event.pad} pressure ${raw}` : undefined;
      }
      const peak = padPeak.get(event.pad) ?? 0;
      padPeak.delete(event.pad);
      return `pad ${event.pad} up  (max pressure ${peak})`;
    }
  }
}

function unmappedChanges(report: Uint8Array, previous: Uint8Array | undefined): string[] {
  if (!previous) return [];
  const lines: string[] = [];
  for (let byte = BUTTON_BYTES.first; byte <= BUTTON_BYTES.last; byte++) {
    const changed =
      ((report[byte] ?? 0) ^ (previous[byte] ?? 0)) & ~(MAPPED_MASK.get(byte) ?? 0) & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      const mask = 1 << bit;
      if (changed & mask) {
        lines.push(
          `UNMAPPED bit byte ${byte} ${hex2(mask)} -> ${(report[byte] ?? 0) & mask ? 1 : 0}`,
        );
      }
    }
  }
  const highNibble = (b: Uint8Array) => ((b[NAV_WHEEL_BYTE] ?? 0) >> 4) & 0x0f;
  if (highNibble(report) !== highNibble(previous)) {
    lines.push(`UNKNOWN byte 11 high nibble -> ${highNibble(report)}`);
  }
  if (u16(report, 34) !== u16(previous, 34)) {
    lines.push(`UNKNOWN bytes 34-35 -> ${u16(report, 34)}`);
  }
  return lines;
}

function print(events: HwEvent[], report: Uint8Array) {
  for (const event of events) {
    const line = describe(event, report);
    if (line) console.log(`${stamp()}  ${line}`);
  }
}

function onReport(report: Uint8Array) {
  reportCount++;
  const t = now();
  const id = report[0] ?? -1;
  const previous = lastById.get(id);
  lastById.set(id, report);
  recordStream?.write(
    JSON.stringify({ t: Math.round(t * 1000) / 1000, hex: Buffer.from(report).toString("hex") }) +
      "\n",
  );

  if (RAW) {
    console.log(
      `${stamp()}  report ${hex2(id)} (${report.length} bytes)\n${hexDump(report, previous)}`,
    );
    return;
  }
  if (id !== REPORT_CONTROLS && id !== 0x02 && !unknownSeen.has(id)) {
    unknownSeen.add(id);
    console.log(`${stamp()}  report ${hex2(id)} seen (meaning unknown, use --raw to inspect)`);
  }
  if (id === REPORT_CONTROLS) {
    for (const line of unmappedChanges(report, previous)) console.log(`${stamp()}  ${line}`);
  }
  print(parser.parse(report), report);
}

async function main() {
  if (flag("--reset")) {
    console.log("Resetting the MK3 over USB…");
    try {
      await resetMk3Usb();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (err) {
      console.log(`USB reset failed (${String(err)}). Continuing without it.`);
    }
  }
  if (RECORD) {
    recordStream = createWriteStream(RECORD);
    console.log(`Recording raw reports to ${RECORD}`);
  }

  const device = new Mk3Device();
  device.on("connected", ({ serial, exclusive }) => {
    console.log(
      `Connected to Maschine MK3 ${serial ?? ""} (${exclusive ? "exclusive" : "shared"}). Ctrl-C to quit.`,
    );
  });
  device.on("disconnected", (reason) =>
    console.log(`Disconnected: ${reason}. Waiting for the MK3…`),
  );
  device.on("unavailable", (reason) => console.log(`Waiting: ${reason}`));
  device.on("report", onReport);
  device.start();

  setTimeout(() => {
    if (reportCount === 0) {
      console.log(
        "No input after 10 s. If you pressed pads, NI's agent may have left the MK3 silent:\n" +
          "  stop it (scripts/ni-agents.sh stop), then rerun with --reset or power-cycle the MK3.",
      );
    }
  }, SILENCE_HINT_MS);

  process.on("SIGINT", () => {
    void device.stop().then(() => {
      recordStream?.end();
      console.log(`\n${reportCount} reports.`);
      process.exit(0);
    });
  });
}

await main();
