import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RunExecutor } from "../../runs";

/**
 * The fibers executing runs, by run id. A run has at most one.
 *
 * It is a service of its own, beside the Run Executor, so that the test
 * harness can stop every run's fiber to simulate a controller restart
 * without a new process. A real controller never clears it: closing its
 * scope when the controller stops interrupts the fibers, and the rows stay
 * as they are for `resumeUnfinishedRuns` to continue from.
 */
export class RunFibers extends Context.Service<RunFibers, FiberMap.FiberMap<string>>()(
  "hercule/controller/daemon/RunFibers",
) {}

const make = Effect.gen(function* () {
  const runFibers = yield* RunFibers;
  const forkRun = yield* FiberMap.runtime(runFibers)<never>();
  return RunExecutor.of({
    // A forked fiber starts running on the caller's thread until its first
    // wait, and a step's database work never waits. The fiber therefore
    // yields first, so the request that started the run is answered before
    // any step runs, rather than after the whole run.
    execute: (runId, execution) => {
      forkRun(runId, Effect.andThen(Effect.yieldNow, execution), { onlyIfMissing: true });
    },
    stop: (runIds) => {
      for (const runId of runIds) {
        const fiber = FiberMap.getUnsafe(runFibers, runId);
        if (Option.isSome(fiber)) fiber.value.interruptUnsafe();
      }
    },
  });
});

/**
 * Implements the runs domain's Run Executor: each run executes on a fiber of
 * its own, which lives as long as the controller does, and a run never has
 * two.
 */
export const RunExecutorLayer: Layer.Layer<RunExecutor | RunFibers> = Layer.effect(RunExecutor)(
  make,
).pipe(Layer.provideMerge(Layer.effect(RunFibers)(FiberMap.make<string>())));
