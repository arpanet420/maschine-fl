// Draws the pages that came with quick edit, SHIFT + pad, NAVIGATE, GRID, NOTE REPEAT, BROWSER, FILE, SETTINGS, ARRANGER (the pattern overview), SCENE, PATTERN (length and color), LOOP, LIVE, KEYBOARD scales and CHORDS to out/ as PNG files, from
// a demo project (no FL, no MK3). The SHIFT + pad feedback cards are ui-shift-undo, -redo, -copy,
// -paste, -clear, -quantize and -octave:
//
//   npm run pagepng
//
// Each scene writes ui-<name>-0.png (left screen), ui-<name>-1.png (right screen) and
// ui-<name>-both.png (side by side); `ui-shift-pads.png` shows the pad LEDs while SHIFT is held.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from "../hw/display.js";
import { padCellRect } from "../modes/padGrid.js";
import { shiftActionOf } from "../modes/shiftPads.js";
import { registerFonts } from "../render/fonts.js";
import { fitText, font, theme } from "../render/widgets.js";
import { stackHarness, type StackHarness } from "./stackHarness.js";

const OUT_DIR = "out";

/** Preset names for the BROWSER scenes (a 128 preset bank repeats them). */
const BANK_NAMES = [
  "Dusty Keys",
  "Soft Pad",
  "Warm Bass",
  "Sub Drop",
  "Glass Bell",
  "Wide Strings",
  "Brass Stab",
  "Pluck Lead",
  "SQ Computer Instrument",
  "Analog Pulse",
  "Choir Air",
  "Rubber Bass",
  "Tape Piano",
  "Reese Growl",
  "Vinyl Organ",
  "Hollow Flute",
];

async function writeScene(name: string, h: StackHarness): Promise<void> {
  const { left, right } = h.render();
  const gap = 16;
  const both = createCanvas(DISPLAY_WIDTH * 2 + gap, DISPLAY_HEIGHT);
  const ctx = both.getContext("2d");
  ctx.fillStyle = "#333";
  ctx.fillRect(0, 0, both.width, both.height);
  ctx.drawImage(left.canvas, 0, 0);
  ctx.drawImage(right.canvas, DISPLAY_WIDTH + gap, 0);
  const files = [
    [`ui-${name}-0.png`, left.canvas],
    [`ui-${name}-1.png`, right.canvas],
    [`ui-${name}-both.png`, both],
  ] as const;
  for (const [file, canvas] of files) {
    await writeFile(join(OUT_DIR, file), await canvas.encode("png"));
    console.log(`Wrote ${join(OUT_DIR, file)}`);
  }
}

/** The MK3's white LED levels as screen grays (the palette has 68–71 for white). */
const LED_GRAY: Record<number, string> = {
  68: "#3a3a3a",
  69: "#7a7a7a",
  70: "#dadada",
  71: "#ffffff",
};

async function writePadLeds(name: string, h: StackHarness): Promise<void> {
  const canvas = createCanvas(4 * 112, 4 * 112 + 8);
  const ctx: SKRSContext2D = canvas.getContext("2d");
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let pad = 0; pad < 16; pad++) {
    const cell = padCellRect(
      { x: 4, y: 4, width: canvas.width - 8, height: canvas.height - 8 },
      pad,
    );
    const led = h.padLed(pad);
    ctx.fillStyle = LED_GRAY[led] ?? (led === 0 ? "#101010" : theme.accent);
    ctx.beginPath();
    ctx.roundRect(cell.x, cell.y, cell.width, cell.height, 10);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = font(15, "bold");
    ctx.fillStyle = led >= 70 ? "#222" : "#bbb";
    ctx.fillText(String(pad + 1), cell.x + 8, cell.y + 6);
    ctx.font = font(15);
    ctx.fillText(
      fitText(ctx, shiftActionOf(pad) ?? "–", cell.width - 14),
      cell.x + 8,
      cell.y + cell.height - 24,
    );
  }
  const file = join(OUT_DIR, `ui-${name}.png`);
  await writeFile(file, await canvas.encode("png"));
  console.log(`Wrote ${file}`);
}

