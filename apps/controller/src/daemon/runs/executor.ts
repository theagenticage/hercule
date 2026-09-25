import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
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

/** One run's execution while it is being carried out. */
interface Execution {
  /**
   * One message per call to `execute` for the run that the current pass has
   * not taken yet. A pass that ends with a message left is followed by
   * another pass.
   */
  readonly wakes: Queue.Queue<void>;
}

const make = Effect.gen(function* () {
  const runFibers = yield* RunFibers;
  const forkRun = yield* FiberMap.runtime(runFibers)<never>();
  // The runs whose execution is being carried out, by run id. Kept apart from
  // the fiber map because a fiber stays in the map for a moment after its last
  // pass has decided to stop. A call to `execute` in that moment must start a
  // new pass, not mark a fiber that will never look at the mark again.
  const executing = new Map<string, Execution>();

  /**
   * Runs `execution` once, and again for as long as the pass before ended
   * with a wake it did not take. Each pass starts with no wake waiting,
   * because it reads the run's rows after any wake sent before it. The check
   * and the removal from `executing` happen in one synchronous step, so a
   * wake either lands before it, and is seen, or after it, and starts a new
   * fiber.
   */
  const executeWhileWoken = (
    runId: string,
    mine: Execution,
    execution: (wakes: Queue.Dequeue<void>) => Effect.Effect<void>,
  ): Effect.Effect<void> => {
    // Only this fiber's own entry is removed: after a `stop`, a new fiber may
    // already have put its own entry in its place.
    const forget = (): void => {
      if (executing.get(runId) === mine) executing.delete(runId);
    };
    return Effect.gen(function* () {
      while (true) {
        yield* Queue.clear(mine.wakes);
        yield* execution(mine.wakes);
        if (Queue.sizeUnsafe(mine.wakes) === 0) {
          forget();
          return;
        }
      }
    }).pipe(
      // A stopped or failed execution must not leave the run marked as
      // executing, or no later `execute` would ever start it again.
      Effect.ensuring(Effect.sync(forget)),
    );
  };

  return RunExecutor.of({
    execute: (runId, execution) => {
      const current = executing.get(runId);
      if (current !== undefined) {
        Queue.offerUnsafe(current.wakes, undefined);
        return;
      }
      // Unbounded, so offering never waits, and `execute` stays synchronous.
      const mine: Execution = { wakes: Effect.runSync(Queue.unbounded<void>()) };
      executing.set(runId, mine);
      // A forked fiber starts running on the caller's thread until its first
      // wait, and a step's database work never waits. The fiber therefore
      // yields first, so the request that started the run is answered before
      // any step runs, rather than after the whole run.
      //
      // The new fiber replaces any fiber still in the map under this run id.
      // That can only be one whose last pass has already decided to stop, or
      // one that `stop` is interrupting, so interrupting it loses nothing.
      forkRun(runId, Effect.andThen(Effect.yieldNow, executeWhileWoken(runId, mine, execution)));
    },
    stop: (runIds) => {
      for (const runId of runIds) {
        // Forgotten at once rather than when the fiber has stopped, so an
        // `execute` in between starts a new pass instead of waking a fiber
        // that is being interrupted.
        executing.delete(runId);
        const fiber = FiberMap.getUnsafe(runFibers, runId);
        if (Option.isSome(fiber)) fiber.value.interruptUnsafe();
      }
    },
  });
});

/**
 * Implements the runs domain's Run Executor: each run executes on a fiber of
 * its own, which lives as long as the controller does, and a run never has
 * two passes of its execution at once.
 */
export const RunExecutorLayer: Layer.Layer<RunExecutor | RunFibers> = Layer.effect(RunExecutor)(
  make,
).pipe(Layer.provideMerge(Layer.effect(RunFibers)(FiberMap.make<string>())));
