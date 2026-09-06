/**
 * The headroom a runner reports, and what it means for placement.
 *
 * Two things are asserted here. The line: below ten gibibytes of free disk a
 * machine stops accepting work, and what a reading means is a pure function of
 * the reading, so it is checked a byte either side of the mark. And the check
 * itself: it reports at once so a runner that has just said hello is not
 * silent about its disk for a minute, then every sixty seconds, and a reading
 * it could not take is skipped rather than reported as zero free bytes - which
 * would take the whole fleet out of service on one unlucky `statfs`.
 *
 * The interval runs on a `TestClock`, as the reconnect loop's schedule does.
 * The disk is handed in, because a test cannot fill one.
 */
import { describe, expect, it } from "vitest";
import { Cause, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { freemem, tmpdir, totalmem } from "node:os";
import type { RunnerWatermark } from "@hydra/protocol";
import {
  checkWatermark,
  DISK_WATERMARK_BYTES,
  machineHeadroom,
  watermarkOf,
  WATERMARK_INTERVAL,
  type Headroom,
} from "./watermark";

const GIB = 1024 * 1024 * 1024;

/** A machine with room to spare, which tests take disk away from. */
const ROOMY: Headroom = { diskFreeBytes: 200 * GIB, availableMemoryBytes: 16 * GIB };

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** Lets a forked loop run without moving time. */
const settle = TestClock.adjust(Duration.zero);

describe("what a reading means", () => {
  it("draws the line at ten gibibytes of free disk", () => {
    expect(DISK_WATERMARK_BYTES).toBe(10 * GIB);
    expect(Duration.toMillis(WATERMARK_INTERVAL)).toBe(60_000);
  });

  it("stops accepting placements below the mark and accepts above it", () => {
    const at = (diskFreeBytes: number): boolean =>
      watermarkOf({ ...ROOMY, diskFreeBytes }).acceptingPlacements;

    expect(at(0), "a full disk").toBe(false);
    expect(at(DISK_WATERMARK_BYTES - 1), "a byte below the mark").toBe(false);
    // At the mark the machine is not below it, so it is still taking work.
    expect(at(DISK_WATERMARK_BYTES), "exactly at the mark").toBe(true);
    expect(at(DISK_WATERMARK_BYTES + 1), "a byte above the mark").toBe(true);
    expect(at(200 * GIB), "a disk with room to spare").toBe(true);
  });

  it("carries the reading through untouched", () => {
    expect(watermarkOf(ROOMY)).toEqual({
      diskFreeBytes: 200 * GIB,
      availableMemoryBytes: 16 * GIB,
      acceptingPlacements: true,
    });
    // Memory has no watermark: a machine short of memory still takes work.
    expect(watermarkOf({ diskFreeBytes: 200 * GIB, availableMemoryBytes: 0 })).toEqual({
      diskFreeBytes: 200 * GIB,
      availableMemoryBytes: 0,
      acceptingPlacements: true,
    });
  });
});

describe("reading the real machine", () => {
  it("reports the free bytes of the filesystem a path sits on, in bytes", async () => {
    const headroom = await Effect.runPromise(machineHeadroom(tmpdir()));

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
      Effect.result(machineHeadroom("/no/such/directory/on/this/machine")),
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
          checkWatermark({
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
          acceptingPlacements: true,
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
          checkWatermark({
            read: Effect.suspend(() =>
              Effect.succeed({ ...ROOMY, diskFreeBytes: disk } satisfies Headroom),
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

        expect(sent.map((one) => one.acceptingPlacements)).toEqual([true, false, true]);
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
          checkWatermark({
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
        expect(sent[0]?.acceptingPlacements).toBe(true);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("stops the moment it is interrupted, holding nothing back for later", async () => {
    await run(
      Effect.gen(function* () {
        const sent: Array<RunnerWatermark> = [];

        const loop = yield* Effect.forkChild(
          checkWatermark({
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
