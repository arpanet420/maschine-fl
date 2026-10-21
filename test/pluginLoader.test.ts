// The plug-in loader: BROWSER's PLUG-INS source = FL's Plugin picker (BROWSE pluginPicker, UI_KEY), and the wire format of the trial messages.
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { FROM_FL, TO_FL } from "../src/fl/protocol.js";
import {
  decodeCommand,
  decodeSysex,
  encodeCommand,
  encodeFlMessage,
  type BrowserNodeInfo,
} from "../src/fl/sysex.js";
import { stackHarness, type StackHarness } from "../src/tools/stackHarness.js";

const frame = (command: number, payload: number[]) => [
  0xf0,
  0x7d,
  0x4d,
  0x33,
  command,
  ...payload,
  0xf7,
];

const node = (patch: Partial<BrowserNodeInfo> = {}): BrowserNodeInfo => ({
  caption: "Diva",
  fileType: -1,
  popup: false,
  browserFocused: true,
  otherFormFocused: false,
  formCaption: "Browser",
  hint: "Plugin database",
  ...patch,
});

const CLOSED = "PUSH PLUG-INS (display 2) TO OPEN FL'S PLUGIN PICKER";

const open = (source: "presets" | "plugins" = "plugins") => {
  const h = stackHarness();
  h.tap("browser");
  if (source === "plugins") h.tap("display2");
  h.sent.length = 0;
  return h;
};

/** FL's channel count grows by one (the picker added a plugin as a new channel). */
const addChannel = (h: StackHarness, name = "Diva") => {
  const total = h.fl.channelTotal + 1;
  h.fl.apply({
    type: "channels",
    total,
    offset: total - 1,
    entries: [{ selected: true, muted: false, solo: false, color: 0x4ae4a8, name }],
  });
  h.fl.apply({
    type: "selectedChannel",
    index: total - 1,
    color: 0x4ae4a8,
    volume: 0.78,
    pan: 0,
    name,
    plugin: name,
  });
  h.stack.onFlChange("channels", h.mc);
  h.stack.onFlChange("selectedChannel", h.mc);
};

interface Drawn {
  text: string;
  x: number;
}
function draw(h: StackHarness): { left: Drawn[]; right: Drawn[] } {
  const left = createCanvas(480, 272).getContext("2d");
  const right = createCanvas(480, 272).getContext("2d");
  const result = { left: [] as Drawn[], right: [] as Drawn[] };
  const record = (ctx: SKRSContext2D, into: Drawn[]) => {
    const original = ctx.fillText.bind(ctx);
    ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      into.push({ text, x });
      original(text, x, y, maxWidth);
    };
  };
  record(left, result.left);
  record(right, result.right);
  h.stack.render(left, right, h.mc);
  return result;
}
const texts = (drawn: Drawn[]) => drawn.map((d) => d.text);

