import { describe, expect, it } from "vitest";
import { FakeTime } from "../src/tools/fakeTime.js";
import {
  DEFAULT_SETTINGS,
  REPEAT_RATES,
  RepeatScheduler,
  anchorUnit,
  hitVelocity,
  intervalBeats,
  intervalMs,
  pressureVelocity,
  rateIndex,
  ratePosition,
  songBeats,
  stepFeel,
  stepRate,
  feelPosition,
  type RepeatSettings,
  type RepeatTiming,
} from "../src/modes/repeatScheduler.js";

type Event = { at: number; kind: "on" | "off"; pad: number; velocity?: number };

function setup(initial: Partial<RepeatSettings> = {}) {
  const time = new FakeTime(1000);
  const events: Event[] = [];
  const ended: number[] = [];
  const settings: RepeatSettings = { ...DEFAULT_SETTINGS, ...initial };
  const timing: RepeatTiming = { bpm: 120, playing: false };
  const scheduler = new RepeatScheduler({
    player: {
      on: (pad, velocity) => events.push({ at: time.now, kind: "on", pad, velocity }),
      off: (pad) => events.push({ at: time.now, kind: "off", pad }),
      ended: (pad) => ended.push(pad),
    },
    timing: () => timing,
    settings: () => settings,
    clock: time.clock,
    timers: time.timers,
  });
  const ons = (pad?: number) =>
    events.filter((e) => e.kind === "on" && (pad === undefined || e.pad === pad)).map((e) => e.at);
  const offs = (pad?: number) =>
    events.filter((e) => e.kind === "off" && (pad === undefined || e.pad === pad)).map((e) => e.at);
  return { time, events, ended, settings, timing, scheduler, ons, offs };
}

const near = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i] ?? NaN, 3));
};

describe("intervals", () => {
  it("is 60 / BPM × 4 / denominator, × 2/3 for triplets, × 3/2 for dotted", () => {
    const expected = [
      500,
      250,
      125,
      62.5,
      500 / 3,
      250 / 3,
      125 / 3,
      1000 / 3,
      750,
      375,
      187.5,
      93.75,
    ];
    REPEAT_RATES.forEach((_, rate) => {
      expect(intervalMs(120, rate)).toBeCloseTo(expected[rate] ?? NaN, 6);
    });
    expect(intervalMs(60, 2)).toBeCloseTo(250, 6);
    expect(intervalBeats(2)).toBe(0.25);
  });

  it("uses 120 BPM while the tempo is unknown", () => {
    expect(intervalMs(0, 2)).toBe(125);
  });

  it("names the twelve rates, the first seven where the saved state has them", () => {
    expect(REPEAT_RATES.map((r) => r.label)).toEqual([
      "1/4",
      "1/8",
      "1/16",
      "1/32",
      "1/8T",
      "1/16T",
      "1/32T",
      "1/4T",
      "1/4D",
      "1/8D",
      "1/16D",
      "1/32D",
    ]);
  });

  it("the rate knob moves the note value and keeps the unit, and stops at the ends", () => {
    const label = (rate: number) => REPEAT_RATES[rate]?.label;
    const rate = rateIndex(8, "dotted");
    expect(label(stepRate(rate, 1))).toBe("1/16D");
    expect(label(stepRate(rate, -1))).toBe("1/4D");
    expect(label(stepRate(rate, 99))).toBe("1/32D");
    expect(label(stepRate(rate, -99))).toBe("1/4D");
    expect(ratePosition(rateIndex(4, "dotted"))).toBe(0);
    expect(ratePosition(rateIndex(32, "triplet"))).toBe(1);
  });

  it("the unit knob moves Normal, Dotted, Triplet and keeps the note value", () => {
    const label = (rate: number) => REPEAT_RATES[rate]?.label;
    const rate = rateIndex(8, "straight");
    expect(label(stepFeel(rate, 1))).toBe("1/8D");
    expect(label(stepFeel(rate, 2))).toBe("1/8T");
    expect(label(stepFeel(rate, 99))).toBe("1/8T");
    expect(label(stepFeel(rate, -1))).toBe("1/8");
    expect(feelPosition(rate)).toBe(0);
    expect(feelPosition(rateIndex(8, "triplet"))).toBe(1);
  });

  it("only rates that do not fit the bar have an anchor", () => {
    expect(anchorUnit(rateIndex(8, "straight"))).toBe(0);
    expect(anchorUnit(rateIndex(16, "triplet"))).toBe(0);
    expect(anchorUnit(rateIndex(8, "triplet"))).toBe(0);
    expect(anchorUnit(rateIndex(4, "triplet"))).toBe(1);
    expect(anchorUnit(rateIndex(8, "dotted"))).toBe(0.25);
    expect(anchorUnit(rateIndex(4, "dotted"))).toBe(0.5);
  });

  it("reads SONG_POS as beats from bar 1 (16 steps per bar)", () => {
    expect(songBeats({ bar: 1, step: 1, tick: 0 }, 96)).toBe(0);
    expect(songBeats({ bar: 2, step: 1, tick: 0 }, 96)).toBe(4);
    expect(songBeats({ bar: 2, step: 5, tick: 12 }, 96)).toBeCloseTo(5.125, 9);
  });

  it("maps hits and pressure to MIDI velocities", () => {
    expect(hitVelocity(0)).toBe(1);
    expect(hitVelocity(1)).toBe(127);
    expect(pressureVelocity(0)).toBe(1);
    expect(pressureVelocity(1)).toBe(127);
    expect(pressureVelocity(0.5)).toBe(64);
  });
});

