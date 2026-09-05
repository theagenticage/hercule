/**
 * Holding a connection open for ever, and the one thing that tells the loop it
 * is worth trying again right now.
 *
 * The schedule is the plain one: try, then wait a second, then two, then four,
 * up to thirty, and never stop. What makes it bearable on a laptop is that the
 * wait can be abandoned. A lid opening or a network coming back means the
 * reason the last attempt failed is probably gone, and waiting out the rest of
 * a thirty-second sleep for that is the difference between a runner that is
 * there when its owner opens the screen and one that is not.
 *
 * No portable API says "the machine woke" or "the network changed", so the loop
 * does not ask for one. It takes a stream of signals and nothing else, and what
 * produces them is `reconnectSignals` below: a timer that fires far later than
 * it was set for means the machine was asleep, and an interface address set
 * that changed means the network did. A platform source can replace or join it
 * later without the loop knowing.
 */
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** The first wait after a failed attempt. */
export const RECONNECT_BASE: Duration.Duration = Duration.seconds(1);

/** The longest wait between attempts, however many have failed. */
export const RECONNECT_CAP: Duration.Duration = Duration.seconds(30);

/** How often the source looks at the machine. */
export const HEURISTIC_INTERVAL: Duration.Duration = Duration.seconds(1);

/**
 * How much later than its interval a timer must fire for the gap to mean sleep
 * rather than a busy machine. A second of drift is an overloaded box; ten is a
 * lid that was shut.
 */
export const CLOCK_GAP_LIMIT: Duration.Duration = Duration.seconds(10);

/** What one connection attempt is: an effect that returns when it is over. */
export interface ReconnectOptions<E> {
  readonly attempt: Effect.Effect<unknown, E>;
  /** Emits whenever it is worth trying again at once. */
  readonly signals: Stream.Stream<void>;
}

/**
 * Attempts for ever, waiting longer each time and starting the schedule over
 * whenever there is reason to.
 *
 * There are two such reasons. A signal says the machine changed under the
 * runner, so the wait is cut short and the next one starts from the beginning.
 * And an attempt that held longer than the cap was a working connection rather
 * than a failure, so what follows it is a first retry, not the next step of a
 * schedule the outage before it had climbed.
 */
export const reconnect = <E>(options: ReconnectOptions<E>): Effect.Effect<never> =>
  Effect.gen(function* () {
    const cap = Duration.toMillis(RECONNECT_CAP);
    const base = Duration.toMillis(RECONNECT_BASE);

    // One subscription for the life of the loop. Taking a fresh one per wait
    // would restart a source that carries state - the heuristic's last reading
    // is exactly that - and would hear nothing at all while an attempt is in
    // flight, which is when a machine is most likely to change under it.
    const arrivals = yield* Queue.unbounded<void>();
    yield* Effect.forkChild(
      Effect.ignore(Stream.runForEach(options.signals, () => Queue.offer(arrivals, undefined))),
    );

    let wait = base;
    while (true) {
      const started = yield* Clock.currentTimeMillis;
      yield* Effect.tapCause(options.attempt, (cause: Cause.Cause<E>) =>
        Effect.logWarning("The connection to the controller ended", cause),
      ).pipe(Effect.ignore);
      const held = (yield* Clock.currentTimeMillis) - started;
      if (held >= cap) {
        wait = base;
        // A connection held for hours banks every network change of the
        // afternoon; spending them all as back-to-back retries the moment it
        // drops is the opposite of what they mean. A signal during a short
        // failing attempt is kept, because that is the case the source exists
        // for: the reason the attempt failed may have just gone away.
        yield* Queue.clear(arrivals);
      }
      const signalled = yield* Effect.race(
        Effect.as(Effect.sleep(Duration.millis(wait)), false),
        Effect.as(Queue.take(arrivals), true),
      );
      wait = signalled ? base : Math.min(wait * 2, cap);
    }
  });

/** What the heuristic reads about the machine it is on. */
export interface MachineReadings {
  /** The wall clock, which a sleeping machine does not stop. */
  readonly now: () => number;
  /** Every address this machine currently holds, in a stable order. */
  readonly addresses: () => ReadonlyArray<string>;
}

/**
 * Signals that the machine changed under the runner: it slept, or its addresses
 * did. Ticks on its own interval and compares each tick with the one before, so
 * it holds nothing but the last reading.
 */
export const reconnectSignals = (readings: MachineReadings): Stream.Stream<void> => {
  const interval = Duration.toMillis(HEURISTIC_INTERVAL);
  const gapLimit = Duration.toMillis(CLOCK_GAP_LIMIT);
  const reading = () => ({ at: readings.now(), addresses: readings.addresses().join(",") });
  // The first reading is taken when the stream is run, not when it is built: a
  // baseline from minutes ago makes the very first tick look like a long sleep.
  return Stream.suspend(() =>
    Stream.unfold(reading(), (previous) =>
      Effect.gen(function* () {
        let last = previous;
        while (true) {
          yield* Effect.sleep(HEURISTIC_INTERVAL);
          const next = reading();
          // The tick was scheduled for one interval; anything much beyond that is
          // time the machine was not running for.
          const slept = next.at - last.at > interval + gapLimit;
          const moved = next.addresses !== last.addresses;
          last = next;
          if (slept || moved) return [undefined, last] as const;
        }
      }),
    ),
  );
};
