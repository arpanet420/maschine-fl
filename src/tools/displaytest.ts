// Exercises the MK3's two screens.
//
//   npm run displaytest -- bars       color bars and gradients (checks colors and byte order)
//   npm run displaytest -- grid       border, grid and corner labels (checks alignment, left/right)
//   npm run displaytest -- text       font sizes
//   npm run displaytest -- partial    small squares sent as partial updates
//   npm run displaytest -- anim       animation; prints frames per second, full and partial
//   npm run displaytest -- widgets    demo layout with fake FL data
//
// Flags: --png (write out/*.png instead of using the MK3), --le (little-endian pixels, to
// diagnose wrong colors), --full (never send partial updates).
import type { SKRSContext2D } from "@napi-rs/canvas";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, Mk3Display, type Rect } from "../hw/display.js";
import { Screens, type FrameSink } from "../render/screens.js";
import {
  clear,
  columns,
  drawFader,
  drawHeader,
  drawKnobRow,
  drawList,
  drawTransport,
  font,
  theme,
} from "../render/widgets.js";

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--")) ?? "bars";
const PNG = args.includes("--png");
const OUT_DIR = "out";
const SCREEN: Rect = { x: 0, y: 0, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const display = new Mk3Display();
const noSink: FrameSink = { send: async () => undefined };
const screens = new Screens(PNG ? noSink : display, {
  littleEndian: args.includes("--le"),
  partialUpdates: !args.includes("--full"),
});

async function present(name = mode): Promise<void> {
  if (PNG) {
    const files = await screens.writePngs(OUT_DIR, name);
    console.log(`Wrote ${files.join(", ")}`);
  } else {
    await screens.flush();
  }
}

function label(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  size = 16,
  color = theme.text,
) {
  ctx.fillStyle = color;
  ctx.font = font(size, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

async function bars() {
  const colors: Array<[string, string]> = [
    ["red", "#ff0000"],
    ["green", "#00ff00"],
    ["blue", "#0000ff"],
    ["white", "#ffffff"],
    ["yellow", "#ffff00"],
    ["cyan", "#00ffff"],
    ["magenta", "#ff00ff"],
    ["black", "#000000"],
  ];
  for (const screen of screens.screens) {
    const ctx = screen.ctx;
    clear(ctx, SCREEN, "#000");
    const half = colors.slice(screen.index * 4, screen.index * 4 + 4);
    columns({ x: 0, y: 0, width: DISPLAY_WIDTH, height: 180 }, 4).forEach((cell, i) => {
      const [name, color] = half[i] ?? ["", "#000"];
      ctx.fillStyle = color;
      ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
      label(
        ctx,
        name,
        cell.x + cell.width / 2,
        90,
        18,
        name === "white" || name === "yellow" || name === "cyan" ? "#000" : "#fff",
      );
    });
    const gradients: Array<[string, (v: number) => string]> = [
      ["red", (v) => `rgb(${v},0,0)`],
      ["green", (v) => `rgb(0,${v},0)`],
      ["blue", (v) => `rgb(0,0,${v})`],
      ["grey", (v) => `rgb(${v},${v},${v})`],
    ];
    gradients.forEach(([, toColor], row) => {
      for (let x = 0; x < DISPLAY_WIDTH; x++) {
        ctx.fillStyle = toColor(Math.round((x / (DISPLAY_WIDTH - 1)) * 255));
        ctx.fillRect(x, 184 + row * 22, 1, 20);
      }
    });
  }
  console.log("Left: red, green, blue, white bars. Right: yellow, cyan, magenta, black.");
  console.log("Below: red, green, blue and grey gradients, dark on the left.");
  await present();
}

async function grid() {
  for (const screen of screens.screens) {
    const ctx = screen.ctx;
    clear(ctx, SCREEN, "#000");
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 1;
    for (let x = 20; x < DISPLAY_WIDTH; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, DISPLAY_HEIGHT);
      ctx.stroke();
    }
    for (let y = 20; y < DISPLAY_HEIGHT; y += 20) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(DISPLAY_WIDTH, y + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = "#fff";
    ctx.strokeRect(0.5, 0.5, DISPLAY_WIDTH - 1, DISPLAY_HEIGHT - 1);
    const corner = (text: string, x: number, y: number) => {
      ctx.fillStyle = "#ff8a00";
      ctx.fillRect(x, y, 8, 8);
      label(ctx, text, x + (x === 0 ? 30 : -22), y + (y === 0 ? 16 : -8), 12);
    };
    corner("TL", 0, 0);
    corner("TR", DISPLAY_WIDTH - 8, 0);
    corner("BL", 0, DISPLAY_HEIGHT - 8);
    corner("BR", DISPLAY_WIDTH - 8, DISPLAY_HEIGHT - 8);
    label(ctx, `SCREEN ${screen.index}`, DISPLAY_WIDTH / 2, DISPLAY_HEIGHT / 2 - 14, 28);
    label(
      ctx,
      screen.index === 0 ? "should be LEFT" : "should be RIGHT",
      DISPLAY_WIDTH / 2,
      DISPLAY_HEIGHT / 2 + 18,
      16,
      theme.dimText,
    );
  }
  console.log("Each screen: white 1-pixel border, grid every 20 px, orange corner squares.");
  await present();
}

async function text() {
  for (const screen of screens.screens) {
    const ctx = screen.ctx;
    clear(ctx, SCREEN);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let y = 6;
    for (const size of [10, 12, 14, 16, 20, 24, 32]) {
      ctx.fillStyle = theme.text;
      ctx.font = font(size, screen.index === 1 ? "bold" : "normal");
      ctx.fillText(`${size}px Kick Snare Hi-Hat 0123456789 åäö`, 8, y);
      y += size + 10;
    }
  }
  console.log("Left: regular weight. Right: bold. Sizes 10–32 px.");
  await present();
}

async function partial() {
  for (const screen of screens.screens) clear(screen.ctx, SCREEN, "#000");
  await present();
  console.log("Screens cleared. Squares now appear one by one, each sent as a partial update.");
  const palette = ["#ff3b3b", "#3ddc6b", "#3b8bff", "#ffd23b", "#ff8a00", "#c03bff"];
  for (let i = 0; ; i++) {
    const screen = screens.screens[i % 2]!;
    const x = 20 + ((i * 97) % 400);
    const y = 20 + ((i * 53) % 210);
    screen.ctx.fillStyle = palette[i % palette.length]!;
    screen.ctx.fillRect(x, y, 40, 40);
    label(screen.ctx, String(i + 1), x + 20, y + 20, 14, "#000");
    await present();
    console.log(`  square ${i + 1}: screen ${screen.index}, x ${x}, y ${y} (40×40)`);
    await sleep(700);
  }
}

async function measure(name: string, seconds: number, draw: (frame: number) => void) {
  let frames = 0;
  let pixels = 0;
  const start = performance.now();
  while (performance.now() - start < seconds * 1000) {
    draw(frames);
    pixels += await screens.flush();
    frames++;
  }
  const elapsed = (performance.now() - start) / 1000;
  console.log(
    `  ${name}: ${(frames / elapsed).toFixed(1)} fps, ${((pixels * 2) / elapsed / 1e6).toFixed(1)} MB/s of pixels`,
  );
}

async function anim() {
  console.log("Measuring for 5 s each…");
  await measure("full frames, both screens", 5, (frame) => {
    for (const screen of screens.screens) {
      const ctx = screen.ctx;
      const hue = (frame * 6 + screen.index * 180) % 360;
      ctx.fillStyle = `hsl(${hue}, 70%, 30%)`;
      ctx.fillRect(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT);
      label(ctx, `frame ${frame}`, DISPLAY_WIDTH / 2, DISPLAY_HEIGHT / 2, 32);
    }
  });
  for (const screen of screens.screens) clear(screen.ctx, SCREEN, "#000");
  await screens.flush();
  await measure("small moving box, partial updates", 5, (frame) => {
    const ctx = screens.left.ctx;
    const x = (frame * 8) % (DISPLAY_WIDTH - 40);
    clear(ctx, { x: 0, y: 116, width: DISPLAY_WIDTH, height: 40 }, "#000");
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x, 116, 40, 40);
  });
}

async function widgets() {
  const left = screens.left.ctx;
  const right = screens.right.ctx;
  clear(left, SCREEN);
  clear(right, SCREEN);
  drawHeader(
    left,
    { x: 0, y: 0, width: DISPLAY_WIDTH, height: 48 },
    {
      title: "Mixer",
      page: "Insert 1–8",
      tabs: ["Volume", "Pan", "Sends", "FX"],
      activeTab: 0,
    },
  );
  drawHeader(
    right,
    { x: 0, y: 0, width: DISPLAY_WIDTH, height: 48 },
    {
      title: "Channels",
      page: "1/3",
      tabs: ["Bank −", "Bank +", "", "Mute"],
    },
  );
  const tracks = [
    { label: "Kick", value: 0.78, peak: 0.9, color: "#e04040", valueText: "-1.2 dB" },
    {
      label: "Snare",
      value: 0.7,
      peak: 0.6,
      color: "#e0a040",
      valueText: "-3.4 dB",
      selected: true,
    },
    { label: "Hats", value: 0.55, peak: 0.4, color: "#40c0e0", valueText: "-8.0 dB" },
    { label: "Bass", value: 0.8, peak: 0.98, color: "#a040e0", valueText: "+0.4 dB", muted: true },
  ];
  columns({ x: 0, y: 48, width: DISPLAY_WIDTH, height: 134 }, 4).forEach((cell, i) => {
    const track = tracks[i];
    if (track) drawFader(left, cell, track);
  });
  drawKnobRow(left, { x: 0, y: 182, width: DISPLAY_WIDTH, height: 90 }, [
    { label: "Kick", valueText: "-1.2 dB", value: 0.78 },
    { label: "Snare", valueText: "-3.4 dB", value: 0.7, touched: true },
    { label: "Hats", valueText: "-8.0 dB", value: 0.55 },
    { label: "Bass", valueText: "+0.4 dB", value: 0.8 },
  ]);
  drawList(
    right,
    { x: 0, y: 48, width: DISPLAY_WIDTH, height: 160 },
    {
      items: [
        { text: "Kick", detail: "1", color: "#e04040" },
        { text: "Snare", detail: "2", color: "#e0a040" },
        { text: "Hats", detail: "3", color: "#40c0e0" },
        { text: "Bass – Diva", detail: "4", color: "#a040e0", muted: true },
        { text: "Pad – Repro-1", detail: "5", color: "#40e080" },
        { text: "FX Riser", detail: "6", color: "#8080a0" },
      ],
      selected: 1,
    },
  );
  drawTransport(
    right,
    { x: 0, y: 240, width: DISPLAY_WIDTH, height: 32 },
    {
      playing: true,
      recording: true,
      bpm: 124,
      position: "5:3:2",
      pattern: "Pattern 2 – Verse",
    },
  );
  console.log(
    "Left: mixer header, 4 faders with meters, knob row. Right: channel list, transport.",
  );
  await present();
}

const modes: Record<string, () => Promise<void>> = { bars, grid, text, partial, anim, widgets };
const selected = modes[mode];
if (!selected) {
  console.log(`Unknown mode "${mode}". Use one of: ${Object.keys(modes).join(", ")}`);
  process.exit(2);
}
if (PNG && (mode === "partial" || mode === "anim")) {
  console.log(`--png does not apply to ${mode}; it needs the MK3.`);
  process.exit(2);
}

// Ctrl-C arrives twice (from the terminal and via tsx); clean up only once.
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) return;
  stopping = true;
  void (async () => {
    if (!PNG) {
      for (const screen of screens.screens) clear(screen.ctx, SCREEN, "#000");
      await screens.flush().catch(() => undefined);
      await display.close();
    }
    process.exit(0);
  })();
});

try {
  await selected();
} catch (err) {
  console.log(`Failed: ${String(err)}`);
  process.exitCode = 1;
}
if (!PNG && mode !== "partial") {
  console.log("Showing on the MK3. Ctrl-C to clear the screens and quit.");
  // Nothing else keeps Node running once the frame is sent; wait for Ctrl-C.
  setInterval(() => undefined, 60_000);
  await new Promise(() => undefined);
}
await display.close();
