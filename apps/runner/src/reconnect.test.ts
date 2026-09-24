/**
 * Tests the reconnect loop and the signal source that resets it.
 *
 * A runner that cannot reach its controller retries for ever. These tests
 * check the timing of those retries: the wait starts at 1 s and doubles up to
 * a 30 s cap. Two things reset the wait to 1 s:
 *
 * - a signal from the reconnect source;
 * - a connection that lasted long enough to show the problem is over.
 *
 * The loop uses no clock or network API directly, so both are passed in. The
 * delays run on a `TestClock`, and the signal source reads the wall clock and
 * the network addresses through functions the test controls. That is the only
 * way to make a laptop sleep or a network change happen on demand.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Logger, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  CLOCK_GAP_LIMIT,
  HEURISTIC_INTERVAL,
  RECONNECT_BASE,
  RECONNECT_CAP,
  reconnect,
  streamReconnectSignals,
} from "./reconnect";
import { RunnerRetired } from "./socket";

/** Returns an attempt that always fails, and counts each try in `count`. */
const buildFailingAttempt = (count: { at: number }) =>
  Effect.suspend(() => {
    count.at += 1;
    return Effect.fail("the controller is not answering" as const);
  });

/** Lets the forked loop run without moving time. */
const settle = TestClock.adjust(Duration.zero);

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** The waits between attempts, in seconds, up to and at the cap. */
const WALK = [1, 2, 4, 8, 16, 30, 30, 30];

