// Names for every MK3 control, following the text printed on the panel.
// Bit positions are from docs/protocol.md (input report 0x01).

export const REPORT_CONTROLS = 0x01;
export const REPORT_PADS = 0x02;

export const BUTTONS = [
  "channel",
  "plugIn",
  "arranger",
  "mixer",
  "browser",
  "sampling",
  "file",
  "settings",
  "auto",
  "macro",
  "arrowLeft",
  "arrowRight",
  "display1",
  "display2",
  "display3",
  "display4",
  "display5",
  "display6",
  "display7",
  "display8",
  "volume",
  "swing",
  "noteRepeat",
  "tempo",
  "lock",
  "pitch",
  "mod",
  "perform",
  "notes",
  "restart",
  "erase",
  "tap",
  "follow",
  "play",
  "rec",
  "stop",
  "shift",
  "fixedVel",
  "padMode",
  "keyboard",
  "chords",
  "step",
  "scene",
  "pattern",
  "events",
  "variation",
  "duplicate",
  "select",
  "solo",
  "mute",
  "groupA",
  "groupB",
  "groupC",
  "groupD",
  "groupE",
  "groupF",
  "groupG",
  "groupH",
] as const;
export type ButtonId = (typeof BUTTONS)[number];

export type NavDirection = "up" | "down" | "left" | "right";
export type Jack = "pedal" | "mic";

export type BitTarget =
  | { kind: "button"; id: ButtonId }
  | { kind: "navPush" }
  | { kind: "navTouch" }
  | { kind: "navTilt"; direction: NavDirection }
  | { kind: "knobTouch"; index: number }
  | { kind: "jack"; jack: Jack };

const button = (id: ButtonId): BitTarget => ({ kind: "button", id });
const tilt = (direction: NavDirection): BitTarget => ({ kind: "navTilt", direction });
const knobTouch = (index: number): BitTarget => ({ kind: "knobTouch", index });

// [byte, mask, target]. Bits not listed here are unmapped; inputlog --raw shows them.
export const CONTROL_BITS: ReadonlyArray<readonly [number, number, BitTarget]> = [
  [1, 0x01, { kind: "navPush" }],
  [1, 0x02, { kind: "jack", jack: "pedal" }],
  [1, 0x04, tilt("up")],
  [1, 0x08, tilt("right")],
  [1, 0x10, tilt("down")],
  [1, 0x20, tilt("left")],
  [1, 0x40, button("shift")],
  [1, 0x80, button("display8")],
  [2, 0x01, button("groupA")],
  [2, 0x02, button("groupB")],
  [2, 0x04, button("groupC")],
  [2, 0x08, button("groupD")],
  [2, 0x10, button("groupE")],
  [2, 0x20, button("groupF")],
  [2, 0x40, button("groupG")],
  [2, 0x80, button("groupH")],
  [3, 0x01, button("notes")],
  [3, 0x02, button("volume")],
  [3, 0x04, button("swing")],
  [3, 0x08, button("tempo")],
  [3, 0x10, button("noteRepeat")],
  [3, 0x20, button("lock")],
  [4, 0x01, button("padMode")],
  [4, 0x02, button("keyboard")],
  [4, 0x04, button("chords")],
  [4, 0x08, button("step")],
  [4, 0x10, button("fixedVel")],
  [4, 0x20, button("scene")],
  [4, 0x40, button("pattern")],
  [4, 0x80, button("events")],
  [5, 0x01, { kind: "jack", jack: "mic" }],
  [5, 0x02, button("variation")],
  [5, 0x04, button("duplicate")],
  [5, 0x08, button("select")],
  [5, 0x10, button("solo")],
  [5, 0x20, button("mute")],
  [5, 0x40, button("pitch")],
  [5, 0x80, button("mod")],
  [6, 0x01, button("perform")],
  [6, 0x02, button("restart")],
  [6, 0x04, button("erase")],
  [6, 0x08, button("tap")],
  [6, 0x10, button("follow")],
  [6, 0x20, button("play")],
  [6, 0x40, button("rec")],
  [6, 0x80, button("stop")],
  [7, 0x01, button("macro")],
  [7, 0x02, button("settings")],
  [7, 0x04, button("arrowRight")],
  [7, 0x08, button("sampling")],
  [7, 0x10, button("mixer")],
  [7, 0x20, button("plugIn")],
  [8, 0x01, button("channel")],
  [8, 0x02, button("arranger")],
  [8, 0x04, button("browser")],
  [8, 0x08, button("arrowLeft")],
  [8, 0x10, button("file")],
  [8, 0x20, button("auto")],
  [9, 0x01, button("display1")],
  [9, 0x02, button("display2")],
  [9, 0x04, button("display3")],
  [9, 0x08, button("display4")],
  [9, 0x10, button("display5")],
  [9, 0x20, button("display6")],
  [9, 0x40, button("display7")],
  [9, 0x80, { kind: "navTouch" }],
  [10, 0x01, knobTouch(7)],
  [10, 0x02, knobTouch(6)],
  [10, 0x04, knobTouch(5)],
  [10, 0x08, knobTouch(4)],
  [10, 0x10, knobTouch(3)],
  [10, 0x20, knobTouch(2)],
  [10, 0x40, knobTouch(1)],
  [10, 0x80, knobTouch(0)],
];

export const BUTTON_BYTES = { first: 1, last: 10 } as const;
export const NAV_WHEEL_BYTE = 11; // low nibble: 4D encoder rotation counter 0–15
export const KNOB_FIRST_BYTE = 12; // 8 knobs, 16-bit little-endian, knob i at 12 + 2i
export const KNOB_COUNT = 8;
// Endless knobs count 0–999 and wrap (Checkpoint 1: raw 992 -> 12 on a clockwise turn).
export const KNOB_RANGE = 1000;
export const STRIP_POSITION_BYTE = 30; // 16-bit little-endian
export const STRIP_MAX = 1024;
export const PAD_COUNT = 16;

/**
 * mk3d numbers pads as Maschine does: pad 0 (Maschine's pad 1) is the bottom-left pad, rows go
 * up. The device numbers them from the top-left. Flipping the rows converts either way.
 */
export const panelPad = (pad: number): number => (3 - Math.floor(pad / 4)) * 4 + (pad % 4);
export const PAD_PRESSURE_MAX = 4095;
