/**
 * The workspace service. It covers:
 *
 * - the operations `workspace.query` and `workspace.read`
 * - the workspace a spawn asks for (`openFor`)
 * - the rows behind the two operations a user calls by name, provision and
 *   dispose
 * - the two things a runner reports about a workspace: the result of
 *   provisioning it, and the git credential it needs to do so
 *
 * All workspace decisions are made here. Nothing outside this domain knows how
 * a multi-repo workspace is laid out, what a thread's branch is called, or
 * which Connection the work in a workspace acts through. A spawn passes in
 * what it asked for and the branch this module named for it, and gets back
 * where the session works.
 *
 * A primary is provisioned by name and never torn down: it is the repo's main
 * workspace on that runner, shared by every session that runs in it. An
 * ephemeral workspace is created by the spawn that asked for it, and is
 * disposed of by hand or by the expiry sweep.
 *
 * Nothing here sends anything to a runner. A frame is returned as a value -
 * what to provision, what to dispose, the answer to a credential request - and
 * the controller daemon sends it once the rows are committed. If a runner never
 * receives the frame, the workspace stays `provisioning`, and both the sweep
 * and the user treat it as a workspace that never came up.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  Subdirectory,
  type CredentialAnswer,
  type CredentialRequest,
  type GitIdentity,
  type WorkspaceDispose,
  type WorkspaceProvision,
  type WorkspaceReport,
} from "@hercule/protocol";
import {
  createConflictError,
  DEFAULT_PAGE_LIMIT,
  Id,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  WORKSPACE_SORT_FIELDS,
  WorkspaceFilter,
  createDecodeValidationError,
  type Checkout,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type SortDirection,
  type SpawnWorkspace,
  type Unauthenticated,
  type Validation,
  type Workspace,
  type WorkspaceStatus,
} from "@hercule/contract";
import { currentStamp, requireGrant, SYSTEM_ACTOR, USER_ACTOR } from "../actor";
import { nowIso, buildPageInputFields, refuseCursor, withTransaction } from "../db";
import type { SessionTokens } from "../permissions";
import { AuditLog } from "../events";
import {
  isCheckedOut,
  NOT_CHECKED_OUT,
  extractRepoName,
  resourceRepository,
  type StoredRepo,
} from "../resources";
import { NO_SUCH_RUNNER, runnerRepository } from "../runners";
import type { Secrets } from "../secrets";
import { Settings, type ScopeSettings, type SettingError } from "../settings";
import { gitCredentials } from "./credentials";
import {
  openPrimary,
  openWorkspace,
  buildProvisionFrame,
  type OpeningCheckout,
} from "./provisioning";
import {
  workspaceRepository,
  type StoredCheckout,
  type StoredWorkspace,
  type SweepCandidate,
} from "./repository";

const QueryInput = Schema.Struct({
  ...WorkspaceFilter.fields,
  ...buildPageInputFields(WORKSPACE_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);

export interface WorkspacePage {
  readonly items: ReadonlyArray<Workspace>;
  readonly nextCursor?: string;
}

/** Newest first, because a workspace list is mostly read to see what exists now. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** How long an ephemeral workspace that no session can resume is kept, in hours. */
const DEFAULT_ORPHAN_TTL_HOURS = 24;

/** How long an ephemeral workspace with a resumable session is kept unused, in days. */
const DEFAULT_IDLE_TTL_DAYS = 30;

/**
 * How long the ephemeral workspace of a failed run, or of a run cancelled
 * with its workspace kept, is kept for inspection after the run finished, in
 * days.
 */
const DEFAULT_FAILED_RUN_TTL_DAYS = 14;

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

const NO_SUCH_WORKSPACE = "no such workspace";

const NO_SUCH_RESOURCE = "no such resource";

const PRIMARY_STANDS = "a main workspace is never torn down";

const NOT_IN_PROJECT = "that repo is not filed under that project";

const REPO_TWICE = "a workspace can hold only one checkout of each repo: list each repo once";

const SAME_NAME =
  "two of those repos have the same name, and each checkout's directory is named after its repo, so they cannot share a workspace";

const WORKSPACE_PINS =
  "that workspace is on another machine, and a session must run on the machine its workspace is on";

const WORKSPACE_NOT_READY = "that workspace is not ready, so no session can start in it";

/** The rule the runner uses to name each directory in a multi-repo workspace, checked here too. */
const isDirectoryName = Schema.is(Subdirectory);