describe("plug-in loader trial: wire format", () => {
  it("uses the free codes", () => {
    expect(FROM_FL.browserNode).toBe(0x1e);
    expect([TO_FL.browse, TO_FL.uiKey, TO_FL.picker]).toEqual([0x67, 0x68, 0x69]);
  });

  it("encodes BROWSE and UI_KEY as one u7", () => {
    expect(encodeCommand({ type: "browse", action: "show" })).toEqual(frame(0x67, [0]));
    expect(encodeCommand({ type: "browse", action: "preview" })).toEqual(frame(0x67, [5]));
    expect(encodeCommand({ type: "uiKey", key: "closePopup" })).toEqual(frame(0x68, [6]));
  });

  it("encodes PICKER with the mode as s7, −1 = left out", () => {
    expect(encodeCommand({ type: "picker", show: true, mode: null })).toEqual(frame(0x69, [1, 63]));
    expect(encodeCommand({ type: "picker", show: false, mode: 3 })).toEqual(frame(0x69, [0, 67]));
    expect(decodeCommand(frame(0x69, [1, 63]))).toEqual({ type: "picker", show: true, mode: null });
    expect(decodeCommand(frame(0x69, [1, 66]))).toEqual({ type: "picker", show: true, mode: 2 });
  });

  it("rejects unknown BROWSE actions and keys", () => {
    expect(decodeCommand(frame(0x67, [9]))).toBeUndefined();
    expect(decodeCommand(frame(0x68, [7]))).toBeUndefined();
  });

  it("carries a folder's file type below −100 through the +8192 bias", () => {
    const message = { type: "browserNode" as const, ...node({ fileType: -4000, popup: true }) };
    const decoded = decodeSysex(encodeFlMessage(message));
    expect(decoded).toEqual(message);
  });

  it("cuts BROWSER_NODE strings to 40 characters", () => {
    const message = { type: "browserNode" as const, ...node({ caption: "c".repeat(60) }) };
    const decoded = decodeSysex(encodeFlMessage(message));
    expect(decoded?.type === "browserNode" && decoded.caption).toBe("c".repeat(40));
  });

  it("decodes the flags into FlState", () => {
    const h = stackHarness();
    h.fl.apply({ type: "browserNode", ...node({ popup: true, otherFormFocused: true }) });
    expect(h.fl.browserNode).toMatchObject({
      caption: "Diva",
      popup: true,
      otherFormFocused: true,
    });
    const flags = encodeFlMessage({
      type: "browserNode",
      ...node({ popup: true, browserFocused: false }),
    });
    expect(decodeSysex(flags)).toMatchObject({ popup: true, browserFocused: false });
  });

  it("reports the missing browser functions in FEATURES", () => {
    const h = stackHarness();
    h.features({ browser: true });
    expect(h.fl.missing).toMatchObject({ browser: true, picker: false });
  });
});

describe("BROWSER sources", () => {
  it("has two source tabs on the left screen, display 3 dark", () => {
    const h = open("presets");
    const left = texts(draw(h).left);
    expect(left).toEqual(expect.arrayContaining(["PRESETS", "PLUG-INS"]));
    expect(left).not.toContain("PICKER");
    expect(h.light("display1")).toBe("bright");
    expect(h.light("display2")).toBe("dim");
    expect(h.light("display3")).toBe("off");
    h.tap("display3");
    expect(h.sent).toEqual([]);
  });

  it("watches the presets only on the PRESETS source", () => {
    const h = stackHarness();
    h.tap("browser");
    expect(h.views.at(-1)?.presets).toBe(true);
    h.tap("display2");
    expect(h.views.at(-1)?.presets).toBe(false);
    h.tap("display1");
    expect(h.views.at(-1)?.presets).toBe(true);
  });

  it("falls back to PRESETS when the page is entered again", () => {
    const h = open();
    h.tap("browser");
    h.tap("browser");
    expect(texts(draw(h).left)).toContain("PRESETS");
    expect(h.views.at(-1)?.presets).toBe(true);
  });
});

