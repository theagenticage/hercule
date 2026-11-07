/**
 * The run operations: `run.start`, `run.rerun`, `run.cancel`, `run.query` and `run.read`,
 * writing the run of a start trigger that matched an event, recording an event
 * that matched a run's signal trigger, resuming unfinished runs when the
 * controller starts, and what the
 * controller daemon calls about workspace steps: their results, the runners
 * and workspaces that fail under them, and the steps a runner is owed.
 * Everything but querying and reading is the run engine's (`engine.ts`).
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createDecodeValidationError,
  createNotFoundError,
  DEFAULT_PAGE_LIMIT,
  Id,
  InvalidState,
  RUN_SORT_FIELDS,
  RunFilter,
  type Forbidden,
  type NotFound,
  type Run,
  type RunSummary,
  type SortDirection,
  type TaskUndoTryAgainInput,
  type TryAgainUndo,
  type Unauthenticated,
  Validation,
} from "@hercule/contract";
import { requireGrant, requireUserActor } from "../actor";
import type { ConnectionTypes } from "../connections";
import {
  buildPageInputFields,
  refuseCursor,
  resolveSortDirection,
  withTransaction,
  type AfterCommit,
} from "../db";
import type { PlatformEvents } from "../events";
import type { Notifier } from "../notifications";
import type { PluginHost } from "../plugins";
import type { PromotionState } from "../promotion";
import type { ProviderAccountRunners } from "../provider-accounts";
import type { Settings } from "../settings";
import { runHeldSubscriptions } from "../subscriptions";
import { TaskService, type FailureRestoreRefusal } from "../tasks";
import type { TextGeneration } from "../text-generation";
import type { WorkflowService } from "../workflows";
import type { WorkspaceService } from "../workspaces";
import { makeRunEngine } from "./engine";
import type { RunExecutor } from "./executor";
import { runRepository } from "./repository";
import { isUnfinished } from "./step-records";
import type { WorkspaceSteps } from "./workspace-steps";

const QueryInput = Schema.Struct({
  ...RunFilter.fields,
  ...buildPageInputFields(RUN_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);

/** Newest first, because the run someone started last is the one they look for. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** One page of the run list, as `run.query` returns it. */
export interface RunPage {
  readonly items: ReadonlyArray<RunSummary>;
  readonly nextCursor?: string;
}

/** The refusal of `task.undoTryAgain` for a caller who is not the user. */
const ONLY_THE_USER_UNDOES_TRY_AGAIN =
  "only the user may undo a Try again: it is the user's own correction, so a session or a workflow step may not; ask the user instead";

/**
 * What the undo line says when the failure was not put back. Each sentence
 * names why, and none says the run has stopped: the run was only asked to.
 */
