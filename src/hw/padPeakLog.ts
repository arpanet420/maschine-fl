// `--log-pads`: how a hit's first value compares with its peak over the next reports. Deckard takes the
// peak of the first 3 reports as the velocity; this measures whether that would change anything here
// before mk3d changes how it reads a hit.

export const PEAK_REPORTS = 3;

interface PeakRun {
  on: number;
  peak: number;
  left: number;
}

export class PadPeakLog {
  private readonly runs = new Map<number, PeakRun>();

  constructor(private readonly log: (line: string) => void) {}

  /** `pressure` is 0–1. A run ends after `PEAK_REPORTS` moves or at the release. */
  onPad(pad: number, phase: "down" | "move" | "up", pressure: number): void {
    if (phase === "down") {
      this.runs.set(pad, { on: pressure, peak: pressure, left: PEAK_REPORTS });
      return;
    }
    const run = this.runs.get(pad);
    if (!run) return;
    if (phase === "move") {
      run.peak = Math.max(run.peak, pressure);
      run.left--;
      if (run.left > 0) return;
    }
    this.runs.delete(pad);
    const on = Math.round(run.on * 4095);
    const peak = Math.round(run.peak * 4095);
    const rise = on > 0 ? Math.round((peak / on - 1) * 100) : 0;
    this.log(`pad ${pad + 1} hit value ${on}, peak of the next reports ${peak} (+${rise} %)`);
  }
}
