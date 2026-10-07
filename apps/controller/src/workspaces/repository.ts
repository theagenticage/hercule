/**
 * Workspace rows, the checkouts inside them, and the leases held on them.
 * Nothing here decides policy: the service decides what may be provisioned,
 * what may be torn down and how long a released lease keeps its workspace.
 *
 * The only other domain's table read here is `runners`, for whether a runner
 * is online. Which sessions and runs use a workspace is known from their
 * leases, which they acquire and release through the service.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { WorkspaceProvision } from "@hercule/protocol";
import type {
  CheckoutForm,
  SortDirection,
  WorkspaceKind,
  WorkspaceStatus,
} from "@hercule/contract";
import { buildOnlineClause } from "../runners";
import {
  decodeCursor,
  encodeCursor,
  buildKeyset,
  mintUuid,
  buildPage,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

export interface StoredWorkspace {
  readonly id: string;
  readonly runnerId: string;
  readonly kind: WorkspaceKind;
  readonly status: WorkspaceStatus;
  /** The Connection that work in the workspace acts through, fixed when it was opened. */
  readonly designatedConnectionId: string | null;
  readonly message: string | null;
  readonly createdAt: string;
  readonly provisionedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly disposedAt: string | null;
}

export interface StoredCheckout {
  readonly id: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly form: CheckoutForm;
  readonly subdirectory: string | null;
  readonly branch: string | null;
  readonly branches: ReadonlyArray<string>;
  readonly defaultBranch: string | null;
  /** The branch a new branch was asked to start from; `null` means the resource's default. */
  readonly baseBranch: string | null;
}

/** One checkout to insert with a new workspace. */
export interface NewCheckout {
  readonly resourceId: string;
  readonly form: CheckoutForm;
  readonly subdirectory: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
}

export interface WorkspacePageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly runnerId: string | undefined;
  readonly resourceId: string | undefined;
  readonly projectId: string | undefined;
  readonly kind: WorkspaceKind | undefined;
  readonly status: WorkspaceStatus | undefined;
}

/** The state of one checkout, as the runner reported it. */
export interface CheckoutState {
  readonly checkoutId: string;
  /** The branch the runner reported as checked out; null if it could not read one. */
  readonly branch: string | null;
  readonly branches: ReadonlyArray<string>;
  readonly defaultBranch: string | null;
}

/** A session or a run that uses a workspace, and so holds a lease on it. */
export interface WorkspaceHolder {
  readonly kind: "session" | "run";
  readonly id: string;
}

/**
 * How long a released lease keeps its workspace. The holder picks one when it
 * releases the lease, and the workspaces domain owns the length of each:
 *
 * - `none`: not at all. A completed run, or a run cancelled without keeping
 *   its workspace, leaves nothing worth looking at.
 * - `orphan`: the orphan window. No session can be resumed from the work.
 * - `idle`: the idle window. A thread that can still be resumed keeps its
 *   worktree, because the worktree holds its work.
 * - `inspection`: the inspection window. A failed run, or a run cancelled
 *   with its workspace kept, leaves its workspace for the user to look at.
 */
export type Retention = "none" | "orphan" | "idle" | "inspection";

/**
 * The lease that kept a workspace longest, once every lease on it has run
 * out. Its retention is the reason the sweep records for deleting the
 * workspace, and its holder is recorded beside it.
 */
export interface ExpiredLease {
  readonly retention: Retention;
  readonly holder: WorkspaceHolder;
}

/**
 * Builds a SQL expression, over a row of `sessions` under the given alias,
 * that is true when the session's workspace is ready for it. A session with no
 * workspace is always ready; a session whose workspace is still provisioning,
 * or is gone, is not.
 *
 * It is exported because the sessions domain needs it twice: a queued session
 * waits for it before it is dispatched, and an exited session cannot be
 * resumed without it. Separate copies of the condition could drift apart.
 */
export const buildReadyClause = (alias: string): string =>
  `(${alias}.workspace_id IS NULL OR EXISTS (SELECT 1 FROM workspaces ` +
  `WHERE workspaces.id = ${alias}.workspace_id AND workspaces.status = 'ready'))`;

/** The statuses a workspace can still leave. Every other status is final. */
const LIVE_STATUSES = "('provisioning', 'ready', 'failed')";

