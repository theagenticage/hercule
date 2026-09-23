/**
 * Keeps a connection open for ever: it reconnects with an exponential backoff,
 * and a signal can cut a wait short. When a laptop lid opens or the network
 * comes back, the reason the last attempt failed is probably gone. Waiting out
 * the rest of a thirty-second sleep then decides whether the runner is online
 * when its owner opens the web app.
 *
 * No portable API reports that the machine woke up, so the loop takes a stream
 * of signals and nothing else. `streamReconnectSignals` below guesses when the
 * machine woke up, and a platform-specific source could replace it without
 * changing the loop.
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

/** One second of timer drift means an overloaded machine; ten means the lid was shut. */
export const CLOCK_GAP_LIMIT: Duration.Duration = Duration.seconds(10);

export interface ReconnectOptions<E> {
  /** Completes when the attempt is over, however it ended. */
  readonly attempt: Effect.Effect<unknown, E>;
  /** Emits whenever it is worth trying again at once. */
  readonly signals: Stream.Stream<void>;
}

/**
 * Runs `attempt` again and again, waiting longer after each failure, up to
 * `RECONNECT_CAP`. Fails only with `RunnerRetired`, when the controller has
 * retired this runner. Two things reset the wait to `RECONNECT_BASE`:
 *
 * - a signal that the machine changed;
 * - an attempt that lasted longer than the cap. That was a working connection,
 *   not a failure, so it should not keep the long wait of an older outage.
 */
export const reconnect = <E>(options: ReconnectOptions<E>): Effect.Effect<never, RunnerRetired> =>
  Effect.gen(function* () {
    const cap = Duration.toMillis(RECONNECT_CAP);
    const base = Duration.toMillis(RECONNECT_BASE);

    // Subscribe once for the life of the loop. A new subscription per wait
    // would restart a stateful source and miss every signal while an attempt
    // is in flight, which is when the machine is most likely to change.
    const arrivals = yield* Queue.unbounded<void>();
    yield* Effect.forkChild(
      Effect.ignore(Stream.runForEach(options.signals, () => Queue.offer(arrivals, undefined))),
    );

    let wait = base;
    while (true) {
      const started = yield* Clock.currentTimeMillis;
      // Every ending is logged and retried, except one: a controller that has
      // retired this runner will never accept it again, however long it waits.
      const retired = yield* Effect.catchCause(
        Effect.as(options.attempt, undefined),
        (cause: Cause.Cause<E>) => {
          const ended = Option.getOrUndefined(
            Option.filter(Cause.findErrorOption(cause), (error) => error instanceof RunnerRetired),
          );
          // Check for retirement before logging the warning. A retirement needs
          // no investigating, and the caller's own message about joining again
          // should be the only line it produces.
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
        // A connection that lasted for hours has collected every network
        // change of the afternoon. Using them as back-to-back retries when it
        // drops would be wrong, so they are cleared. Signals that arrive during
        // a short failing attempt are kept: that is the case they exist for.
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
  /** Reads the wall clock, which keeps running while the machine sleeps. */
  readonly now: () => number;
  /** Lists every network address of this machine, in a stable order. */
  readonly addresses: () => ReadonlyArray<string>;
}

/**
 * Returns a stream that emits when the machine probably woke up or changed
 * network. Each second it takes a reading and compares it with the previous
 * one:
 *
 * - a clock jump much larger than the interval means the machine was asleep;
 * - a change in the address list means the network changed.
 *
 * It keeps only the previous reading.
 */
export const streamReconnectSignals = (readings: MachineReadings): Stream.Stream<void> => {
  const interval = Duration.toMillis(HEURISTIC_INTERVAL);
  const gapLimit = Duration.toMillis(CLOCK_GAP_LIMIT);
  const takeReading = () => ({ at: readings.now(), addresses: readings.addresses().join(",") });
  // Take the first reading when the stream runs, not when it is built. A
  // reading from minutes ago would make the first tick look like a long sleep.
  return Stream.suspend(() =>
    Stream.unfold(takeReading(), (previous) =>
      Effect.gen(function* () {
        let last = previous;
        while (true) {
          yield* Effect.sleep(HEURISTIC_INTERVAL);
          const next = takeReading();
          // Time well past one interval is time the machine was not running.
          const slept = next.at - last.at > interval + gapLimit;
          const moved = next.addresses !== last.addresses;
          last = next;
          if (slept || moved) return [undefined, last] as const;
        }
      }),
    ),
  );
};
