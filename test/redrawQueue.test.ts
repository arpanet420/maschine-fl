import { describe, expect, it } from "vitest";
import { RedrawQueue } from "../src/render/screens.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("RedrawQueue", () => {
  it("runs at once, and once more for all the requests during a run", async () => {
    let runs = 0;
    let finish = () => {};
    const queue = new RedrawQueue(
      async () => {
        runs++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      () => undefined,
    );
    queue.request();
    expect(runs).toBe(1);
    queue.request();
    queue.request();
    finish();
    await tick();
    expect(runs).toBe(2);
    finish();
    await queue.settled();
    expect(runs).toBe(2);
  });

  it("reports a run that failed before its first await, and runs again when asked", async () => {
    const seen: string[] = [];
    const failures: unknown[] = [];
    let fail = true;
    const queue = new RedrawQueue(
      () => {
        if (fail) throw new Error("boom");
        seen.push("drawn");
        return Promise.resolve();
      },
      (err) => failures.push(err),
    );
    queue.request();
    await queue.settled();
    expect(failures).toHaveLength(1);
    fail = false;
    queue.request();
    await queue.settled();
    expect(seen).toEqual(["drawn"]);
  });
});