describe("reconnect", () => {
  it("doubles from a second to a thirty-second cap and keeps trying", async () => {
    await run(
      Effect.gen(function* () {
        const count = { at: 0 };
        const loop = yield* Effect.forkChild(
          reconnect({ attempt: buildFailingAttempt(count), signals: Stream.never }),
        );

        yield* settle;
        expect(count.at, "the first attempt is made at once").toBe(1);

        for (const [index, seconds] of WALK.entries()) {
          const expected = index + 2;
          yield* TestClock.adjust(Duration.millis(seconds * 1000 - 1));
          expect(count.at, `a millisecond before ${String(seconds)} s`).toBe(expected - 1);
          yield* TestClock.adjust(Duration.millis(1));
          expect(count.at, `at ${String(seconds)} s`).toBe(expected);
        }

        // The cap limits the wait, not the number of tries.
        expect(Duration.toMillis(RECONNECT_BASE)).toBe(1000);
        expect(Duration.toMillis(RECONNECT_CAP)).toBe(30_000);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("retries at once on a signal, and starts the schedule over", async () => {
    await run(
      Effect.gen(function* () {
        const count = { at: 0 };
        const signals = yield* Queue.unbounded<void>();
        const loop = yield* Effect.forkChild(
          reconnect({ attempt: buildFailingAttempt(count), signals: Stream.fromQueue(signals) }),
        );

        yield* settle;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        expect(count.at, "three attempts, so the next delay would be four seconds").toBe(3);

        // The lid opens: the loop stops waiting and tries at once.
        yield* Queue.offer(signals, undefined);
        yield* settle;
        expect(count.at).toBe(4);

        // The wait is back to its first value, not where it left off.
        yield* TestClock.adjust(Duration.millis(999));
        expect(count.at).toBe(4);
        yield* TestClock.adjust(Duration.millis(1));
        expect(count.at).toBe(5);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("starts over after a connection that lasted longer than the cap", async () => {
    await run(
      Effect.gen(function* () {
        const count = { at: 0 };
        const held = Duration.sum(RECONNECT_CAP, Duration.seconds(1));
        const attempt = Effect.suspend(() => {
          count.at += 1;
          const failure = Effect.fail("the connection ended" as const);
          // The third connection lasts longer than the cap before it ends, so
          // it was a working connection, not a failing one.
          return count.at === 3 ? Effect.andThen(Effect.sleep(held), failure) : failure;
        });
        const loop = yield* Effect.forkChild(reconnect({ attempt, signals: Stream.never }));

        yield* settle;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        expect(count.at, "the third attempt is the one that lasts").toBe(3);

        yield* TestClock.adjust(held);
        expect(count.at, "no new attempt until the connection ends").toBe(3);

        // After three failures the wait would be four seconds. After a
        // working connection it is one second.
        yield* TestClock.adjust(Duration.millis(999));
        expect(count.at).toBe(3);
        yield* TestClock.adjust(Duration.millis(1));
        expect(count.at).toBe(4);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("keeps a signal that arrives while a failing attempt is in flight", async () => {
    await run(
      Effect.gen(function* () {
        const count = { at: 0 };
        const signals = yield* Queue.unbounded<void>();
        // An attempt that takes a while to fail.
        const attempt = Effect.suspend(() => {
          count.at += 1;
          return Effect.andThen(
            Effect.sleep(Duration.seconds(3)),
            Effect.fail("the controller is not answering" as const),
          );
        });
        const loop = yield* Effect.forkChild(
          reconnect({ attempt, signals: Stream.fromQueue(signals) }),
        );

        yield* settle;
        // The lid opens during the attempt, so the reason it fails may already
        // be gone by the time it reports the failure.
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Queue.offer(signals, undefined);
        yield* TestClock.adjust(Duration.seconds(2));

        yield* settle;
        expect(count.at, "the loop retried at once instead of waiting").toBe(2);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("drops the signals that arrived during a long-lived connection", async () => {
    await run(
      Effect.gen(function* () {
        const count = { at: 0 };
        const signals = yield* Queue.unbounded<void>();
        const held = Duration.sum(RECONNECT_CAP, Duration.seconds(1));
        const attempt = Effect.suspend(() => {
          count.at += 1;
          // The first connection lasts a while, like a machine whose network
          // changed three times in an afternoon and kept working.
          return count.at === 1
            ? Effect.andThen(Effect.sleep(held), Effect.fail("the connection ended" as const))
            : Effect.fail("the controller is not answering" as const);
        });
        const loop = yield* Effect.forkChild(
          reconnect({ attempt, signals: Stream.fromQueue(signals) }),
        );

        yield* settle;
        for (let signal = 0; signal < 3; signal++) yield* Queue.offer(signals, undefined);
        yield* TestClock.adjust(held);
        expect(count.at, "the connection stayed up through all of them").toBe(1);

        // The afternoon's signals were dropped, so the loop waits the full first
        // delay.
        yield* TestClock.adjust(Duration.millis(999));
        expect(count.at).toBe(1);
        yield* TestClock.adjust(Duration.millis(1));
        expect(count.at).toBe(2);

        // A signal that arrives during a wait still cuts it short.
        yield* Queue.offer(signals, undefined);
        yield* settle;
        expect(count.at).toBe(3);

        yield* Fiber.interrupt(loop);
      }),
    );
  });
});

describe("streamReconnectSignals", () => {
  /** Counts the source's emissions for as long as the returned fiber runs. */
  const collectEmissions = (source: Stream.Stream<void>) =>
    Effect.gen(function* () {
      const seen = { count: 0 };
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(source, () =>
          Effect.sync(() => {
            seen.count += 1;
          }),
        ),
      );
      return { seen, fiber };
    });

  it("emits when a one-second timer fires much later than a second", async () => {
    await run(
      Effect.gen(function* () {
        const wall = { at: Date.parse("2026-09-05T10:00:00.000Z") };
        const addresses = ["192.168.1.10"];
        const { seen, fiber } = yield* collectEmissions(
          streamReconnectSignals({ now: () => wall.at, addresses: () => addresses }),
        );

        // A tick where the wall clock moved as much as the timer: the machine
        // did not sleep.
        wall.at += Duration.toMillis(HEURISTIC_INTERVAL);
        yield* TestClock.adjust(HEURISTIC_INTERVAL);
        yield* settle;
        expect(seen.count, "a normal tick is not a wake-up").toBe(0);

        // A tick the machine slept through: one interval on the fiber's clock,
        // but far more on the wall clock.
        wall.at += Duration.toMillis(HEURISTIC_INTERVAL) + Duration.toMillis(CLOCK_GAP_LIMIT) + 1;
        yield* TestClock.adjust(HEURISTIC_INTERVAL);
        yield* settle;
        expect(seen.count).toBe(1);

        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  it("takes a new first reading every time the stream runs", async () => {
    await run(
      Effect.gen(function* () {
        const wall = { at: Date.parse("2026-09-05T10:00:00.000Z") };
        const addresses = ["192.168.1.10"];
        const source = streamReconnectSignals({ now: () => wall.at, addresses: () => addresses });

        // A long first run with no change to the machine, so nothing is emitted.
        const first = yield* collectEmissions(source);
        for (let tick = 0; tick < 30; tick++) {
          wall.at += Duration.toMillis(HEURISTIC_INTERVAL);
          yield* TestClock.adjust(HEURISTIC_INTERVAL);
        }
        yield* settle;
        expect(first.seen.count).toBe(0);
        yield* Fiber.interrupt(first.fiber);

        // A second run compares with a reading taken now, not with the reading
        // the first run started from half a minute ago.
        const second = yield* collectEmissions(source);
        wall.at += Duration.toMillis(HEURISTIC_INTERVAL);
        yield* TestClock.adjust(HEURISTIC_INTERVAL);
        yield* settle;
        expect(second.seen.count, "the machine did not change").toBe(0);

        yield* Fiber.interrupt(second.fiber);
      }),
    );
  });

  it("emits when the machine's addresses change, and not while they stay the same", async () => {
    await run(
      Effect.gen(function* () {
        const wall = { at: Date.parse("2026-09-05T10:00:00.000Z") };
        let addresses: ReadonlyArray<string> = ["192.168.1.10"];
        const tick = Effect.gen(function* () {
          wall.at += Duration.toMillis(HEURISTIC_INTERVAL);
          yield* TestClock.adjust(HEURISTIC_INTERVAL);
          yield* settle;
        });
        const { seen, fiber } = yield* collectEmissions(
          streamReconnectSignals({ now: () => wall.at, addresses: () => addresses }),
        );

        yield* tick;
        expect(seen.count, "the same addresses are not a change").toBe(0);

        addresses = ["192.168.1.10", "10.0.0.4"];
        yield* tick;
        expect(seen.count, "an address appeared").toBe(1);

        yield* tick;
        expect(seen.count, "and then stayed").toBe(1);

        addresses = ["10.0.0.4"];
        yield* tick;
        expect(seen.count, "an address went away").toBe(2);

        yield* Fiber.interrupt(fiber);
      }),
    );
  });
});

describe("a runner the controller has retired", () => {
  it("stops the loop instead of reconnecting with a revoked credential", async () => {
    /** Every message the loop logged. */
    const said: Array<string> = [];
    const collecting = Logger.make<unknown, void>(({ message }) => {
      said.push(String(message));
    });

    await run(
      Effect.provide(
        Effect.gen(function* () {
          const count = { at: 0 };
          const attempt = Effect.suspend(() => {
            count.at += 1;
            return Effect.fail(
              new RunnerRetired({
                message:
                  "this runner was retired; run `hercule runner join` to join the fleet again",
              }),
            );
          });
          const loop = yield* Effect.forkChild(
            Effect.result(reconnect({ attempt, signals: Stream.never })),
          );

          yield* settle;
          // Every other failure is worth another attempt. This one means the
          // credential is revoked, and no amount of waiting brings it back.
          const ended = loop.pollUnsafe();
          expect(
            ended,
            "the loop is still trying a controller that retired this runner",
          ).toBeDefined();
          expect(count.at).toBe(1);

          const outcome =
            ended?._tag === "Success"
              ? (ended.value as { readonly _tag: string; readonly failure?: unknown })
              : undefined;
          expect(outcome?._tag).toBe("Failure");
          // Returned instead of logged: the daemon prints it and exits.
          expect(outcome?.failure).toBeInstanceOf(RunnerRetired);
          // A retirement needs no investigating, so the loop does not log the
          // warning it logs for every other failure.
          expect(said).toEqual([]);
        }),
        Logger.layer([collecting]),
      ),
    );
  });
});
