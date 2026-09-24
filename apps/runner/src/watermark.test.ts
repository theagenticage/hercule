/**
 * The headroom a runner reports.
 *
 * What is asserted here is the check: it reports at once so a runner that has
 * just said hello is not silent about its disk for a minute, then every sixty
 * seconds, and a reading it could not take is skipped rather than reported as
 * zero free bytes - which would take the whole fleet out of service on one
 * unlucky `statfs`. Whether a reading means the machine can take work is the
 * controller's, against the watermark it holds; this file only reports.
 *
 * The interval runs on a `TestClock`, as the reconnect loop's schedule does.
 * The disk is handed in, because a test cannot fill one.
 */
import { describe, expect, it } from "vitest";
import { Cause, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { freemem, tmpdir, totalmem } from "node:os";
import type { RunnerWatermark } from "@hercule/protocol";
import { reportWatermark, readMachineHeadroom, WATERMARK_INTERVAL } from "./watermark";

const GIB = 1024 * 1024 * 1024;

/** A machine with room to spare, which tests take disk away from. */
const ROOMY: RunnerWatermark = { diskFreeBytes: 200 * GIB, availableMemoryBytes: 16 * GIB };

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** Lets a forked loop run without moving time. */
const settle = TestClock.adjust(Duration.zero);

describe("reading the real machine", () => {
  it("reports the free bytes of the filesystem a path sits on, in bytes", async () => {
    const headroom = await Effect.runPromise(readMachineHeadroom(tmpdir()));

    expect(Number.isInteger(headroom.diskFreeBytes)).toBe(true);
    expect(headroom.diskFreeBytes).toBeGreaterThan(0);
    expect(Number.isInteger(headroom.availableMemoryBytes)).toBe(true);
    expect(headroom.availableMemoryBytes).toBeGreaterThan(0);
    // Available, not fitted: whatever the machine can still hand out is at most
    // what it has, and is in the same units the facts report the total in.
    expect(headroom.availableMemoryBytes).toBeLessThanOrEqual(totalmem());
    expect(freemem()).toBeGreaterThan(0);
  });

  it("fails rather than guessing when the path is not there", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(readMachineHeadroom("/no/such/directory/on/this/machine")),
    );
    expect(outcome._tag).toBe("Failure");
  });
});

describe("the sixty-second check", () => {
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
        // Right after the hello, without waiting out a minute first.
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

  it("reports the same reading again rather than only when it changed", async () => {
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
        // A disk filling up while the runner watched it.
        disk = 4 * GIB;
        yield* TestClock.adjust(WATERMARK_INTERVAL);
        disk = 40 * GIB;
        yield* TestClock.adjust(WATERMARK_INTERVAL);

        expect(sent.map((one) => one.diskFreeBytes)).toEqual([200 * GIB, 4 * GIB, 40 * GIB]);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("skips a reading it could not take and keeps checking", async () => {
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
        // A reading nobody could take is not a machine with no disk left.
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

  it("stops the moment it is interrupted, holding nothing back for later", async () => {
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

        // The connection ended. A watermark with no socket under it is dropped:
        // nothing queues up for the next one, because a reading taken now says
        // nothing useful about the machine when it reconnects.
        yield* Fiber.interrupt(loop);
        for (let minute = 0; minute < 10; minute++) yield* TestClock.adjust(WATERMARK_INTERVAL);
        expect(sent).toHaveLength(1);
      }),
    );
  });
});