describe("free running", () => {
  it.each(REPEAT_RATES.map((r, rate) => [r.label, rate] as const))(
    "repeats %s at its interval, the first at the press",
    (_label, rate) => {
      const { time, scheduler, ons } = setup({ rate });
      scheduler.start(0, 100, 0.5);
      time.advance(2000);
      const interval = intervalMs(120, rate);
      const expected = Array.from(
        { length: Math.floor(2000 / interval + 1e-9) + 1 },
        (_, i) => 1000 + i * interval,
      );
      near(ons(), expected);
    },
  );

  it("ends each note at the end of the gate, before the next one starts", () => {
    const { time, scheduler, events } = setup({ gate: 0.5 });
    scheduler.start(0, 100, 0.5);
    time.advance(260);
    expect(events.map((e) => [e.kind, e.at - 1000])).toEqual([
      ["on", 0],
      ["off", 62.5],
      ["on", 125],
      ["off", 187.5],
      ["on", 250],
    ]);
  });

  it("a gate of 100 % still ends a note before the next one starts", () => {
    const { time, scheduler, events } = setup({ gate: 1 });
    scheduler.start(0, 100, 0.5);
    time.advance(400);
    const kinds = events.map((e) => e.kind);
    // never two ons in a row for the pad
    for (let i = 1; i < kinds.length; i++)
      expect(kinds[i] === "on" && kinds[i - 1] === "on").toBe(false);
  });

  it("gate 10 % is a short note", () => {
    const { time, scheduler, offs } = setup({ gate: 0.1 });
    scheduler.start(0, 100, 0.5);
    time.advance(140);
    near(offs(), [1000 + 12.5, 1125 + 12.5]);
  });

  it("swing delays every second repeat by a share of the interval", () => {
    const { time, scheduler, ons } = setup({ swing: 0.2 });
    scheduler.start(0, 100, 0.5);
    time.advance(520);
    near(ons(), [1000, 1150, 1250, 1400, 1500]);
  });

  it("swing of 50 % puts the odd repeats half an interval late", () => {
    const { time, scheduler, ons } = setup({ swing: 0.5 });
    scheduler.start(0, 100, 0.5);
    time.advance(400);
    near(ons(), [1000, 1187.5, 1250, 1437.5].slice(0, 3));
  });

  it("follows a tempo change at once, from where the grid was", () => {
    const { time, timing, scheduler, ons } = setup();
    scheduler.start(0, 100, 0.5);
    time.advance(130); // on at 0 and 125
    timing.bpm = 240;
    scheduler.refresh();
    time.advance(200);
    // 5 ms of the grid passed at 120 BPM (0.01 beat); the next slot (0.5 beat) is 60 ms later.
    near(
      ons(),
      [1000, 1125, 1190, 1252.5, 1315, 1377.5].filter((t) => t <= 1330),
    );
  });

  it("follows a rate change from the last repeat", () => {
    const { time, settings, scheduler, ons } = setup();
    scheduler.start(0, 100, 0.5);
    time.advance(130);
    settings.rate = 1; // 1/8 = 250 ms
    scheduler.refresh();
    time.advance(600);
    near(
      ons(),
      [1000, 1125, 1375, 1625, 1875].filter((t) => t <= 1730),
    );
  });

  it("uses 120 BPM when FL's tempo is 0", () => {
    const { time, timing, scheduler, ons } = setup();
    timing.bpm = 0;
    scheduler.start(0, 100, 0.5);
    time.advance(130);
    near(ons(), [1000, 1125]);
  });

  it("plays several pads on one shared grid, a pad hit between slots sounds at once", () => {
    const { time, scheduler, ons } = setup();
    scheduler.start(0, 100, 0.5);
    time.advance(40);
    scheduler.start(1, 90, 0.5);
    time.advance(300);
    near(ons(0), [1000, 1125, 1250]);
    near(ons(1), [1040, 1125, 1250]);
  });

  it("does not repeat a new pad twice within a quarter interval", () => {
    const { time, scheduler, ons } = setup();
    scheduler.start(0, 100, 0.5);
    time.advance(115);
    scheduler.start(1, 90, 0.5); // 10 ms before the slot
    time.advance(30);
    near(ons(1), [1115]);
    time.advance(120);
    near(ons(1), [1115, 1250]);
  });
});