const STAYED_AS_IT_IS: Record<FailureRestoreRefusal, string> = {
  "no-such-start": "This run did not end a failure, so there is none to put back.",
  "already-restored": "The failure was already put back.",
  "task-deleted": "The Task was deleted.",
  "task-merged": "The Task was merged into another, which now holds its failure.",
  "task-finished": "The Task is already done or dropped.",
  "handled-since":
    "A newer failure, run or Thread took over this Task, so what it shows now stays.",
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* TaskService;
  const runs = yield* runRepository;
  const runHeld = yield* runHeldSubscriptions;
  const engine = yield* makeRunEngine;

  /** Stores the first answer of an Undo on its recovery row, and returns it. */
  const storeAnswer = (runId: string, answer: TryAgainUndo) =>
    Effect.as(tasks.storeTryAgainUndo(runId, answer), answer);

  return {
    start: engine.start,
    startOnTask: engine.startOnTask,
    rerun: engine.rerun,
    startTriggeredRun: engine.startTriggeredRun,
    recordSignalMatch: engine.recordSignalMatch,

    /** `run.cancel`: cancels a run and returns it, as the run engine's `cancel` describes. */
    cancel: engine.cancel,
    resumeUnfinished: engine.resumeUnfinished,
    completeStep: engine.completeStep,
    failRunsInWorkspace: engine.failRunsInWorkspace,
    failRunsPinnedTo: engine.failRunsPinnedTo,
    failStepsOfEndedSessions: engine.failStepsOfEndedSessions,
    failStepWithDroppedPrompt: engine.failStepWithDroppedPrompt,
    listOwedWorkspaceSteps: engine.listOwedWorkspaceSteps,
    listEndedWorkspaceSteps: engine.listEndedWorkspaceSteps,
    stopSessionsOfEndedRuns: engine.stopSessionsOfEndedRuns,
    wakeRunsWaitingForRunner: engine.wakeRunsWaitingForRunner,

    /**
     * `task.undoTryAgain`: undoes the Try again that started the run
     * `input.runId` on the Task `taskId`, as the user, and returns the first
     * answer decided for it. A repeat returns that answer again and changes
     * nothing.
     *
     * It lives here, not in the tasks domain, because it asks a run to stop
     * and the runs domain imports the tasks domain. In one transaction it
     * decides before it cancels anything:
     *
     * 1. With no recovery row for the run, or one whose Task is not exactly
     *    `taskId` (compared as stored, not through the merge redirect), it
     *    fails with `NotFound` and cancels nothing.
     * 2. When the recovery was already decided, it returns that answer.
     * 3. When the run has ended, the answer is `too-late` and nothing changes.
     * 4. Otherwise it asks the run to stop, as `run.cancel` does, and restores
     *    the failure when nothing newer holds the Task (`restored`), else
     *    leaves the Task as it is (`stopped`) with the reason.
     *
     * Only the user undoes: a session is refused with `Forbidden`.
     */
    undoTryAgain: (
      taskId: Id,
      input: TaskUndoTryAgainInput,
    ): Effect.Effect<TryAgainUndo, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("task.undoTryAgain", ONLY_THE_USER_UNDOES_TRY_AGAIN);
        yield* requireGrant("run.cancel");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const recovery = yield* tasks.readFailureRecovery(input.runId);
            if (Option.isNone(recovery) || recovery.value.taskId !== taskId) {
              return yield* Effect.fail(createNotFoundError("no such Try again on this Task"));
            }
            if (recovery.value.undo !== undefined) return recovery.value.undo;
            // Only a failure restored before the answer was stored can reach
            // here, and nothing knows whether that run was asked to stop.
            if (recovery.value.restoredAt !== undefined) {
              return { outcome: "restored", stopRequested: false } as const;
            }
            // The row was written with the run in one transaction, and runs
            // are never deleted.
            const run = Option.getOrThrow(yield* runs.read(input.runId));
            if (!isUnfinished(run.status)) {
              return yield* storeAnswer(input.runId, { outcome: "too-late", stopRequested: false });
            }
            // The run is unfinished and the user holds the grant, so `cancel`
            // cannot refuse it.
            yield* engine
              .cancel(input.runId, {})
              .pipe(
                Effect.catchIf(
                  (error): error is Validation | InvalidState =>
                    error instanceof Validation || error instanceof InvalidState,
                  Effect.die,
                ),
              );
            const restoration = yield* tasks.restoreRecoveredFailure({ runId: input.runId });
            return yield* storeAnswer(
              input.runId,
              restoration.restored
                ? { outcome: "restored", stopRequested: true }
                : {
                    outcome: "stopped",
                    stopRequested: true,
                    reason: STAYED_AS_IT_IS[restoration.reason],
                  },
            );
          }),
        );
      }),

    /** Returns one page of runs, the newest first unless the caller sorts the other way. */
    query: (
      input: QueryInput,
    ): Effect.Effect<RunPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("run.query");
        const { limit, cursor, sort, ...filter } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          runs.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, DEFAULT_DIRECTION),
            ...filter,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Returns a run with its frozen plan, its inputs, every step record and
     * its live subscriptions. Fails with `NotFound` if no run has the id.
     * The run and its subscriptions are read in one transaction, so they are
     * from the same moment.
     */
    read: (id: Id): Effect.Effect<Run, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("run.read");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* runs.read(id);
            if (Option.isNone(found)) {
              return yield* Effect.fail(createNotFoundError("no such run"));
            }
            return { ...found.value, subscriptions: yield* runHeld.list(id) };
          }),
        );
      }),
  };
});

export class RunService extends Context.Service<RunService, Effect.Success<typeof make>>()(
  "hercule/controller/runs/RunService",
) {}

export const RunServiceLayer: Layer.Layer<
  RunService,
  never,
  | SqlClient.SqlClient
  | WorkflowService
  | TaskService
  | PluginHost
  | Settings
  | AfterCommit
  | RunExecutor
  | WorkspaceService
  | WorkspaceSteps
  | PlatformEvents
  | Notifier
  | ConnectionTypes
  | PromotionState
  | TextGeneration
  | ProviderAccountRunners
> = Layer.effect(RunService)(make);

/**
 * Resumes every unfinished run, as the controller does when it starts
 * serving. A resume that cannot even list the runs is a broken database, which
 * nothing after it could work around, so it dies.
 */
export const resumeUnfinishedRuns: Effect.Effect<void, never, RunService> = Effect.orDie(
  Effect.flatMap(RunService, (runs) => runs.resumeUnfinished),
);
