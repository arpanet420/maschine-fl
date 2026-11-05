import { describe, expect, it } from "vitest";
import { FlState } from "../src/fl/flState.js";
import { ParamDump, QUIET_MS, dumpFileName, dumpText } from "../src/fl/paramDump.js";

function harness() {
  const fl = new FlState();
  const written: [string, string][] = [];
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const logs: string[] = [];
  const dump = new ParamDump({
    fl,
    folder: "out/params",
    log: (line) => logs.push(line),
    write: (path, text) => {
      written.push([path, text]);
      return Promise.resolve();
    },
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });
  fl.on("change", (section) => dump.onFlChange(section));
  const fire = async () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.run();
    await Promise.resolve();
  };
  return { fl, written, timers, logs, fire };
}

describe("ParamDump", () => {
  it("writes the names once no new one has come for a moment", async () => {
    const h = harness();
    h.fl.apply({ type: "plugin", channel: 0, valid: true, paramCount: 4240, name: "Atomika" });
    h.fl.apply({ type: "paramNames", offset: 8, names: ["Filter - Cutoff", "", "Filter - Res"] });
    h.fl.apply({ type: "paramNames", offset: 0, names: ["Echo - Off"] });
    expect(h.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
    expect(h.timers.at(-1)?.ms).toBe(QUIET_MS);
    expect(h.written).toEqual([]);
    await h.fire();
    expect(h.written).toEqual([
      [
        "out/params/Atomika.txt",
        "# Atomika: 3 named of 4240\n0\tEcho - Off\n8\tFilter - Cutoff\n10\tFilter - Res\n",
      ],
    ]);
    expect(h.logs).toEqual([
      "PLUG-IN: 3 parameter names of Atomika written to out/params/Atomika.txt",
    ]);
  });

  it("doesn't write the same list twice, or a plugin without names", async () => {
    const h = harness();
    h.fl.apply({ type: "plugin", channel: 0, valid: true, paramCount: 10, name: "OB-1" });
    await h.fire();
    expect(h.written).toEqual([]);
    h.fl.apply({ type: "paramNames", offset: 0, names: ["Cutoff"] });
    await h.fire();
    h.fl.apply({ type: "plugin", channel: 0, valid: true, paramCount: 10, name: "OB-1" });
    h.fl.apply({ type: "paramNames", offset: 0, names: ["Cutoff"] });
    await h.fire();
    expect(h.written).toHaveLength(1);
  });

  it("writes a plugin's names at once when another comes before they went quiet", async () => {
    const h = harness();
    h.fl.apply({ type: "plugin", channel: 4, valid: true, paramCount: 4240, name: "Nepheton 2" });
    h.fl.apply({ type: "paramNames", offset: 0, names: ["Parameter 1"] });
    h.fl.apply({ type: "plugin", channel: 5, valid: true, paramCount: 4240, name: "Repro-5" });
    expect(h.written).toEqual([
      ["out/params/Nepheton 2.txt", "# Nepheton 2: 1 named of 4240\n0\tParameter 1\n"],
    ]);
    h.fl.apply({ type: "paramNames", offset: 0, names: ["Output"] });
    await h.fire();
    expect(h.written.map(([path]) => path)).toEqual([
      "out/params/Nepheton 2.txt",
      "out/params/Repro-5.txt",
    ]);
  });

  it("makes a file name of any plugin name", () => {
    expect(dumpFileName("Synthesizer Expander Module")).toBe("Synthesizer Expander Module.txt");
    expect(dumpFileName("a/b: c")).toBe("a_b_ c.txt");
    expect(dumpFileName("///")).toBe("_.txt");
    expect(dumpText("X", 2, new Map())).toBe("# X: 0 named of 2\n");
  });
});
