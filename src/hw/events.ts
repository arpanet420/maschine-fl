import type { ButtonId, Jack, NavDirection } from "./ids.js";

export interface ButtonEvent {
  type: "button";
  id: ButtonId;
  pressed: boolean;
}

/** pressure and velocity are 0–1. velocity is only set on "down". */
export interface PadEvent {
  type: "pad";
  pad: number;
  phase: "down" | "move" | "up";
  pressure: number;
  velocity?: number;
}

/** delta is in encoder steps; positive = clockwise. */
export interface EncoderEvent {
  type: "encoder";
  index: number;
  delta: number;
}

export interface EncoderTouchEvent {
  type: "encoderTouch";
  index: number;
  touched: boolean;
}

export type NavEvent =
  | { type: "nav"; action: "turn"; delta: number }
  | { type: "nav"; action: "push"; pressed: boolean }
  | { type: "nav"; action: "touch"; touched: boolean }
  | { type: "nav"; action: "tilt"; direction: NavDirection; pressed: boolean };

/** position is 0–1, left to right. */
export interface StripEvent {
  type: "strip";
  position: number;
  touched: boolean;
}

export interface JackEvent {
  type: "jack";
  jack: Jack;
  connected: boolean;
}

export type HwEvent =
  ButtonEvent | PadEvent | EncoderEvent | EncoderTouchEvent | NavEvent | StripEvent | JackEvent;
