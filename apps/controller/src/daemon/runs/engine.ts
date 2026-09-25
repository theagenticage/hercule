/**
 * The run engine: starts runs of workflows and executes their steps.
 *
 * A run is only rows (the runs domain). Starting a run (`start.ts`) writes the
 * run and a step record for each entry step, and returns. The engine then
 * executes the run on a fiber of its own, the run's scheduler. The scheduler
 * reads the run and starts a child fiber for each step that has a pending
 * record, so steps on parallel branches run at the same time. A step never
 * has two records running: a record queued behind a running one of the same
 * step starts after it, in iteration order. Each child fiber:
 *
 * 1. Takes one step record that is pending, or running because a restart
 *    cut it off.
 * 2. The start transaction: it reads the run again and evaluates the step's
 *    condition. If the condition holds, or the step has none, the record
 *    moves to `running`. If it is false, the record moves to `skipped` and
 *    the run is routed as if the step had completed (see step 5). If it
 *    cannot be decided, the record and the run fail.
 * 3. It renders the step's params from the run's inputs and the outputs of
 *    the steps that have finished, and decodes them with the action's input
 *    schema.
 * 4. It calls the action. A built-in action is called as the run, in the
 *    same transaction that ends its record; `wait` is the exception, because
 *    it holds no transaction while it waits. A plugin's action is called
 *    outside any transaction, and its record ends afterwards.
 * 5. The end transaction: it ends the step record, reads the run again, and
 *    routes it (`routing.ts`): it follows the edges whose conditions hold,
 *    adds the records of the steps that are ready, and completes or fails
 *    the run when routing says so. A `terminal` step that completes ends
 *    the run with its output, without following its edges.
 *
 * Each time a child fiber ends, the scheduler reads the run again and starts
 * the child fibers that are now ready, until the run has ended. Then it
 * interrupts the child fibers still executing, as a cancel does.
 *
 * Every routing decision is made in a start or an end transaction, against
 * rows read inside it, so the decision and its writes commit together. A
 * built-in action's effect and the end of its step record commit together
 * too, so a crash never leaves the effect committed with the step still
 * unfinished. A failed step, or a template that cannot be rendered, fails the
 * run and cancels every step record that is still pending or running.
 *
 * Nothing about a run is held only in memory. When the controller starts, it
 * resumes every run that is pending or running from its rows. A built-in
 * action's step record found `running` then is executed again: its action
 * calls the controller's own services, in the transaction that would have
 * ended the record, so a record still `running` means that transaction never
 * committed and the action took no effect. A `wait` step waits only for the
 * time it had left. A plugin's action reaches outside the controller, so its
 * step record found `running` may or may not have taken effect; runs never
 * retry such an action, and the step fails with the code `interrupted`. When
 * several were running, the first fails and the run cancels the others.
 *
 * Cancelling a run ends it, its unfinished step records, and every unfinished
 * run its steps started, directly or further down, in one transaction. Then
 * it interrupts the fibers executing them. A plugin's action in flight sees
 * its signal abort. An action that returns after the cancel cannot end its
 * step record any more, so the run stays cancelled and no later step starts.
 *
 * If executing a run fails for a reason of the controller's own, such as a
 * database error or a bug, the run fails with `controller-error` rather than
 * staying `running` until the next restart: at the step whose child fiber
 * failed, or with no failed step when the scheduler itself failed.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createInvalidStateError,
  createNotFoundError,
  Id,
  type FailureReason,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Run,
  type RunStatus,
  type StepError,
  type Unauthenticated,
} from "@hercule/contract";
import { requireGrant } from "../../actor";
import { AfterCommit, afterCommit, nowIso, withTransaction } from "../../db";
import { isBuiltInActionId, type PluginHost } from "../../plugins";
import {
  isUnfinished,
  listNextStepRecords,
  runRepository,
  type RunOutcome,
  type UnfinishedStepRecord,
} from "../../runs";
import type { Settings } from "../../settings";
import type { TaskService } from "../../tasks";
import type { WorkflowService } from "../../workflows";
import { absorbFailures } from "../absorbing";
import { decideRouting, isStepConditionMet } from "./routing";
import { makeRunStart } from "./start";
import { makeStepExecution, type EngineStepError, type StepAttempt } from "./step";

/**
 * The step error for a run that could not be carried out at this step for a
 * reason of the controller's own, such as a bug, whether or not the step's
 * action had started.
 */
