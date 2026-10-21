// Exercises the MK3's LEDs.
//
//   npm run ledtest -- walk [--delay 600] [--from 0x80:20]   light each LED address in turn, named
//   npm run ledtest -- levels    all button lights: off, dim, bright
//   npm run ledtest -- ladder    raw brightness values side by side on the display buttons
//   npm run ledtest -- rainbow   cycling colors on pads, strip, groups and 4D encoder
//   npm run ledtest -- palette   every palette color on the pads; arrow buttons change page
//   npm run ledtest -- run       press anything and it lights up
//   npm run ledtest -- off       turn every LED off
import { Mk3Device } from "../hw/device.js";
import type { HwEvent } from "../hw/events.js";
import type { NavDirection } from "../hw/ids.js";
import { InputParser } from "../hw/input.js";
import {
  COLOR_LEDS,
  LedSender,
  LedState,
  MONO_LEDS,
  NAV_LEDS,
  REPORT_BUTTON_LEDS,
  REPORT_PAD_LEDS,
  STRIP_LED_COUNT,
  isColorLed,
  isMonoLed,
} from "../hw/leds.js";
import { paletteColor, paletteName } from "../hw/palette.js";

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--") && !/^\d|^0x/.test(a)) ?? "walk";
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const device = new Mk3Device();
const leds = new LedState();
const sender = new LedSender(leds, (report) => device.write(report));
const parser = new InputParser();
const inputHandlers: Array<(event: HwEvent) => void> = [];

device.on("connected", ({ serial }) => {
  console.log(`Connected to Maschine MK3 ${serial ?? ""}. Ctrl-C to quit.`);
  sender.resendAll();
});
device.on("disconnected", (reason) => console.log(`Disconnected: ${reason}`));
device.on("unavailable", (reason) => console.log(`Waiting: ${reason}`));
device.on("report", (report) => {
  for (const event of parser.parse(report)) {
    for (const handler of inputHandlers) handler(event);
  }
});

const connected = new Promise<void>((resolve) => device.once("connected", () => resolve()));

async function show(): Promise<void> {
  sender.update();
  await sender.flush();
}

function nameOf(report: number, byte: number): string {
  if (report === REPORT_PAD_LEDS) {
    if (byte <= STRIP_LED_COUNT) return `touch strip segment ${byte}`;
    return `pad ${byte - STRIP_LED_COUNT}`;
  }
  const find = (table: Record<string, number>) =>
    Object.entries(table).find(([, b]) => b === byte)?.[0];
  const mono = find(MONO_LEDS);
  if (mono) return `${mono} (brightness)`;
  const color = find(COLOR_LEDS);
  if (color) return `${color} (color)`;
  const nav = find(NAV_LEDS);
  if (nav) return `4D ${nav} (color)`;
  return "UNKNOWN — tell me which light is on";
}

async function walk() {
  const delay = Number(option("--delay") ?? 600);
  const [fromReport, fromByte] = (option("--from") ?? "0x80:1").split(":");
  const steps: Array<[number, number]> = [];
  for (let b = 1; b < 63; b++) steps.push([REPORT_BUTTON_LEDS, b]);
  for (let b = 1; b < 42; b++) steps.push([REPORT_PAD_LEDS, b]);
  const start = steps.findIndex(
    ([r, b]) => r === Number(fromReport) && b === Number(fromByte ?? 1),
  );
  console.log("Lighting each LED address in turn. Note any name that doesn't match the light.");
  for (const [report, byte] of steps.slice(Math.max(0, start))) {
    leds.clear();
    // 63 is full brightness for single-color LEDs and a bright palette color for the rest.
    leds.setRaw(report as 0x80 | 0x81, byte, 63);
    await show();
    console.log(
      `0x${report.toString(16)} byte ${String(byte).padStart(2)}: ${nameOf(report, byte)}`,
    );
    await sleep(delay);
  }
  leds.clear();
  await show();
  console.log("Walk done.");
}

async function levels() {
  console.log("All button lights: off, dim, bright.");
  for (const level of ["off", "dim", "bright"] as const) {
    for (const id of Object.keys(MONO_LEDS) as Array<keyof typeof MONO_LEDS>) {
      leds.setLight(id, level);
    }
    await show();
    console.log(`  ${level}`);
    await sleep(2000);
  }
  leds.clear();
  await show();
}

