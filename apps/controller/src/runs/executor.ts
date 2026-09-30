/**
 * The Run Executor: the port through which the runs domain hands a run's
 * execution to be carried out apart from the request that started it, and
 * stops it when the run is cancelled.
 *
 * The runs domain decides what a run does; it never decides where that work
 * runs. A domain holds no long-lived fibers and knows nothing of the process
 * lifetime, so a run that outlives its request needs something else to host
 * it. The controller daemon implements this port (`daemon/runs/`), and gives
 * each run a place to execute for as long as the controller lives. ADR 0033
 * records this split between domains and the controller daemon.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Queue from "effect/Queue";

/** The Run Executor, which the controller daemon implements. */
export class RunExecutor extends Context.Service<
  RunExecutor,
  {
    /**
     * Starts carrying out `execution`, the effect that executes the run
     * `runId` from its rows until it has ended or has nothing left to do
     * until something outside it happens, and returns at once.
     *
     * When an execution of that run is already being carried out, `execute`
     * starts no second one, so a run is never executed twice at the same
     * time. Instead it wakes the execution being carried out:
     *
     * - `execution` is given a queue, `wakes`, and each such call puts a
     *   message in it. An execution that waits for something can also wait
     *   for a wake, take it, and read the run's rows again, so a step result
     *   is acted on while the execution is still busy with other steps.
     * - When the execution returns with a wake still in the queue, it is
     *   carried out once more. Without that, a step result committed just
     *   as the execution decided it had nothing left to do would wait until
     *   the next restart. Many wakes before that read cost one read, not one
     *   each.
     *
     * It returns nothing and is synchronous, so that it can run right after a
     * commit (see `afterCommit`). The request that started the run is answered
     * before the execution takes its first step.
     */
    readonly execute: (
      runId: string,
      execution: (wakes: Queue.Dequeue<void>) => Effect.Effect<void>,
    ) => void;

    /**
     * Stops the execution of each of these runs that is being carried out, and
     * returns without waiting for them to stop. A plugin action in flight sees
     * its signal abort. Synchronous, like `execute`.
     */
    readonly stop: (runIds: ReadonlyArray<string>) => void;
  }
>()("hercule/controller/runs/RunExecutor") {}
