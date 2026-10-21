// SETTINGS (a tool page, latched). mk3d's own settings, saved with the page stack's state file
// (`pages.settings`): knob 1 = the pad's full-scale hit (the hit value that gives velocity 127), knob
// 2 = the pad curve (exponent; below 1 makes soft hits louder), knob 3 = the fixed velocity value
// (1–127, used while FIXED VEL is on; the FIXED VEL button toggles it, in the page stack). The pad
// processor reads the same PadConfig object, so a change counts from the next hit; at start-up the
// saved values are used unless the command line gave `--velocity-full` or `--velocity-curve`.
//
// Left screen: the velocity curve of the current settings (hit value on x, velocity on y; with FIXED
// VEL on the curve is dimmed and the fixed line is drawn) and the three knobs under their columns.
// Right screen: the same values as text.
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import { PAD_PRESSURE_MAX } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import {
  TAB_HEIGHT,
  clear,
  drawKnobRow,
  drawTabs,
  font,
  theme,
  type KnobProps,
} from "../render/widgets.js";
import { FULL } from "./draw.js";
import { knobStep } from "./knob.js";
import type { Mode, ModeContext } from "./mode.js";
import {
  EXPONENT_MAX,
  EXPONENT_MIN,
  FIXED_VELOCITY_MAX,
  FIXED_VELOCITY_MIN,
  FULL_SCALE_MAX,
  FULL_SCALE_MIN,
  type PadSettings,
} from "./padSettings.js";
import type { RepeatTimers } from "./repeatScheduler.js";
import { realTimers } from "./repeatScheduler.js";
import { DISPLAY_BUTTONS } from "./channelPadPage.js";

/** The settings are written this long after the last knob turn. */
const SAVE_DELAY_MS = 400;
const KNOB_ROW = { ...FULL, y: FULL.height - 110, height: 110 };
const GRAPH = { x: 56, y: TAB_HEIGHT + 22, width: 384, height: 96 };

export interface SettingsOptions {
  timers?: RepeatTimers;
}

export class SettingsPage implements Mode {
  readonly name = "settings";
  private readonly timers: RepeatTimers;
  private saveTimer: unknown;
  private mc: ModeContext | undefined;

  constructor(
    private readonly settings: PadSettings,
    options: SettingsOptions = {},
  ) {
    this.timers = options.timers ?? realTimers;
  }

  readonly persisted = {
    save: () => this.settings.persisted.save(),
    load: (data: unknown) => this.settings.persisted.load(data),
  };

  enter(mc: ModeContext): void {
    this.mc = mc;
  }

  /** Closed: write what is still waiting to be saved. */
  leave(): void {
    if (this.saveTimer === undefined) return;
    this.timers.clear(this.saveTimer);
    this.saveTimer = undefined;
    this.mc?.saveState?.();
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    this.mc = mc;
    if (event.type !== "encoder" || event.index > 2) return false;
    const step = knobStep(event.delta, mc.shift);
    const s = this.settings;
    if (event.index === 0) s.fullScale += step * (FULL_SCALE_MAX - FULL_SCALE_MIN);
    else if (event.index === 1) s.exponent += step * (EXPONENT_MAX - EXPONENT_MIN);
    else s.nudgeFixed(step * (FIXED_VELOCITY_MAX - FIXED_VELOCITY_MIN));
    this.timers.clear(this.saveTimer);
    this.saveTimer = this.timers.set(() => {
      this.saveTimer = undefined;
      mc.saveState?.();
    }, SAVE_DELAY_MS);
    mc.requestRender();
    return true;
  }

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const s = this.settings;
    const touched = (knob: number) => mc.touchedKnobs.has(knob);