describe("PLUG-INS = FL's Plugin picker", () => {
  it("display 2 sends pluginPicker and shows the help; pressed again it closes", () => {
    const h = open("presets");
    h.tap("display2");
    expect(h.sent).toEqual([{ type: "browse", action: "pluginPicker" }]);
    const { left, right } = draw(h);
    expect(texts(left)).toEqual(
      expect.arrayContaining([
        "PLUG-IN PICKER",
        "Turn 4D: browse",
        "Tilt 4D < >: category",
        "Push 4D: add as new channel",
        "Shown in FL Studio",
      ]),
    );
    expect(texts(right)).toContain("CLOSE");
    h.tap("display2");
    expect(h.sentOf("browse")).toHaveLength(2);
    expect(texts(draw(h).left).join(" ")).toContain(CLOSED);
    expect(texts(draw(h).right)).not.toContain("CLOSE");
  });

  it("maps 4D turn and tilt to UI keys and push to enter", () => {
    const h = open();
    h.sent.length = 0;
    h.turn(1);
    h.advance(1000);
    h.turn(-1);
    h.tilt("left");
    h.tilt("right");
    h.advance(1000);
    h.tilt("up");
    h.advance(1000);
    h.tilt("down");
    expect(h.sentOf("uiKey").map((c) => c.key)).toEqual([
      "down",
      "up",
      "left",
      "right",
      "up",
      "down",
    ]);
    h.push();
    expect(h.sentOf("uiKey").at(-1)).toEqual({ type: "uiKey", key: "enter" });
    expect(h.sentOf("browse")).toEqual([]);
  });

  it("sends nothing from the 4D while the picker is closed", () => {
    const h = open();
    h.tap("display2"); // closed
    h.sent.length = 0;
    h.turn(1);
    h.tilt("left");
    h.push();
    expect(h.sent).toEqual([]);
  });

  it("sends at most about 15 keys per second", () => {
    const h = open();
    h.sent.length = 0;
    for (let i = 0; i < 30; i++) {
      h.turn(1);
      h.advance(10);
    }
    const sent = h.sentOf("uiKey").length;
    expect(sent).toBeGreaterThanOrEqual(4);
    expect(sent).toBeLessThanOrEqual(7);
    h.advance(1000);
    h.turn(1);
    expect(h.sentOf("uiKey")).toHaveLength(sent + 1);
  });

  it("push closes the state and returns to PRESETS", () => {
    const h = open();
    h.push();
    expect(texts(draw(h).left)).toContain("PRESETS");
    expect(h.views.at(-1)?.presets).toBe(true);
    h.sent.length = 0;
    h.tap("browser"); // leaving: nothing to close any more
    expect(h.sentOf("uiKey")).toEqual([]);
  });

  it("CLOSE on display 8 toggles the picker again and stays on PLUG-INS", () => {
    const h = open();
    h.sent.length = 0;
    h.tap("display8");
    expect(h.sent).toEqual([{ type: "browse", action: "pluginPicker" }]);
    expect(texts(draw(h).left).join(" ")).toContain(CLOSED);
    h.tap("display8");
    expect(h.sent).toHaveLength(1);
  });

  it("leaving the page or switching to PRESETS while it is open sends escape", () => {
    const h = open();
    h.tap("browser");
    expect(h.sentOf("uiKey")).toEqual([{ type: "uiKey", key: "escape" }]);
    const g = open();
    g.tap("display1");
    expect(g.sentOf("uiKey")).toEqual([{ type: "uiKey", key: "escape" }]);
    expect(g.views.at(-1)?.presets).toBe(true);
    g.tap("browser");
    expect(g.sentOf("uiKey")).toHaveLength(1);
    const p = open("presets");
    p.tap("browser");
    expect(p.sentOf("uiKey")).toEqual([]);
  });

  it("shows the ADDED card when the channel count grows within 3 s of the push", () => {
    const h = open();
    h.push();
    h.advance(800);
    addChannel(h, "Diva");
    const text = texts(draw(h).left);
    expect(text).toEqual(expect.arrayContaining(["ADDED", "Diva"]));
    expect(h.log.some((l) => l.includes("ADDED") || l.includes("added"))).toBe(true);
  });

  it("shows no card when the channel arrives too late or the count does not grow", () => {
    const h = open();
    h.push();
    h.advance(4000);
    addChannel(h);
    expect(texts(draw(h).left)).not.toContain("ADDED");
    const g = open();
    g.push();
    g.stack.onFlChange("channels", g.mc);
    expect(texts(draw(g).left)).not.toContain("ADDED");
  });

  it("keeps labels on their own screen", () => {
    const h = open();
    const { left, right } = draw(h);
    expect(texts(left)).not.toContain("CLOSE");
    expect(texts(right)).toContain("CLOSE");
    for (const label of ["PRESETS", "PLUG-INS"]) {
      expect(texts(right), label).not.toContain(label);
    }
    for (const line of ["PLUG-IN PICKER", "Turn 4D: browse"]) {
      expect(texts(right), line).not.toContain(line);
    }
  });
});
