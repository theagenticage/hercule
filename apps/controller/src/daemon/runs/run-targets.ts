/**
 * Run Targets: answers, for `subscription.create`, whether the run a run
 * target names may be read and whether it has ended.
 *
 * It lives in the controller daemon because the port belongs to the
 * subscriptions domain and is answered by the runs domain, which itself
 * depends on subscriptions. Only the layer above both can join them.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isUnfinished, RunService } from "../../runs";
import { RunTargets } from "../../subscriptions";

export const RunTargetsLayer: Layer.Layer<RunTargets, never, RunService> = Layer.effect(RunTargets)(
  Effect.gen(function* () {
    const runs = yield* RunService;
    return {
      // `run.read` checks the caller's grant, so a caller who may not read
      // the run cannot learn from a subscription whether it has ended.
      readEndedStatus: (runId) =>
        Effect.map(runs.read(runId), (run) => (isUnfinished(run.status) ? undefined : run.status)),
    };
  }),
);
