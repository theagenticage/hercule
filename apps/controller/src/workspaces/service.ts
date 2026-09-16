/**
 * Workspaces as the API sees them - `workspace.query`, `read`, `provision` and
 * `dispose` - what a spawn needs one to be (`openFor`), and the two things a
 * machine says about one: what came of a provisioning, and what credential it
 * needs to get on with it.
 *
 * This is where a working area is decided, in full: nothing outside this domain
 * knows how a multi-repo workspace is laid out, what a thread's branch is called
 * or which Connection the work in one acts through. A spawn hands over the wish
 * and the session id and gets back where the session works.
 *
 * A primary is provisioned by name and never torn down: it is the repo's main
 * workspace on that machine, shared by whatever runs in it. An ephemeral one is
 * made by the spawn that asked for it and is disposed of by hand or by the
 * sweep below.
 *
 * Nothing here waits on a machine inside a transaction: the rows are written
 * and committed, and only then is the machine told. A machine that never hears
 * about a workspace leaves it `provisioning`, which is what the sweep and the
 * user both read as a workspace that never came up.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  Subdirectory,
  type CredentialRequest,
  type WorkspaceProvision,
  type WorkspaceReport,
} from "@hydra/protocol";
import {
  conflict,
  DEFAULT_PAGE_LIMIT,
  Id,
  invalidState,
  notFound,
  validation,
  WORKSPACE_SORT_FIELDS,
  WorkspaceFilter,
  WorkspaceProvisionInput,
  validationOf,
  type Actor,
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
} from "@hydra/contract";
import { requireGrant, SYSTEM_ACTOR, USER_ACTOR } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import {
  isCheckedOut,
  NOT_CHECKED_OUT,
  repoNameOf,
  resourceRepository,
  type StoredRepo,
} from "../resources";
import { RunnerPresence, runnerRepository } from "../runners";
import { Secrets } from "../secrets";
import { Settings, type ScopeSettings } from "../settings";
import { gitCredentials } from "./credentials";
import { openPrimary, openWorkspace, provisionFrame, type OpeningCheckout } from "./provisioning";
import { workspaceRepository, type StoredCheckout, type StoredWorkspace } from "./repository";

const QueryInput = Schema.Struct({
  ...WorkspaceFilter.fields,
  ...pageInput(WORKSPACE_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeProvision = Schema.decodeUnknownEffect(WorkspaceProvisionInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

export interface WorkspacePage {
  readonly items: ReadonlyArray<Workspace>;
  readonly nextCursor?: string;
}

/** Newest first: a workspace list is read as what is standing right now. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** How often the controller looks for workspaces nothing needs any more. */
const WORKSPACE_SWEEP_INTERVAL: Duration.Duration = Duration.minutes(10);

/** Tests hand over an interval they can wait out. */
export const WorkspaceSweepInterval = Context.Reference<Duration.Duration>(
  "hydra/controller/workspaces/WorkspaceSweepInterval",
  { defaultValue: (): Duration.Duration => WORKSPACE_SWEEP_INTERVAL },
);

/** How long an ephemeral workspace nothing references is kept, in hours. */
const DEFAULT_ORPHAN_TTL_HOURS = 24;

/** How long one nobody has worked in is kept, in days. */
const DEFAULT_IDLE_TTL_DAYS = 30;

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

const NO_SUCH_WORKSPACE = "no such workspace";

const NO_SUCH_RESOURCE = "no such resource";

const NO_SUCH_RUNNER = "no such runner";

const PRIMARY_STANDS = "a primary is never torn down";

const NOT_IN_PROJECT = "that repo is not filed under that project";

const REPO_TWICE = "a workspace holds one working copy of a repo: name each one once";

const SAME_NAME = "two of those repos are called the same thing, so they cannot sit side by side";

const WORKSPACE_PINS =
  "that workspace is on another machine; a session runs where its workspace is";

const WORKSPACE_NOT_READY = "that workspace is not ready to be worked in";

/** The one rule the runner lays a multi-repo workspace out by, asked here too. */
const isDirectoryName = Schema.is(Subdirectory);

const unnameable = (name: string): string =>
  `a repo called ${name} cannot have a directory of its own in a workspace`;

/**
 * The branch a thread's own worktree is made on, named after the thread by the
 * last eight characters of its id: a UUIDv7 opens with a timestamp, so two
 * threads started in the same millisecond share their first eight and would ask
 * one machine for one branch twice.
 */
