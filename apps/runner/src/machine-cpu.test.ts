/**
 * Tests the CPU minute the runner reports. A sample is the share of all cores
 * busy between two reads of the kernel's counters, and the minute keeps their
 * average and highest value.
 *
 * The counters are passed in, so the tests feed a known sequence. The
 * once-a-second loop runs on a `TestClock`.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Exit, Logger, Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  parseProcStatCpuTimes,
  readMachineCpuTimes,
  startCpuSampler,
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

/** What the kernel prints on a four-core machine, the per-core lines included. */
const PROC_STAT = `cpu  4705 150 3120 80000 200 30 40 25 500 60
cpu0 1170 40 780 20000 50 8 10 6 125 15
cpu1 1180 35 790 20000 50 7 10 6 125 15
intr 123456 0 0
ctxt 987654
btime 1700000000
`;

describe("parseProcStatCpuTimes", () => {
  it("adds user, nice, system, irq, softirq and steal as busy, and idle and iowait on top as total", () => {
    // busy: 4705 + 150 + 3120 + 30 + 40 + 25 = 8070. Guest (500) and
    // guest_nice (60) are already inside user and nice, so they are not added.
    // total: 8070 + 80000 idle + 200 iowait.
    expect(parseProcStatCpuTimes(PROC_STAT)).toEqual({ busyTicks: 8070, totalTicks: 88270 });
  });

  it("reads the summary line, not a core's line", () => {
    const onlyCores = PROC_STAT.split("\n").slice(1).join("\n");
    expect(() => parseProcStatCpuTimes(onlyCores)).toThrow("/proc/stat has no");
  });

  it("fails when the line has fewer than eight counts or a count is not a number", () => {
    expect(() => parseProcStatCpuTimes("cpu  1 2 3 4\n")).toThrow("/proc/stat has no");
    expect(() => parseProcStatCpuTimes("cpu  1 2 3 4 5 6 7 x\n")).toThrow("/proc/stat has no");
    expect(() => parseProcStatCpuTimes("")).toThrow("/proc/stat has no");
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

  it("measures the busy share of the ticks between two reads", async () => {
    await run(
      Effect.gen(function* () {
        // 0% of the first 400 ticks, then 100% of the next 400.
        const reader = sequence([at(0, 0), at(0, 400), at(400, 800)]);
        const scope = yield* Scope.make();
        const sampler = yield* Scope.provide(startCpuSampler(reader.read), scope);

        yield* TestClock.adjust(Duration.seconds(2));

        expect(yield* sampler.takeMinute).toEqual({ averagePercent: 50, peakPercent: 100 });
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("rounds the average and the peak to one decimal", async () => {
    await run(
      Effect.gen(function* () {
        // Samples of 10, 20 and 33.333...: mean 21.111..., peak 33.333...
        const reader = sequence([at(0, 0), at(10, 100), at(30, 200), at(30 + 100 / 3, 300)]);
        const scope = yield* Scope.make();
        const sampler = yield* Scope.provide(startCpuSampler(reader.read), scope);

        yield* TestClock.adjust(Duration.seconds(3));

        expect(yield* sampler.takeMinute).toEqual({ averagePercent: 21.1, peakPercent: 33.3 });
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("skips a read in which no ticks passed", async () => {
    await run(
      Effect.gen(function* () {
        const reader = sequence([at(100, 1000), at(100, 1000)]);
        const scope = yield* Scope.make();
        const sampler = yield* Scope.provide(startCpuSampler(reader.read), scope);

        yield* TestClock.adjust(Duration.seconds(2));

        expect(yield* sampler.takeMinute).toBeNull();
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

  it("skips reads that throw, warns once, and measures a proper minute after they recover", async () => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make<unknown, void>((options) => {
      if (options.logLevel === "Warn") warnings.push(options.message);
    });
    await run(
      Effect.gen(function* () {
        let call = 0;
        // Call 0 is the baseline. Calls 1 to 3 throw. After that every second
        // adds 100 ticks of which 40 are busy.
        const reader = (): CpuTimes => {
          const index = call++;
          if (index >= 1 && index <= 3) throw new Error("the counters are gone");
          return at(index * 40, index * 100);
        };
        const scope = yield* Scope.make();
        const sampler = yield* Scope.provide(startCpuSampler(reader), scope);

        yield* TestClock.adjust(Duration.seconds(3));
        // Nothing could be measured yet, and the failures were logged once.
        expect(yield* sampler.takeMinute).toBeNull();
        expect(warnings).toHaveLength(1);

        // The sampler is still running: it samples again. Its first sample
        // spans the gap back to the baseline and measures the same 40%.
        yield* TestClock.adjust(Duration.seconds(2));
        expect(yield* sampler.takeMinute).toEqual({ averagePercent: 40, peakPercent: 40 });
        expect(warnings).toHaveLength(1);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(Logger.layer([logger]))),
    );
  });

  it("stops sampling when its scope closes", async () => {
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