const describeUnnameableRepo = (name: string): string =>
  `${name} is not a valid directory name, so that repo cannot be checked out beside other repos in a workspace`;

/**
 * Builds the name of the branch a thread's own worktree is created on, from
 * the last eight characters of the session id. A UUIDv7 starts with a
 * timestamp, so two threads started in the same millisecond share their first
 * eight characters and would ask one runner for the same branch twice.
 */
export const buildThreadBranch = (sessionId: string): string =>
  `hercule/thread-${sessionId.slice(-8)}`;

/**
 * Builds the name of the branch a run's own worktree is created on. The whole
 * run id is used, so the branch of a run can be found from the run alone.
 */
export const buildRunBranch = (runId: string): string => `hercule/run-${runId}`;

const ALREADY_GONE = "that workspace is already gone";

const describeLiveSessions = (sessions: number): string =>
  `${String(sessions)} session(s) in that workspace have not exited; stop them first`;

const RUN_UNFINISHED =
  "that workspace belongs to a run that has not finished; cancel the run first, and choose there whether to keep its workspace";

/**
 * Where a session that asked for a workspace will work, once the rows are
 * written. It holds:
 *
 * - the workspace the session is in
 * - the branch the runner switches the main workspace to before the harness
 *   starts
 * - the Connection the session pushes through
 * - if a new workspace was opened, the frame that asks the runner to
 *   provision it
 *
 * The frame is returned rather than sent from here, because this runs in the
 * caller's transaction, and a transaction never spans a wait on a runner.
 *
 * The runner is not included. `machineFor` decides it before the session is
 * placed, and `openFor` is given it rather than deciding it.
 */
interface Opened {
  readonly workspaceId: string | null;
  readonly checkoutBranch: string | undefined;
  readonly designatedConnectionId: string | null;
  readonly frame?: WorkspaceProvision;
}

/** The status change a runner's report made to a workspace, for whoever was waiting on it. */
interface Settled {
  readonly workspaceId: string;
  readonly moved: "ready" | "failed" | "deleted";
}

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

/**
 * Why the sweep disposed of a workspace, as opposed to a user disposing of
 * it. The audit entry records it, so a reader can tell which rule applied:
 *
 * - `orphan`: no session can resume in it, and the orphan window ended
 * - `idle`: a session could still resume in it, and the idle window ended
 * - `run-completed`: it was the workspace of a run that completed
 * - `run-cancelled`: it was the workspace of a run cancelled without keeping it
 * - `run-failed`: it was the workspace of a failed run, and the failed-run
 *   window ended
 * - `run-kept`: it was the workspace of a run cancelled with its workspace
 *   kept, and the failed-run window ended
 */
type Expiry = "orphan" | "idle" | "run-completed" | "run-cancelled" | "run-failed" | "run-kept";

/** One workspace the sweep may dispose of, and the rule that applied. */
interface Expired {
  readonly id: string;
  readonly reason: Expiry;
}

/**
 * Returns the time a finished run's workspace, kept for inspection, is due
 * for deletion: the time the run finished plus the failed-run window.
 */
const addFailedRunWindow = (finishedAt: string, controller: ScopeSettings<"controller">): string =>
  new Date(
    Date.parse(finishedAt) +
      (controller["workspace.failedRunTtlDays"] ?? DEFAULT_FAILED_RUN_TTL_DAYS) * DAY_MS,
  ).toISOString();

/**
 * Decides whether a workspace is due for deletion, and returns the rule that
 * applied, or `undefined` if the workspace stays. A workspace with a running
 * session always stays.
 *
 * The workspace of a finished run follows how the run ended: it is deleted at
 * once when the run completed, or was cancelled by a user who did not keep
 * it. After a failure, or a cancel that kept it, it stays for the failed-run
 * window, so the user can look at what the run left behind.
 *
 * Any other workspace belongs to threads. A thread that can still be resumed
 * keeps its worktree, because that worktree holds its work, so its workspace
 * outlives the orphan window and expires only on the longer idle window.
 */