describe("velocity", () => {
  it("the first note has the hit velocity, repeats follow the pressure", () => {
    const { time, scheduler, events } = setup();
    scheduler.start(0, 99, 0.5);
    time.advance(60);
    scheduler.setPressure(0, 0.25);
    time.advance(70); // 130: slot at 125
    scheduler.setPressure(0, 1);
    time.advance(120); // 250
    scheduler.setPressure(0, 0);
    time.advance(125); // 375
    expect(events.filter((e) => e.kind === "on").map((e) => e.velocity)).toEqual([99, 32, 127, 1]);
  });

  it("a repeat is never below 1", () => {
    const { time, scheduler, events } = setup();
    scheduler.start(0, 50, 0);
    time.advance(130);
    expect(events.filter((e) => e.kind === "on").map((e) => e.velocity)).toEqual([50, 1]);
  });
});

describe("stopping", () => {
  it("ends the pad's note at once and stops its timer", () => {
    const { time, scheduler, events } = setup({ gate: 1 });
    scheduler.start(0, 100, 0.5);
    time.advance(130);
    const before = events.length;
    scheduler.stop(0);
    expect(events.slice(before)).toEqual([{ at: time.now, kind: "off", pad: 0 }]);
    expect(time.timerCount).toBe(0);
    expect(scheduler.active).toBe(false);
    time.advance(1000);
    expect(events).toHaveLength(before + 1);
  });

  it("other pads keep repeating", () => {
    const { time, scheduler, ons } = setup();
    scheduler.start(0, 100, 0.5);
    scheduler.start(1, 100, 0.5);
    time.advance(10);
    scheduler.stop(0);
    time.advance(300);
    near(ons(0), [1000]);
    near(ons(1), [1000, 1125, 1250]);
  });

  it("stopAll leaves no note on: every on has an off", () => {
    const { time, scheduler, events } = setup({ gate: 1, swing: 0.3 });
    scheduler.start(0, 100, 0.5);
    time.advance(33);
    scheduler.start(5, 100, 0.5);
    time.advance(777);
    scheduler.stopAll();
    time.advance(1000);
    for (const pad of [0, 5]) {
      let on = false;
      for (const e of events.filter((x) => x.pad === pad)) {
        if (e.kind === "on") {
          expect(on).toBe(false);
          on = true;
        } else {
          expect(on).toBe(true);
          on = false;
        }
      }
      expect(on).toBe(false);
    }
    expect(time.timerCount).toBe(0);
  });

  it("hitting a repeating pad again restarts it", () => {
    const { time, scheduler, events } = setup();
    scheduler.start(0, 100, 0.5);
    time.advance(10);
    scheduler.start(0, 80, 0.5);
    expect(events.filter((e) => e.kind === "on").map((e) => e.velocity)).toEqual([100, 80]);
    expect(events.filter((e) => e.kind === "off")).toHaveLength(1);
  });
});

