/**
 * The periodic sweep that ends the sessions of lost runners.
 *
 * Only a runner can report that a session has exited. A runner that never
 * connects again, such as a wiped machine or one lost while the controller was
 * down, reports nothing, and its sessions would keep their tokens forever.
 *
 * The rule itself is `SessionService.endOnLostRunners`. This module reads
 * which runners are connected from the runners domain, and runs the rule once
 * when the controller starts and then on an interval, because the rule
 * depends on how much time has passed. No runner will report the turn of an
 * agent step whose session the sweep ended, so the sweep fails those steps
 * too.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withTransaction } from "../../db";
import { runnerRepository } from "../../runners";
import { RunService } from "../../runs";
import { SessionService } from "../../sessions";
import { absorbFailures } from "../absorbing";

/**
 * How often the sweep runs. The limit the sweep applies is a session's
 * absolute timeout, which is a whole number of minutes and eight hours by
 * default. So up to one more minute of delay changes little.
 */
const LOST_RUNNER_SWEEP_INTERVAL: Duration.Duration = Duration.minutes(1);

/** The sweep interval. Tests override it with a shorter one. */
export const LostRunnerSweepInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/LostRunnerSweepInterval",
  { defaultValue: (): Duration.Duration => LOST_RUNNER_SWEEP_INTERVAL },
);

/**
 * Ends the sessions of lost runners, then repeats every interval. Never
 * returns.
 *
 * The first pass runs at once: the controller may have been down for longer
 * than the timeout, and a token must not stay valid for one more interval
 * because of that. A pass that fails is logged, and the next one runs.
 *
 * Reading the connected runners and ending the sessions are one transaction.
 * So a runner that connects during the pass is either seen as connected, or
 * connects after its sessions were ended. In the second case, its sessions
 * report lists what it still runs, and the controller stops those processes.
 */
export const sweepSessionsOnLostRunners: Effect.Effect<
  never,
  SqlError,
  SessionService | RunService | SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const runs = yield* RunService;
  const runners = yield* runnerRepository;
  const interval = yield* LostRunnerSweepInterval;
  const pass = withTransaction(
    sql,
    Effect.gen(function* () {
      const ended = yield* sessions.endOnLostRunners(yield* runners.connected());
      // No runner will report the turn of an agent step whose session ended
      // here, so the step fails in the same transaction.
      yield* runs.failStepsOfEndedSessions(
        ended,
        "The step's session ended because its runner was not heard from for longer than the session's absolute timeout.",
      );
    }),
  );
  while (true) {
    yield* absorbFailures("Ending sessions on lost runners failed", pass);
    yield* Effect.sleep(interval);
  }
});
