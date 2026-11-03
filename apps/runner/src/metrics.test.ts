/**
 * Tests the Runner Metrics a runner reports. The report loop:
 *
 * - sends a report at once, so a runner that has just connected does not go
 *   a minute without reporting its disk;
 * - then sends one every sixty seconds;
 * - skips a report whose disk and memory read fails or hangs, instead of
 *   reporting zero free bytes, which would take the machine out of service
 *   because of one failed `statfs`;
 * - carries the CPU use: `null` on the first report, however long the first
 *   read takes, then the average and the peak of the minute before the report,
 *   from a fake sequence of the kernel's counters. A skipped report's minute
 *   is dropped, not added to the next.
 *
 * The controller decides whether a report means the machine can take work;
 * that is not tested here.
 *
 * The interval runs on a `TestClock`, like the reconnect loop's tests. The
 * disk, memory and counters are passed in, because a test cannot fill a real
 * disk or load the machine's processors.
 */
import { describe, expect, it } from "vitest";
import { Cause, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { freemem, tmpdir, totalmem } from "node:os";
import type { RunnerMetrics } from "@hercule/protocol";
import type { CpuTimes } from "./machine-cpu";
import {
  DISK_AND_MEMORY_TIMEOUT,
  METRICS_INTERVAL,
  readDiskAndMemory,
  reportMetrics,
  type DiskAndMemory,
} from "./metrics";

const GIB = 1024 * 1024 * 1024;

/** A machine with plenty of room. Tests lower its free disk from here. */
const ROOMY: DiskAndMemory = { diskFreeBytes: 200 * GIB, availableMemoryBytes: 16 * GIB };

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** Lets a forked loop run without moving time. */
const settle = TestClock.adjust(Duration.zero);

/**
 * Builds a reader of the kernel's counters. The first call is the baseline;
 * each later call is one second further, with the busy share given by the next
 * entry of `percents` (the last entry again when they run out). `calls` counts
 * the reads, the baseline included.
 */
const fakeCpuTimes = (
  percents: ReadonlyArray<number>,
): { readCpuTimes: () => CpuTimes; calls: () => number } => {
  let calls = 0;
  let times: CpuTimes = { busyTicks: 0, totalTicks: 0 };
  return {
    readCpuTimes: () => {
      if (calls > 0) {
        const percent = percents[Math.min(calls - 1, percents.length - 1)]!;
        times = { busyTicks: times.busyTicks + percent, totalTicks: times.totalTicks + 100 };
      }
      calls++;
      return times;
    },
    calls: () => calls,
  };
};

/** A machine that stays at 20% CPU. */
const STEADY = () => fakeCpuTimes([20]).readCpuTimes;

describe("readDiskAndMemory on the real machine", () => {
  it("returns the free bytes of the filesystem that holds a path", async () => {
    const metrics = await Effect.runPromise(readDiskAndMemory(tmpdir()));

    expect(Number.isInteger(metrics.diskFreeBytes)).toBe(true);
    expect(metrics.diskFreeBytes).toBeGreaterThan(0);
    expect(Number.isInteger(metrics.availableMemoryBytes)).toBe(true);
    expect(metrics.availableMemoryBytes).toBeGreaterThan(0);
    // Available memory can never exceed total memory, and both are in bytes,
    // the unit the runner's facts use for the total.
    expect(metrics.availableMemoryBytes).toBeLessThanOrEqual(totalmem());
    expect(freemem()).toBeGreaterThan(0);
  });

  it("fails instead of guessing when the path does not exist", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(readDiskAndMemory("/no/such/directory/on/this/machine")),
    );
    expect(outcome._tag).toBe("Failure");
  });
});

