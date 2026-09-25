/**
 * The run operations: `run.start`, `run.cancel`, `run.query` and `run.read`,
 * resuming unfinished runs when the controller starts, and what the
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
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createNotFoundError,
  DEFAULT_PAGE_LIMIT,
  Id,
  RUN_SORT_FIELDS,
  RunFilter,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Run,
  type RunCancelInput,
  type RunSummary,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { buildPageInputFields, refuseCursor, type AfterCommit } from "../db";
import type { PluginHost } from "../plugins";
import type { SettingError, Settings } from "../settings";
import type { TaskService } from "../tasks";
import type { WorkflowService } from "../workflows";
import { WorkspaceService } from "../workspaces";
import { makeRunEngine } from "./engine";
import type { RunExecutor } from "./executor";
import { runRepository } from "./repository";
import type { WorkspaceSteps } from "./workspace-steps";

const QueryInput = Schema.Struct({
  ...RunFilter.fields,
  ...buildPageInputFields(RUN_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);

/** One page of the run list, as `run.query` returns it. */
export interface RunPage {
  readonly items: ReadonlyArray<RunSummary>;
  readonly nextCursor?: string;
}

const make = Effect.gen(function* () {
  const runs = yield* runRepository;
  const engine = yield* makeRunEngine;
  const workspaces = yield* WorkspaceService;

  /**
   * Returns the run with `workspaceKeptUntil` added when its ephemeral
   * workspace is kept for inspection: the run failed, or was cancelled by a
   * user who kept the workspace. Every other run is returned as it is.
   */
  const addWorkspaceKeptUntil = (run: Run): Effect.Effect<Run, SettingError | SqlError> =>
    Effect.gen(function* () {
      if (run.workspaceId === undefined || run.plan.workspace?.kind !== "ephemeral") return run;
      if (run.status !== "failed" && run.status !== "cancelled") return run;
      if (run.status === "cancelled" && !(yield* runs.keepsWorkspace(run.id))) return run;
      return { ...run, workspaceKeptUntil: yield* workspaces.computeKeptUntil(run.finishedAt) };
    });

  return {
    start: engine.start,

    /** `run.cancel`: cancels a run and returns it, as the run engine's `cancel` describes. */
    cancel: (
      id: Id,
      input: RunCancelInput,
    ): Effect.Effect<
      Run,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SettingError | SqlError
    > => Effect.flatMap(engine.cancel(id, input), addWorkspaceKeptUntil),
    resumeUnfinished: engine.resumeUnfinished,
    completeStep: engine.completeStep,
    failWorkspace: engine.failWorkspace,
    failRunsPinnedTo: engine.failRunsPinnedTo,
    owedWorkspaceSteps: engine.owedWorkspaceSteps,
    listEndedWorkspaceSteps: engine.listEndedWorkspaceSteps,
    wakeRunsWaitingForRunner: engine.wakeRunsWaitingForRunner,

    /**
     * Returns one page of runs, the newest first unless the caller sorts the
     * other way: the run someone started last is the one they look for.
     */
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
            direction: sort?.direction ?? "desc",
            ...filter,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Returns a run with its frozen plan, its inputs and every step record.
     * Fails with `NotFound` if no run has the id.
     */
    read: (
      id: Id,
    ): Effect.Effect<Run, Unauthenticated | Forbidden | NotFound | SettingError | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("run.read");
        const found = yield* runs.read(id);
        if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError("no such run"));
        return yield* addWorkspaceKeptUntil(found.value);
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
> = Layer.effect(RunService)(make);

/**
 * Resumes every unfinished run, as the controller does when it starts
 * serving. A resume that cannot even list the runs is a broken database, which
 * nothing after it could work around, so it dies.
 */
export const resumeUnfinishedRuns: Effect.Effect<void, never, RunService> = Effect.orDie(
  Effect.flatMap(RunService, (runs) => runs.resumeUnfinished),
);
