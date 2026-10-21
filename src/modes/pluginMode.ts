// Plugin mode: the knobs drive the selected channel's own plugin (u-he Diva, ...), so its GUI
// knobs move. Pages of 8 parameters come from a PageSource (FL's parameter list for now). Each
// screen owns the controls above and below it: display buttons 1–4 and knobs 1–4 belong to the
// left screen, 5–8 to the right one; the tabs are the pages of the current bank of 8.
import { loadImage } from "@napi-rs/canvas";
import type { Image, SKRSContext2D } from "@napi-rs/canvas";
import type { HwEvent } from "../hw/events.js";
import type { ButtonId } from "../hw/ids.js";
import type { LedState } from "../hw/leds.js";
import type { Rect } from "../hw/display.js";
import type { FlSection, FlState } from "../fl/flState.js";
import {
  SCREEN_COLUMNS,
  TAB_HEIGHT,
  clear,
  columns,
  drawKnobRow,
  drawTabs,
  fitText,
  font,
  theme,
} from "../render/widgets.js";
import type { KnobProps } from "../render/widgets.js";
import { pageStart } from "./channelMode.js";
import { FULL, drawBand, drawTransportBar } from "./draw.js";
import { flColorToCss, pct } from "./format.js";
import { RenderSoon, clamp, isLive, knobStep } from "./knob.js";
import type { PendingValue } from "./knob.js";
import type { Mode, ModeContext, ViewCommand } from "./mode.js";
import { FlParamPages, PAGE_SIZE, paramLabel } from "./pluginPages.js";
import type { PageSource, PluginPage } from "./pluginPages.js";

const DISPLAY_BUTTONS = [
  "display1",
  "display2",
  "display3",
  "display4",
  "display5",
  "display6",
  "display7",
  "display8",
] as const;

const TABS_RECT: Rect = { ...FULL, height: TAB_HEIGHT };
const KNOB_ROW: Rect = { ...FULL, y: FULL.height - 110, height: 110 };
const TRANSPORT_STRIP: Rect = { ...FULL, y: TAB_HEIGHT + 4, height: 28 };
const MIDDLE_TOP = TAB_HEIGHT + 4;
const MIDDLE_BOTTOM = KNOB_ROW.y - 4;
/** Section row right above the knob row, when the page has sections. */
const SECTION_HEIGHT = 18;
const LOGO_MARGIN = 6;
const LOGO_MAX_SHARE = 0.4;

/** The plugin Plugin mode is driving: the selected channel's, once FL has reported it. */
interface Target {
  channel: number;
  name: string;
}

interface KnobView {
  name: string;
  props: KnobProps;
}

