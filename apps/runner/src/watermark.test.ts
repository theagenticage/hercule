/**
 * Tests the headroom a runner reports. The report loop:
 *
 * - sends a reading at once, so a runner that has just connected does not go
 *   a minute without reporting its disk;
 * - then sends one every sixty seconds;
 * - skips a reading that fails, instead of reporting zero free bytes, which
 *   would take the machine out of service because of one failed `statfs`.
 *
 * The controller decides whether a reading means the machine can take work;
 * that is not tested here.
 *
 * The interval runs on a `TestClock`, like the reconnect loop's tests. The
 * reading is passed in, because a test cannot fill a real disk.
 */
import { describe, expect, it } from "vitest";
import { Cause, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { freemem, tmpdir, totalmem } from "node:os";
import type { RunnerWatermark } from "@hercule/protocol";
import { reportWatermark, readMachineHeadroom, WATERMARK_INTERVAL } from "./watermark";

const GIB = 1024 * 1024 * 1024;

/** A machine with plenty of room. Tests lower its free disk from here. */
const ROOMY: RunnerWatermark = { diskFreeBytes: 200 * GIB, availableMemoryBytes: 16 * GIB };

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** Lets a forked loop run without moving time. */
const settle = TestClock.adjust(Duration.zero);

describe("readMachineHeadroom on the real machine", () => {
  it("returns the free bytes of the filesystem that holds a path", async () => {
    const headroom = await Effect.runPromise(readMachineHeadroom(tmpdir()));

    expect(Number.isInteger(headroom.diskFreeBytes)).toBe(true);
    expect(headroom.diskFreeBytes).toBeGreaterThan(0);
    expect(Number.isInteger(headroom.availableMemoryBytes)).toBe(true);
    expect(headroom.availableMemoryBytes).toBeGreaterThan(0);
    // Available memory can never exceed total memory, and both are in bytes,
    // the unit the runner's facts use for the total.
    expect(headroom.availableMemoryBytes).toBeLessThanOrEqual(totalmem());
    expect(freemem()).toBeGreaterThan(0);
  });

  it("fails instead of guessing when the path does not exist", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(readMachineHeadroom("/no/such/directory/on/this/machine")),
    );
    expect(outcome._tag).toBe("Failure");
  });
});

describe("reportWatermark", () => {
  it("reports at once and then on the interval", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerWatermark> = [];

        const loop = yield* Effect.forkChild(
          reportWatermark({
            read: Effect.succeed(ROOMY),
            send: (watermark) => Effect.sync(() => void sent.push(watermark)),
          }),
        );

        yield* settle;
        // Sent right after connecting, without waiting a minute first.
        expect(sent).toHaveLength(1);
        expect(sent[0]).toEqual({
          diskFreeBytes: 200 * GIB,
          availableMemoryBytes: 16 * GIB,
        });

        yield* TestClock.adjust(Duration.millis(59_999));
        expect(sent, "a millisecond before the minute").toHaveLength(1);
        yield* TestClock.adjust(Duration.millis(1));
        expect(sent, "on the minute").toHaveLength(2);

        for (let minute = 0; minute < 5; minute++) yield* TestClock.adjust(WATERMARK_INTERVAL);
        expect(sent).toHaveLength(7);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("reports every minute, not only when the reading changed", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerWatermark> = [];
        let disk = 200 * GIB;

        const loop = yield* Effect.forkChild(
          reportWatermark({
            read: Effect.suspend(() =>
              Effect.succeed({ ...ROOMY, diskFreeBytes: disk } satisfies RunnerWatermark),
            ),
            send: (watermark) => Effect.sync(() => void sent.push(watermark)),
          }),
        );

        yield* settle;
        // The disk fills up and then frees up while the loop runs.
        disk = 4 * GIB;
        yield* TestClock.adjust(WATERMARK_INTERVAL);
        disk = 40 * GIB;
        yield* TestClock.adjust(WATERMARK_INTERVAL);

        expect(sent.map((one) => one.diskFreeBytes)).toEqual([200 * GIB, 4 * GIB, 40 * GIB]);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("skips a reading that fails and keeps checking", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerWatermark> = [];
        let readable = false;

        const loop = yield* Effect.forkChild(
          reportWatermark({
            read: Effect.suspend(() =>
              readable
                ? Effect.succeed(ROOMY)
                : Effect.fail(new Cause.UnknownError(new Error("the filesystem did not answer"))),
            ),
            send: (watermark) => Effect.sync(() => void sent.push(watermark)),
          }),
        );

        yield* settle;
        // A failed reading does not mean the machine has no disk left.
        expect(sent).toEqual([]);

        yield* TestClock.adjust(WATERMARK_INTERVAL);
        expect(sent).toEqual([]);

        readable = true;
        yield* TestClock.adjust(WATERMARK_INTERVAL);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.diskFreeBytes).toBe(ROOMY.diskFreeBytes);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("stops as soon as it is interrupted, and queues nothing for later", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerWatermark> = [];

        const loop = yield* Effect.forkChild(
          reportWatermark({
            read: Effect.succeed(ROOMY),
            send: (watermark) => Effect.sync(() => void sent.push(watermark)),
          }),
        );

        yield* settle;
        expect(sent).toHaveLength(1);

        // The connection ended. No readings queue up for the next connection,
        // because a reading taken now is out of date by the time the runner
        // reconnects.
        yield* Fiber.interrupt(loop);
        for (let minute = 0; minute < 10; minute++) yield* TestClock.adjust(WATERMARK_INTERVAL);
        expect(sent).toHaveLength(1);
      }),
    );
  });
});