describe("reportMetrics", () => {
  it("reports at once and then on the interval", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerMetrics> = [];

        const loop = yield* Effect.forkChild(
          reportMetrics({
            readDiskAndMemory: Effect.succeed(ROOMY),
            readCpuTimes: STEADY(),
            send: (metrics) => Effect.sync(() => void sent.push(metrics)),
          }),
        );

        yield* settle;
        // Sent right after connecting, without waiting a minute first.
        expect(sent).toHaveLength(1);
        expect(sent[0]).toEqual({
          diskFreeBytes: 200 * GIB,
          availableMemoryBytes: 16 * GIB,
          cpu: null,
        });

        yield* TestClock.adjust(Duration.millis(59_999));
        expect(sent, "a millisecond before the minute").toHaveLength(1);
        yield* TestClock.adjust(Duration.millis(1));
        expect(sent, "on the minute").toHaveLength(2);

        for (let minute = 0; minute < 5; minute++) yield* TestClock.adjust(METRICS_INTERVAL);
        expect(sent).toHaveLength(7);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("reports every minute, not only when the metrics changed", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerMetrics> = [];
        let disk = 200 * GIB;

        const loop = yield* Effect.forkChild(
          reportMetrics({
            readCpuTimes: STEADY(),
            readDiskAndMemory: Effect.suspend(() =>
              Effect.succeed({ ...ROOMY, diskFreeBytes: disk } satisfies RunnerMetrics),
            ),
            send: (metrics) => Effect.sync(() => void sent.push(metrics)),
          }),
        );

        yield* settle;
        // The disk fills up and then frees up while the loop runs.
        disk = 4 * GIB;
        yield* TestClock.adjust(METRICS_INTERVAL);
        disk = 40 * GIB;
        yield* TestClock.adjust(METRICS_INTERVAL);

        expect(sent.map((one) => one.diskFreeBytes)).toEqual([200 * GIB, 4 * GIB, 40 * GIB]);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("skips a report whose read fails, and its CPU minute with it", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerMetrics> = [];
        let readable = true;
        // Reads 1 to 55 are busy and every later read is quiet. The busy
        // minute is the one whose report fails, so a report that still carried
        // it would show 100%. Read 60 may fall on either side of the minute's
        // end, which is why the busy reads stop before it.
        const cpu = fakeCpuTimes([...Array.from({ length: 55 }, () => 100), 20]);

        const loop = yield* Effect.forkChild(
          reportMetrics({
            readCpuTimes: cpu.readCpuTimes,
            readDiskAndMemory: Effect.suspend(() =>
              readable
                ? Effect.succeed(ROOMY)
                : Effect.fail(new Cause.UnknownError(new Error("the filesystem did not answer"))),
            ),
            send: (metrics) => Effect.sync(() => void sent.push(metrics)),
          }),
        );

        yield* settle;
        expect(sent).toHaveLength(1);

        // The read fails at the end of the busy minute. A failed read does not
        // mean the machine has no disk left, so nothing is sent.
        readable = false;
        yield* TestClock.adjust(METRICS_INTERVAL);
        expect(sent).toHaveLength(1);

        readable = true;
        yield* TestClock.adjust(METRICS_INTERVAL);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.diskFreeBytes).toBe(ROOMY.diskFreeBytes);
        // Only the quiet minute before this report: not the busy minute whose
        // report was skipped, and not an average of the two.
        expect(sent[1]?.cpu).toEqual({ averagePercent: 20, peakPercent: 20 });

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("gives up on a read that takes too long, and reports again once it answers", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerMetrics> = [];
        let hangs = true;

        const loop = yield* Effect.forkChild(
          reportMetrics({
            readCpuTimes: STEADY(),
            // A `vm_stat` that never exits, or a `statfs` on a dead mount.
            readDiskAndMemory: Effect.suspend(() => (hangs ? Effect.never : Effect.succeed(ROOMY))),
            send: (metrics) => Effect.sync(() => void sent.push(metrics)),
          }),
        );

        yield* settle;
        yield* TestClock.adjust(Duration.millis(Duration.toMillis(DISK_AND_MEMORY_TIMEOUT) - 1));
        expect(sent).toEqual([]);

        // The read is given up on, so the loop reaches its next round instead
        // of waiting for ever.
        hangs = false;
        yield* TestClock.adjust(Duration.millis(1));
        yield* TestClock.adjust(METRICS_INTERVAL);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.diskFreeBytes).toBe(ROOMY.diskFreeBytes);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("reports no CPU on the first report even when the first read takes seconds", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerMetrics> = [];

        const loop = yield* Effect.forkChild(
          reportMetrics({
            readCpuTimes: STEADY(),
            readDiskAndMemory: Effect.delay(Effect.succeed(ROOMY), Duration.seconds(2)),
            send: (metrics) => Effect.sync(() => void sent.push(metrics)),
          }),
        );

        // By now the sampler has two seconds of samples, so a report that
        // took its CPU from them would not be `null`.
        yield* TestClock.adjust(Duration.seconds(2));
        expect(sent).toHaveLength(1);
        expect(sent[0]?.cpu).toBeNull();

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("reports no CPU on the first report, then the minute's average and peak", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerMetrics> = [];
        // Read 5 is a spike. Every other read is 20%.
        const cpu = fakeCpuTimes([20, 20, 20, 20, 80, 20]);

        const loop = yield* Effect.forkChild(
          reportMetrics({
            readDiskAndMemory: Effect.succeed(ROOMY),
            readCpuTimes: cpu.readCpuTimes,
            send: (metrics) => Effect.sync(() => void sent.push(metrics)),
          }),
        );

        yield* settle;
        // No minute has been read yet. `null` tells the Fleet screen that this
        // runner measures CPU, as opposed to a missing key for an old runner.
        expect(sent[0]?.cpu).toBeNull();

        yield* TestClock.adjust(METRICS_INTERVAL);
        // The minute holds 59 or 60 reads, depending on whether the sampler's
        // last read of the minute runs before the report. Both average 21.0.
        expect(sent[1]?.cpu).toEqual({ averagePercent: 21, peakPercent: 80 });

        // The next minute starts empty: the spike does not carry over.
        yield* TestClock.adjust(METRICS_INTERVAL);
        expect(sent[2]?.cpu).toEqual({ averagePercent: 20, peakPercent: 20 });

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("stops as soon as it is interrupted, and queues nothing for later", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerMetrics> = [];
        const cpu = fakeCpuTimes([20]);

        const loop = yield* Effect.forkChild(
          reportMetrics({
            readDiskAndMemory: Effect.succeed(ROOMY),
            readCpuTimes: cpu.readCpuTimes,
            send: (metrics) => Effect.sync(() => void sent.push(metrics)),
          }),
        );

        yield* settle;
        expect(sent).toHaveLength(1);
        yield* TestClock.adjust(Duration.seconds(5));
        const readsWhileRunning = cpu.calls();
        // The baseline, then one read a second.
        expect(readsWhileRunning).toBe(6);

        // The connection ended. No reports queue up for the next connection,
        // because metrics taken now are out of date by the time the runner
        // reconnects.
        yield* Fiber.interrupt(loop);
        for (let minute = 0; minute < 10; minute++) yield* TestClock.adjust(METRICS_INTERVAL);
        expect(sent).toHaveLength(1);
        // The CPU sampler stopped with the loop: it does not keep a timer
        // running on a connection that is gone.
        expect(cpu.calls()).toBe(readsWhileRunning);
      }),
    );
  });
});
