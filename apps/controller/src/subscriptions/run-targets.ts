/**
 * The port through which `subscription.create` checks a run target.
 *
 * The runs domain opens and ends the subscriptions a run holds, so runs
 * depends on subscriptions. A session-held subscription that waits on a run
 * still needs to know whether the caller may read that run and whether it has
 * ended. That question goes through this port, which the controller daemon
 * implements with the run service, so subscriptions never imports runs.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Forbidden, NotFound, RunStatus, Unauthenticated } from "@hercule/contract";

/** What `subscription.create` reads about the run a run target names. */
export class RunTargets extends Context.Service<
  RunTargets,
  {
    /**
     * Returns the status the run ended with, or `undefined` while the run is
     * pending or running. Fails with `NotFound` when no run has the id, and
     * with `Forbidden` when the caller lacks `run.read`, because the events
     * about a run describe the run. Joins the caller's transaction.
     */
    readonly readEndedStatus: (
      runId: string,
    ) => Effect.Effect<RunStatus | undefined, Unauthenticated | Forbidden | NotFound | SqlError>;
  }
>()("hercule/controller/subscriptions/RunTargets") {}