const UNEXPECTED_RUN_FAILURE: EngineStepError = {
  code: "unexpected",
  message:
    "The controller could not carry out the run at this step. The controller's log has the details.",
};

/** The step error for a plugin action's step record that a restart cut off while the action ran. */
const INTERRUPTED: EngineStepError = {
  code: "interrupted",
  message:
    "The controller stopped while this step's action was running, so it may or may not have taken effect. Runs never retry an action; start a new run if it is needed.",
};

/** Describes how a run ended, for the refusal to cancel it. */
const describeEnding = (status: RunStatus): string =>
  status === "cancelled" ? "has already been cancelled" : `has already ${status}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* runRepository;
  // The listener that publishes a committed change on the live topics. A run
  // executes on a fiber of the engine's own, not of the request that started
  // it, so the listener is provided to that fiber here.
  const afterCommitListener = yield* AfterCommit;
  /** The fiber executing each run, by run id. A run has at most one. */
  const runFibers = yield* FiberMap.make<string>();
  const forkRun = yield* FiberMap.runtime(runFibers)<never>();
  // The fiber that executes a new run is started through a function the
  // engine defines below, which itself calls `startRun` for the `run.start`
  // action, so the reference is passed as a function.
  const startRun = yield* makeRunStart((runId) => executeInBackground(runId));

  /**
   * Runs one of a run's write sets in a transaction that cannot be
   * interrupted. Cancelling a run interrupts the fiber executing it, and an
   * interrupt that landed after the commit and before the transaction's
   * after-commit work would lose that work: the live announcements, and the
   * start of a child run that a `run.start` step committed. The write set
   * only touches the local database, so the interrupt waits a moment at most.
   */
  const commitUninterruptibly = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.uninterruptible(withTransaction(sql, effect));

  /**
   * Ends a run: cancels every step record of it that is still pending or
   * running, and moves the run to `outcome`. Every way a run ends goes
   * through here, inside the transaction that decided it, so a reader never
   * sees an ended run with a step record still pending or running.
   */
  const writeRunEnding = (
    runId: string,
    outcome: RunOutcome,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.andThen(runs.cancelUnfinishedSteps(runId, at), runs.finish(runId, outcome, at));

  /**
   * Fails a run at one of its steps, inside the caller's transaction: the
   * step record fails with `error`, and the run fails with `failureReason`
   * (see `writeRunEnding`). A record that has already ended keeps its ending.
   */
  const writeStepFailure = (
    runId: string,
    attempt: StepAttempt,
    error: StepError,
    failureReason: FailureReason,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* Effect.catchTag(
        runs.finishStep(
          runId,
          attempt,
          { status: "failed", error },
          { startedAt: attempt.startedAt ?? at, finishedAt: at },
        ),
        "StepRecordEnded",
        () => Effect.void,
      );
      yield* writeRunEnding(
        runId,
        { status: "failed", failureReason, failedStepId: attempt.stepId },
        at,
      );
    });

  /** Fails a run at one of its steps (see `writeStepFailure`), in a transaction of its own. */
  const failRun = (
    runId: string,
    attempt: StepAttempt,
    error: StepError,
    failureReason: FailureReason,
  ): Effect.Effect<void, SqlError> =>
    commitUninterruptibly(
      Effect.flatMap(nowIso, (at) => writeStepFailure(runId, attempt, error, failureReason, at)),
    );

  /**
   * Routes a run after the latest record of `stepId` finished, inside the
   * caller's transaction, which has already written that record's ending.
   * Reads the run again, so the decision sees every row the transaction can,
   * and writes the decision: the edges followed, the new pending records,
   * and the run's ending when routing ends it (see `decideRouting`).
   */
  const routeAfterStep = (
    runId: string,
    stepId: string,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      // Runs are never deleted, and the caller has just written a record of
      // this one.
      const run = Option.getOrThrow(yield* runs.read(runId));
      const decision = yield* decideRouting(run, stepId);
      yield* runs.recordTraversals(runId, decision.traversedEdgeIndexes);
      yield* runs.insertSteps(runId, decision.readyStepIds, at);
      const { ending } = decision;
      if (ending._tag === "completed") {
        yield* writeRunEnding(runId, { status: "completed", output: ending.output }, at);
      } else if (ending._tag === "failed") {
        yield* writeRunEnding(
          runId,
          {
            status: "failed",
            failureReason: ending.failureReason,
            failedStepId: stepId,
            failedEdge: ending.failedEdge,
          },
          at,
        );
      }
    });

  /**
   * Starts a pending step record, in a transaction of its own. Reads the run
   * again and evaluates the step's condition:
   *
   * - true, or no condition: the record moves to `running`, and this returns
   *   the run as read, for rendering the step's params, and the moment the
   *   record started;
   * - false: the record moves to `skipped`, and the run is routed as if the
   *   step had completed;
   * - the condition cannot be decided: the record fails with
   *   `expression_error`, and the run fails at the step.
   *
   * Returns `None` in the last two cases, and when the record is no longer
   * pending, for example because the run was cancelled.
   */
  const startStepRecord = (
    runId: string,
    record: StepAttempt,
  ): Effect.Effect<Option.Option<{ readonly run: Run; readonly startedAt: string }>, SqlError> =>
    Effect.catchTag(
      commitUninterruptibly(
        Effect.gen(function* () {
          const at = yield* nowIso;
          const run = Option.getOrThrow(yield* runs.read(runId));
          // The scheduler never starts a record of a step that has one
          // running, so this only catches a bug in the scheduler. It is
          // checked here, against rows read in the transaction, because a
          // step with two running records would corrupt the run.
          if (
            run.steps.some((other) => other.stepId === record.stepId && other.status === "running")
          ) {
            return yield* Effect.die(
              `step ${record.stepId} of run ${runId} would have two running records`,
            );
          }
          const met = yield* Effect.result(isStepConditionMet(run, record.stepId));
          if (Result.isFailure(met)) {
            yield* writeStepFailure(
              runId,
              record,
              {
                code: "expression_error",
                message: `The condition of this step failed: ${met.failure.message}`,
              },
              "expression-error",
              at,
            );
            return Option.none();
          }
          if (!met.success) {
            yield* runs.skipStep(runId, record, at);
            yield* routeAfterStep(runId, record.stepId, at);
            return Option.none();
          }
          yield* runs.startStep(runId, record, at);
          return Option.some({ run, startedAt: at });
        }),
      ),
      "StepRecordEnded",
      () => Effect.succeedNone,
    );

  const executeStep = yield* makeStepExecution({
    startRun,
    commitUninterruptibly,
    failRun,
    routeAfterStep,
  });

  /**
   * Executes one step record of a run, on a child fiber of the run's
   * scheduler (see `executeRun`). A pending record is started first (see
   * `startStepRecord`). A running record is one a restart cut off, and only
   * a built-in action's record gets here that way: it is executed again.
   *
   * If executing the record fails for a reason of the controller's own, such
   * as a database error or a bug, the run fails with `controller-error` at
   * this record, which fails with the code `unexpected`. This effect fails
   * only when that ending cannot be written either.
   */
  const executeRecord = (run: Run, record: UnfinishedStepRecord): Effect.Effect<void, SqlError> =>
    Effect.catchCause(
      Effect.gen(function* () {
        if (record.status === "running") return yield* executeStep(run, record);
        const started = yield* startStepRecord(run.id, record);
        if (Option.isSome(started)) {
          yield* executeStep(started.value.run, { ...record, startedAt: started.value.startedAt });
        }
      }),
      (cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.andThen(
              Effect.logError(
                `Executing step ${record.stepId} of run ${run.id} failed, so the run fails`,
                cause,
              ),
              failRun(run.id, record, UNEXPECTED_RUN_FAILURE, "controller-error"),
            ),
    );

  /**
   * Executes a run from its rows until it has ended. This is the run's
   * scheduler.
   *
   * Each step's next record (see `listNextStepRecords`) executes on a child
   * fiber of its own (see `executeRecord`), so steps on parallel branches run
   * at the same time. A step has at most one child fiber, so a record queued
   * behind a running one of the same step waits until that one has ended.
   *
   * Each time a child fiber ends, the scheduler reads the run again, because
   * that child's transactions may have added records or ended the run. It
   * never decides from an older read: which records are ready is always read
   * from the rows after the last child's writes committed.
   *
   * When the run has ended, the scheduler returns, and closing its scope
   * interrupts the child fibers still executing: a `wait` stops, and a
   * plugin's action sees its signal abort. Interrupting the scheduler, when
   * the run is cancelled or the controller stops, interrupts them the same
   * way.
   */
  const executeRun = (runId: string): Effect.Effect<void, SqlError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const endedChildren = yield* Queue.unbounded<{
          readonly record: UnfinishedStepRecord;
          readonly exit: Exit.Exit<void, SqlError>;
        }>();
        // The steps whose record a child fiber is executing. Only this loop
        // changes the set, so it is never stale.
        const busySteps = new Set<string>();
        for (;;) {
          const found = yield* runs.read(runId);
          if (Option.isNone(found)) return;
          const run = found.value;
          if (!isUnfinished(run.status)) return;
          if (run.status === "pending") {
            yield* commitUninterruptibly(Effect.flatMap(nowIso, (at) => runs.start(runId, at)));
          }
          const ready = listNextStepRecords(run.steps).filter(
            (record) => !busySteps.has(record.stepId),
          );
          // A running record with no child fiber executing it was cut off by
          // a restart. A plugin's action may or may not have taken effect, so
          // the first such record fails the run, which cancels the others.
          const cutOff = ready.find((record) => {
            const step = run.plan.steps.find((candidate) => candidate.id === record.stepId);
            return (
              record.status === "running" &&
              !(step?.kind === "action" && isBuiltInActionId(step.action))
            );
          });
          if (cutOff !== undefined) {
            yield* failRun(runId, cutOff, INTERRUPTED, "step-failed");
            continue;
          }
          for (const record of ready) {
            busySteps.add(record.stepId);
            yield* Effect.forkScoped(
              Effect.onExit(executeRecord(run, record), (exit) =>
                Queue.offer(endedChildren, { record, exit }),
              ),
            );
          }
          if (busySteps.size === 0) {
            // Routing completes a run in the transaction that ends its last
            // record. An earlier engine completed it in a transaction of its
            // own, so a restart between the two leaves such a run with
            // nothing to execute.
            return yield* commitUninterruptibly(
              Effect.flatMap(nowIso, (at) => writeRunEnding(runId, { status: "completed" }, at)),
            );
          }
          const ended = yield* Queue.take(endedChildren);
          busySteps.delete(ended.record.stepId);
          if (Exit.isSuccess(ended.exit)) continue;
          // Children are interrupted only after the scheduler has left this
          // loop, by returning or by being interrupted itself. So a child
          // that ended interrupted while the loop still runs interrupted
          // itself, for example a plugin's action that ended in its own
          // interrupt. Nothing else would end that child's record, and the
          // run would stay running, so the run fails at it.
          if (!Cause.hasInterrupts(ended.exit.cause)) {
            return yield* Effect.failCause(ended.exit.cause);
          }
          yield* Effect.logError(
            `Executing step ${ended.record.stepId} of run ${runId} was interrupted, so the run fails`,
            ended.exit.cause,
          );
          yield* failRun(runId, ended.record, UNEXPECTED_RUN_FAILURE, "controller-error");
        }
      }),
    );

  /**
   * Fails a run that its scheduler could not carry out for a reason of the
   * controller's own, such as a database error or a bug, with
   * `controller-error` and no failed step: the error was not at any one step.
   */
  const failRunUnexpectedly = (runId: string): Effect.Effect<void, SqlError> =>
    commitUninterruptibly(
      Effect.flatMap(nowIso, (at) =>
        writeRunEnding(runId, { status: "failed", failureReason: "controller-error" }, at),
      ),
    );

  /**
   * Starts executing a run on a fiber of the engine's own, unless a fiber
   * already executes it, and returns at once. It is synchronous so that it
   * can run right after a commit (see `afterCommit`).
   *
   * A forked fiber starts running on the caller's thread until its first
   * wait, and a step's database work never waits. The fiber therefore yields
   * first, so the request that started the run is answered before any step
   * runs, rather than after the whole run.
   */
  const executeInBackground = (runId: string): void => {
    const execution = Effect.catchCause(
      Effect.andThen(Effect.yieldNow, executeRun(runId)),
      (cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.andThen(
              Effect.logError(`Executing run ${runId} failed, so the run fails`, cause),
              absorbFailures(`Failing run ${runId} failed`, failRunUnexpectedly(runId)),
            ),
    );
    forkRun(runId, Effect.provideService(execution, AfterCommit, afterCommitListener), {
      onlyIfMissing: true,
    });
  };

  /**
   * Stops the fiber executing a run, if one is, without waiting for it to
   * stop. It is synchronous so that it can run right after a commit.
   */
  const stopExecuting = (runId: string): void => {
    const fiber = FiberMap.getUnsafe(runFibers, runId);
    if (Option.isSome(fiber)) fiber.value.interruptUnsafe();
  };

  return {
    startRun,

    /**
     * `run.cancel`: cancels a pending or running run and returns it.
     *
     * One transaction cancels the run, every step record of it that has not
     * ended, and every unfinished run that its steps started, directly or
     * further down, with their step records. Then the fibers executing those
     * runs are interrupted, which aborts the signal of a plugin action in
     * flight. A step whose action ends after the cancel cannot end its record
     * any more, and no later step starts.
     *
     * Fails with `NotFound` for an unknown run, and with `InvalidState` for a
     * run that has already ended.
     */
    cancelRun: (
      id: Id,
    ): Effect.Effect<Run, Unauthenticated | Forbidden | NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("run.cancel");
        return yield* Effect.uninterruptible(
          withTransaction(
            sql,
            Effect.gen(function* () {
              const found = yield* runs.read(id);
              if (Option.isNone(found)) {
                return yield* Effect.fail(createNotFoundError("no such run"));
              }
              const { status } = found.value;
              if (!isUnfinished(status)) {
                return yield* Effect.fail(
                  createInvalidStateError(
                    `the run ${describeEnding(status)}; only a pending or running run can be cancelled`,
                  ),
                );
              }
              const at = yield* nowIso;
              const cancelled = [id, ...(yield* runs.listUnfinishedDescendants(id))];
              for (const runId of cancelled) {
                yield* writeRunEnding(runId, { status: "cancelled" }, at);
              }
              yield* afterCommit(() => {
                for (const runId of cancelled) stopExecuting(runId);
              });
              // The same transaction found the run above, and runs are never
              // deleted.
              return Option.getOrThrow(yield* runs.read(id));
            }),
          ),
        );
      }),

    /**
     * Resumes every run that is pending or running and has no fiber executing
     * it. The controller calls this when it starts: the rows of a run that a
     * restart cut off are all there is to continue it from.
     */
    resumeUnfinishedRuns: Effect.map(runs.listUnfinished(), (ids) => {
      for (const runId of ids) executeInBackground(runId);
    }),

    /**
     * Interrupts every fiber executing a run, and waits until they have
     * stopped. This is what happens to them when the controller stops: the
     * rows stay as they are, for `resumeUnfinishedRuns` to continue from.
     *
     * Only the test harness calls it: it stops the fibers, then resumes the
     * unfinished runs, to simulate a controller restart without a new process.
     * A real shutdown needs no call, because closing the service's scope
     * interrupts the fibers.
     */
    stopExecutingRuns: FiberMap.clear(runFibers),
  };
});

/** The run engine: starts runs and executes their steps. */
export class RunEngine extends Context.Service<RunEngine, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/RunEngine",
) {}

export const RunEngineLayer: Layer.Layer<
  RunEngine,
  never,
  SqlClient.SqlClient | WorkflowService | TaskService | PluginHost | Settings | AfterCommit
> = Layer.effect(RunEngine)(make);

/**
 * Resumes every unfinished run, as the controller does when it starts
 * serving. A resume that cannot even list the runs is a broken database, which
 * nothing after it could work around, so it dies.
 */
export const resumeUnfinishedRuns: Effect.Effect<void, never, RunEngine> = Effect.orDie(
  Effect.flatMap(RunEngine, (engine) => engine.resumeUnfinishedRuns),
);