const decideExpiry = (
  candidate: SweepCandidate,
  now: number,
  controller: ScopeSettings<"controller">,
): Expiry | undefined => {
  if (candidate.liveSessions > 0) return undefined;
  const { run } = candidate;
  if (run !== undefined) {
    if (run.status === "completed") return "run-completed";
    if (run.status === "cancelled" && !run.keepsWorkspace) return "run-cancelled";
    const due = Date.parse(addFailedRunWindow(run.finishedAt, controller));
    if (now <= due) return undefined;
    return run.status === "failed" ? "run-failed" : "run-kept";
  }
  const reason = candidate.resumableSessions > 0 ? "idle" : "orphan";
  const window =
    reason === "idle"
      ? (controller["workspace.idleTtlDays"] ?? DEFAULT_IDLE_TTL_DAYS) * DAY_MS
      : (controller["workspace.orphanTtlHours"] ?? DEFAULT_ORPHAN_TTL_HOURS) * HOUR_MS;
  return now - Date.parse(candidate.usedAt) > window ? reason : undefined;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaces = yield* workspaceRepository;
  const resources = yield* resourceRepository;
  const runners = yield* runnerRepository;
  const credentials = yield* gitCredentials;
  const settings = yield* Settings;
  const audit = yield* AuditLog;

  const readStoredWorkspaceOrFail = (
    id: string,
  ): Effect.Effect<StoredWorkspace, NotFound | SqlError> =>
    Effect.flatMap(
      workspaces.one(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_WORKSPACE)),
        onSome: Effect.succeed,
      }),
    );

  const toCheckoutRecord = (checkout: StoredCheckout): Checkout => ({
    checkoutId: checkout.id,
    resourceId: checkout.resourceId,
    form: checkout.form,
    subdirectory: checkout.subdirectory,
    branch: checkout.branch,
    branches: checkout.branches,
    defaultBranch: checkout.defaultBranch,
  });

  /**
   * Builds the API records for a page of workspace rows, with their checkouts
   * and the sessions running in them. The Connection comes from the row's own
   * column, fixed when the workspace was opened, and not from its first
   * checkout's resource: a resource moved to another Connection does not
   * change what an existing workspace was opened with.
   */
  const readWorkspaceRecords = (
    rows: ReadonlyArray<StoredWorkspace>,
  ): Effect.Effect<ReadonlyArray<Workspace>, SqlError> =>
    Effect.gen(function* () {
      const ids = rows.map((row) => row.id);
      const checkouts = yield* workspaces.listCheckouts(ids);
      const sessionIds = yield* workspaces.sessionIdsOf(ids);
      return rows.map((row) => ({
        id: row.id,
        runnerId: row.runnerId,
        kind: row.kind,
        status: row.status,
        checkouts: (checkouts.get(row.id) ?? []).map(toCheckoutRecord),
        designatedConnectionId: row.designatedConnectionId,
        message: row.message,
        sessionIds: sessionIds.get(row.id) ?? [],
        createdAt: row.createdAt,
        provisionedAt: row.provisionedAt,
        lastUsedAt: row.lastUsedAt,
        disposedAt: row.disposedAt,
      }));
    });

  const readWorkspaceRecord = (row: StoredWorkspace): Effect.Effect<Workspace, SqlError> =>
    Effect.map(readWorkspaceRecords([row]), (found) => found[0]!);

  const readRepoOrFail = (
    resourceId: string,
  ): Effect.Effect<StoredRepo, NotFound | InvalidState | SqlError> =>
    Effect.gen(function* () {
      const found = yield* resources.one(resourceId);
      if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError(NO_SUCH_RESOURCE));
      if (!isCheckedOut(found.value))
        return yield* Effect.fail(createInvalidStateError(NOT_CHECKED_OUT));
      return found.value;
    });

  /**
   * Reads the repo for a new checkout. Fails with a validation error if the
   * resource does not exist, is not a repo, or is not filed under the project.
   */
  const readCheckoutableRepoOrFail = (
    resourceId: string,
    projectId: string | undefined,
  ): Effect.Effect<StoredRepo, Validation | SqlError> =>
    Effect.gen(function* () {
      const found = yield* resources.one(resourceId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          createValidationError([{ path: ["workspace"], message: NO_SUCH_RESOURCE }]),
        );
      }
      if (!isCheckedOut(found.value)) {
        return yield* Effect.fail(
          createValidationError([{ path: ["workspace"], message: NOT_CHECKED_OUT }]),
        );
      }
      yield* validateFiledUnderProject([resourceId], projectId);
      return found.value;
    });

  /**
   * Checks that every one of these repos is filed under the thread's project,
   * and fails with a validation error if one is not. The check applies to a
   * workspace the thread joins as well as to one it creates: a thread in one
   * project must not reach another project's repo just because a workspace
   * holding it already exists.
   */
  const validateFiledUnderProject = (
    resourceIds: ReadonlyArray<string>,
    projectId: string | undefined,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      if (projectId === undefined || resourceIds.length === 0) return;
      const filed = yield* resources.projectsOf(resourceIds);
      for (const resourceId of resourceIds) {
        if (!(filed.get(resourceId) ?? []).includes(projectId)) {
          return yield* Effect.fail(
            createValidationError([{ path: ["projectId"], message: NOT_IN_PROJECT }]),
          );
        }
      }
    });

  /**
   * Rebuilds the provision frame of a workspace from its rows and the repos
   * behind its checkouts. The rows hold everything provisioning needs, so the
   * rebuilt frame is the same as the frame that was first sent, and asks for
   * the same clone or worktree.
   */
  const rebuildProvisionFrame = (
    workspace: StoredWorkspace,
  ): Effect.Effect<WorkspaceProvision, SqlError> =>
    Effect.gen(function* () {
      const checkouts = (yield* workspaces.listCheckouts([workspace.id])).get(workspace.id) ?? [];
      const named = yield* resources.byIds(checkouts.map((checkout) => checkout.resourceId));
      const plans: Array<{ checkout: StoredCheckout; resource: StoredRepo }> = [];
      for (const checkout of checkouts) {
        const resource = named.get(checkout.resourceId);
        // Only a repo is ever checked out, so a checkout of any other kind of
        // resource cannot be provisioned.
        if (resource === undefined || resource.kind !== "repo") continue;
        plans.push({ checkout, resource });
      }
      return buildProvisionFrame(workspace, plans);
    });

  /**
   * Decides where a spawned session works, and writes the rows in the
   * caller's transaction. Returns an `Opened`, with the frame to send once the
   * transaction has committed. Fails with a validation error if the requested
   * workspace or repos cannot be used.
   *
   * This is the whole workspace part of a spawn:
   *
   * - what the requested workspace means
   * - reading the repos behind it and checking they belong to the project
   * - the layout of a multi-repo workspace
   * - the Connection the work acts through
   *
   * The caller names the branch a new worktree is created on, because the
   * branch is named after whatever the workspace is for: a thread
   * (`buildThreadBranch`) or a run (`buildRunBranch`).
   *
   * For an `existing` workspace, this does not check again whether it is
   * ready: `machineFor` checked that before the session was placed, because
   * the workspace decides which runner the session runs on. This only checks
   * what `machineFor` does not: whether the repos in it belong to this project.
   */
  const openFor = (input: {
    /** The workspace the caller asked for; absent keeps the workspace the session already has. */
    readonly wish: SpawnWorkspace | undefined;
    /** The workspace the session keeps when `wish` is absent, as a fork does. */
    readonly heldWorkspaceId: string | null;
    readonly runnerId: string;
    readonly projectId: string | undefined;
    /** The branch each checkout of a new ephemeral workspace is created on. */
    readonly branch: string;
    readonly at: string;
  }): Effect.Effect<Opened, Validation | SqlError> =>
    Effect.gen(function* () {
      const wish = input.wish;
      const nothing: Opened = {
        workspaceId: null,
        checkoutBranch: undefined,
        designatedConnectionId: null,
      };

      // Nothing new to create: the session joins the workspace it named, or
      // stays in the one it already has, which is what a fork does.
      if (wish === undefined || wish.kind === "existing") {
        const joined = wish === undefined ? input.heldWorkspaceId : wish.workspaceId;
        if (joined === null) return nothing;
        const row = yield* workspaces.one(joined);
        if (Option.isNone(row)) {
          return yield* Effect.fail(
            createValidationError([
              { path: ["workspace", "workspaceId"], message: NO_SUCH_WORKSPACE },
            ]),
          );
        }
        const held = (yield* workspaces.listCheckouts([joined])).get(joined) ?? [];
        // An existing workspace's repos must still belong to this project, so
        // joining a workspace is not a way around project filing.
        yield* validateFiledUnderProject(
          held.map((checkout) => checkout.resourceId),
          input.projectId,
        );
        return {
          workspaceId: joined,
          checkoutBranch: undefined,
          designatedConnectionId: row.value.designatedConnectionId,
        };
      }

      if (wish.kind === "primary") {
        const resource = yield* readCheckoutableRepoOrFail(wish.resourceId, input.projectId);
        const standing = yield* workspaces.primaryOn(resource.id, input.runnerId);
        if (Option.isSome(standing)) {
          return {
            workspaceId: standing.value.id,
            checkoutBranch: wish.branch,
            designatedConnectionId: standing.value.designatedConnectionId,
          };
        }
        const opened = yield* openPrimary(
          { workspaces, audit },
          { resource, runnerId: input.runnerId, actor: yield* currentStamp, at: input.at },
        );
        return {
          workspaceId: opened.workspace.id,
          checkoutBranch: wish.branch,
          designatedConnectionId: opened.workspace.designatedConnectionId,
          frame: opened.frame,
        };
      }

      const repos = yield* Effect.forEach(wish.checkouts, (checkout) =>
        Effect.map(
          readCheckoutableRepoOrFail(checkout.resourceId, input.projectId),
          (resource) => ({
            resource,
            baseBranch: checkout.baseBranch,
          }),
        ),
      );
      // Each checkout gets its own directory, named after the repo. So a
      // workspace with one repo twice, or with two repos of the same name,
      // cannot be laid out.
      const names = repos.map((repo) => extractRepoName(repo.resource.canonicalRemote));
      if (new Set(repos.map((repo) => repo.resource.id)).size !== repos.length) {
        return yield* Effect.fail(
          createValidationError([{ path: ["workspace", "checkouts"], message: REPO_TWICE }]),
        );
      }
      if (repos.length > 1 && new Set(names).size !== names.length) {
        return yield* Effect.fail(
          createValidationError([{ path: ["workspace", "checkouts"], message: SAME_NAME }]),
        );
      }
      // Checked here, where the user can read the error, rather than left to
      // the frame that carries the name to the runner. A frame that fails to
      // encode is a defect, and the spawn would fail with nothing the user
      // could act on.
      const unusable = repos.length > 1 ? names.find((name) => !isDirectoryName(name)) : undefined;
      if (unusable !== undefined) {
        return yield* Effect.fail(
          createValidationError([
            { path: ["workspace", "checkouts"], message: describeUnnameableRepo(unusable) },
          ]),
        );
      }
      const checkouts: ReadonlyArray<OpeningCheckout> = repos.map((repo, index) => ({
        resource: repo.resource,
        form: "worktree" as const,
        // A single repo is checked out at the root of the workspace; several
        // repos sit side by side, each in a directory named after the repo.
        subdirectory: repos.length > 1 ? (names[index] ?? null) : null,
        branch: input.branch,
        ...(repo.baseBranch === undefined ? {} : { baseBranch: repo.baseBranch }),
      }));
      const opened = yield* openWorkspace(
        { workspaces, audit },
        {
          runnerId: input.runnerId,
          kind: "ephemeral",
          designatedConnectionId: repos[0]?.resource.connectionId ?? null,
          checkouts,
          actor: yield* currentStamp,
          at: input.at,
        },
      );
      return {
        workspaceId: opened.workspace.id,
        checkoutBranch: undefined,
        designatedConnectionId: opened.workspace.designatedConnectionId,
        frame: opened.frame,
      };
    });

  return {
    query: (input: QueryInput): Effect.Effect<WorkspacePage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.query");
        const { limit, cursor, sort, ...filter } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          workspaces.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            runnerId: filter.runnerId,
            resourceId: filter.resourceId,
            projectId: filter.projectId,
            kind: filter.kind,
            status: filter.status,
          }),
        );
        return {
          items: yield* readWorkspaceRecords(listing.items),
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (id: Id): Effect.Effect<Workspace, Exclude<ReadError | NotFound, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.read");
        return yield* Effect.flatMap(readStoredWorkspaceOrFail(id), readWorkspaceRecord);
      }),

    /**
     * Opens a repo's main workspace on one runner, cloned fresh under that
     * runner's own storage, and writes the rows in the caller's transaction.
     * Returns the workspace record and the frame to send. Fails with:
     *
     * - `NotFound` if the resource or the runner does not exist
     * - `InvalidState` if the resource is not a repo
     * - `Conflict` if the repo already has a main workspace on that runner
     *
     * The repo and the runner are read here rather than passed in, because
     * this method owns the errors for them. The repo is read first, so a
     * request with both ids wrong gets the error about the repo.
     *
     * The record is returned with the frame rather than read again later: it
     * is built from the rows just written, and a second read could include
     * changes made in the meantime.
     */
    openPrimaryFor: (input: {
      readonly resourceId: string;
      readonly runnerId: string;
    }): Effect.Effect<
      { readonly workspace: Workspace; readonly frame: WorkspaceProvision },
      Conflict | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        const resource = yield* readRepoOrFail(input.resourceId);
        const runner = yield* runners.read(input.runnerId);
        if (Option.isNone(runner)) return yield* Effect.fail(createNotFoundError(NO_SUCH_RUNNER));
        const held = yield* workspaces.primaryOn(resource.id, input.runnerId);
        if (Option.isSome(held)) {
          return yield* Effect.fail(
            createConflictError("that repo already has a main workspace on that machine"),
          );
        }
        const at = yield* nowIso;
        // This path is always a user provisioning a primary by name. A spawn
        // that needs one goes through `openFor`, with its own actor.
        const opened = yield* openPrimary(
          { workspaces, audit },
          { resource, runnerId: input.runnerId, actor: USER_ACTOR, at },
        );
        return { workspace: yield* readWorkspaceRecord(opened.workspace), frame: opened.frame };
      }),

    /**
     * Returns the workspace if a user may dispose of it. Fails with
     * `NotFound` if there is no such workspace, and with `InvalidState` if:
     *
     * - it is a primary, which is never torn down
     * - it is already deleted or lost
     * - a session in it has not exited, because removing the directory would
     *   break a running harness
     * - it is the workspace of a run that has not finished, because the run's
     *   next steps work in it. Cancelling the run is the way to stop it, and
     *   the cancel asks whether to keep the workspace.
     */
    disposable: (id: string): Effect.Effect<StoredWorkspace, NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        const workspace = yield* readStoredWorkspaceOrFail(id);
        if (workspace.kind === "primary")
          return yield* Effect.fail(createInvalidStateError(PRIMARY_STANDS));
        if (workspace.status === "deleted" || workspace.status === "lost") {
          return yield* Effect.fail(createInvalidStateError(ALREADY_GONE));
        }
        if (yield* workspaces.hasUnfinishedRun(id)) {
          return yield* Effect.fail(createInvalidStateError(RUN_UNFINISHED));
        }
        const living = (yield* workspaces.sessionIdsOf([id])).get(id) ?? [];
        if (living.length > 0)
          return yield* Effect.fail(createInvalidStateError(describeLiveSessions(living.length)));
        return workspace;
      }),

    /**
     * Returns every workspace the sweep may dispose of, and why: each ephemeral
     * workspace on an online runner that has no running session and has
     * outlived its expiry window (see `decideExpiry`).
     */
    expiredCandidates: (): Effect.Effect<ReadonlyArray<Expired>, SettingError | SqlError> =>
      Effect.gen(function* () {
        const candidates = yield* workspaces.sweepCandidates();
        if (candidates.length === 0) return [];
        const controller = yield* settings.all();
        const now = yield* Clock.currentTimeMillis;
        const due: Array<Expired> = [];
        for (const candidate of candidates) {
          const reason = decideExpiry(candidate, now, controller);
          if (reason !== undefined) due.push({ id: candidate.id, reason });
        }
        return due;
      }),

    /**
     * Returns when the sweep deletes the ephemeral workspace of a run that
     * finished at `finishedAt` and keeps its workspace for inspection: after
     * a failure, or a cancel that kept it. The window is the controller
     * setting `workspace.failedRunTtlDays`, read now, so a change to the
     * setting moves the time.
     */
    computeKeptUntil: (finishedAt: string): Effect.Effect<string, SettingError | SqlError> =>
      Effect.map(settings.all(), (controller) => addFailedRunWindow(finishedAt, controller)),

    /**
     * Returns the workspace if the sweep may still dispose of it, or
     * `undefined` if its files are gone or a session is running in it. A
     * sweep reads every candidate up front, and a session can start in one
     * while an earlier one is being disposed of. A workspace with a running
     * harness in it is never disposed of.
     */
    sweepable: (id: string): Effect.Effect<StoredWorkspace | undefined, SqlError> =>
      Effect.gen(function* () {
        const found = yield* workspaces.one(id);
        if (
          Option.isNone(found) ||
          (found.value.status !== "ready" && found.value.status !== "failed")
        ) {
          return undefined;
        }
        const living = (yield* workspaces.sessionIdsOf([id])).get(id) ?? [];
        return living.length > 0 ? undefined : found.value;
      }),

    /**
     * Marks a workspace as `deleted`, records the audit entry, and returns the
     * frame that removes it from disk. The row is written first: if the runner
     * never receives the frame, a directory is left behind, which the user can
     * remove. A row left `ready` for a workspace nobody uses would never be
     * cleaned up.
     */
    markGone: (
      workspace: StoredWorkspace,
      actor: typeof USER_ACTOR | typeof SYSTEM_ACTOR,
      reason?: Expiry,
    ): Effect.Effect<WorkspaceDispose, SqlError> =>
      Effect.gen(function* () {
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* workspaces.markDisposed(workspace.id, at);
            yield* audit.append({
              kind: "workspace.deleted",
              actor,
              payload: {
                workspaceId: workspace.id,
                runnerId: workspace.runnerId,
                ...(reason === undefined ? {} : { reason }),
              },
              at,
            });
          }),
        );
        return { _tag: "workspaceDispose", workspaceId: workspace.id };
      }),

    /**
     * Returns a provision frame for every workspace on this runner that is
     * still `provisioning`, so they can be sent again. Without this, a frame
     * sent to a runner that was not connected, or that restarted before it
     * acted, would leave the workspace provisioning forever. The runner is
     * expected to treat a repeat frame for a workspace it already has as a
     * no-op.
     *
     * Every frame here is safe to send again: the rows hold everything
     * provisioning needs, so a rebuilt frame is the same as the frame that was
     * sent, and asks for the same clone or worktree.
     */
    listOwedProvisioning: (
      runnerId: string,
    ): Effect.Effect<ReadonlyArray<WorkspaceProvision>, SqlError> =>
      Effect.flatMap(workspaces.provisioningOn(runnerId), (owed) =>
        Effect.forEach(owed, rebuildProvisionFrame),
      ),

    /**
     * Returns the provision frame of one workspace, rebuilt from its rows, if
     * the workspace is still `provisioning`, and `none` otherwise. A run's
     * first workspace step sends this before the step itself, so a runner that
     * missed the first frame still provisions the workspace before it is
     * asked to work in it.
     */
    rebuildOwedProvision: (
      workspaceId: string,
    ): Effect.Effect<Option.Option<WorkspaceProvision>, SqlError> =>
      Effect.gen(function* () {
        const found = yield* workspaces.one(workspaceId);
        if (Option.isNone(found) || found.value.status !== "provisioning") return Option.none();
        return Option.some(yield* rebuildProvisionFrame(found.value));
      }),

    /**
     * Records a runner's report about a workspace it was asked to provision or
     * dispose of. A report about a workspace that is not on this runner is
     * ignored, because a runner may only report on its own workspaces.
     *
     * Returns the status change the report made, or `undefined` if it changed
     * nothing, for example a repeated report or one about a workspace that
     * became ready in the meantime. What happens to the sessions waiting on the
     * workspace is not decided here: the controller daemon tells the sessions
     * domain. That keeps this domain from depending on the sessions domain.
     */
    reported: (
      runnerId: string,
      report: WorkspaceReport,
    ): Effect.Effect<Settled | undefined, SqlError> =>
      Effect.gen(function* () {
        const found = yield* workspaces.one(report.workspaceId);
        if (Option.isNone(found) || found.value.runnerId !== runnerId) return undefined;
        const moved = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            switch (report.status) {
              case "ready":
                return yield* workspaces.markReady(report.workspaceId, report.checkouts ?? [], at);
              case "failed":
                return yield* workspaces.markFailed(report.workspaceId, report.message ?? null, at);
              case "deleted":
                return yield* workspaces.markDisposed(report.workspaceId, at);
            }
          }),
        );
        return moved ? { workspaceId: report.workspaceId, moved: report.status } : undefined;
      }),

    /**
     * Marks every live workspace on a retired runner as `lost`. The workspaces
     * were directories on its disk, and this controller will never reach them
     * again. Runs in the caller's transaction, which is the one that retires
     * the runner.
     */
    lostOnRunner: (runnerId: string, at: string): Effect.Effect<void, SqlError> =>
      workspaces.lostOnRunner(runnerId, at),

    /**
     * Returns a workspace's status, or `undefined` if there is no such
     * workspace. This is the one fact about a workspace the controller daemon
     * reads directly: a thread cannot be resumed in a workspace that is gone,
     * and the error has to say which status the workspace is in.
     */
    statusOf: (workspaceId: string): Effect.Effect<WorkspaceStatus | undefined, SqlError> =>
      Effect.map(workspaces.one(workspaceId), (found) =>
        Option.isNone(found) ? undefined : found.value.status,
      ),

    /**
     * Returns the ids of the runners that hold a ready primary of this
     * resource. A run whose steps work in the main workspace prefers one of
     * these runners, because its steps can start there without a fresh clone.
     */
    listRunnersWithReadyPrimary: (
      resourceId: string,
    ): Effect.Effect<ReadonlySet<string>, SqlError> =>
      workspaces.listRunnersWithReadyPrimary(resourceId),

    /**
     * Returns the identity a workspace step's commits are made as: that of
     * the workspace's designated Connection, the account the work in the
     * workspace commits and pushes as. It is read now rather than stored, the
     * way a session start reads its account. Returns `undefined` when no
     * Connection backs the workspace, when there is no such workspace, or
     * when the Connection has no usable account; the runner then leaves git's
     * own identity unchanged.
     */
    readCommitAuthor: (workspaceId: string): Effect.Effect<GitIdentity | undefined, SqlError> =>
      Effect.gen(function* () {
        const found = yield* workspaces.one(workspaceId);
        const connectionId = Option.isNone(found) ? null : found.value.designatedConnectionId;
        if (connectionId === null) return undefined;
        return (yield* credentials.readGithubAccount(connectionId))?.gitIdentity;
      }),

    /**
     * Marks a workspace as used just now, which keeps the sweep from disposing
     * of it. The controller daemon calls this when a session in the workspace
     * starts or exits, because that is what counts as use.
     */
    touched: (workspaceId: string, at: string): Effect.Effect<void, SqlError> =>
      workspaces.touched(workspaceId, at),

    /**
     * Returns the runner a spawn must run on when it joins an existing
     * workspace, because a session runs where its files are. The caller reads
     * this before the session is placed. Fails with:
     *
     * - a validation error if the workspace does not exist, or if the spawn
     *   asked for a different runner
     * - `InvalidState` if the workspace is not ready, because the harness
     *   would be given a directory that does not exist yet
     */
    machineFor: (
      workspaceId: string,
      requestedRunnerId: string | undefined,
    ): Effect.Effect<string, Validation | InvalidState | SqlError> =>
      Effect.gen(function* () {
        const found = yield* workspaces.one(workspaceId);
        if (Option.isNone(found)) {
          return yield* Effect.fail(
            createValidationError([
              { path: ["workspace", "workspaceId"], message: NO_SUCH_WORKSPACE },
            ]),
          );
        }
        if (requestedRunnerId !== undefined && requestedRunnerId !== found.value.runnerId) {
          return yield* Effect.fail(
            createValidationError([{ path: ["runnerId"], message: WORKSPACE_PINS }]),
          );
        }
        if (found.value.status !== "ready") {
          return yield* Effect.fail(createInvalidStateError(WORKSPACE_NOT_READY));
        }
        return found.value.runnerId;
      }),

    openFor,

    /**
     * Builds the answer to a runner's git credential request. The answer is
     * not stored: it is built for that one request and returned, to be sent on
     * the connection the request came in on. Never fails: an error is logged
     * and answered as `no_connection`.
     */
    credentialAnswer: (
      runnerId: string,
      request: CredentialRequest,
    ): Effect.Effect<CredentialAnswer> =>
      Effect.catchCause(
        credentials.answer(runnerId, request),
        // A secret that does not decrypt means this controller's master key is
        // wrong. The asker cannot act on that, so it is only told that no
        // credential is coming, but the error is logged so the operator can
        // see what happened.
        (cause) =>
          Effect.as(Effect.logError("A git credential could not be read", cause), {
            _tag: "credentialAnswer" as const,
            requestId: request.requestId,
            error: "no_connection" as const,
          }),
      ),
  };
});

/**
 * The workspace service has two kinds of method, and nothing else would catch
 * a method wired up as the wrong kind.
 *
 * - `query` and `read` are operations: each checks its own grant and decodes
 *   its own input, and a route handler calls it directly.
 * - Every other method updates rows or builds a frame as a value. It checks no
 *   grant, and only the controller daemon calls it, after checking the grant
 *   for the operation it carries out. Putting one of these on a route would
 *   expose it to anyone who can reach the API.
 */
export class WorkspaceService extends Context.Service<
  WorkspaceService,
  Effect.Success<typeof make>
>()("hercule/controller/workspaces/WorkspaceService") {}

export const WorkspaceServiceLayer: Layer.Layer<
  WorkspaceService,
  never,
  SqlClient.SqlClient | AuditLog | Settings | Secrets | SessionTokens
> = Layer.effect(WorkspaceService)(make);