/** Markers like a song's sections, one every 8 bars from bar 1 (PPQ 96: a bar is 384 ticks). */
const SECTION_NAMES = [
  "Intro",
  "Verse 1",
  "Pre-chorus",
  "Chorus",
  "Verse 2",
  "Pre-chorus 2",
  "Chorus 2",
  "Bridge",
  "Breakdown",
  "Build-up",
  "Drop",
  "Drop 2",
  "Outro",
  "Tail",
  "Fade",
  "End",
  "Bonus 1",
  "Bonus 2",
];
const demoMarkers = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    ticks: i * 8 * 384,
    name: SECTION_NAMES[i] ?? `Marker ${i + 1}`,
  }));

async function main(): Promise<void> {
  registerFonts();
  await mkdir(OUT_DIR, { recursive: true });

  // Quick edit: TEMPO after one turn of the 4D encoder.
  let h = stackHarness({ tempo: 120, selected: 2 });
  h.tap("tempo");
  h.turn(1);
  await writeScene("quickedit-tempo", h);

  // Quick edit: VOLUME with a pad held edits the channel's volume, named in the read-out.
  h = stackHarness({ selected: 2, volume: 0.78 });
  h.tap("volume");
  h.pad(0);
  h.turn(2);
  await writeScene("quickedit-volume-pad", h);

  // Quick edit: VOLUME and SWING on their own (main volume, main swing), and TUNE with a pad.
  h = stackHarness({ mainVolume: 0.8 });
  h.tap("volume");
  h.turn(-3);
  await writeScene("quickedit-volume-main", h);
  h = stackHarness({ swing: 0.25 });
  h.tap("swing");
  h.turn(5);
  await writeScene("quickedit-swing", h);
  h = stackHarness({ selected: 2, pitch: 0.25, pitchRange: 12 });
  h.tap("tempo");
  h.pad(0);
  h.turn(1);
  await writeScene("quickedit-tune", h);

  // The same read-out over the Mixer page.
  h = stackHarness({ mainVolume: 0.8 });
  h.tap("mixer");
  h.tap("volume");
  h.turn(1);
  await writeScene("quickedit-mixer", h);

  // NAVIGATE: the rack has the focus, the playlist is shown.
  h = stackHarness({ selected: 2 });
  h.state.shift = true;
  h.press("variation");
  await writeScene("navigate", h);
  h.ui({ visible: [true, true, true, true, false], focused: 3 });
  await writeScene("navigate-piano", h);

  // GRID: the snap mode is Beat.
  h = stackHarness({ selected: 2 });
  h.ui({ snap: 13 });
  h.state.shift = true;
  h.press("follow");
  await writeScene("grid", h);

  // NOTE REPEAT (PAD MODE; KEYBOARD and CHORDS are the arpeggiator below): 1/16, gate 50 %, FL
  // stopped; then a triplet rate with swing, pinned and a pad held.
  h = stackHarness({ selected: 2 });
  h.pads.mode = "channels";
  h.press("noteRepeat");
  await writeScene("noterepeat", h);
  h = stackHarness({ selected: 2, tempo: 128 });
  h.pads.mode = "channels";
  h.press("noteRepeat");
  h.tap("display1");
  h.tap("display7"); // 1/16T
  h.knob(1, 300);
  h.knob(2, 700);
  h.pad(0);
  h.touched.add(2);
  await writeScene("noterepeat-triplet", h);
  h.touched.delete(2);

  // ARP (NOTE REPEAT in KEYBOARD and CHORDS): nothing held, then a held C minor chord, Up/Down 1/8
  // over two octaves (the preset), HOLD on, the knob of Octaves touched, the second step playing.
  h = stackHarness({ selected: 2 });
  h.press("noteRepeat");
  await writeScene("arp-empty", h);
  h = stackHarness({ selected: 2, tempo: 128 });
  h.tap("chords");
  h.pads.harmony.scale = 2; // Minor: pad 1 = C minor
  h.press("noteRepeat");
  h.tap("display1");
  h.tap("display3");
  h.tap("display7"); // UP/DN 8TH
  h.pad(0);
  h.advance(300); // two steps played: the highlight sits on the second one
  h.touched.add(2);
  await writeScene("arp-cminor", h);
  h.touched.delete(2);

  // BROWSER: the cursor on the loaded preset, the cursor elsewhere in a 128-preset bank (after a
  // push, then the read-out card), a bank whose loaded preset is unknown, and the notice for a plugin
  // without presets. `answer` plays FL's script: PRESETS for the window mk3d asked for.
  const bank = (i: number) =>
    `${BANK_NAMES[i % BANK_NAMES.length]}${i >= BANK_NAMES.length ? ` ${Math.floor(i / BANK_NAMES.length) + 1}` : ""}`;
  const names = (offset: number) => Array.from({ length: 8 }, (_, i) => bank(offset + i));
  const answer = (h: StackHarness, current: number | null) => {
    const window = h.sentOf("presetWindow").at(-1);
    const offset = Math.min(window?.offset ?? h.fl.presets?.offset ?? 0, 120);
    h.presets(128, current, names(offset), offset);
  };
  h = stackHarness({ selected: 2 });
  h.tap("browser");
  h.presets(128, 17, names(14), 14);
  await writeScene("browser", h);
  h.turn(5);
  answer(h, 17);
  await writeScene("browser-cursor", h);
  h.push();
  h.push(false);
  await writeScene("browser-loaded", h); // the read-out card is over the page for a moment
  h = stackHarness({ selected: 2 });
  h.tap("browser");
  h.presets(128, 17, names(14), 14);
  h.turn(40);
  answer(h, 17);
  await writeScene("browser-far", h);
  h = stackHarness({ selected: 2 });
  h.tap("browser");
  h.presets(128, null, names(0), 0);
  await writeScene("browser-unknown", h);
  h = stackHarness({ selected: 2 });
  h.tap("browser");
  h.presets(0, null, [], 0);
  await writeScene("browser-none", h);

  // BROWSER's PLUG-INS = FL's Plugin picker: open (help text, CLOSE), closed (the notice), then the ADDED card.
  h = stackHarness({ selected: 2 });
  h.tap("browser");
  h.tap("display2");
  await writeScene("browser-picker-open", h);
  h.tap("display8");
  await writeScene("browser-picker-closed", h);
  h.tap("display2");
  h.push();
  h.advance(600);
  h.fl.apply({
    type: "channels",
    total: h.fl.channelTotal + 1,
    offset: h.fl.channelTotal,
    entries: [{ selected: true, muted: false, solo: false, color: 0x4ae4a8, name: "Diva" }],
  });
  h.stack.onFlChange("channels", h.mc);
  await writeScene("browser-picker-added", h); // the read-out card is over the page for a moment

  // FILE: after an undo (the card, then the page itself), and the SHIFT + FILE read-out.
  h = stackHarness({ selected: 2 });
  h.tap("file");
  h.undoState(4, 12, "MK3: clear steps");
  h.tap("display5");
  await writeScene("file-undo", h); // the read-out card is over the page for a moment
  h.advance(3000);
  await writeScene("file", h);
  h = stackHarness({ selected: 2 });
  h.state.shift = true;
  h.tap("file");
  await writeScene("shift-file", h);

  // SETTINGS: the default curve, then a harder curve with FIXED VEL on and a knob touched.
  h = stackHarness({ selected: 2 });
  h.tap("settings");
  await writeScene("settings", h);
  h = stackHarness({ selected: 2 });
  h.tap("settings");
  h.knob(0, -250);
  h.knob(1, 180);
  h.knob(2, -300);
  h.touched.add(2);
  h.tap("fixedVel");
  await writeScene("settings-fixed-card", h);
  h.advance(3000);
  await writeScene("settings-fixed", h);
  h.touched.delete(2);

  // ARRANGER, the pattern overview: a 4-row drum pattern (16 steps) with the play head on step 7.
  h = stackHarness({
    selected: 1,
    channels: 4,
    patternLength: 16,
    grid: {
      0: [0, 4, 8, 12],
      1: [4, 12],
      2: [12],
      3: [0, 2, 4, 6, 8, 10, 12, 14],
    },
  });
  h.tap("arranger");
  h.playing(true);
  h.songPos(1, 7);
  await writeScene("arranger", h);
  // A 64-step pattern on page 2 (steps 17–32), the cursor on the 3rd row, knob 6 touched.
  h = stackHarness({
    selected: 2,
    patternLength: 64,
    grid: {
      0: [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60],
      1: [20, 28, 52, 60],
      2: [18, 22, 26, 30, 50, 54],
      3: [16, 17, 19, 24, 25, 27, 30, 31],
      4: [28, 29],
      5: [16, 24, 40],
    },
  });
  h.tap("arranger");
  h.tilt("right");
  h.touched.add(5);
  await writeScene("arranger-page2", h);
  h.touched.delete(5);
  // A bank with 24 channels: the cursor on channel 11, so the 8 rows are scrolled (channels 4–11);
  // one channel muted, one soloed, one a piano roll channel, the second pattern bank on the pads.
  h = stackHarness({
    selected: 0,
    channels: 24,
    patternLength: 32,
    patternCount: 20,
    muted: [6],
    solo: [9],
    grid: {
      4: [0, 3, 6, 8, 11, 14, 16, 19, 22, 24, 27, 30],
      5: [2, 10, 18, 26],
      6: [0, 8, 16, 24],
      7: [4, 5, 12, 13, 20, 21, 28, 29],
      8: [0, 3, 8, 11, 16, 19, 24, 27],
      9: [0, 16],
      10: { on: [], stepSequencer: false },
      11: [8, 24],
    },
  });
  h.tap("arranger");
  h.turn(11);
  h.touched.add(4);
  await writeScene("arranger-bank", h);
  h.touched.delete(4);

  // SCENE: held over the channel page while FL plays, a jump to "Drop" queued for the next bar.
  h = stackHarness({ selected: 2, markers: demoMarkers(12) });
  h.playing(true);
  h.songPos(26, 3);
  h.press("scene");
  h.pad(10);
  await writeScene("scene-queued", h);
  // SCENE stopped, pinned, NOW on, without a queued jump.
  h = stackHarness({ selected: 2, markers: demoMarkers(12) });
  h.songPos(9, 1);
  h.press("scene");
  h.tap("display1");
  h.tap("display2");
  await writeScene("scene", h);
  h = stackHarness({ selected: 2 });
  h.press("scene");
  await writeScene("scene-none", h);

  // PATTERN: COLOR (knob 1) next to LENGTH (knob 4, 2 bars) on one page, a knob touched.
  h = stackHarness({ selected: 2, patternLength: 32, patternCount: 6 });
  h.press("pattern");
  h.touched.add(3);
  await writeScene("pattern-length", h);
  h.touched.delete(3);
  h.touched.add(0);
  await writeScene("pattern-color", h);
  h.touched.delete(0);
  // The touch strip's read-out card, in each mode (a finger on the strip).
  h = stackHarness({ selected: 2 });
  h.stripAt(0.71);
  await writeScene("strip-pitch", h);
  h.stripAt(0, false);
  h.tap("mod");
  h.stripAt(0.68);
  await writeScene("strip-mod", h);
  h.stripAt(0, false);
  h.tap("perform");
  h.stripAt(0.62);
  await writeScene("strip-cutoff", h);
  h.stripAt(0, false);
  h.tap("notes");
  h.stripAt(0.3);
  await writeScene("strip-notes", h);
  // PATTERN right after DOUBLE: the read-out card on the left, the free slots (+) on the right.
  h = stackHarness({ selected: 2, patternLength: 16, patternCount: 6 });
  h.press("pattern");
  h.tap("display3");
  await writeScene("pattern-double", h);

  // LOOP (hold SHIFT + RESTART): bars 5–9 looped, with the markers' grid and without markers (the ruler).
  h = stackHarness({ selected: 2, markers: demoMarkers(12), ppq: 96 });
  h.loopState(true, 8 * 384, 16 * 384);
  h.state.shift = true;
  h.press("restart");
  h.advance(400);
  h.state.shift = false;
  await writeScene("loop-markers", h);
  h = stackHarness({ selected: 2 });
  h.loopState(true, 4 * 384, 8 * 384);
  h.state.shift = true;
  h.press("restart");
  h.advance(400);
  h.state.shift = false;
  h.touched.add(1);
  await writeScene("loop", h);
  h.touched.delete(1);

  // LIVE (SHIFT + SCENE): FL playing, bar 9 beat 2, five tracks of performance-mode clips; Bass
  // plays scene 2 and has scene 3 queued, Keys is muted, Vox soloed.
  h = stackHarness({ selected: 2 });
  h.state.shift = true;
  h.press("scene");
  h.state.shift = false;
  h.playing(true);
  h.songPos(9, 5, 0);
  {
    const F = 1;
    const S = 2;
    const P = 4;
    const clip = (status: number, color: number) => ({ status, color });
    const empty = { status: 0, color: 0 };
    // Clips have their pattern's color, so each is named by the one pattern of that color.
    h.fl.apply({
      type: "patterns",
      count: 5,
      offset: 0,
      entries: [
        { current: true, color: 0xe0707a, name: "Beat" },
        { current: false, color: 0x5aa9e6, name: "Bassline" },
        { current: false, color: 0xeec54e, name: "Pattern 3" },
        { current: false, color: 0x4ae4a8, name: "Vocal Chops" },
        { current: false, color: 0xa678de, name: "Riser" },
      ],
    });
    h.liveGrid({ scanned: 8 });
    h.liveTrack(
      1,
      [clip(F, 0xe0707a), clip(F | P, 0xe0707a), clip(F, 0xe0707a), clip(F, 0xe0707a)],
      {
        name: "Drums",
        color: 0xe0707a,
      },
    );
    h.liveTrack(
      2,
      [clip(F, 0x5aa9e6), clip(F | P, 0x5aa9e6), clip(F | S, 0x5aa9e6), empty, clip(F, 0x5aa9e6)],
      {
        name: "Bass",
        color: 0x5aa9e6,
      },
    );
    h.liveTrack(3, [empty, clip(F, 0xeec54e), clip(F, 0xeec54e)], {
      name: "Keys",
      color: 0xeec54e,
      muted: true,
    });
    h.liveTrack(4, [clip(F, 0x4ae4a8), empty, clip(F | P, 0x4ae4a8)], {
      name: "Vox",
      color: 0x4ae4a8,
      solo: true,
    });
    h.liveTrack(5, [empty, empty, empty, clip(F, 0xa678de)], {
      name: "FX Risers and Sweeps",
      color: 0xa678de,
    });
    for (let t = 6; t <= 8; t++) h.liveTrack(t, []);
  }
  await writeScene("live", h);

  // KEYBOARD in C Minor (knob 1 scale: 2 detents = Major, Minor), the root pads brighter.
  h = stackHarness({ selected: 2 });
  h.tap("keyboard");
  h.knob(0, 240);
  h.touched.add(0);
  await writeScene("keyboard-cminor", h);
  h.touched.delete(0);

  // CHORDS, harmonizer: C Minor, Seventh chords, one inversion, a pad held.
  h = stackHarness({ selected: 2 });
  h.tap("chords");
  h.knob(0, 240); // Minor
  h.knob(2, 240); // Triad -> Seventh
  h.knob(3, 120); // position 1
  h.pad(2);
  await writeScene("chords-harmonizer", h);
  // CHORDS, chord set: the diatonic triads and sevenths of C Minor.
  h = stackHarness({ selected: 2 });
  h.tap("chords");
  h.knob(0, 240);
  h.knob(1, 120); // Chord set
  h.touched.add(1);
  await writeScene("chords-set", h);
  h.touched.delete(1);

  // SHIFT + pad feedback on the left screen: undo and redo show FL's hint and position / count.
  h = stackHarness({ selected: 2 });
  h.state.shift = true;
  h.pad(0);
  h.undoState(4, 12, "MK3: clear steps");
  await writeScene("shift-undo", h);
  h = stackHarness({ selected: 2 });
  h.state.shift = true;
  h.pad(1);
  h.undoState(5, 12, "MK3: paste steps");
  await writeScene("shift-redo", h);
  // copy, paste, clear and quantize name the channel (copy: how many steps of it)
  const channelActions: [string, number][] = [
    ["shift-copy", 10],
    ["shift-paste", 11],
    ["shift-clear", 8],
    ["shift-quantize", 4],
  ];
  for (const [name, pad] of channelActions) {
    h = stackHarness({ selected: 2 });
    h.state.shift = true;
    h.pad(pad);
    await writeScene(name, h);
  }
  // octave +: the new range of the KEYBOARD pads
  h = stackHarness({ selected: 2 });
  h.state.shift = true;
  h.pad(15);
  await writeScene("shift-octave", h);

  // The pad LEDs while SHIFT is held, one pad pressed (pad 2: redo).
  h = stackHarness({ selected: 2 });
  h.state.shift = true;
  h.pad(1);
  await writePadLeds("shift-pads", h);
}

void main();
