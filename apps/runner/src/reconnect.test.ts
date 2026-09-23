/**
 * The reconnect loop and the source that resets it.
 *
 * A runner that cannot reach its controller retries for ever, and the shape of
 * "for ever" is the whole of what is asserted here: 1 s doubling to a 30 s cap,
 * and three things that put it back to the start - a signal from the reconnect
 * source, and a connection that stood up long enough to say the trouble is over.
 *
 * The loop names no clock and no network API, so both are handed to it: the
 * delays run on a `TestClock`, and the heuristic reads the wall clock and the
 * interface addresses through functions this test owns. That is the only way to
 * make a laptop sleep and a network change happen on demand.
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

/** A connection attempt that never gets anywhere, counted. */
const buildFailingAttempt = (count: { at: number }) =>
  Effect.suspend(() => {
    count.at += 1;
    return Effect.fail("the controller is not answering" as const);
  });

/** Lets the forked loop run without moving time. */
const settle = TestClock.adjust(Duration.zero);

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** The delays the schedule walks, in seconds, before it flattens at the cap. */
const WALK = [1, 2, 4, 8, 16, 30, 30, 30];

describe("the reconnect schedule", () => {
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

        // The cap is the cap, not a limit on the number of tries.
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

        // A lid opening: the wait is abandoned rather than waited out.
        yield* Queue.offer(signals, undefined);
        yield* settle;
        expect(count.at).toBe(4);

        // And the schedule is back at its first delay, not where it left off.
        yield* TestClock.adjust(Duration.millis(999));
        expect(count.at).toBe(4);
        yield* TestClock.adjust(Duration.millis(1));
        expect(count.at).toBe(5);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("starts over after a connection that held past the cap", async () => {
    await run(
      Effect.gen(function* () {
        const count = { at: 0 };
        const held = Duration.sum(RECONNECT_CAP, Duration.seconds(1));
        const attempt = Effect.suspend(() => {
          count.at += 1;
          const failure = Effect.fail("the connection ended" as const);
          // The third connection stands up for longer than the cap before it
          // is lost, which is a working link rather than a failing one.
          return count.at === 3 ? Effect.andThen(Effect.sleep(held), failure) : failure;
        });
        const loop = yield* Effect.forkChild(reconnect({ attempt, signals: Stream.never }));

        yield* settle;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        expect(count.at, "the third attempt is the one that holds").toBe(3);

        yield* TestClock.adjust(held);
        expect(count.at, "it is still holding until the connection ends").toBe(3);

        // Four seconds would be next had nothing worked; a second is what
        // follows a connection that did.
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
        // A dial that sits in a connect for a while before it gives up.
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
        // The lid opens halfway through the attempt: the reason it is failing
        // may already be gone by the time it reports that it failed.
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Queue.offer(signals, undefined);
        yield* TestClock.adjust(Duration.seconds(2));

        yield* settle;
        expect(count.at, "the wait was abandoned rather than served out").toBe(2);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("does not bank the signals of a connection that was holding", async () => {
    await run(
      Effect.gen(function* () {
        const count = { at: 0 };
        const signals = yield* Queue.unbounded<void>();
        const held = Duration.sum(RECONNECT_CAP, Duration.seconds(1));
        const attempt = Effect.suspend(() => {
          count.at += 1;
          // The first connection stands up for a while - a machine whose
          // network changed three times over an afternoon and kept working.
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
        expect(count.at, "the connection was holding through all of them").toBe(1);

        // The afternoon's signals are spent, not saved: the schedule's first
        // delay is waited out in full.
        yield* TestClock.adjust(Duration.millis(999));
        expect(count.at).toBe(1);
        yield* TestClock.adjust(Duration.millis(1));
        expect(count.at).toBe(2);

        // And a signal that arrives while there is a wait still cuts it short.
        yield* Queue.offer(signals, undefined);
        yield* settle;
        expect(count.at).toBe(3);

        yield* Fiber.interrupt(loop);
      }),
    );
  });
});

describe("the reconnect source", () => {
  /** Collects what the source emits, for as long as the fiber lives. */
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

  it("signals when a one-second timer fires far later than a second", async () => {
    await run(
      Effect.gen(function* () {
        const wall = { at: Date.parse("2026-09-05T10:00:00.000Z") };
        const addresses = ["192.168.1.10"];
        const { seen, fiber } = yield* collectEmissions(
          streamReconnectSignals({ now: () => wall.at, addresses: () => addresses }),
        );

        // A tick where the wall clock moved the way the timer did: nothing
        // happened to this machine.
        wall.at += Duration.toMillis(HEURISTIC_INTERVAL);
        yield* TestClock.adjust(HEURISTIC_INTERVAL);
        yield* settle;
        expect(seen.count, "an ordinary tick is not a wake").toBe(0);

        // A tick the machine slept through: one interval on the fiber's clock,
        // far more than that on the wall.
        wall.at += Duration.toMillis(HEURISTIC_INTERVAL) + Duration.toMillis(CLOCK_GAP_LIMIT) + 1;
        yield* TestClock.adjust(HEURISTIC_INTERVAL);
        yield* settle;
        expect(seen.count).toBe(1);

        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  it("reads the machine afresh every time it is run", async () => {
    await run(
      Effect.gen(function* () {
        const wall = { at: Date.parse("2026-09-05T10:00:00.000Z") };
        const addresses = ["192.168.1.10"];
        const source = streamReconnectSignals({ now: () => wall.at, addresses: () => addresses });

        // A long first run: nothing happens to the machine, so nothing is said.
        const first = yield* collectEmissions(source);
        for (let tick = 0; tick < 30; tick++) {
          wall.at += Duration.toMillis(HEURISTIC_INTERVAL);
          yield* TestClock.adjust(HEURISTIC_INTERVAL);
        }
        yield* settle;
        expect(first.seen.count).toBe(0);
        yield* Fiber.interrupt(first.fiber);

        // A second run compares against what it reads now, not against what the
        // first run started from half a minute ago.
        const second = yield* collectEmissions(source);
        wall.at += Duration.toMillis(HEURISTIC_INTERVAL);
        yield* TestClock.adjust(HEURISTIC_INTERVAL);
        yield* settle;
        expect(second.seen.count, "nothing happened to this machine").toBe(0);

        yield* Fiber.interrupt(second.fiber);
      }),
    );
  });

  it("signals when the machine's addresses change, and not while they hold", async () => {
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
        expect(seen.count, "and then held").toBe(1);

        addresses = ["10.0.0.4"];
        yield* tick;
        expect(seen.count, "an address went away").toBe(2);

        yield* Fiber.interrupt(fiber);
      }),
    );
  });
});

describe("a runner the controller has retired", () => {
  it("stops the loop rather than redialling with a dead credential", async () => {
    /** Every line the loop logged, so what it said can be asserted. */
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
                message: "this runner was retired; run `hercule runner join` to re-enlist",
              }),
            );
          });
          const loop = yield* Effect.forkChild(
            Effect.result(reconnect({ attempt, signals: Stream.never })),
          );

          yield* settle;
          // Every other ending is worth another dial; this one is the credential
          // being gone, and no amount of waiting brings it back.
          const ended = loop.pollUnsafe();
          expect(
            ended,
            "the loop is still trying a controller that will not have it",
          ).toBeDefined();
          expect(count.at).toBe(1);

          const outcome =
            ended?._tag === "Success"
              ? (ended.value as { readonly _tag: string; readonly failure?: unknown })
              : undefined;
          expect(outcome?._tag).toBe("Failure");
          // Carried out rather than logged: the daemon prints it and exits.
          expect(outcome?.failure).toBeInstanceOf(RunnerRetired);
          // A retirement is not an ending anyone should go looking into, so the
          // warning every other ending gets is not written for this one.
          expect(said).toEqual([]);
        }),
        Logger.layer([collecting]),
      ),
    );
  });
});