const threadBranch = (sessionId: string): string => `hydra/run-${sessionId.slice(-8)}`;

const ALREADY_GONE = "that workspace is already gone";

const stillLivedIn = (sessions: number): string =>
  `${String(sessions)} session(s) in that workspace have not exited; stop them first`;

/**
 * Where a session that asked for a workspace is to work, once the rows are
 * written: the workspace it is in, the machine that pins it, the branch the
 * machine switches the main workspace to before the harness starts, the account
 * it pushes as, and - where this opened a new one - the frame that asks the
 * machine to make it. The frame is handed back rather than sent from here: it
 * is the caller's transaction, and a transaction never spans a wait on a
 * machine.
 */
export interface Opened {
  readonly workspaceId: string | null;
  readonly runnerId: string;
  readonly checkoutBranch: string | undefined;
  readonly designatedConnectionId: string | null;
  readonly frame?: WorkspaceProvision;
}

/** What a machine's report did to a workspace, for whoever was waiting on it. */
export interface Settled {
  readonly workspaceId: string;
  readonly moved: "ready" | "failed" | "deleted";
}

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

/** Why the sweep took a workspace away, which is what its entry records. */
type Expiry = "orphan" | "idle";

/**
 * Whether a workspace has outlived its use, and on which window: one nothing is
 * living in, judged against the window its threads earn it. A thread that can
 * still be resumed keeps its worktree - that worktree is its work - so it
 * survives the orphan window and goes only on the long idle one.
 */
const expired = (
  candidate: { readonly liveSessions: number; readonly resumableSessions: number },
  idleFor: number,
  controller: ScopeSettings<"controller">,
): Expiry | undefined => {
  if (candidate.liveSessions > 0) return undefined;
  const reason: Expiry = candidate.resumableSessions > 0 ? "idle" : "orphan";
  const window =
    reason === "idle"
      ? (controller["workspace.idleTtlDays"] ?? DEFAULT_IDLE_TTL_DAYS) * DAY_MS
      : (controller["workspace.orphanTtlHours"] ?? DEFAULT_ORPHAN_TTL_HOURS) * HOUR_MS;
  return idleFor > window ? reason : undefined;
};