export class PluginMode implements Mode {
  readonly name = "plugin";
  private page = 0;
  private key = "";
  private cache: PluginPage[] | undefined;
  private lastView: string | undefined;
  /** Values we set, by parameter index, for a moment after a turn. */
  private readonly pending = new Map<number, PendingValue<number>>();
  private readonly redraw = new RenderSoon();
  /** Logos by path: the image once loaded, null when it could not be, absent while loading. */
  private readonly logos = new Map<string, Image | null>();
  private readonly loadingLogos = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly source: PageSource = new FlParamPages(),
  ) {}

  enter(mc: ModeContext): void {
    this.pending.clear();
    this.cache = undefined;
    this.syncKey(mc.fl);
    this.lastView = undefined;
    this.sendView(mc);
  }

  /** An overlay closed: resend the VIEW and keep the page. */
  resume(mc: ModeContext): void {
    this.lastView = undefined;
    this.sendView(mc);
  }

  onFlChange(section: FlSection, mc: ModeContext): void {
    if (section !== "plugin" && section !== "paramNames" && section !== "selectedChannel") return;
    this.cache = undefined;
    this.syncKey(mc.fl);
    this.sendView(mc);
  }

  onEvent(event: HwEvent, mc: ModeContext): boolean {
    switch (event.type) {
      case "encoder":
        return this.turnKnob(event.index, event.delta, mc);
      case "button":
        return this.onButton(event.id, event.pressed, mc);
      default:
        return false;
    }
  }

  /** The page source has something new (e.g. its index got ready): rebuild the pages. */
  sourceChanged(): void {
    this.cache = undefined;
  }

  // ── Target and pages ───────────────────────────────────────────────────────

  private target(fl: FlState): Target | undefined {
    const { plugin, selectedChannel } = fl;
    if (!plugin.valid || plugin.channel === null || plugin.channel !== selectedChannel.index) {
      return undefined;
    }
    return { channel: plugin.channel, name: plugin.name };
  }

  private pages(fl: FlState): PluginPage[] {
    if (!this.target(fl)) return [];
    this.cache ??= this.source.pages(fl);
    return this.cache;
  }

  /** Back to page 1 when the plugin (channel or name) is another one. */
  private syncKey(fl: FlState): void {
    const target = this.target(fl);
    const key = target ? `${target.channel}:${target.name}` : "";
    if (key !== this.key) {
      this.key = key;
      this.page = 0;
      this.pending.clear();
    }
    this.page = clamp(this.page, 0, Math.max(0, this.pages(fl).length - 1));
  }

  private current(fl: FlState): PluginPage | undefined {
    return this.pages(fl)[this.page];
  }

  /** Tell FL which parameters to report: the current page's, and the channel window. */
  view(mc: ModeContext): ViewCommand {
    const params = (this.current(mc.fl)?.params ?? []).filter((p): p is number => p !== undefined);
    const selected = mc.fl.selectedChannel.index;
    return {
      type: "view",
      channelOffset: selected === null ? 0 : pageStart(selected),
      mixerOffset: 0,
      patternOffset: 0,
      stepOffset: 0,
      meters: false,
      presets: false,
      patternGrid: false,
      params,
    };
  }

  private sendView(mc: ModeContext): void {
    const view = this.view(mc);
    const json = JSON.stringify(view);
    if (json === this.lastView) return;
    this.lastView = json;
    mc.send(view);
  }

  private setPage(page: number, mc: ModeContext): void {
    const count = this.pages(mc.fl).length;
    if (count === 0) return;
    const next = clamp(page, 0, count - 1);
    if (next === this.page) return;
    this.page = next;
    this.sendView(mc);
    mc.requestRender();
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private onButton(id: ButtonId, pressed: boolean, mc: ModeContext): boolean {
    const slot = DISPLAY_BUTTONS.findIndex((button) => button === id);
    if (slot >= 0) {
      if (pressed) this.setPage(this.bank() * PAGE_SIZE + slot, mc);
      return true;
    }
    if (id === "arrowLeft" || id === "arrowRight") {
      if (pressed) this.setPage(this.page + (id === "arrowLeft" ? -1 : 1), mc);
      return true;
    }
    return false;
  }

  /** The bank of 8 pages the tabs show. */
  private bank(): number {
    return Math.floor(this.page / PAGE_SIZE);
  }

  private turnKnob(knob: number, delta: number, mc: ModeContext): boolean {
    const { fl } = mc;
    if (!this.target(fl)) return true;
    const param = this.current(fl)?.params[knob];
    if (param === undefined) return false;
    const old = this.valueOf(param, fl);
    if (old === undefined) return true; // FL hasn't reported it yet
    const value = clamp(old + knobStep(delta, mc.shift), 0, 1);
    if (value === old) return true;
    this.pending.set(param, { value, at: this.now() });
    mc.send({ type: "setParam", param, value });
    this.redraw.request(mc);
    return true;
  }

  /** Ours for a moment after a turn, then FL's; undefined until FL has reported it. */
  private valueOf(param: number, fl: FlState): number | undefined {
    const pending = this.pending.get(param);
    return isLive(pending, this.now()) && pending
      ? pending.value
      : fl.pluginParams.get(param)?.value;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  render(left: SKRSContext2D, right: SKRSContext2D, mc: ModeContext): void {
    const { fl } = mc;
    const color = flColorToCss(fl.selectedChannel.color);
    const target = this.target(fl);
    clear(left, FULL);
    clear(right, FULL);
    drawTabs(left, TABS_RECT, { tabs: [] });
    drawTabs(right, TABS_RECT, { tabs: [] });
    drawTransportBar(right, fl, TRANSPORT_STRIP);
    if (!target) {
      const text =
        fl.selectedChannel.index === null
          ? "No channel selected"
          : `No plugin on ${fl.selectedChannel.name}`;
      for (const ctx of [left, right]) drawNotice(ctx, text);
      return;
    }

    const pages = this.pages(fl);
    const page = pages[this.page];
    const bank = this.bank() * PAGE_SIZE;
    const tabs = Array.from({ length: PAGE_SIZE }, (_, i) => pages[bank + i]?.name ?? "");
    const active = [this.page - bank];
    drawTabs(left, TABS_RECT, { tabs: tabs.slice(0, SCREEN_COLUMNS), active });
    drawTabs(right, TABS_RECT, {
      tabs: tabs.slice(SCREEN_COLUMNS),
      active: active.map((i) => i - SCREEN_COLUMNS),
    });

    const header = this.source.header?.(fl);
    // the product's color marks its section row; everything else is FL's orange and mint
    const sectionColor = header?.color ?? theme.accent;
    const logo = header?.logo === undefined ? undefined : this.logo(header.logo, mc);
    const knobs = page ? this.knobViews(page, mc) : [];
    const bottom = MIDDLE_BOTTOM - (page?.sections ? SECTION_HEIGHT : 0);
    const middle = (top: number): Rect => ({ ...FULL, y: top, height: bottom - top });
    const screens: Array<[SKRSContext2D, number, Rect]> = [
      [left, 0, middle(MIDDLE_TOP)],
      [right, SCREEN_COLUMNS, middle(TRANSPORT_STRIP.y + TRANSPORT_STRIP.height + 6)],
    ];
    for (const [ctx, base, area] of screens) {
      const views = knobs.slice(base, base + SCREEN_COLUMNS);
      drawKnobRow(
        ctx,
        KNOB_ROW,
        views.map((view, i) =>
          view ? { ...view.props, touched: mc.touchedKnobs.has(base + i) } : undefined,
        ),
      );
      if (page?.sections) {
        drawSectionRow(
          ctx,
          { ...FULL, y: KNOB_ROW.y - SECTION_HEIGHT, height: SECTION_HEIGHT },
          {
            sections: page.sections.slice(base, base + SCREEN_COLUMNS),
            before: page.sections.slice(0, base),
            color: sectionColor,
          },
        );
      }
      const touched = views.find((_, i) => mc.touchedKnobs.has(base + i));
      if (touched) drawBand(ctx, area, touched);
      else if (ctx === left) this.drawPluginInfo(ctx, area, target, mc, color, logo);
      else this.drawPageInfo(ctx, area, page, color);
    }
  }

  /** The logo at `path` once it has loaded; starts loading it (once) and asks for a redraw. */
  private logo(path: string, mc: ModeContext): Image | undefined {
    const known = this.logos.get(path);
    if (known) return known;
    if (known === undefined && !this.loadingLogos.has(path)) {
      this.loadingLogos.add(path);
      loadImage(path).then(
        (image) => this.logoLoaded(path, image, mc),
        () => this.logoLoaded(path, null, mc),
      );
    }
    return undefined;
  }

  private logoLoaded(path: string, image: Image | null, mc: ModeContext): void {
    this.loadingLogos.delete(path);
    this.logos.set(path, image);
    if (image) mc.requestRender();
  }

  private knobViews(page: PluginPage, mc: ModeContext): Array<KnobView | undefined> {
    const { fl } = mc;
    return page.params.map((param, index) => {
      if (param === undefined) return undefined;
      const info = fl.pluginParams.get(param);
      const name = info?.name || fl.paramNames.get(param) || `Parameter ${param + 1}`;
      const value = this.valueOf(param, fl);
      return {
        name,
        props: {
          label: page.labels?.[index] ?? paramLabel(page, name),
          valueText: info ? info.valueText || pct(info.value) : "…",
          value,
        },
      };
    });
  }

  /** Left middle: plugin name big, the channel in its color, and which page we are on. */
  private drawPluginInfo(
    ctx: SKRSContext2D,
    rect: Rect,
    target: Target,
    mc: ModeContext,
    color: string,
    logo: Image | undefined,
  ): void {
    const { fl } = mc;
    const textWidth = rect.width - 24 - (logo ? drawLogo(ctx, rect, logo) : 0);
    ctx.fillStyle = color;
    ctx.fillRect(rect.x, rect.y, 4, rect.height);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.text;
    ctx.font = font(30, "bold");
    ctx.fillText(fitText(ctx, target.name, textWidth), rect.x + 14, rect.y + 4);
    ctx.fillStyle = color;
    ctx.font = font(17);
    ctx.fillText(fitText(ctx, fl.selectedChannel.name, textWidth), rect.x + 14, rect.y + 44);
    const count = this.pages(fl).length;
    ctx.fillStyle = theme.dimText;
    ctx.fillText(
      count === 0 ? "No parameters" : `page ${this.page + 1} / ${count}`,
      rect.x + 14,
      rect.y + Math.min(68, rect.height - 22),
    );
  }

  /** Right middle: the current page's name. */
  private drawPageInfo(
    ctx: SKRSContext2D,
    rect: Rect,
    page: PluginPage | undefined,
    color: string,
  ): void {
    ctx.fillStyle = color;
    ctx.fillRect(rect.x, rect.y, 4, rect.height);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.text;
    ctx.font = font(30, "bold");
    ctx.fillText(fitText(ctx, page?.name ?? "–", rect.width - 24), rect.x + 14, rect.y + 4);
  }

  leds(leds: LedState, mc: ModeContext): void {
    const pages = this.pages(mc.fl).length;
    const bank = this.bank() * PAGE_SIZE;
    DISPLAY_BUTTONS.forEach((id, slot) => {
      const index = bank + slot;
      leds.setLight(id, index >= pages ? "off" : index === this.page ? "bright" : "dim");
    });
    leds.setLight("arrowLeft", this.page > 0 ? "dim" : "off");
    leds.setLight("arrowRight", this.page + 1 < pages ? "dim" : "off");
    // Channel mode's Mute is unused here; the previous frame is not cleared. GROUP A–H are the
    // channel banks (page stack).
    leds.setLight("mute", "off");
  }
}

/**
 * Draws `logo` right-aligned in `rect`, as tall as the rect allows (and at most 40 % of its
 * width), keeping its aspect. Returns the width it took, with its margin.
 */
function drawLogo(ctx: SKRSContext2D, rect: Rect, logo: Image): number {
  if (logo.width <= 0 || logo.height <= 0) return 0;
  const scale = Math.min(
    (rect.height - 2 * LOGO_MARGIN) / logo.height,
    (rect.width * LOGO_MAX_SHARE) / logo.width,
  );
  if (!(scale > 0)) return 0;
  const width = logo.width * scale;
  const height = logo.height * scale;
  ctx.drawImage(
    logo,
    rect.x + rect.width - LOGO_MARGIN - width,
    rect.y + (rect.height - height) / 2,
    width,
    height,
  );
  return width + 2 * LOGO_MARGIN;
}

interface SectionRowProps {
  /** The section starting at each of the screen's 4 columns; undefined = continues. */
  sections: ReadonlyArray<string | undefined>;
  /** The page's slots to the left of this screen, to find a section that carries over. */
  before: ReadonlyArray<string | undefined>;
  color: string;
}

/**
 * One screen's section row: a label where a section starts, over its column and the following
 * ones on this screen, with a line under the span. A section carried over from the other
 * screen is drawn again, dimmed, at this screen's first column.
 */
function drawSectionRow(ctx: SKRSContext2D, rect: Rect, props: SectionRowProps): void {
  const cells = columns(rect, SCREEN_COLUMNS);
  const starts: Array<{ column: number; text: string; dim: boolean }> = [];
  props.sections.forEach((text, column) => {
    if (text) starts.push({ column, text, dim: false });
  });
  if (!props.sections[0]) {
    const carried = props.before.findLast((text) => text);
    if (carried) starts.unshift({ column: 0, text: carried, dim: true });
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = font(12, "bold");
  starts.forEach((start, i) => {
    const first = cells[start.column];
    const last = cells[(starts[i + 1]?.column ?? SCREEN_COLUMNS) - 1];
    if (!first || !last) return;
    const x = first.x + 3;
    const width = last.x + last.width - 3 - x;
    ctx.globalAlpha = start.dim ? 0.5 : 1;
    ctx.fillStyle = props.color;
    ctx.fillText(fitText(ctx, start.text.toUpperCase(), width - 2), x + 1, rect.y + 1);
    ctx.fillRect(x, rect.y + rect.height - 3, width, 2);
    ctx.globalAlpha = 1;
  });
}

function drawNotice(ctx: SKRSContext2D, text: string): void {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.dimText;
  ctx.font = font(22, "bold");
  ctx.fillText(fitText(ctx, text, FULL.width - 24), FULL.width / 2, FULL.height / 2);
}