/**
 * A condition on a lease's `workspace_id`, true when a released lease on that
 * workspace means nothing and is deleted rather than kept:
 *
 * - on a primary, because the sweep never deletes a primary;
 * - on a workspace that is gone, because there is nothing left to keep.
 *
 * Only an active lease matters on such a workspace: the credential rule
 * reads it, and `Workspace.sessionIds` lists it. Deleting the rest keeps the
 * table from growing with every session and run that ever ended.
 */
const NO_RETENTION_CLAUSE =
  "workspace_id IN (SELECT id FROM workspaces " +
  "WHERE kind = 'primary' OR status IN ('deleted', 'lost'))";

/**
 * The statuses in which a primary blocks another primary of the same repo on
 * the same runner. A primary that failed to provision holds nothing, so it
 * does not block a new one.
 */
const PRIMARY_STANDING = "('provisioning', 'ready')";

interface WorkspaceRow {
  readonly id: Uint8Array;
  readonly runner_id: Uint8Array;
  readonly kind: string;
  readonly status: string;
  readonly designated_connection_id: Uint8Array | null;
  readonly message: string | null;
  readonly created_at: string;
  readonly provisioned_at: string | null;
  readonly last_used_at: string | null;
  readonly disposed_at: string | null;
}

interface CheckoutRow {
  readonly id: Uint8Array;
  readonly workspace_id: Uint8Array;
  readonly resource_id: Uint8Array;
  readonly form: string;
  readonly subdirectory: string | null;
  readonly branch: string | null;
  readonly branches: string;
  readonly default_branch: string | null;
  readonly base_branch: string | null;
}

const COLUMNS =
  "id, runner_id, kind, status, designated_connection_id, message, created_at, " +
  "provisioned_at, last_used_at, disposed_at";

/** The same columns, for the one query that joins the checkouts table. */
const WORKSPACE_COLUMNS = COLUMNS.split(", ")
  .map((column) => `w.${column}`)
  .join(", ");

const CHECKOUT_COLUMNS =
  "id, workspace_id, resource_id, form, subdirectory, branch, branches, default_branch, base_branch";

const toWorkspace = (row: WorkspaceRow): StoredWorkspace => ({
  id: uuidToString(row.id),
  runnerId: uuidToString(row.runner_id),
  kind: row.kind as WorkspaceKind,
  status: row.status as WorkspaceStatus,
  designatedConnectionId:
    row.designated_connection_id === null ? null : uuidToString(row.designated_connection_id),
  message: row.message,
  createdAt: row.created_at,
  provisionedAt: row.provisioned_at,
  lastUsedAt: row.last_used_at,
  disposedAt: row.disposed_at,
});

