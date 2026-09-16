/**
 * Workspaces as the API sees them - `workspace.query`, `read`, `provision` and
 * `dispose` - plus the two things a machine says about one: what came of a
 * provisioning, and what credential it needs to get on with it.
 *
 * A primary is provisioned by name and never torn down: it is the user's own
 * checkout of that repo on that machine, and a workspace an agent shares with
 * the user is not something Hydra deletes. An ephemeral one is made by the
 * spawn that asked for it and is disposed of by hand or by the sweep below.
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
import type { CredentialRequest, WorkspaceReport } from "@hydra/protocol";
import {
  conflict,
  DEFAULT_PAGE_LIMIT,
  Id,
  invalidState,
  notFound,
  WORKSPACE_SORT_FIELDS,
  WorkspaceFilter,
  WorkspaceProvisionInput,
  validationOf,
  type Checkout,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
  type Workspace,
} from "@hydra/contract";
import { requireGrant, SYSTEM_ACTOR, USER_ACTOR } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { resourceRepository, type StoredRepo } from "../resources";
import { requireOnline, RunnerPresence, runnerRepository } from "../runners";
import { SessionService } from "../sessions";
import { Secrets } from "../secrets";
import { Settings, type ScopeSettings } from "../settings";
import { gitCredentials } from "./credentials";
import { provisionFrame, type CheckoutPlan } from "./provisioning";
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

const LOST_ADOPT =
  "that machine went away before it could be told to adopt the folder; provision it again";

const NOT_CHECKED_OUT = "only a repo is checked out; a folder and a mailbox are records";

const PRIMARY_STANDS = "a primary is never torn down";

const ALREADY_GONE = "that workspace is already gone";

const stillLivedIn = (sessions: number): string =>
  `${String(sessions)} session(s) in that workspace have not exited; stop them first`;

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

/**
 * Whether a workspace has outlived its use: one nothing is living in, judged
 * against the window its threads earn it. A thread that can still be resumed
 * keeps its worktree - that worktree is its work - so it survives the orphan
 * window and goes only on the long idle one.
 */
