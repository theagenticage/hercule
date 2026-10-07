/**
 * The workspace service. It covers:
 *
 * - the operations `workspace.query` and `workspace.read`
 * - the workspace a spawn asks for (`openFor`)
 * - the leases sessions and runs hold on the workspaces they use, and how
 *   long a released lease keeps its workspace
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
 * disposed of by hand or by the expiry sweep. The sweep reads only the
 * workspace's leases. Each session and run that used the workspace released
 * its lease with a retention, and the workspace is kept until the latest
 * kept-until time among them.
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  Subdirectory,
  WORKSPACE_LIFECYCLE_CAPABILITY,
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
  type WorkspaceAttachInput,
} from "@hercule/contract";
import { currentStamp, requireGrant, SYSTEM_ACTOR, USER_ACTOR } from "../actor";
import {
  nowIso,
  buildPageInputFields,
  refuseCursor,
  resolveSortDirection,
  withTransaction,
} from "../db";
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
import { Settings, type ScopeSettings } from "../settings";
import { githubAccounts, gitCredentials, type WorkspaceStepActivity } from "./credentials";
import {
  openPrimary,
  openWorkspace,
  buildProvisionFrame,
  type OpeningCheckout,
} from "./provisioning";
import {
  workspaceRepository,
  type ExpiredLease,
  type Retention,
  type StoredCheckout,
  type StoredWorkspace,
  type WorkspaceHolder,
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

/** How long an `orphan` lease keeps its workspace after its release, in hours. */
const DEFAULT_ORPHAN_TTL_HOURS = 24;

/** How long an `idle` lease keeps its workspace after its release, in days. */
const DEFAULT_IDLE_TTL_DAYS = 30;

/** How long an `inspection` lease keeps its workspace after its release, in days. */
const DEFAULT_INSPECTION_TTL_DAYS = 14;

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

/**
 * Builds the refusal for disposing of a workspace that holders still use. It
 * names every holder and what to do about each: a run is cancelled, because
 * cancelling is the one way to stop it and the cancel asks whether to keep
 * the workspace, and a session is stopped.
 */
const describeActiveHolders = (holders: ReadonlyArray<WorkspaceHolder>): string => {
  const runIds = holders
    .filter((holder) => holder.kind === "run")
    .map((holder) => holder.id)
    .join(", ");
  const sessionIds = holders
    .filter((holder) => holder.kind === "session")
    .map((holder) => holder.id)
    .join(", ");
  const users: Array<string> = [];
  const steps: Array<string> = [];
  if (runIds !== "") {
    users.push(`run ${runIds}, which has not finished`);
    steps.push(`cancel run ${runIds} first, and choose there whether to keep its workspace`);
  }
  if (sessionIds !== "") {
    users.push(`sessions ${sessionIds}, which have not exited`);
    steps.push(`stop sessions ${sessionIds} first`);
  }
  return `that workspace is in use by ${users.join(", and by ")}; ${steps.join("; ")}`;
};

/** Writes a holder the way a Subscription's holder is written: `session:<id>` or `run:<id>`. */
const formatHolder = (holder: WorkspaceHolder): string => `${holder.kind}:${holder.id}`;

/**
 * Returns how long a lease released with this retention keeps its workspace,
 * in milliseconds, from the controller settings as they are now. A later
 * change to a setting does not move a lease already released.
 */
const computeRetentionWindow = (
  retention: Retention,
  controller: ScopeSettings<"controller">,
): number => {
  switch (retention) {
    case "none":
      return 0;
    case "orphan":
      return (controller["workspace.orphanTtlHours"] ?? DEFAULT_ORPHAN_TTL_HOURS) * HOUR_MS;
    case "idle":
      return (controller["workspace.idleTtlDays"] ?? DEFAULT_IDLE_TTL_DAYS) * DAY_MS;
    case "inspection":
      return (controller["workspace.inspectionTtlDays"] ?? DEFAULT_INSPECTION_TTL_DAYS) * DAY_MS;
  }
};

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