    clear(left, FULL);
    drawTabs(left, { ...FULL, height: TAB_HEIGHT }, { tabs: ["SETTINGS"], active: [0] });
    this.drawCurve(left);
    const knobs: KnobProps[] = [
      {
        label: "Full scale",
        valueText: String(Math.round(s.fullScale)),
        value: (s.fullScale - FULL_SCALE_MIN) / (FULL_SCALE_MAX - FULL_SCALE_MIN),
        touched: touched(0),
      },
      {
        label: "Curve",
        valueText: s.exponent.toFixed(2),
        value: (s.exponent - EXPONENT_MIN) / (EXPONENT_MAX - EXPONENT_MIN),
        touched: touched(1),
      },
      {
        label: "Fixed vel",
        valueText: String(s.fixedVelocity),
        value: (s.fixedVelocity - FIXED_VELOCITY_MIN) / (FIXED_VELOCITY_MAX - FIXED_VELOCITY_MIN),
        color: s.fixedOn ? theme.accent : theme.knobRim,
        touched: touched(2),
      },
    ];
    drawKnobRow(left, KNOB_ROW, knobs);

    clear(right, FULL);
    drawTabs(right, { ...FULL, height: TAB_HEIGHT }, { tabs: [] });
    right.textAlign = "left";
    right.textBaseline = "top";
    // Knob values stay on the left screen (Layout rule); the right one shows the FIXED VEL button's
    // state and what the knobs mean.
    right.fillStyle = theme.dimText;
    right.font = font(15);
    right.fillText("FIXED VEL", 24, TAB_HEIGHT + 20);
    right.fillStyle = s.fixedOn ? theme.accent : theme.text;
    right.font = font(30, "bold");
    right.fillText(s.fixedOn ? "ON" : "OFF", 24, TAB_HEIGHT + 40);
    right.fillStyle = theme.dimText;
    right.font = font(13);
    right.fillText(
      s.fixedOn ? "every pad plays the Fixed vel value" : "pads play the hit's velocity",
      24,
      TAB_HEIGHT + 74,
    );
    const hints = [
      "Full scale: the hit value that gives velocity 127",
      "Curve: below 1 makes soft hits louder",
      "Fixed vel: the velocity used while FIXED VEL is on",
    ];
    hints.forEach((hint, i) => right.fillText(hint, 24, TAB_HEIGHT + 130 + i * 24));
  }

  /** Hit value (x) against velocity (y) for the current settings, and the fixed line when it is on. */
  private drawCurve(ctx: SKRSContext2D): void {
    const s = this.settings;
    const { x, y, width, height } = GRAPH;
    ctx.fillStyle = theme.background;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = theme.line;
    for (let i = 0; i <= 4; i++) ctx.fillRect(Math.round(x + (i * width) / 4), y, 1, height);
    ctx.fillRect(x, y + height - 1, width, 1);
    const toY = (velocity: number) => y + height - (velocity / 127) * height;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.fixedOn ? theme.knobRim : theme.accent;
    ctx.beginPath();
    for (let px = 0; px <= width; px += 2) {
      const hit = (px / width) * PAD_PRESSURE_MAX;
      const velocity = Math.round(s.curve(hit) * 126) + 1;
      if (px === 0) ctx.moveTo(x, toY(velocity));
      else ctx.lineTo(x + px, toY(velocity));
    }
    ctx.stroke();
    if (s.fixedOn) {
      ctx.strokeStyle = theme.selected;
      ctx.beginPath();
      ctx.moveTo(x, toY(s.fixedVelocity));
      ctx.lineTo(x + width, toY(s.fixedVelocity));
      ctx.stroke();
    }
    ctx.fillStyle = theme.dimText;
    ctx.font = font(12);
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    ctx.fillText("127", x - 6, y + 2);
    ctx.fillText("1", x - 6, y + height - 4);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("velocity by hit value", x + width / 2, y + height + 3);
  }

  leds(leds: LedState): void {
    for (const id of DISPLAY_BUTTONS) leds.setLight(id, "off");
    leds.setLight("display1", "bright"); // a tool page is always latched
  }
}
