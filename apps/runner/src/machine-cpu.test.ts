/**
 * Tests the CPU minute the runner reports. A reading is the share of all cores
 * busy between two reads of the kernel's counters, and the minute keeps their
 * average and highest value.
 *
 * The counters are passed in, so the tests feed a known sequence. The
 * once-a-second loop runs on a `TestClock`.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  addCpuRead,
  EMPTY_CPU_MINUTE,
  measureBusyPercent,
  readMachineCpuTimes,
  startCpuSampler,
  summarizeCpuMinute,
  type CpuTimes,
} from "./machine-cpu";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** Counters after `busy` and `total` ticks in all. */
const at = (busyTicks: number, totalTicks: number): CpuTimes => ({ busyTicks, totalTicks });

/** A reader that returns the given counters one after another, then the last one again. */
const sequence = (
  counters: ReadonlyArray<CpuTimes>,
): { read: () => CpuTimes; calls: () => number } => {
  let index = 0;
  return {
    read: () => counters[Math.min(index++, counters.length - 1)]!,
    calls: () => index,
  };
};

describe("measureBusyPercent", () => {
  it("returns the busy share of the ticks between two readings", () => {
    expect(measureBusyPercent(at(100, 1000), at(150, 1100))).toBe(50);
    expect(measureBusyPercent(at(0, 0), at(0, 400))).toBe(0);
    expect(measureBusyPercent(at(0, 0), at(400, 400))).toBe(100);
  });

  it("returns nothing when no ticks passed", () => {
    expect(measureBusyPercent(at(100, 1000), at(100, 1000))).toBeUndefined();
  });

  it("returns nothing when a counter went backwards", () => {
    expect(measureBusyPercent(at(500, 1000), at(100, 1100))).toBeUndefined();
    expect(measureBusyPercent(at(100, 1000), at(150, 900))).toBeUndefined();
  });
});

describe("a CPU minute", () => {
  it("has no summary before any reading", () => {
    expect(summarizeCpuMinute(EMPTY_CPU_MINUTE)).toBeNull();
  });

  it("summarizes the average and the peak, rounded to one decimal", () => {
    const minute = [10, 20, 100 / 3].reduce(addCpuRead, EMPTY_CPU_MINUTE);
    // mean 21.111..., peak 33.333...
    expect(summarizeCpuMinute(minute)).toEqual({ averagePercent: 21.1, peakPercent: 33.3 });
  });
});

describe("readMachineCpuTimes on the real machine", () => {
  it("returns counters whose busy part never exceeds the total", () => {
    const times = readMachineCpuTimes();
    expect(times.totalTicks).toBeGreaterThan(0);
    expect(times.busyTicks).toBeGreaterThanOrEqual(0);
    expect(times.busyTicks).toBeLessThanOrEqual(times.totalTicks);
  });
});

describe("startCpuSampler", () => {
  it("summarizes sixty one-second reads at the minute", async () => {
    await run(
      Effect.gen(function* () {
        // Baseline, then 60 reads: each second adds 100 ticks, half of them
        // busy in the odd seconds and a quarter in the even ones.
        const counters = [at(0, 0)];
        for (let second = 1; second <= 60; second++) {
          const last = counters[counters.length - 1]!;
          counters.push(at(last.busyTicks + (second % 2 === 1 ? 50 : 25), last.totalTicks + 100));
        }
        const reader = sequence(counters);
        const scope = yield* Scope.make();
        const sampler = yield* Scope.provide(startCpuSampler(reader.read), scope);

        yield* TestClock.adjust(Duration.seconds(60));

        expect(reader.calls()).toBe(61);
        // 30 reads of 50 and 30 reads of 25.
        expect(yield* sampler.takeMinute).toEqual({ averagePercent: 37.5, peakPercent: 50 });
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("starts a new minute after each take", async () => {
    await run(
      Effect.gen(function* () {
        const reader = sequence([at(0, 0), at(90, 100), at(90, 200), at(100, 300)]);
        const scope = yield* Scope.make();
        const sampler = yield* Scope.provide(startCpuSampler(reader.read), scope);

        yield* TestClock.adjust(Duration.seconds(2));
        expect(yield* sampler.takeMinute).toEqual({ averagePercent: 45, peakPercent: 90 });

        // Nothing is read between the take and the next second.
        expect(yield* sampler.takeMinute).toBeNull();

        yield* TestClock.adjust(Duration.seconds(1));
        expect(yield* sampler.takeMinute).toEqual({ averagePercent: 10, peakPercent: 10 });
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("has nothing to take before the first read", async () => {
    await run(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const sampler = yield* Scope.provide(startCpuSampler(sequence([at(0, 0)]).read), scope);

        yield* TestClock.adjust(Duration.millis(999));
        expect(yield* sampler.takeMinute).toBeNull();
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("skips a read whose counter went backwards and measures from the new counters", async () => {
    await run(
      Effect.gen(function* () {
        const reader = sequence([at(500, 1000), at(100, 1100), at(150, 1200)]);
        const scope = yield* Scope.make();
        const sampler = yield* Scope.provide(startCpuSampler(reader.read), scope);

        yield* TestClock.adjust(Duration.seconds(2));

        // The first read went backwards and counts for nothing. The second is
        // measured from the counters the first one left.
        expect(yield* sampler.takeMinute).toEqual({ averagePercent: 50, peakPercent: 50 });
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("stops reading when its scope closes", async () => {
    await run(
      Effect.gen(function* () {
        const reader = sequence([at(0, 0), at(10, 100)]);
        const scope = yield* Scope.make();
        yield* Scope.provide(startCpuSampler(reader.read), scope);

        yield* TestClock.adjust(Duration.seconds(3));
        const callsWhileOpen = reader.calls();
        expect(callsWhileOpen).toBe(4);

        yield* Scope.close(scope, Exit.void);
        yield* TestClock.adjust(Duration.seconds(10));
        expect(reader.calls()).toBe(callsWhileOpen);
      }),
    );
  });
});