/** What `openFor` is given. */
interface OpenInput {
  /** The session or run that works in the workspace, and so takes a lease on it. */
  readonly holder: WorkspaceHolder;
  /** The workspace the caller asked for; absent keeps the workspace the session already has. */
  readonly wish: SpawnWorkspace | undefined;
  /** The workspace the session keeps when `wish` is absent, as a fork does. */
  readonly heldWorkspaceId: string | null;
  readonly runnerId: string;
  readonly projectId: string | undefined;
  /** The branch each checkout of a new ephemeral workspace is created on. */
  readonly branch: string;
  readonly at: string;
}

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaces = yield* workspaceRepository;
  const resources = yield* resourceRepository;
  const runners = yield* runnerRepository;
  const credentials = yield* gitCredentials;
  const accounts = yield* githubAccounts;
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
    baseBranch: checkout.baseBranch,
  });

  /**
   * Builds the API records for a page of workspace rows. Each record holds:
   *
   * - the workspace's checkouts;
   * - the sessions that hold an active lease on it;
   * - for an ephemeral workspace that is not gone, when the sweep may delete
   *   it, once no lease on it is active.
   *
   * Only the active leases and the latest kept-until time are read, never
   * every lease: a workspace a thread worked in for months has had many.
   *
   * The Connection comes from the row's own column, fixed when the workspace
   * was opened, and not from its first checkout's resource: a resource moved
   * to another Connection does not change what an existing workspace was
   * opened with.
   */
  const readWorkspaceRecords = (
    rows: ReadonlyArray<StoredWorkspace>,
  ): Effect.Effect<ReadonlyArray<Workspace>, SqlError> =>
    Effect.gen(function* () {
      const ids = rows.map((row) => row.id);
      const checkouts = yield* workspaces.listCheckouts(ids);
      const active = yield* workspaces.listActiveHolders(ids);
      // Only an ephemeral workspace that is not gone can still be deleted by
      // the sweep, so only such a workspace has a kept-until time to show.
      const keptUntil = yield* workspaces.listKeptUntil(
        rows
          .filter(
            (row) => row.kind === "ephemeral" && row.status !== "deleted" && row.status !== "lost",
          )
          .map((row) => row.id),
      );
      return rows.map((row) => ({
        id: row.id,
        runnerId: row.runnerId,
        kind: row.kind,
        status: row.status,
        ownership: row.ownership,
        path: row.path,
        checkouts: (checkouts.get(row.id) ?? []).map(toCheckoutRecord),
        designatedConnectionId: row.designatedConnectionId,
        message: row.message,
        sessionIds: (active.get(row.id) ?? [])
          .filter((holder) => holder.kind === "session")
          .map((holder) => holder.id),
        keptUntil: keptUntil.get(row.id) ?? null,
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

  /** Returns the attached main workspace that new work must use, refusing unavailable sources. */
  const readSelectedExistingWorkspace = (
    resourceId: string,
    runnerId: string,
  ): Effect.Effect<StoredWorkspace | undefined, Validation | SqlError> =>
    Effect.gen(function* () {
      const selection = yield* workspaces.readRepositorySelection(resourceId, runnerId);
      if (Option.isNone(selection) || selection.value.mode === "managed") return undefined;
      const source =
        selection.value.primaryWorkspaceId === null
          ? Option.none()
          : yield* workspaces.one(selection.value.primaryWorkspaceId);
      if (Option.isNone(source) || source.value.status !== "ready") {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["workspace"],
              message:
                "The selected existing checkout is unavailable or still being validated. Reattach the same checkout and wait until it is ready.",
            },
          ]),
        );
      }
      const runner = yield* runners.read(runnerId);
      if (
        Option.isNone(runner) ||
        !(runner.value.negotiatedCapabilities ?? []).includes(WORKSPACE_LIFECYCLE_CAPABILITY)
      ) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["runnerId"],
              message:
                "This runner does not support existing checkout attachment. Upgrade and reconnect the runner before starting work.",
            },
          ]),
        );
      }
      return source.value;
    });

  /**
   * Returns the workspace's frozen creation instruction. Legacy workspaces
   * lack that snapshot, so their first resend records the instruction rebuilt
   * from their existing rows and Resources.
   */
  const rebuildProvisionFrame = (
    workspace: StoredWorkspace,
  ): Effect.Effect<WorkspaceProvision, SqlError> =>
    Effect.gen(function* () {
      const frozen = yield* workspaces.readProvisionFrame(workspace.id);
      if (Option.isSome(frozen)) return frozen.value;
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
      const frame = buildProvisionFrame(workspace, plans);
      return yield* workspaces.freezeProvisionFrame(workspace.id, frame);
    });

  /**
   * Decides where a spawned session or a run works, and writes the rows in
   * the caller's transaction, all but the lease: `openFor` below writes that.
   */
  const openWithoutLease = (input: OpenInput): Effect.Effect<Opened, Validation | SqlError> =>
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
        if (row.value.status !== "ready") {
          return yield* Effect.fail(
            createValidationError([
              { path: ["workspace", "workspaceId"], message: WORKSPACE_NOT_READY },
            ]),
          );
        }
        const instruction = yield* workspaces.readProvisionFrame(joined);
        if (
          row.value.ownership === "existing" ||
          (Option.isSome(instruction) &&
            instruction.value.checkouts.some(
              (checkout) => checkout.repositoryWorkspaceId !== undefined,
            ))
        ) {
          const runner = yield* runners.read(row.value.runnerId);
          if (
            Option.isNone(runner) ||
            !(runner.value.negotiatedCapabilities ?? []).includes(WORKSPACE_LIFECYCLE_CAPABILITY)
          ) {
            return yield* Effect.fail(
              createValidationError([
                {
                  path: ["runnerId"],
                  message:
                    "This runner does not support this workspace's existing repository. Upgrade and reconnect it before starting work.",
                },
              ]),
            );
          }
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
        const selected = yield* readSelectedExistingWorkspace(resource.id, input.runnerId);
        if (selected !== undefined) {
          return {
            workspaceId: selected.id,
            checkoutBranch: wish.branch,
            designatedConnectionId: selected.designatedConnectionId,
          };
        }
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
        Effect.gen(function* () {
          const resource = yield* readCheckoutableRepoOrFail(checkout.resourceId, input.projectId);
          const selected = yield* readSelectedExistingWorkspace(resource.id, input.runnerId);
          return { resource, baseBranch: checkout.baseBranch, repositoryWorkspaceId: selected?.id };
        }),
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
        ...(repo.repositoryWorkspaceId === undefined
          ? {}
          : { repositoryWorkspaceId: repo.repositoryWorkspaceId }),
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

  /**
   * Decides where a spawned session or a run works, and writes the rows in
   * the caller's transaction, including the holder's lease on the workspace.
   * Returns an `Opened`, with the frame to send once the transaction has
   * committed. Fails with a validation error if the requested workspace or
   * repos cannot be used.
   *
   * Every workspace the holder opens or joins gets the holder's lease here,
   * in the same transaction. A new workspace is therefore never without a
   * lease, and the sweep, which deletes only a workspace whose leases are
   * all released, never deletes one before its first holder is done.
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
  const openFor = (input: OpenInput): Effect.Effect<Opened, Validation | SqlError> =>
    Effect.gen(function* () {
      const opened = yield* openWithoutLease(input);
      if (opened.workspaceId !== null) {
        yield* workspaces.acquireLease(opened.workspaceId, input.holder, input.at);
      }
      return opened;
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
            direction: resolveSortDirection(sort, DEFAULT_DIRECTION),
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
        const selection = yield* workspaces.readRepositorySelection(resource.id, input.runnerId);
        if (Option.isSome(selection) && selection.value.mode === "existing") {
          return yield* Effect.fail(
            createConflictError(
              "This repository already uses an existing checkout on this runner. Reattach that checkout instead of selecting managed storage.",
            ),
          );
        }
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

    /** Opens or revalidates the user's fixed existing checkout on its selected runner. */
    openAttachmentFor: (
      input: WorkspaceAttachInput,
    ): Effect.Effect<
      { readonly workspace: Workspace; readonly frame: WorkspaceProvision },
      Conflict | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        const resource = yield* readRepoOrFail(input.resourceId);
        const runner = yield* runners.read(input.runnerId);
        if (Option.isNone(runner)) return yield* Effect.fail(createNotFoundError(NO_SUCH_RUNNER));
        if (runner.value.lifecycle === "retired") {
          return yield* Effect.fail(
            createInvalidStateError(
              "This runner is retired and cannot validate an attachment. Join it as a new runner before attaching a checkout.",
            ),
          );
        }
        if (!(runner.value.negotiatedCapabilities ?? []).includes(WORKSPACE_LIFECYCLE_CAPABILITY)) {
          return yield* Effect.fail(
            createInvalidStateError(
              "This runner does not support existing checkout attachment. Upgrade and reconnect it before attaching a checkout.",
            ),
          );
        }
        const remoteName = input.remoteName ?? "origin";
        const selection = yield* workspaces.readRepositorySelection(resource.id, input.runnerId);
        if (Option.isSome(selection)) {
          const held = selection.value;
          const primary =
            held.primaryWorkspaceId === null
              ? Option.none()
              : yield* workspaces.one(held.primaryWorkspaceId);
          if (
            held.mode !== "existing" ||
            held.remoteName !== remoteName ||
            (held.path !== input.path &&
              (Option.isNone(primary) || primary.value.path !== input.path))
          ) {
            return yield* Effect.fail(
              createConflictError(
                "This repository already has a different storage choice on this runner. Use its selected checkout; replacement is not supported.",
              ),
            );
          }
          if (
            Option.isSome(primary) &&
            primary.value.status !== "deleted" &&
            primary.value.status !== "lost"
          ) {
            if (yield* workspaces.retryAttachment(primary.value.id)) {
              yield* audit.append({
                kind: "workspace.attachmentRetried",
                actor: USER_ACTOR,
                payload: { workspaceId: primary.value.id, runnerId: input.runnerId },
                at: yield* nowIso,
              });
            }
            const updated = yield* readStoredWorkspaceOrFail(primary.value.id);
            return {
              workspace: yield* readWorkspaceRecord(updated),
              frame: yield* rebuildProvisionFrame(updated),
            };
          }
          return yield* Effect.fail(
            createInvalidStateError(
              "The selected existing checkout has no active registration. Restore its registration before creating work here.",
            ),
          );
        }
        yield* workspaces.reserveRepositorySelection(resource.id, input.runnerId, {
          mode: "existing",
          path: input.path,
          remoteName,
        });
        const opened = yield* openWorkspace(
          { workspaces, audit },
          {
            runnerId: input.runnerId,
            kind: "primary",
            attachment: { path: input.path, remoteName },
            designatedConnectionId: resource.connectionId,
            checkouts: [{ resource, form: "clone", subdirectory: null, branch: null }],
            actor: USER_ACTOR,
            at: yield* nowIso,
          },
        );
        return { workspace: yield* readWorkspaceRecord(opened.workspace), frame: opened.frame };
      }),

    /**
     * Returns the workspace if a user may dispose of it. Fails with
     * `NotFound` if there is no such workspace, and with `InvalidState` if:
     *
     * - it is a primary, which is never torn down
     * - it is already deleted or lost
     * - a holder's lease on it is active:
     *   - a run that has not finished, because the run's next steps work in
     *     it. Cancelling the run is the way to stop it, and the cancel asks
     *     whether to keep the workspace.
     *   - a session that has not exited, because removing the directory
     *     would break a running harness.
     *
     * The message names every run and session to stop first.
     */
    disposable: (id: string): Effect.Effect<StoredWorkspace, NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        const workspace = yield* readStoredWorkspaceOrFail(id);
        if (workspace.kind === "primary")
          return yield* Effect.fail(createInvalidStateError(PRIMARY_STANDS));
        if (workspace.status === "deleted" || workspace.status === "lost") {
          return yield* Effect.fail(createInvalidStateError(ALREADY_GONE));
        }
        const active = (yield* workspaces.listActiveHolders([id])).get(id) ?? [];
        if (active.length > 0) {
          return yield* Effect.fail(createInvalidStateError(describeActiveHolders(active)));
        }
        return workspace;
      }),

    /**
     * Returns the ids of the workspaces the sweep may dispose of now: each
     * ephemeral workspace on an online runner whose leases are all released
     * and whose latest kept-until time has passed. `sweepable` checks each
     * one again before it is disposed of.
     */
    listSweepCandidates: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.flatMap(nowIso, workspaces.listSweepCandidates),

    /**
     * Returns the workspace and the lease that kept it longest, if the sweep
     * may still dispose of it now. Returns `undefined` if its files are gone,
     * if a lease on it is active again, or if a lease keeps it for longer
     * now. Runs in the caller's transaction, which also disposes of it.
     *
     * A sweep lists its candidates up front, and the leases can change before
     * a candidate's turn comes: a session can be resumed in it, or a released
     * lease can be released again with another window. A workspace with a
     * running harness in it is never disposed of, and neither is one a lease
     * still keeps.
     */
    sweepable: (
      id: string,
    ): Effect.Effect<
      { readonly workspace: StoredWorkspace; readonly expired: ExpiredLease } | undefined,
      SqlError
    > =>
      Effect.gen(function* () {
        const found = yield* workspaces.one(id);
        if (
          Option.isNone(found) ||
          (found.value.status !== "ready" && found.value.status !== "failed")
        ) {
          return undefined;
        }
        const expired = yield* workspaces.findExpiredLease(id, yield* nowIso);
        return Option.isNone(expired)
          ? undefined
          : { workspace: found.value, expired: expired.value };
      }),

    /**
     * Makes the holder's lease on a workspace active again. A session calls
     * this when it is resumed in the workspace it exited from, in the
     * transaction that resumes it. Opening or joining a workspace takes the
     * lease through `openFor` instead.
     */
    acquire: (
      holder: WorkspaceHolder,
      workspaceId: string,
      at: string,
    ): Effect.Effect<void, SqlError> => workspaces.acquireLease(workspaceId, holder, at),

    /**
     * Releases every lease the holder has, with this retention, in the
     * caller's transaction. Each lease is then kept until its release time
     * plus the retention's window, read from the settings now: a later change
     * to a setting does not move it.
     *
     * A lease that is already released keeps its release time, and only its
     * retention and kept-until time change. That is how a session whose
     * conversation was deleted, and which can therefore never be resumed, is
     * moved from the idle window to the orphan window. Calling this twice with
     * the same retention changes nothing.
     */
    release: (
      holder: WorkspaceHolder,
      retention: Retention,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const window = computeRetentionWindow(retention, yield* settings.all());
        yield* workspaces.releaseLeases(holder, retention, window, at);
      }),

    /**
     * Marks a workspace as `deleted`, records the audit entry, and returns the
     * frame that removes it from disk. The row is written first: if the runner
     * never receives the frame, a directory is left behind, which the user can
     * remove. A row left `ready` for a workspace nobody uses would never be
     * cleaned up.
     *
     * The sweep passes the lease that kept the workspace longest. The audit
     * entry records its retention as the reason, and its holder, so a reader
     * can tell which rule let the workspace go.
     */
    markGone: (
      workspace: StoredWorkspace,
      actor: typeof USER_ACTOR | typeof SYSTEM_ACTOR,
      expired?: ExpiredLease,
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
                ...(expired === undefined
                  ? {}
                  : { reason: expired.retention, holder: formatHolder(expired.holder) }),
              },
              at,
            });
          }),
        );
        return { _tag: "workspaceDispose", workspaceId: workspace.id };
      }),

    /** Returns whether this runner can execute the workspace's recorded attachment semantics. */
    supportsProvisionFrame: (
      runnerId: string,
      frame: WorkspaceProvision,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        if (
          frame.attachment === undefined &&
          frame.checkouts.every((checkout) => checkout.repositoryWorkspaceId === undefined)
        )
          return true;
        const runner = yield* runners.read(runnerId);
        return (
          Option.isSome(runner) &&
          (runner.value.negotiatedCapabilities ?? []).includes(WORKSPACE_LIFECYCLE_CAPABILITY)
        );
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
              case "ready": {
                const changed = yield* workspaces.markReady(
                  report.workspaceId,
                  report.checkouts ?? [],
                  at,
                );
                if (report.path !== undefined)
                  yield* workspaces.recordAttachmentPath(report.workspaceId, report.path);
                return changed;
              }
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
        return (yield* accounts.readGithubAccount(connectionId))?.gitIdentity;
      }),

    /**
     * Marks a workspace as used just now, in the caller's transaction. The
     * sessions domain calls this when a session in the workspace starts or
     * exits, because that is what counts as use. The time is only shown to
     * the user: how long a workspace is kept is read off its leases.
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
  SqlClient.SqlClient | AuditLog | Settings | Secrets | SessionTokens | WorkspaceStepActivity
> = Layer.effect(WorkspaceService)(make);
