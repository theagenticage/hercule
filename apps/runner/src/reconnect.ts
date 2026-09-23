/**
 * Holding a connection open for ever, on a plain doubling backoff whose wait can
 * be abandoned. A lid opening or a network coming back means the reason the last
 * attempt failed is probably gone, and waiting out the rest of a thirty-second
 * sleep is the difference between a runner being there when its owner opens the
 * screen and not.
 *
 * No portable API says "the machine woke", so the loop takes a stream of signals
 * and nothing else; `streamReconnectSignals` below guesses at them, and a platform
 * source can replace it without the loop knowing.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { RunnerRetired } from "./socket";

export const RECONNECT_BASE: Duration.Duration = Duration.seconds(1);

export const RECONNECT_CAP: Duration.Duration = Duration.seconds(30);

export const HEURISTIC_INTERVAL: Duration.Duration = Duration.seconds(1);

/** A second of timer drift is an overloaded box; ten is a lid that was shut. */
export const CLOCK_GAP_LIMIT: Duration.Duration = Duration.seconds(10);

export interface ReconnectOptions<E> {
  /** Returns when the attempt is over, however it ended. */
  readonly attempt: Effect.Effect<unknown, E>;
  /** Emits whenever it is worth trying again at once. */
  readonly signals: Stream.Stream<void>;
}

/**
 * Two things start the schedule over: a signal that the machine changed, and an
 * attempt that held longer than the cap, which was a working connection rather
 * than a failure and should not inherit an older outage's climb.
 */
export const reconnect = <E>(options: ReconnectOptions<E>): Effect.Effect<never, RunnerRetired> =>
  Effect.gen(function* () {
    const cap = Duration.toMillis(RECONNECT_CAP);
    const base = Duration.toMillis(RECONNECT_BASE);

    // One subscription for the life of the loop. A fresh one per wait would
    // restart a stateful source and hear nothing while an attempt is in flight,
    // which is when a machine is most likely to change under it.
    const arrivals = yield* Queue.unbounded<void>();
    yield* Effect.forkChild(
      Effect.ignore(Stream.runForEach(options.signals, () => Queue.offer(arrivals, undefined))),
    );

    let wait = base;
    while (true) {
      const started = yield* Clock.currentTimeMillis;
      // Every ending is logged and dialled again, bar one: a controller that
      // has retired this runner will not have it back, whatever it waits.
      const retired = yield* Effect.catchCause(
        Effect.as(options.attempt, undefined),
        (cause: Cause.Cause<E>) => {
          const ended = Option.getOrUndefined(
            Option.filter(Cause.findErrorOption(cause), (error) => error instanceof RunnerRetired),
          );
          // A retirement is not an ending anyone should go looking into, so it
          // is picked out before the warning: the caller's own message about
          // re-enlisting is the only line it should produce.
          if (ended !== undefined) return Effect.succeed(ended);
          return Effect.as(
            Effect.logWarning("The connection to the controller ended", cause),
            undefined,
          );
        },
      );
      if (retired !== undefined) return yield* Effect.fail(retired);
      const held = (yield* Clock.currentTimeMillis) - started;
      if (held >= cap) {
        wait = base;
        // A connection held for hours banks every network change of the
        // afternoon, and spending those as back-to-back retries when it drops is
        // the opposite of what they mean. Signals during a short failing attempt
        // are kept: that is the case the source exists for.
        yield* Queue.clear(arrivals);
      }
      const signalled = yield* Effect.race(
        Effect.as(Effect.sleep(Duration.millis(wait)), false),
        Effect.as(Queue.take(arrivals), true),
      );
      wait = signalled ? base : Math.min(wait * 2, cap);
    }
  });

export interface MachineReadings {
  /** The wall clock, which a sleeping machine does not stop. */
  readonly now: () => number;
  /** Every address this machine holds, in a stable order. */
  readonly addresses: () => ReadonlyArray<string>;
}

/** Compares each tick with the one before, so it holds nothing but the last reading. */
export const streamReconnectSignals = (readings: MachineReadings): Stream.Stream<void> => {
  const interval = Duration.toMillis(HEURISTIC_INTERVAL);
  const gapLimit = Duration.toMillis(CLOCK_GAP_LIMIT);
  const takeReading = () => ({ at: readings.now(), addresses: readings.addresses().join(",") });
  // Taken when the stream is run, not when it is built: a baseline from minutes
  // ago makes the first tick look like a long sleep.
  return Stream.suspend(() =>
    Stream.unfold(takeReading(), (previous) =>
      Effect.gen(function* () {
        let last = previous;
        while (true) {
          yield* Effect.sleep(HEURISTIC_INTERVAL);
          const next = takeReading();
          // Anything much past one interval is time the machine was not running.
          const slept = next.at - last.at > interval + gapLimit;
          const moved = next.addresses !== last.addresses;
          last = next;
          if (slept || moved) return [undefined, last] as const;
        }
      }),
    ),
  );
};