const toCheckout = (row: CheckoutRow): StoredCheckout => ({
  id: uuidToString(row.id),
  workspaceId: uuidToString(row.workspace_id),
  resourceId: uuidToString(row.resource_id),
  form: row.form as CheckoutForm,
  subdirectory: row.subdirectory,
  branch: row.branch,
  branches: JSON.parse(row.branches) as ReadonlyArray<string>,
  defaultBranch: row.default_branch,
  baseBranch: row.base_branch,
});

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "workspace.query",
  sort: [{ field: "createdAt", direction }],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const one = (id: string): Effect.Effect<Option.Option<StoredWorkspace>, SqlError> =>
    Effect.map(
      sql<WorkspaceRow>`SELECT ${sql.literal(COLUMNS)} FROM workspaces
                        WHERE id = ${uuidFromString(id)}`,
      (rows) => Option.map(Option.fromNullishOr(rows[0]), toWorkspace),
    );

  const listCheckouts = (
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<StoredCheckout>>, SqlError> =>
    ids.length === 0
      ? Effect.succeed(new Map())
      : Effect.map(
          sql<CheckoutRow>`
            SELECT ${sql.literal(CHECKOUT_COLUMNS)} FROM checkouts
            WHERE workspace_id IN ${sql.in(ids.map(uuidFromString))}
            ORDER BY position
          `,
          (rows) => {
            const found = new Map<string, Array<StoredCheckout>>();
            for (const row of rows) {
              const checkout = toCheckout(row);
              const list = found.get(checkout.workspaceId) ?? [];
              list.push(checkout);
              found.set(checkout.workspaceId, list);
            }
            return found;
          },
        );

  return {
    one,
    listCheckouts,

    /** Records the first creation instruction and returns the instruction that won the write. */
    freezeProvisionFrame: (
      id: string,
      frame: WorkspaceProvision,
    ): Effect.Effect<WorkspaceProvision, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly provision_frame: string }>`
          UPDATE workspaces SET provision_frame = COALESCE(provision_frame, ${JSON.stringify(frame)})
          WHERE id = ${uuidFromString(id)} RETURNING provision_frame
        `;
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceProvision))(
          rows[0]?.provision_frame,
        ).pipe(Effect.orDie);
      }),

    /** Returns the frozen creation instruction, or none for a legacy workspace. */
    readProvisionFrame: (id: string): Effect.Effect<Option.Option<WorkspaceProvision>, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly provision_frame: string | null }>`
          SELECT provision_frame FROM workspaces WHERE id = ${uuidFromString(id)}
        `;
        const frame = rows[0]?.provision_frame;
        if (frame === undefined || frame === null) return Option.none();
        return Option.some(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceProvision))(frame).pipe(
            Effect.orDie,
          ),
        );
      }),

    insert: (workspace: {
      readonly runnerId: string;
      readonly kind: WorkspaceKind;
      readonly designatedConnectionId: string | null;
      readonly at: string;
    }): Effect.Effect<StoredWorkspace, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO workspaces (id, runner_id, kind, status, designated_connection_id,
                                  created_at, last_used_at)
          VALUES (${id}, ${uuidFromString(workspace.runnerId)}, ${workspace.kind},
                  'provisioning',
                  ${
                    workspace.designatedConnectionId === null
                      ? null
                      : uuidFromString(workspace.designatedConnectionId)
                  },
                  ${workspace.at}, ${workspace.at})
        `;
        return {
          id: uuidToString(id),
          runnerId: workspace.runnerId,
          kind: workspace.kind,
          status: "provisioning",
          designatedConnectionId: workspace.designatedConnectionId,
          message: null,
          createdAt: workspace.at,
          provisionedAt: null,
          lastUsedAt: workspace.at,
          disposedAt: null,
        };
      }),

    /** Writes the checkouts of a new workspace, in the order they were asked for. */
    insertCheckouts: (
      workspaceId: string,
      checkouts: ReadonlyArray<NewCheckout>,
      at: string,
    ): Effect.Effect<ReadonlyArray<StoredCheckout>, SqlError> =>
      Effect.forEach(checkouts, (checkout, position) =>
        Effect.gen(function* () {
          const id = mintUuid();
          yield* sql`
            INSERT INTO checkouts (id, workspace_id, resource_id, form, subdirectory, branch,
                                   base_branch, branches, default_branch, position, created_at)
            VALUES (${id}, ${uuidFromString(workspaceId)}, ${uuidFromString(checkout.resourceId)},
                    ${checkout.form}, ${checkout.subdirectory}, ${checkout.branch},
                    ${checkout.baseBranch}, '[]', NULL, ${position}, ${at})
          `;
          return {
            id: uuidToString(id),
            workspaceId,
            resourceId: checkout.resourceId,
            form: checkout.form,
            subdirectory: checkout.subdirectory,
            branch: checkout.branch,
            branches: [],
            defaultBranch: null,
            baseBranch: checkout.baseBranch,
          } satisfies StoredCheckout;
        }),
      ),

    /**
     * Returns the primary of this resource on this runner that is ready or
     * still provisioning, or `none`. A second primary conflicts with this one,
     * and a thread that asks for the main workspace is given this one.
     */
    primaryOn: (
      resourceId: string,
      runnerId: string,
    ): Effect.Effect<Option.Option<StoredWorkspace>, SqlError> =>
      Effect.map(
        sql<WorkspaceRow>`
          SELECT ${sql.literal(WORKSPACE_COLUMNS)}
          FROM workspaces w JOIN checkouts c ON c.workspace_id = w.id
          WHERE w.runner_id = ${uuidFromString(runnerId)} AND w.kind = 'primary'
            AND c.resource_id = ${uuidFromString(resourceId)}
            AND w.status IN ${sql.literal(PRIMARY_STANDING)}
          LIMIT 1
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toWorkspace),
      ),

    /** Returns the ids of the runners that hold a ready primary of this resource. */
    listRunnersWithReadyPrimary: (
      resourceId: string,
    ): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(
        sql<{ readonly runner_id: Uint8Array }>`
          SELECT w.runner_id
          FROM workspaces w JOIN checkouts c ON c.workspace_id = w.id
          WHERE w.kind = 'primary' AND w.status = 'ready'
            AND c.resource_id = ${uuidFromString(resourceId)}
        `,
        (rows) => new Set(rows.map((row) => uuidToString(row.runner_id))),
      ),

    /** Returns every workspace this runner was asked to provision and has not yet reported on. */
    provisioningOn: (runnerId: string): Effect.Effect<ReadonlyArray<StoredWorkspace>, SqlError> =>
      Effect.map(
        sql<WorkspaceRow>`
          SELECT ${sql.literal(COLUMNS)} FROM workspaces
          WHERE runner_id = ${uuidFromString(runnerId)} AND status = 'provisioning'
          ORDER BY created_at
        `,
        (rows) => rows.map(toWorkspace),
      ),

    /**
     * Marks a failed primary of this resource as `deleted`, so a new one can
     * replace it. The row is kept as a record of the attempt and of what the
     * runner reported about it.
     */
    supersedeFailedPrimary: (
      resourceId: string,
      runnerId: string,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE workspaces SET status = 'deleted', disposed_at = ${at}
        WHERE runner_id = ${uuidFromString(runnerId)} AND kind = 'primary' AND status = 'failed'
          AND id IN (SELECT workspace_id FROM checkouts
                     WHERE resource_id = ${uuidFromString(resourceId)})
      `),

    /**
     * Records the runner's report that a workspace is ready, with the state of
     * its checkouts. Returns whether the status changed.
     *
     * The status and the checkouts are written separately, because the runner
     * sends this report more than once:
     *
     * - The status changes only from `provisioning` to `ready`, and the return
     *   value reports that change. The change releases the sessions waiting on
     *   the workspace, and a second report must not release them twice.
     * - The checkouts are written whenever the workspace is `ready`, whether
     *   the status changed or not. A primary is reported again after every
     *   session that ran in it, and that report is the only way the branch
     *   listing learns which branch the agent left it on.
     * - A workspace that is `deleted`, `lost` or `failed` gets neither: its
     *   directory is gone or was never created, so there are no branches to
     *   record.
     */
    markReady: (
      id: string,
      checkouts: ReadonlyArray<CheckoutState>,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        // `last_used_at` is left alone: it tracks work done in the workspace,
        // which is a session starting or ending, not the runner reporting.
        const moved = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE workspaces SET status = 'ready', provisioned_at = ${at}, message = NULL
          WHERE id = ${uuidFromString(id)} AND status = 'provisioning'
          RETURNING id
        `;
        yield* Effect.forEach(
          checkouts,
          (checkout) =>
            sql`
              UPDATE checkouts SET branch = ${checkout.branch},
                                   branches = ${JSON.stringify(checkout.branches)},
                                   default_branch = ${checkout.defaultBranch}
              WHERE id = ${uuidFromString(checkout.checkoutId)}
                AND workspace_id = ${uuidFromString(id)}
                AND EXISTS (SELECT 1 FROM workspaces w
                            WHERE w.id = ${uuidFromString(id)} AND w.status = 'ready')
            `,
          { discard: true },
        );
        return moved.length > 0;
      }),

    /**
     * Marks a provisioning workspace as `failed`, and returns whether the
     * status changed. A report that arrives twice, or that is about a
     * workspace that became ready in the meantime, changes nothing, and the
     * caller must then do nothing either.
     */
    markFailed: (
      id: string,
      message: string | null,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE workspaces SET status = 'failed', message = ${message}, last_used_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status = 'provisioning'
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Marks a live workspace as `deleted`, deletes the released leases on
     * it, and returns whether the status changed, for the same reason as
     * `markFailed`.
     */
    markDisposed: (id: string, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const moved = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE workspaces SET status = 'deleted', disposed_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status IN ${sql.literal(LIVE_STATUSES)}
          RETURNING id
        `;
        // A gone workspace keeps nothing; see `NO_RETENTION_CLAUSE`.
        yield* sql`
          DELETE FROM workspace_leases
          WHERE workspace_id = ${uuidFromString(id)} AND released_at IS NOT NULL
        `;
        return moved.length > 0;
      }),

    /**
     * Marks every live workspace on a retired runner as `lost`, because they
     * are gone with it, and deletes the released leases on them.
     */
    lostOnRunner: (runnerId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE workspaces SET status = 'lost', disposed_at = ${at}
          WHERE runner_id = ${uuidFromString(runnerId)}
            AND status IN ${sql.literal(LIVE_STATUSES)}
        `;
        // Every workspace on the runner is gone now, and a gone workspace
        // keeps nothing; see `NO_RETENTION_CLAUSE`.
        yield* sql`
          DELETE FROM workspace_leases
          WHERE released_at IS NOT NULL
            AND workspace_id IN (SELECT id FROM workspaces
                                 WHERE runner_id = ${uuidFromString(runnerId)})
        `;
      }),

    /** Marks a workspace as used just now. Only the API shows this time; the sweep reads leases. */
    touched: (workspaceId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE workspaces SET last_used_at = ${at} WHERE id = ${uuidFromString(workspaceId)}
      `),

    /**
     * Makes this holder's lease on the workspace active, as of `at`. Creates
     * the lease if the holder has none on the workspace yet. Otherwise it
     * clears the release of the lease the holder has, which is what resuming
     * a session does.
     */
    acquireLease: (
      workspaceId: string,
      holder: WorkspaceHolder,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at)
        VALUES (${uuidFromString(workspaceId)}, ${holder.kind}, ${uuidFromString(holder.id)},
                ${at})
        ON CONFLICT (workspace_id, holder_kind, holder_id) DO UPDATE
        SET acquired_at = excluded.acquired_at, released_at = NULL, retention = NULL,
            kept_until = NULL
      `),

    /**
     * Releases every lease this holder has, with this retention, and stamps
     * each lease's kept-until time: its release time plus `windowMs`.
     *
     * - An active lease is released as of `at`.
     * - A lease that is already released keeps its release time. Only its
     *   retention and kept-until time are written again.
     * - A holder with no lease is left alone.
     * - A lease on a primary, or on a workspace that is gone, is deleted
     *   instead, because nothing reads a released lease there; see
     *   `NO_RETENTION_CLAUSE`. Resuming the session inserts it again.
     *
     * The time is computed in SQL, because each lease adds the window to its
     * own release time. The format is the ISO 8601 form `nowIso` writes, so a
     * kept-until time compares correctly with every other timestamp as text.
     */
    releaseLeases: (
      holder: WorkspaceHolder,
      retention: Retention,
      windowMs: number,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM workspace_leases
          WHERE holder_kind = ${holder.kind} AND holder_id = ${uuidFromString(holder.id)}
            AND ${sql.literal(NO_RETENTION_CLAUSE)}
        `;
        yield* sql`
          UPDATE workspace_leases
          SET released_at = COALESCE(released_at, ${at}),
              retention = ${retention},
              kept_until = strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(released_at, ${at}),
                                    ${`+${String(windowMs / 1000)} seconds`})
          WHERE holder_kind = ${holder.kind} AND holder_id = ${uuidFromString(holder.id)}
        `;
      }),

    /** Returns the holders of the active leases on each of these workspaces, oldest first. */
    listActiveHolders: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<WorkspaceHolder>>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{
              readonly workspace_id: Uint8Array;
              readonly holder_kind: WorkspaceHolder["kind"];
              readonly holder_id: Uint8Array;
            }>`
              SELECT workspace_id, holder_kind, holder_id FROM workspace_leases
              WHERE workspace_id IN ${sql.in(ids.map(uuidFromString))}
                AND released_at IS NULL
              ORDER BY acquired_at, holder_id
            `,
            (rows) => {
              const found = new Map<string, Array<WorkspaceHolder>>();
              for (const row of rows) {
                const key = uuidToString(row.workspace_id);
                const list = found.get(key) ?? [];
                list.push({ kind: row.holder_kind, id: uuidToString(row.holder_id) });
                found.set(key, list);
              }
              return found;
            },
          ),

    /**
     * Returns, for each of these workspaces whose leases are all released,
     * the latest kept-until time among them. A workspace with an active
     * lease, or with no lease, is left out of the map.
     */
    listKeptUntil: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly workspace_id: Uint8Array; readonly kept_until: string }>`
              SELECT workspace_id, MAX(kept_until) AS kept_until FROM workspace_leases
              WHERE workspace_id IN ${sql.in(ids.map(uuidFromString))}
              GROUP BY workspace_id
              HAVING COUNT(released_at) = COUNT(*)
            `,
            (rows) => new Map(rows.map((row) => [uuidToString(row.workspace_id), row.kept_until])),
          ),

    /**
     * Returns the lease that kept this workspace longest, if every lease on
     * it is released and the latest kept-until time is before `now`. Returns
     * `none` while a lease is active, while a lease still keeps the
     * workspace, and when there is no lease at all.
     */
    findExpiredLease: (
      workspaceId: string,
      now: string,
    ): Effect.Effect<Option.Option<ExpiredLease>, SqlError> =>
      Effect.map(
        sql<{
          readonly retention: Retention;
          readonly holder_kind: WorkspaceHolder["kind"];
          readonly holder_id: Uint8Array;
        }>`
          SELECT retention, holder_kind, holder_id FROM (
            SELECT retention, holder_kind, holder_id, kept_until FROM workspace_leases
            WHERE workspace_id = ${uuidFromString(workspaceId)}
              AND NOT EXISTS (SELECT 1 FROM workspace_leases a
                              WHERE a.workspace_id = ${uuidFromString(workspaceId)}
                                AND a.released_at IS NULL)
            ORDER BY kept_until DESC
            LIMIT 1
          )
          WHERE kept_until < ${now}
        `,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row) => ({
            retention: row.retention,
            holder: { kind: row.holder_kind, id: uuidToString(row.holder_id) },
          })),
      ),

    /**
     * Returns the ids of the ephemeral workspaces the sweep may delete at
     * `now`. That is each one that:
     *
     * - still has files on its runner: it is `ready`, or `failed`, whose
     *   files may be on disk;
     * - is on a runner that is online to receive the dispose frame;
     * - has no active lease;
     * - has a latest kept-until time before `now`.
     *
     * A workspace with no lease at all is never returned, because the inner
     * join leaves it out. Every workspace gets its first lease in the
     * transaction that opens it, so a workspace without one is a mistake, and
     * keeping its files is the safe way to be wrong.
     */
    listSweepCandidates: (now: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT w.id
          FROM workspaces w JOIN runners r ON r.id = w.runner_id
            JOIN workspace_leases l ON l.workspace_id = w.id
          WHERE w.kind = 'ephemeral' AND w.status IN ('ready', 'failed')
            AND ${sql.literal(buildOnlineClause("r"))}
          GROUP BY w.id
          HAVING COUNT(l.released_at) = COUNT(*) AND MAX(l.kept_until) < ${now}
        `,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),

    list: (
      request: WorkspacePageRequest,
    ): Effect.Effect<Page<StoredWorkspace>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "created_at", direction: request.direction }],
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const clauses = [keyset];
        if (request.runnerId !== undefined) {
          clauses.push(sql`runner_id = ${uuidFromString(request.runnerId)}`);
        }
        if (request.kind !== undefined) clauses.push(sql`kind = ${request.kind}`);
        if (request.status !== undefined) clauses.push(sql`status = ${request.status}`);
        if (request.resourceId !== undefined) {
          clauses.push(sql`id IN (SELECT workspace_id FROM checkouts
                                  WHERE resource_id = ${uuidFromString(request.resourceId)})`);
        }
        if (request.projectId !== undefined) {
          clauses.push(sql`id IN (SELECT c.workspace_id FROM checkouts c
                                  JOIN project_resources p ON p.resource_id = c.resource_id
                                  WHERE p.project_id = ${uuidFromString(request.projectId)})`);
        }
        const rows = yield* sql<WorkspaceRow>`
          SELECT ${sql.literal(COLUMNS)} FROM workspaces
          WHERE ${sql.and(clauses)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toWorkspace)),
          (last) => encodeCursor(scope, [last.createdAt], last.id),
        );
      }),
  };
});

/** Everything the workspace service reads and writes. */
export const workspaceRepository = make;
