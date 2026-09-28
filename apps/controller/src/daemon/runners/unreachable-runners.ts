/**
 * The periodic check that tells the user about a runner that has been
 * unreachable for a while.
 *
 * A runner whose connection drops without a goodbye is marked unreachable at
 * once, and most come back within seconds: a network blip, a laptop waking up.
 * A notification for each of those would be noise, so the user is told only
 * about a runner that is still unreachable two minutes after it was last seen.
 *
 * The rule itself is `RunnerConnections.reportUnreachableRunners`. It reads
 * everything it needs from the database, so a runner that was already away
 * when the controller restarted is still reported.
 *
 * The first check waits out the grace after the controller starts. A
 * controller that was down for a while finds every runner last seen before it
 * stopped, and those runners need a moment to reconnect; without the wait,
 * each restart would report the whole fleet as unreachable.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { RunnerConnections } from "../../runners";
import { absorbFailures } from "../absorbing";

/** How long a runner stays unreachable before the user is told about it. */
const UNREACHABLE_GRACE: Duration.Duration = Duration.minutes(2);

/** How often the check runs, which is how late past the grace a notification can be. */
const CHECK_INTERVAL: Duration.Duration = Duration.seconds(30);

/**
 * Waits out the grace, then raises the notifications for runners unreachable
 * longer than the grace, and repeats that every interval. Never returns. A
 * pass that fails is logged, and the next one runs.
 */
export const sweepUnreachableRunners: Effect.Effect<never, SqlError, RunnerConnections> =
  Effect.gen(function* () {
    const connections = yield* RunnerConnections;
    const pass = Effect.flatMap(Clock.currentTimeMillis, (millis) =>
      connections.reportUnreachableRunners(
        new Date(millis - Duration.toMillis(UNREACHABLE_GRACE)).toISOString(),
      ),
    );
    yield* Effect.sleep(UNREACHABLE_GRACE);
    while (true) {
      yield* absorbFailures("Reporting unreachable runners failed", pass);
      yield* Effect.sleep(CHECK_INTERVAL);
    }
  });
