// A bug in a page must not take the daemon down, or the MK3 with it. What failed goes to the log and
// across the bottom of the left screen for a while; the pads keep playing and the other pages work.
import type { SKRSContext2D } from "@napi-rs/canvas";
import { fitText, font } from "./render/widgets.js";

/** How long a fault stays on the screen, and how often the same one is logged. */
export const FAULT_SHOW_MS = 5000;
const BAR_HEIGHT = 24;
const SCREEN = { width: 480, height: 272 };

export class FaultReporter {
  private message: string | undefined;
  private shownUntil = 0;
  private lastLogged = "";
  private lastLoggedAt = -Infinity;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number = () => performance.now(),
    /** The fault appeared or its time on the screen ended: draw again. */
    private readonly changed: () => void = () => undefined,
  ) {}

  /** The text on the screen now, if any. */
  get shown(): string | undefined {
    return this.now() < this.shownUntil ? this.message : undefined;
  }

  report(where: string, err: unknown): void {
    const text = err instanceof Error ? err.message : String(err);
    const message = `${where}: ${text}`;
    const now = this.now();
    if (message !== this.lastLogged || now - this.lastLoggedAt >= FAULT_SHOW_MS) {
      this.lastLogged = message;
      this.lastLoggedAt = now;
      this.log(`FAULT ${message}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
    }
    this.message = message;
    this.shownUntil = now + FAULT_SHOW_MS;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changed(), FAULT_SHOW_MS + 1);
    this.timer.unref();
  }

  /** Runs `task`; a throw is reported and `fallback` comes back. */
  guard<T>(where: string, task: () => T, fallback: T): T {
    try {
      return task();
    } catch (err) {
      this.report(where, err);
      return fallback;
    }
  }

  /** The bar across the bottom of the left screen, over whatever is there. */
  draw(ctx: SKRSContext2D): void {
    const message = this.shown;
    if (message === undefined) return;
    ctx.fillStyle = "#b3261e";
    ctx.fillRect(0, SCREEN.height - BAR_HEIGHT, SCREEN.width, BAR_HEIGHT);
    ctx.fillStyle = "#ffffff";
    ctx.font = font(13, "bold");
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(fitText(ctx, message, SCREEN.width - 16), 8, SCREEN.height - BAR_HEIGHT / 2);
  }
}