describe("late timers", () => {
  it("skips slots that are more than half an interval late instead of playing a burst", () => {
    const { time, scheduler, ons } = setup();
    scheduler.start(0, 100, 0.5);
    time.now = 1400; // the event loop was away: slots 1 and 2 are over, slot 3 (1375) is 25 ms late
    time.advance(0);
    near(ons(), [1000, 1400]);
    time.advance(100); // the grid goes on at 1500
    near(ons(), [1000, 1400, 1500]);
  });

  it("plays a slot that is less than half an interval late", () => {
    const { time, scheduler, ons } = setup();
    scheduler.start(0, 100, 0.5);
    time.now = 1150; // slot 1 (1125) is 25 ms late
    time.advance(0);
    near(ons(), [1000, 1150]);
  });

  it("a very late wake plays at most one note", () => {
    const { time, scheduler, ons } = setup();
    scheduler.start(0, 100, 0.5);
    time.now = 5000;
    time.advance(0);
    expect(ons().length).toBeLessThanOrEqual(2);
  });
});

describe("aligned to FL's song position", () => {
  it("repeats on multiples of the interval from bar 1 while FL plays", () => {
    const { time, timing, scheduler, ons } = setup();
    timing.playing = true;
    timing.songPos = { beats: 0, at: 1000 };
    time.advance(30);
    scheduler.start(0, 100, 0.5); // 30 ms in: slots at 1000 + k × 125
    time.advance(350);
    near(ons(), [1030, 1125, 1250, 1375]);
  });

  it("estimates the position from the last SONG_POS and the time since", () => {
    const { time, timing, scheduler, ons } = setup();
    timing.playing = true;
    timing.songPos = { beats: songBeats({ bar: 3, step: 1, tick: 0 }, 96) + 0.1, at: 1000 }; // 8.1 beats
    time.advance(20);
    scheduler.start(0, 100, 0.5); // 8.14 beats: late in the slot, so it plays at 8.25, 55 ms away
    time.advance(200);
    near(ons(), [1075, 1200]);
  });

  it("a new SONG_POS corrects the grid", () => {
    const { time, timing, scheduler, ons } = setup();
    timing.playing = true;
    timing.songPos = { beats: 0, at: 1000 };
    scheduler.start(0, 100, 0.5);
    time.advance(50);
    // FL says it is already at 0.15 beats (75 ms in): the slot at 0.25 beat is 50 ms away
    timing.songPos = { beats: 0.15, at: 1050 };
    scheduler.refresh();
    time.advance(200);
    near(ons(), [1000, 1100, 1225]);
  });

  it("swing delays the odd slots of the song's grid", () => {
    const { time, timing, scheduler, ons } = setup({ swing: 0.2 });
    timing.playing = true;
    timing.songPos = { beats: 0, at: 1000 };
    scheduler.start(0, 100, 0.5);
    time.advance(420);
    near(ons(), [1000, 1150, 1250, 1400]);
  });

  it("runs free again when SONG_POS goes stale or FL stops", () => {
    const { time, timing, scheduler, ons } = setup();
    timing.playing = true;
    timing.songPos = { beats: 0, at: 1000 };
    time.advance(30);
    scheduler.start(0, 100, 0.5);
    time.advance(70); // 1100: the slot at 1125 has not played yet
    timing.playing = false;
    scheduler.refresh();
    time.advance(350);
    // free from the last grid point (the slot the press counted as, 1000)
    near(ons(), [1030, 1125, 1250, 1375]);
  });

  it("follows a tempo change while FL plays", () => {
    const { time, timing, scheduler, ons } = setup();
    timing.playing = true;
    timing.songPos = { beats: 0, at: 1000 };
    scheduler.start(0, 100, 0.5);
    time.advance(60);
    timing.bpm = 240;
    timing.songPos = { beats: 0.12, at: 1060 }; // FL's next message at the new tempo
    scheduler.refresh();
    time.advance(200);
    // slots at 0.25 beat (1060 + 0.13 × 250 = 1092.5), then every 62.5 ms
    near(ons(), [1000, 1092.5, 1155, 1217.5]);
  });

  it("a SONG_POS late by 0–30 ms does not move the notes", () => {
    const { time, timing, scheduler, ons, settings } = setup();
    settings.rate = 1; // 1/8: 250 ms
    timing.playing = true;
    // Readings every 50 ms from a 1 ms clock, each late by its own amount.
    const lateness = [0, 30, 7, 22, 3, 28, 12, 1, 19, 25, 5, 16];
    const start = time.now;
    let reading = 0;
    const feed = (until: number) => {
      while (time.now < until) {
        time.advance(1);
        const due = start + reading * 50 + (lateness[reading % lateness.length] ?? 0);
        if (time.now >= due) {
          const sent = start + reading * 50;
          timing.songPos = { beats: (sent - start) / 500, at: time.now };
          scheduler.refresh();
          reading++;
        }
      }
    };
    feed(start + 400);
    scheduler.start(0, 100, 0.5);
    feed(start + 3000);
    const notes = ons();
    expect(notes.length).toBeGreaterThan(8);
    for (let i = 1; i < notes.length; i++) {
      expect(Math.abs((notes[i] ?? 0) - (notes[i - 1] ?? 0) - 250)).toBeLessThanOrEqual(1.5);
    }
  });

  it("one stalled SONG_POS does not move the grid, a loop restart does once it is confirmed", () => {
    const { time, timing, scheduler, ons } = setup();
    timing.playing = true;
    timing.songPos = { beats: 0, at: 1000 };
    scheduler.start(0, 100, 0.5);
    time.advance(50);
    timing.songPos = { beats: 0.1, at: 1050 };
    scheduler.refresh();
    time.advance(50);
    // The UI thread hung: this reading is from 200 ms ago.
    timing.songPos = { beats: 0.0, at: 1100 };
    scheduler.refresh();
    time.advance(50);
    timing.songPos = { beats: 0.3, at: 1150 };
    scheduler.refresh();
    time.advance(50);
    near(ons(), [1000, 1125]);
    // The loop restarts: two readings agree about a new place, 40 ms before a slot.
    timing.songPos = { beats: 4.0, at: 1200 };
    scheduler.refresh();
    time.advance(50);
    timing.songPos = { beats: 4.1, at: 1250 };
    scheduler.refresh();
    time.advance(40);
    near(ons(), [1000, 1125, 1250]);
    time.advance(40);
    near(ons(), [1000, 1125, 1250, 1325]);
  });

  describe("a hit goes on the grid", () => {
    it("in the first half of a slot it sounds at once, and the next slot is the next repeat", () => {
      const { time, timing, scheduler, ons, settings } = setup();
      settings.rate = 1; // 1/8: 250 ms
      timing.playing = true;
      timing.songPos = { beats: 0, at: 1000 };
      time.advance(120); // 0.48 of the slot
      scheduler.start(0, 100, 0.5);
      time.advance(400);
      near(ons(), [1120, 1250, 1500]);
    });

    it("in the second half it waits for the next slot, with the hit's velocity", () => {
      const { time, timing, scheduler, events, settings } = setup();
      settings.rate = 1;
      timing.playing = true;
      timing.songPos = { beats: 0, at: 1000 };
      time.advance(130); // 0.52 of the slot
      scheduler.start(0, 100, 0.5);
      expect(scheduler.isWaiting(0)).toBe(true);
      time.advance(300);
      const on = events.filter((e) => e.kind === "on");
      expect(on.map((e) => e.at)).toEqual([1250]);
      expect(on[0]?.velocity).toBe(100);
      expect(scheduler.isWaiting(0)).toBe(false);
    });

    it("a pad let go while it waits plays one whole note, then says it ended", () => {
      const { time, timing, scheduler, ons, offs, ended, settings } = setup({ gate: 0.5 });
      settings.rate = 1;
      timing.playing = true;
      timing.songPos = { beats: 0, at: 1000 };
      time.advance(130);
      scheduler.start(0, 100, 0.5);
      time.advance(10);
      expect(scheduler.release(0)).toBe(true);
      expect(scheduler.isRepeating(0)).toBe(true);
      expect(ended).toEqual([]);
      time.advance(1000);
      near(ons(), [1250]);
      near(offs(), [1375]);
      expect(ended).toEqual([0]);
      expect(scheduler.active).toBe(false);
    });

    it("a pad let go after its first note just stops", () => {
      const { time, timing, scheduler, ons, ended } = setup();
      timing.playing = true;
      timing.songPos = { beats: 0, at: 1000 };
      scheduler.start(0, 100, 0.5);
      time.advance(10);
      expect(scheduler.release(0)).toBe(false);
      expect(scheduler.active).toBe(false);
      time.advance(500);
      near(ons(), [1000]);
      expect(ended).toEqual([]);
    });

    it("a second pad goes on the same grid", () => {
      const { time, timing, scheduler, ons } = setup();
      timing.playing = true;
      timing.songPos = { beats: 0, at: 1000 };
      scheduler.start(0, 100, 0.5);
      time.advance(100); // 0.8 of a 1/16
      scheduler.start(1, 100, 0.5);
      expect(ons(1)).toEqual([]);
      time.advance(30);
      near(ons(1), [1125]);
      near(ons(0), [1000, 1125]);
    });
  });

  describe("a rate that does not fit the bar", () => {
    it("starts where it is first needed, on the straight value under it", () => {
      const { time, timing, scheduler, ons, settings } = setup();
      settings.rate = rateIndex(8, "dotted"); // 0.75 beat: 375 ms
      timing.playing = true;
      timing.songPos = { beats: 1.26, at: 1000 }; // just after a 1/16 on the way to a beat
      scheduler.start(0, 100, 0.5);
      time.advance(800);
      // The grid starts at 1.25 beats: the press is its slot 0, then 2 and 2.75 beats.
      near(ons(), [1000, 1370, 1745]);
    });

    it("a new press finds a new start", () => {
      const { time, timing, scheduler, ons, settings } = setup();
      settings.rate = rateIndex(8, "dotted");
      timing.playing = true;
      timing.songPos = { beats: 1, at: 1000 };
      scheduler.start(0, 100, 0.5);
      time.advance(100);
      scheduler.stop(0);
      time.advance(400); // 2 beats
      scheduler.start(0, 100, 0.5);
      time.advance(400);
      near(ons(), [1000, 1500, 1875]);
    });

    it("a straight rate stays on the bar", () => {
      const { time, timing, scheduler, ons, settings } = setup();
      settings.rate = rateIndex(8, "straight");
      timing.playing = true;
      timing.songPos = { beats: 1.26, at: 1000 };
      scheduler.start(0, 100, 0.5); // 0.52 of a 1/8: waits for 1.5 beats, 120 ms away
      time.advance(130);
      near(ons(), [1120]);
    });
  });
});