const expired = (
  candidate: { readonly liveSessions: number; readonly resumableSessions: number },
  idleFor: number,
  controller: ScopeSettings<"controller">,
): boolean => {
  if (candidate.liveSessions > 0) return false;
  const window =
    candidate.resumableSessions > 0
      ? (controller["workspace.idleTtlDays"] ?? DEFAULT_IDLE_TTL_DAYS) * DAY_MS
      : (controller["workspace.orphanTtlHours"] ?? DEFAULT_ORPHAN_TTL_HOURS) * HOUR_MS;
  return idleFor > window;
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
  const sessions = yield* SessionService;
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
   * The records a page of rows makes: their checkouts, the sessions living in
   * them, and the Connection each one acts through, which is the one its first
   * checkout's resource names.
   */
  const composed = (
    rows: ReadonlyArray<StoredWorkspace>,
  ): Effect.Effect<ReadonlyArray<Workspace>, SqlError> =>
    Effect.gen(function* () {
      const ids = rows.map((row) => row.id);
      const checkouts = yield* workspaces.checkoutsOf(ids);
      const sessionIds = yield* workspaces.sessionIdsOf(ids);
      const firsts = rows.map((row) => checkouts.get(row.id)?.[0]?.resourceId);
      const named = yield* resources.byIds(
        firsts.filter((resourceId): resourceId is string => resourceId !== undefined),
      );
      const designated = new Map<string, string | null>(
        rows.map((row, index) => {
          const first = firsts[index];
          return [row.id, first === undefined ? null : (named.get(first)?.connectionId ?? null)];
        }),
      );
      return rows.map((row) => ({
        id: row.id,
        runnerId: row.runnerId,
        kind: row.kind,
        status: row.status,
        checkouts: (checkouts.get(row.id) ?? []).map(asCheckout),
        designatedConnectionId: designated.get(row.id) ?? null,
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
      if (found.value.kind !== "repo") return yield* Effect.fail(invalidState(NOT_CHECKED_OUT));
      return found.value;
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
            payload: { workspaceId: workspace.id, runnerId: workspace.runnerId },
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
   * Every frame this re-sends is one that can be re-sent: a provision that
   * named a folder to adopt in place is refused unless the machine is
   * connected, so nothing here has to stand in for a path the controller does
   * not store. What comes back is a clone or a worktree, which is what it was.
   */
  const resendProvisioning = (runnerId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const owed = yield* workspaces.provisioningOn(runnerId);
      for (const workspace of owed) {
        const checkouts = (yield* workspaces.checkoutsOf([workspace.id])).get(workspace.id) ?? [];
        const named = yield* resources.byIds(checkouts.map((checkout) => checkout.resourceId));
        const plans: Array<CheckoutPlan> = [];
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
      if (!expired(candidate, now - Date.parse(candidate.usedAt), controller)) continue;
      const row = yield* workspaces.one(candidate.id);
      // Read again inside the pass: a session could have started in it while
      // the previous workspace of this pass was being disposed of.
      if (Option.isNone(row) || row.value.status !== "ready") continue;
      yield* disposing(row.value, SYSTEM_ACTOR);
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
     * The repo's own checkout on one machine: cloned fresh, or adopted from a
     * folder the user already has. A second one for the same pair is a
     * conflict, because that is what "the repo's checkout there" means.
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
        // A folder to adopt is the one thing the controller never writes down,
        // so it cannot be asked for again later: the machine has to be there to
        // hear it now. Everything else queues and is re-sent on arrival.
        if (decoded.path !== undefined) yield* requireOnline(runner.value);

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
            // One that could not be made holds nothing; it is stood down here
            // so this one takes its place rather than living beside it.
            yield* workspaces.supersedeFailedPrimary(resource.id, decoded.runnerId, at);
            const row = yield* workspaces.insert({
              runnerId: decoded.runnerId,
              kind: "primary",
              at,
            });
            const checkouts = yield* workspaces.insertCheckouts(
              row.id,
              [{ resourceId: resource.id, form: "clone", subdirectory: null, branch: null }],
              at,
            );
            yield* audit.append({
              kind: "workspace.created",
              actor: USER_ACTOR,
              payload: {
                workspaceId: row.id,
                runnerId: decoded.runnerId,
                kind: row.kind,
                resourceIds: [resource.id],
              },
              at,
            });
            return {
              workspace: row,
              frame: provisionFrame(row, [
                {
                  checkout: checkouts[0]!,
                  resource,
                  ...(decoded.path === undefined ? {} : { path: decoded.path }),
                },
              ]),
            };
          }),
        );
        // Outside the transaction: a transaction never spans a wait on
        // anything outside the database.
        const told = yield* presence.tell(decoded.runnerId, frame);
        // An adopt is the one frame that is never re-sent, because the folder
        // it names is not stored; a machine that went in the meantime leaves a
        // workspace that says so rather than one waiting for a frame that will
        // not come again.
        if (!told && decoded.path !== undefined) {
          yield* withTransaction(
            sql,
            Effect.flatMap(nowIso, (at) => workspaces.markFailed(workspace.id, LOST_ADOPT, at)),
          );
          return yield* composedOne(yield* stored(workspace.id));
        }
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
     * A workspace that came up releases whatever was waiting for it, and one
     * that could not be made ends those sessions with the machine's own words
     * for why - both outside the transaction that recorded it.
     */
    reported: (runnerId: string, report: WorkspaceReport): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const found = yield* workspaces.one(report.workspaceId);
        if (Option.isNone(found) || found.value.runnerId !== runnerId) return;
        const moved = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            switch (report.status) {
              case "ready":
                yield* workspaces.markReady(report.workspaceId, report.checkouts ?? [], at);
                return true;
              case "failed":
                return yield* workspaces.markFailed(report.workspaceId, report.message ?? null, at);
              case "deleted":
                return yield* workspaces.markDisposed(report.workspaceId, at);
            }
          }),
        );
        // A report that moved nothing - a second one, or one about a workspace
        // that came up meanwhile - must not end the sessions living in it.
        if (report.status === "ready") yield* sessions.dispatch(runnerId);
        if (report.status === "failed" && moved) {
          yield* sessions.endForWorkspace(report.workspaceId, report.message ?? null);
        }
      }),

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
  SqlClient.SqlClient | AuditLog | RunnerPresence | SessionService | Settings | Secrets
> = Layer.effect(WorkspaceService)(make);