// Raw byte values side by side on the 8 display buttons, to find the real brightness steps.
async function ladder() {
  const sets = [
    [1, 8, 16, 24, 31, 32, 48, 63],
    [63, 64, 80, 96, 112, 127, 128, 255],
  ];
  let page = 0;
  const render = async () => {
    const values = sets[page] ?? [];
    console.log(`\nSet ${page + 1}/${sets.length}, display buttons 1–8 (left to right):`);
    values.forEach((value, i) => {
      leds.setRaw(
        REPORT_BUTTON_LEDS,
        MONO_LEDS[`display${i + 1}` as keyof typeof MONO_LEDS],
        value,
      );
      console.log(`  display ${i + 1}: raw ${value}`);
    });
    leds.setLight("arrowLeft", page > 0 ? "bright" : "off");
    leds.setLight("arrowRight", page < sets.length - 1 ? "bright" : "off");
    await show();
  };
  inputHandlers.push((event) => {
    if (event.type !== "button" || !event.pressed) return;
    if (event.id === "arrowLeft" && page > 0) page--;
    else if (event.id === "arrowRight" && page < sets.length - 1) page++;
    else return;
    void render();
  });
  console.log("Compare the 8 display buttons above the screens. Arrow buttons switch sets.");
  await render();
  await new Promise(() => undefined);
}

async function rainbow() {
  console.log("Rainbow: pads, touch strip, group buttons and 4D encoder cycle through colors.");
  const navOrder: NavDirection[] = ["up", "right", "down", "left"];
  for (let offset = 0; ; offset++) {
    for (let pad = 0; pad < 16; pad++) leds.setPad(pad, paletteColor(pad + offset));
    for (let s = 0; s < STRIP_LED_COUNT; s++) {
      leds.setStrip(s, paletteColor(Math.floor((s * 16) / STRIP_LED_COUNT) + offset));
    }
    (Object.keys(COLOR_LEDS) as Array<keyof typeof COLOR_LEDS>).forEach((id, i) =>
      leds.setButtonColor(id, paletteColor(i * 2 + offset)),
    );
    navOrder.forEach((dir, i) => leds.setNav(dir, paletteColor(i * 4 + offset)));
    await show();
    await sleep(150);
  }
}

async function palette() {
  let page = 0;
  const pages = 5; // indices 0–79 cover the 72 entries
  const render = async () => {
    console.log(`\nPalette page ${page + 1}/${pages} (pads 1–16, bottom-left first):`);
    for (let pad = 0; pad < 16; pad++) {
      const index = page * 16 + pad;
      leds.setPad(pad, index < 72 ? index : 0);
      if (index < 72)
        console.log(
          `  pad ${String(pad + 1).padStart(2)}: ${String(index).padStart(2)} ${paletteName(index)}`,
        );
    }
    leds.setLight("arrowLeft", page > 0 ? "bright" : "dim");
    leds.setLight("arrowRight", page < pages - 1 ? "bright" : "dim");
    await show();
  };
  inputHandlers.push((event) => {
    if (event.type !== "button" || !event.pressed) return;
    if (event.id === "arrowLeft" && page > 0) page--;
    else if (event.id === "arrowRight" && page < pages - 1) page++;
    else return;
    void render();
  });
  console.log("Use the arrow buttons (left of the screens) to change page.");
  await render();
  await new Promise(() => undefined);
}

async function run() {
  console.log("Press buttons, pads, the 4D encoder or the touch strip: they light up.");
  inputHandlers.push((event) => {
    switch (event.type) {
      case "button":
        if (isMonoLed(event.id)) leds.setLight(event.id, event.pressed ? "bright" : "off");
        else if (isColorLed(event.id)) {
          const i = Object.keys(COLOR_LEDS).indexOf(event.id);
          leds.setButtonColor(event.id, event.pressed ? paletteColor(i * 2) : 0);
        }
        break;
      case "pad":
        if (event.phase === "down") {
          leds.setPad(
            event.pad,
            paletteColor(event.pad, (event.velocity ?? 0) > 0.6 ? "pressed" : "bright"),
          );
        } else if (event.phase === "up") {
          leds.setPad(event.pad, 0);
        }
        break;
      case "nav":
        if (event.action === "tilt")
          leds.setNav(event.direction, event.pressed ? paletteColor(8) : 0);
        break;
      case "encoderTouch":
        leds.setLight(
          `display${event.index + 1}` as keyof typeof MONO_LEDS,
          event.touched ? "bright" : "off",
        );
        break;
      case "strip": {
        const lit = event.touched ? Math.round(event.position * STRIP_LED_COUNT) : 0;
        for (let s = 0; s < STRIP_LED_COUNT; s++) leds.setStrip(s, s < lit ? paletteColor(10) : 0);
        break;
      }
    }
    sender.update();
  });
  await new Promise(() => undefined);
}

// Ctrl-C arrives twice (from the terminal and via tsx); clean up only once.
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) return;
  stopping = true;
  leds.clear();
  sender.cancel();
  void sender
    .flush()
    .finally(() => device.stop())
    .finally(() => process.exit(0));
});

async function off() {
  leds.clear();
  await show();
  console.log("All LEDs off.");
}

const modes: Record<string, () => Promise<void>> = {
  walk,
  levels,
  ladder,
  rainbow,
  palette,
  run,
  off,
};
const selected = modes[mode];
if (!selected) {
  console.log(`Unknown mode "${mode}". Use one of: ${Object.keys(modes).join(", ")}`);
  process.exit(2);
}
device.start();
await connected;
await selected();
await device.stop();
