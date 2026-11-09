/**
 * Tests the Runner Metrics a runner reports. The report loop:
 *
 * - sends a report at once, so a runner that has just connected does not go
 *   a minute without reporting its disk;
 * - then sends one every sixty seconds;
 * - skips a report whose disk and memory read fails or hangs, instead of
 *   reporting zero free bytes, which would take the machine out of service
 *   because of one failed `statfs`;
 * - sends a report soon after a workspace removal ends, once for removals that
 *   come together, at most once in `REMOVAL_REPORT_DELAY` however long a bulk
 *   removal lasts, and without taking a CPU minute away from the periodic
 *   report;
 * - carries the CPU use: `null` on the first report, however long the first
 *   read takes, then the average and the peak of the minute before the report,
 *   from a fake sequence of the kernel's counters. The minute is taken before
 *   the disk and memory read, so a skipped report's minute is dropped, not
 *   added to the next.
 *
 * The controller decides whether a report means the machine can take work;
 * that is not tested here.
 *
 * The interval runs on a `TestClock`, like the reconnect loop's tests. The
 * disk, memory and counters are passed in, because a test cannot fill a real
 * disk or load the machine's processors.
 */
import { describe, expect, it } from "vitest";
import { Cause, Clock, Duration, Effect, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import { freemem, tmpdir, totalmem } from "node:os";
import type { RunnerMetrics } from "@hercule/protocol";
import type { CpuTimes } from "./machine-cpu";
import {
  DISK_AND_MEMORY_TIMEOUT,
  METRICS_INTERVAL,
  REMOVAL_REPORT_DELAY,
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

        // The read fails right after the busy minute is taken. A failed read
        // does not mean the machine has no disk left, so nothing is sent, and
        // the busy minute goes with the skipped report.
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
        // took its CPU after the read would not be `null`. The loop takes the
        // minute before the read starts.
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

describe("reportMetrics after a workspace removal", () => {
  const DELAY_MS = Duration.toMillis(REMOVAL_REPORT_DELAY);

  /**
   * Starts the loop with a disk the test can change, and a queue the test
   * signals removals on. Returns the reports sent so far, each with the clock
   * time it was sent at.
   */
  const startReporting = (cpu: () => CpuTimes = STEADY()) =>
    Effect.gen(function* () {
      const sent: Array<{ readonly at: number; readonly metrics: RunnerMetrics }> = [];
      const state = { diskFreeBytes: 100 * GIB };
      const workspaceRemovals = yield* Queue.sliding<void>(1);
      const loop = yield* Effect.forkChild(
        reportMetrics({
          readCpuTimes: cpu,
          readDiskAndMemory: Effect.sync(() => ({ ...ROOMY, ...state })),
          send: (metrics) =>
            Effect.gen(function* () {
              sent.push({ at: yield* Clock.currentTimeMillis, metrics });
            }),
          workspaceRemovals,
        }),
      );
      yield* settle;
      const removalEnds = Effect.sync(() => void Queue.offerUnsafe(workspaceRemovals, undefined));
      return { sent, state, loop, workspaceRemovals, removalEnds };
    });

  it("reports the freed disk at once when no report went out lately, without waiting for the minute", async () => {
    await run(
      Effect.gen(function* () {
        const { sent, state, loop, removalEnds } = yield* startReporting();
        // The report after connecting is all there is, for longer than the delay.
        yield* TestClock.adjust(Duration.millis(DELAY_MS + 1));
        expect(sent).toHaveLength(1);

        state.diskFreeBytes = 150 * GIB;
        yield* removalEnds;
        yield* settle;

        expect(sent).toHaveLength(2);
        expect(sent[1]?.metrics.diskFreeBytes).toBe(150 * GIB);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("sends one report for removals that end together, and not before the delay since the last report", async () => {
    await run(
      Effect.gen(function* () {
        const { sent, state, loop, removalEnds } = yield* startReporting();
        // A report went out 2 seconds ago (the one after connecting).
        yield* TestClock.adjust(Duration.seconds(2));

        state.diskFreeBytes = 150 * GIB;
        yield* removalEnds;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* removalEnds;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* removalEnds;
        expect(sent, "still inside the delay").toHaveLength(1);

        // The delay ends 5 seconds after the first report, 3 seconds after the first removal.
        yield* TestClock.adjust(Duration.millis(DELAY_MS - 4_000 - 1));
        expect(sent, "a millisecond before the delay ends").toHaveLength(1);
        yield* TestClock.adjust(Duration.millis(1));
        expect(sent).toHaveLength(2);
        expect(sent[1]?.at).toBe(DELAY_MS);
        expect(sent[1]?.metrics.diskFreeBytes).toBe(150 * GIB);

        // Nothing is left over: the removals before the report did not queue a second one.
        yield* TestClock.adjust(Duration.millis(DELAY_MS * 2));
        expect(sent).toHaveLength(2);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("reports a removal within the delay however long removals go on, and at most once in the delay", async () => {
    await run(
      Effect.gen(function* () {
        const { sent, loop, removalEnds } = yield* startReporting();
        yield* TestClock.adjust(Duration.millis(DELAY_MS));

        // A removal ends every second for 40 seconds, which is between two periodic reports.
        const removedAt: Array<number> = [];
        for (let second = 0; second < 40; second++) {
          yield* removalEnds;
          removedAt.push(yield* Clock.currentTimeMillis);
          yield* TestClock.adjust(Duration.seconds(1));
        }
        yield* TestClock.adjust(Duration.millis(DELAY_MS));

        const reportedAt = sent.map((report) => report.at);
        // Every removal is followed by a report no later than the delay.
        for (const removal of removedAt) {
          const next = reportedAt.find((at) => at >= removal);
          expect(next, `a report after the removal at ${String(removal)} ms`).toBeDefined();
          expect(next! - removal).toBeLessThanOrEqual(DELAY_MS);
        }
        // Reports that follow removals keep the delay between them, so 40 removals are far fewer reports.
        const periodic = reportedAt.filter((at) => at % Duration.toMillis(METRICS_INTERVAL) === 0);
        const early = reportedAt.filter((at) => !periodic.includes(at));
        for (let index = 1; index < early.length; index++) {
          expect(early[index]! - early[index - 1]!).toBeGreaterThanOrEqual(DELAY_MS);
        }
        expect(early.length).toBeLessThanOrEqual(Math.ceil(40_000 / DELAY_MS) + 1);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("repeats the CPU of the report before it, and leaves the periodic report its whole minute", async () => {
    await run(
      Effect.gen(function* () {
        // Reads 1 to 29 are 20% and every later read is 60%.
        const cpu = fakeCpuTimes([...Array.from({ length: 29 }, () => 20), 60]);
        const { sent, loop, removalEnds } = yield* startReporting(cpu.readCpuTimes);
        expect(sent[0]?.metrics.cpu).toBeNull();

        // The periodic report of the first full minute: 29 seconds of 20% and 31 of 60%.
        yield* TestClock.adjust(METRICS_INTERVAL);
        const firstMinute = sent[1]?.metrics.cpu;
        expect(firstMinute?.peakPercent).toBe(60);

        // A removal ends ten seconds into the next minute.
        yield* TestClock.adjust(Duration.seconds(10));
        yield* removalEnds;
        yield* settle;
        expect(sent).toHaveLength(3);
        expect(sent[2]?.metrics.cpu, "the CPU of the report before it").toEqual(firstMinute);

        // The next periodic report covers the whole minute, 60% all through.
        // Its minute started with the previous periodic report, not with the removal's.
        yield* TestClock.adjust(Duration.seconds(50));
        expect(sent).toHaveLength(4);
        expect(sent[3]?.metrics.cpu).toEqual({ averagePercent: 60, peakPercent: 60 });

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("drops a signal from before the connection, because the first report covers it", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerMetrics> = [];
        const workspaceRemovals = yield* Queue.sliding<void>(1);
        // The runner was disconnected when this removal ended.
        Queue.offerUnsafe(workspaceRemovals, undefined);

        const loop = yield* Effect.forkChild(
          reportMetrics({
            readCpuTimes: STEADY(),
            readDiskAndMemory: Effect.succeed(ROOMY),
            send: (metrics) => Effect.sync(() => void sent.push(metrics)),
            workspaceRemovals,
          }),
        );
        yield* settle;
        yield* TestClock.adjust(Duration.millis(DELAY_MS * 2));

        expect(sent).toHaveLength(1);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("skips a removal's report when the disk cannot be read, and the periodic report goes on", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerMetrics> = [];
        let readable = true;
        const workspaceRemovals = yield* Queue.sliding<void>(1);
        const loop = yield* Effect.forkChild(
          reportMetrics({
            readCpuTimes: STEADY(),
            readDiskAndMemory: Effect.suspend(() =>
              readable
                ? Effect.succeed(ROOMY)
                : Effect.fail(new Cause.UnknownError(new Error("the filesystem did not answer"))),
            ),
            send: (metrics) => Effect.sync(() => void sent.push(metrics)),
            workspaceRemovals,
          }),
        );
        yield* settle;
        yield* TestClock.adjust(Duration.millis(DELAY_MS));

        readable = false;
        Queue.offerUnsafe(workspaceRemovals, undefined);
        yield* TestClock.adjust(Duration.millis(DELAY_MS * 2));
        expect(sent, "no report, and no retry").toHaveLength(1);

        readable = true;
        yield* TestClock.adjust(METRICS_INTERVAL);
        expect(sent).toHaveLength(2);

        yield* Fiber.interrupt(loop);
      }),
    );
  });
});