/** A driver must not stop on one failure, so the cause is logged and dropped. */
const absorbing = (what: string, effect: Effect.Effect<void, unknown>): Effect.Effect<void> =>
  Effect.ignore(Effect.tapCause(effect, (cause) => Effect.logError(what, cause)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaces = yield* workspaceRepository;
  const resources = yield* resourceRepository;
  const runners = yield* runnerRepository;
  const credentials = yield* gitCredentials;
  const presence = yield* RunnerPresence;
  const settings = yield* Settings;
  const audit = yield* AuditLog;

  const stored = (id: string): Effect.Effect<StoredWorkspace, NotFound | SqlError> =>
    Effect.flatMap(
      workspaces.one(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_WORKSPACE)),
        onSome: Effect.succeed,
      }),
    );

  const asCheckout = (checkout: StoredCheckout): Checkout => ({
    checkoutId: checkout.id,
    resourceId: checkout.resourceId,
    form: checkout.form,
    subdirectory: checkout.subdirectory,
    branch: checkout.branch,
    branches: checkout.branches,
    defaultBranch: checkout.defaultBranch,
  });

  /**
   * The records a page of rows makes: their checkouts and the sessions living in
   * them. The Connection each one acts through is the row's own column, settled
   * when it was opened, not re-derived from its first checkout's resource: a
   * resource that changes hands does not change what a workspace already
   * standing was opened against.
   */
  const composed = (
    rows: ReadonlyArray<StoredWorkspace>,
  ): Effect.Effect<ReadonlyArray<Workspace>, SqlError> =>
    Effect.gen(function* () {
      const ids = rows.map((row) => row.id);
      const checkouts = yield* workspaces.checkoutsOf(ids);
      const sessionIds = yield* workspaces.sessionIdsOf(ids);
      return rows.map((row) => ({
        id: row.id,
        runnerId: row.runnerId,
        kind: row.kind,
        status: row.status,
        checkouts: (checkouts.get(row.id) ?? []).map(asCheckout),
        designatedConnectionId: row.designatedConnectionId,
        message: row.message,
        sessionIds: sessionIds.get(row.id) ?? [],
        createdAt: row.createdAt,
        provisionedAt: row.provisionedAt,
        lastUsedAt: row.lastUsedAt,
        disposedAt: row.disposedAt,
      }));
    });

  const composedOne = (row: StoredWorkspace): Effect.Effect<Workspace, SqlError> =>
    Effect.map(composed([row]), (found) => found[0]!);

  const repo = (
    resourceId: string,
  ): Effect.Effect<StoredRepo, NotFound | InvalidState | SqlError> =>
    Effect.gen(function* () {
      const found = yield* resources.one(resourceId);
      if (Option.isNone(found)) return yield* Effect.fail(notFound(NO_SUCH_RESOURCE));
      if (!isCheckedOut(found.value)) return yield* Effect.fail(invalidState(NOT_CHECKED_OUT));
      return found.value;
    });

  /** The repo a checkout is made of, held to what a checkout needs of it. */
  const checkoutable = (
    resourceId: string,
    projectId: string | undefined,
  ): Effect.Effect<StoredRepo, Validation | SqlError> =>
    Effect.gen(function* () {
      const found = yield* resources.one(resourceId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(validation([{ path: ["workspace"], message: NO_SUCH_RESOURCE }]));
      }
      if (!isCheckedOut(found.value)) {
        return yield* Effect.fail(validation([{ path: ["workspace"], message: NOT_CHECKED_OUT }]));
      }
      yield* filedUnder([resourceId], projectId);
      return found.value;
    });

  /**
   * Every one of these repos is filed under the project the thread is filed
   * under. Asked of a workspace that is joined as well as of one that is made:
   * a thread under one project must not reach a repo that belongs to another
   * just because a workspace holding it already stands.
   */
  const filedUnder = (
    resourceIds: ReadonlyArray<string>,
    projectId: string | undefined,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      if (projectId === undefined || resourceIds.length === 0) return;
      const filed = yield* resources.projectsOf(resourceIds);
      for (const resourceId of resourceIds) {
        if (!(filed.get(resourceId) ?? []).includes(projectId)) {
          return yield* Effect.fail(validation([{ path: ["projectId"], message: NOT_IN_PROJECT }]));
        }
      }
    });

  /**
   * Where a spawn is to work, decided and written in the caller's transaction.
   *
   * This is the whole of the workspace half of a spawn: what the wish means, the
   * repos behind it read and held to the project, the layout a multi-repo
   * workspace gets, the branch the thread's own worktree is made on, and the
   * Connection the work acts through. The caller hands it a session id that does
   * not exist yet - the branch is named after the thread - and gets back the
   * frame to send once its transaction has committed.
   */
  const openFor = (input: {
    /** What the caller asked for; absent keeps the workspace it already holds. */
    readonly wish: SpawnWorkspace | undefined;
    /** The workspace the session keeps where the wish brings none: a fork's. */
    readonly heldWorkspaceId: string | null;
    readonly runnerId: string;
    readonly projectId: string | undefined;
    readonly sessionId: string;
    readonly at: string;
    readonly actor: Actor;
  }): Effect.Effect<Opened, Validation | SqlError> =>
    Effect.gen(function* () {
      const wish = input.wish;
      const nothing: Opened = {
        workspaceId: null,
        runnerId: input.runnerId,
        checkoutBranch: undefined,
        designatedConnectionId: null,
      };

      // Nothing new to make: the session joins the workspace it was pointed at,
      // or stays in the one it already holds, which is what a fork does.
      if (wish === undefined || wish.kind === "existing") {
        const joined = wish === undefined ? input.heldWorkspaceId : wish.workspaceId;
        if (joined === null) return nothing;
        const row = yield* workspaces.one(joined);
        if (Option.isNone(row)) {
          return yield* Effect.fail(
            validation([{ path: ["workspace", "workspaceId"], message: NO_SUCH_WORKSPACE }]),
          );
        }
        const held = (yield* workspaces.checkoutsOf([joined])).get(joined) ?? [];
        // A workspace that stands is still a set of repos, and they have to be
        // this project's: joining is not a way around the filing.
        yield* filedUnder(
          held.map((checkout) => checkout.resourceId),
          input.projectId,
        );
        return {
          workspaceId: joined,
          runnerId: row.value.runnerId,
          checkoutBranch: undefined,
          designatedConnectionId: row.value.designatedConnectionId,
        };
      }

      if (wish.kind === "primary") {
        const resource = yield* checkoutable(wish.resourceId, input.projectId);
        const standing = yield* workspaces.primaryOn(resource.id, input.runnerId);
        if (Option.isSome(standing)) {
          return {
            workspaceId: standing.value.id,
            runnerId: standing.value.runnerId,
            checkoutBranch: wish.branch,
            designatedConnectionId: standing.value.designatedConnectionId,
          };
        }
        const opened = yield* openPrimary(
          { workspaces, audit },
          { resource, runnerId: input.runnerId, actor: input.actor, at: input.at },
        );
        return {
          workspaceId: opened.workspace.id,
          runnerId: opened.workspace.runnerId,
          checkoutBranch: wish.branch,
          designatedConnectionId: opened.workspace.designatedConnectionId,
          frame: opened.frame,
        };
      }

      const repos = yield* Effect.forEach(wish.checkouts, (checkout) =>
        Effect.map(checkoutable(checkout.resourceId, input.projectId), (resource) => ({
          resource,
          baseBranch: checkout.baseBranch,
        })),
      );
      // Each working copy gets a directory of its own, named after the repo, so
      // one repo twice and two repos of the same name are both a workspace that
      // cannot be laid out.
      const names = repos.map((repo) => repoNameOf(repo.resource.canonicalRemote));
      if (new Set(repos.map((repo) => repo.resource.id)).size !== repos.length) {
        return yield* Effect.fail(
          validation([{ path: ["workspace", "checkouts"], message: REPO_TWICE }]),
        );
      }
      if (repos.length > 1 && new Set(names).size !== names.length) {
        return yield* Effect.fail(
          validation([{ path: ["workspace", "checkouts"], message: SAME_NAME }]),
        );
      }
      // Said here, where the user can read it, rather than left to the frame
      // that carries the name to the runner: an unencodable frame is a defect,
      // and the spawn would fail with nothing the user could act on.
      const unusable = repos.length > 1 ? names.find((name) => !isDirectoryName(name)) : undefined;
      if (unusable !== undefined) {
        return yield* Effect.fail(
          validation([{ path: ["workspace", "checkouts"], message: unnameable(unusable) }]),
        );
      }
      const checkouts: ReadonlyArray<OpeningCheckout> = repos.map((repo, index) => ({
        resource: repo.resource,
        form: "worktree" as const,
        // One repo sits at the root of the workspace; several sit side by side,
        // each under the name it is known by.
        subdirectory: repos.length > 1 ? (names[index] ?? null) : null,
        branch: threadBranch(input.sessionId),
        ...(repo.baseBranch === undefined ? {} : { baseBranch: repo.baseBranch }),
      }));
      const opened = yield* openWorkspace(
        { workspaces, audit },
        {
          runnerId: input.runnerId,
          kind: "ephemeral",
          designatedConnectionId: repos[0]?.resource.connectionId ?? null,
          checkouts,
          actor: input.actor,
          at: input.at,
        },
      );
      return {
        workspaceId: opened.workspace.id,
        runnerId: opened.workspace.runnerId,
        checkoutBranch: undefined,
        designatedConnectionId: opened.workspace.designatedConnectionId,
        frame: opened.frame,
      };
    });

  /**
   * Marks a workspace gone and tells the machine to take it off disk. The row
   * is committed first: a machine that never hears this leaves a directory
   * behind, which the user can remove, where a row that said `ready` for a
   * workspace nobody owns is one nothing would ever clean up.
   */
  const disposing = (
    workspace: StoredWorkspace,
    actor: typeof USER_ACTOR | typeof SYSTEM_ACTOR,
    /** Why it went, where it was not a person asking. */
    reason?: Expiry,
  ): Effect.Effect<void, SqlError> =>
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
      yield* presence.tell(workspace.runnerId, {
        _tag: "workspaceDispose",
        workspaceId: workspace.id,
      });
    });

  /**
   * Tells a machine again about every workspace it still owes: what a frame
   * sent to a machine that was not connected, or that restarted before it
   * acted, would otherwise leave provisioning for ever. The machine is expected
   * to take a repeat of a workspace it already holds as the no-op it is.
   *
   * Every frame this re-sends is one that can be re-sent: the rows hold
   * everything a provisioning needs, so a frame built again here is the frame
   * that was sent. What comes back is a clone or a worktree, which is what it
   * was.
   */
  const resendProvisioning = (runnerId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const owed = yield* workspaces.provisioningOn(runnerId);
      for (const workspace of owed) {
        const checkouts = (yield* workspaces.checkoutsOf([workspace.id])).get(workspace.id) ?? [];
        const named = yield* resources.byIds(checkouts.map((checkout) => checkout.resourceId));
        const plans: Array<{ checkout: StoredCheckout; resource: StoredRepo }> = [];
        for (const checkout of checkouts) {
          const resource = named.get(checkout.resourceId);
          if (resource === undefined) continue;
          // Only a repo is ever checked out, so a row that is not one is a
          // checkout nothing can be made of.
          if (resource.kind !== "repo") continue;
          plans.push({ checkout, resource });
        }
        yield* presence.tell(workspace.runnerId, provisionFrame(workspace, plans));
      }
    });

  /** One pass of the expiry sweep. */
  const sweep = Effect.gen(function* () {
    const candidates = yield* workspaces.sweepCandidates();
    if (candidates.length === 0) return;
    const controller = yield* settings.all();
    const now = yield* Clock.currentTimeMillis;
    for (const candidate of candidates) {
      const reason = expired(candidate, now - Date.parse(candidate.usedAt), controller);
      if (reason === undefined) continue;
      const row = yield* workspaces.one(candidate.id);
      // Read again inside the pass: a session could have started in it while
      // the previous workspace of this pass was being disposed of.
      if (Option.isNone(row) || row.value.status !== "ready") continue;
      yield* disposing(row.value, SYSTEM_ACTOR, reason);
    }
  });

  return {
    query: (input: QueryInput): Effect.Effect<WorkspacePage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.query");
        const { limit, cursor, sort, ...filter } = yield* Effect.mapError(
          decodeQuery(input),
          validationOf,
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
          items: yield* composed(listing.items),
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (input: Identified): Effect.Effect<Workspace, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* Effect.flatMap(stored(id), composedOne);
      }),

    /**
     * The repo's own workspace on one machine, cloned fresh under that machine's
     * own storage. A second one for the same pair is a conflict, because that is
     * what "the repo's main workspace there" means.
     */
    provision: (
      input: WorkspaceProvisionInput,
    ): Effect.Effect<Workspace, ReadError | NotFound | Conflict | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.provision");
        const decoded = yield* Effect.mapError(decodeProvision(input), validationOf);
        const resource = yield* repo(decoded.resourceId);
        const runner = yield* runners.read(decoded.runnerId);
        if (Option.isNone(runner)) return yield* Effect.fail(notFound(NO_SUCH_RUNNER));

        const { workspace, frame } = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const held = yield* workspaces.primaryOn(resource.id, decoded.runnerId);
            if (Option.isSome(held)) {
              return yield* Effect.fail(
                conflict("that repo already has a primary workspace on that machine"),
              );
            }
            const at = yield* nowIso;
            return yield* openPrimary(
              { workspaces, audit },
              { resource, runnerId: decoded.runnerId, actor: USER_ACTOR, at },
            );
          }),
        );
        // Outside the transaction: a transaction never spans a wait on
        // anything outside the database. A machine that is not listening is
        // told again when it dials in, from the rows this just wrote.
        yield* presence.tell(decoded.runnerId, frame);
        return yield* composedOne(workspace);
      }),

    dispose: (
      input: Identified,
    ): Effect.Effect<Record<string, never>, ReadError | NotFound | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.dispose");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const workspace = yield* stored(id);
        if (workspace.kind === "primary") return yield* Effect.fail(invalidState(PRIMARY_STANDS));
        if (workspace.status === "deleted" || workspace.status === "lost") {
          return yield* Effect.fail(invalidState(ALREADY_GONE));
        }
        // Taking the directory away from a session that is living in it would
        // pull the floor out from under a running harness.
        const living = (yield* workspaces.sessionIdsOf([id])).get(id) ?? [];
        if (living.length > 0) return yield* Effect.fail(invalidState(stillLivedIn(living.length)));
        yield* disposing(workspace, USER_ACTOR);
        return {};
      }),

    /**
     * What a machine made of a workspace it was asked for. A report about a
     * workspace that is not on this machine is dropped: a machine speaks only
     * for what was placed on it.
     *
     * What follows for the sessions waiting on it is not decided here. This
     * answers what the report moved, or nothing where it moved nothing - a
     * second report, or one about a workspace that came up meanwhile - and the
     * caller, which holds both services, tells the sessions domain. That is
     * what keeps this domain from reaching into that one.
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
     * Everything on a retired machine is gone with it, whatever it held: the
     * working areas were directories on its disk and this controller will never
     * reach them again. Runs in the caller's transaction, which is the one that
     * retires the machine.
     */
    lostOnRunner: (runnerId: string, at: string): Effect.Effect<void, SqlError> =>
      workspaces.lostOnRunner(runnerId, at),

    /**
     * Where a workspace stands, or nothing where there is no such row. The one
     * fact about a workspace another domain reads directly: a thread cannot be
     * picked up again in a working area that is gone, and the refusal has to
     * name which state it was in.
     */
    statusOf: (workspaceId: string): Effect.Effect<WorkspaceStatus | undefined, SqlError> =>
      Effect.map(workspaces.one(workspaceId), (found) =>
        Option.isNone(found) ? undefined : found.value.status,
      ),

    /**
     * Work happened in a workspace just now, which is what keeps the sweep from
     * taking it away. Called by the sessions domain when a session in it starts
     * or exits, because that is the work.
     */
    touched: (workspaceId: string, at: string): Effect.Effect<void, SqlError> =>
      workspaces.touched(workspaceId, at),

    /**
     * The machine a spawn that asked to join a standing workspace has to run
     * on, read before the session is placed: a session runs where its files
     * are. One that is still being made is refused rather than joined - the
     * harness would be handed a directory that does not exist yet.
     */
    machineFor: (
      workspaceId: string,
      requestedRunnerId: string | undefined,
    ): Effect.Effect<string, Validation | InvalidState | SqlError> =>
      Effect.gen(function* () {
        const found = yield* workspaces.one(workspaceId);
        if (Option.isNone(found)) {
          return yield* Effect.fail(
            validation([{ path: ["workspace", "workspaceId"], message: NO_SUCH_WORKSPACE }]),
          );
        }
        if (requestedRunnerId !== undefined && requestedRunnerId !== found.value.runnerId) {
          return yield* Effect.fail(validation([{ path: ["runnerId"], message: WORKSPACE_PINS }]));
        }
        if (found.value.status !== "ready") {
          return yield* Effect.fail(invalidState(WORKSPACE_NOT_READY));
        }
        return found.value.runnerId;
      }),

    openFor,

    /**
     * A machine asking for the credential git needs. The answer goes back on
     * the same connection the question came in on, and is held nowhere.
     */
    credentialAsked: (
      runnerId: string,
      request: CredentialRequest,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const answer = yield* Effect.catchCause(
          credentials.answer(runnerId, request),
          // A secret that will not decrypt is this machine's master key being
          // wrong: nothing the asker can act on, and nothing to say to it
          // beyond that no credential is coming - but the operator has to be
          // able to read what happened.
          (cause) =>
            Effect.as(Effect.logError("A git credential could not be read", cause), undefined),
        );
        yield* presence.tell(
          runnerId,
          answer ?? {
            _tag: "credentialAnswer",
            requestId: request.requestId,
            error: "no_connection",
          },
        );
      }),

    /**
     * What the controller does about workspaces on its own: it tells a machine
     * that has just dialled in what it still owes, and it sweeps what nothing
     * needs any more. The sweep decides and the machine deletes; a machine that
     * is not connected is left for the next pass rather than having its disk
     * changed behind its back.
     */
    driving: Effect.all(
      [
        Stream.runForEach(presence.arrivals, (runnerId) =>
          Effect.forkChild(
            absorbing(
              "A machine could not be told what it still owes",
              resendProvisioning(runnerId),
            ),
          ),
        ),
        Effect.gen(function* () {
          const interval = yield* WorkspaceSweepInterval;
          while (true) {
            yield* Effect.sleep(interval);
            yield* absorbing("The workspace expiry sweep failed", sweep);
          }
        }),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  };
});

export class WorkspaceService extends Context.Service<
  WorkspaceService,
  Effect.Success<typeof make>
>()("hydra/controller/workspaces/WorkspaceService") {}

export const WorkspaceServiceLayer: Layer.Layer<
  WorkspaceService,
  never,
  SqlClient.SqlClient | AuditLog | RunnerPresence | Settings | Secrets
> = Layer.effect(WorkspaceService)(make);
