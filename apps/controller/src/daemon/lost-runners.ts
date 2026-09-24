/**
 * The clock that ends the sessions of lost runners.
 *
 * Only a runner can report that a session has exited. A runner that never
 * connects again - a machine that was wiped, or one that was lost while the
 * controller was down - reports nothing, and its sessions would keep their
 * tokens for ever. The rule is `SessionService.endOnLostRunners`; this reads
 * which runners are connected, which is the runners domain's, and runs the
 * rule once when the controller starts and then on an interval, because the
 * rule depends on how much time has passed.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withTransaction } from "../db";
import { runnerRepository } from "../runners";
import { SessionService } from "../sessions";
import { absorbFailures } from "./absorbing";

/**
 * How often the sweep runs. The bound it applies is a session's absolute
 * timeout: whole minutes, and eight hours by default. So one more minute of
 * delay on top of it changes little.
 */
const LOST_RUNNER_SWEEP_INTERVAL: Duration.Duration = Duration.minutes(1);

/** Tests hand over an interval they can wait out. */
export const LostRunnerSweepInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/LostRunnerSweepInterval",
  { defaultValue: (): Duration.Duration => LOST_RUNNER_SWEEP_INTERVAL },
);

/**
 * The first pass runs at once: the controller can have been down for longer
 * than the bound, and a token must not stay live for one more interval
 * because of that. A pass that fails is logged and the next one runs.
 *
 * The read of the connected runners and the write are one transaction, so a
 * runner that connects during the pass is either seen as connected or
 * connects after its sessions were ended. In the second case its report
 * lists what it still runs, and the controller stops those processes.
 */
export const sweepSessionsOnLostRunners: Effect.Effect<
  never,
  SqlError,
  SessionService | SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const runners = yield* runnerRepository;
  const interval = yield* LostRunnerSweepInterval;
  const pass = withTransaction(
    sql,
    Effect.flatMap(runners.connected(), (connected) => sessions.endOnLostRunners(connected)),
  );
  while (true) {
    yield* absorbFailures("The sweep for sessions on lost runners failed", pass);
    yield* Effect.sleep(interval);
  }
});
