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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createNotFoundError,
  DEFAULT_PAGE_LIMIT,
  Id,
  RUN_SORT_FIELDS,
  RunFilter,
  type Forbidden,
  type NotFound,
  type Run,
  type RunSummary,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../actor";
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
import type { Settings } from "../settings";
import { runHeldSubscriptions } from "../subscriptions";
import type { TaskService } from "../tasks";
import type { WorkflowService } from "../workflows";
import type { WorkspaceService } from "../workspaces";
import { makeRunEngine } from "./engine";
import type { RunExecutor } from "./executor";
import { runRepository } from "./repository";
import type { StepSessionFailures } from "./session-observer";
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* runRepository;
  const runHeld = yield* runHeldSubscriptions;
  const engine = yield* makeRunEngine;

  return {
    start: engine.start,
    rerun: engine.rerun,
    startTriggeredRun: engine.startTriggeredRun,
    recordSignalMatch: engine.recordSignalMatch,

    /** `run.cancel`: cancels a run and returns it, as the run engine's `cancel` describes. */
    cancel: engine.cancel,
    resumeUnfinished: engine.resumeUnfinished,
    completeStep: engine.completeStep,
    failRunsInWorkspace: engine.failRunsInWorkspace,
    failRunsPinnedTo: engine.failRunsPinnedTo,
    listOwedWorkspaceSteps: engine.listOwedWorkspaceSteps,
    listEndedWorkspaceSteps: engine.listEndedWorkspaceSteps,
    wakeRunsWaitingForRunner: engine.wakeRunsWaitingForRunner,

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
  | StepSessionFailures
> = Layer.effect(RunService)(make);

/**
 * Resumes every unfinished run, as the controller does when it starts
 * serving. A resume that cannot even list the runs is a broken database, which
 * nothing after it could work around, so it dies.
 */
export const resumeUnfinishedRuns: Effect.Effect<void, never, RunService> = Effect.orDie(
  Effect.flatMap(RunService, (runs) => runs.resumeUnfinished),
);
