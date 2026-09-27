/**
 * Workspace rows and the checkouts inside them. Nothing here decides policy:
 * the service decides what may be provisioned, what may be torn down and what
 * has expired.
 *
 * This module reads the sessions table for two facts about a workspace: which
 * sessions are running in it, and which could still be resumed in it. The
 * sweep decides on those two facts. Nothing else about a session is read, and
 * this domain imports nothing from the sessions domain.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
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
}

/** One checkout to insert with a new workspace. */
export interface NewCheckout {
  readonly resourceId: string;
  readonly form: CheckoutForm;
  readonly subdirectory: string | null;
  readonly branch: string | null;
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

/**
 * One ephemeral workspace the sweep considers: how many sessions are running
 * in it, how many could still be resumed in it, and when it was last used.
 */
export interface SweepCandidate {
  readonly id: string;
  readonly runnerId: string;
  readonly liveSessions: number;
  readonly resumableSessions: number;
  readonly usedAt: string;
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

/**
 * Builds a SQL expression, over a row of `sessions` under the given alias,
 * that is true when the session can be resumed. All of these must hold:
 *
 * - the session has exited
 * - its provider-native transcript is known
 * - its runner is not retired
 * - its workspace is ready (see `buildReadyClause`)
 * - it answers no assistant's conversation, or that conversation still
 *   exists. A session whose conversation was deleted takes no input, so
 *   nothing can ever resume it.
 *
 * It lives here rather than in the sessions domain because the sweep below
 * uses it: a thread that can still be resumed keeps its worktree, so its
 * workspace expires on the long window rather than the short one. The sessions
 * repository uses the same expression, for example to compute `resumable`.
 * Here is the only place both domains can import it from without importing
 * each other.
 */
export const buildResumableClause = (alias: string): string =>
  `${alias}.status = 'exited' AND ${alias}.native_session_id IS NOT NULL ` +
  `AND EXISTS (SELECT 1 FROM runners WHERE runners.id = ${alias}.runner_id ` +
  `AND runners.lifecycle <> 'retired') ` +
  `AND ${buildReadyClause(alias)} ` +
  `AND (${alias}.conversation_id IS NULL OR EXISTS (SELECT 1 FROM conversations ` +
  `WHERE conversations.id = ${alias}.conversation_id))`;

/** The statuses a workspace can still leave. Every other status is final. */
const LIVE_STATUSES = "('provisioning', 'ready', 'failed')";

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
}

const COLUMNS =
  "id, runner_id, kind, status, designated_connection_id, message, created_at, " +
  "provisioned_at, last_used_at, disposed_at";

/** The same columns, for the one query that joins the checkouts table. */
const WORKSPACE_COLUMNS = COLUMNS.split(", ")
  .map((column) => `w.${column}`)
  .join(", ");

const CHECKOUT_COLUMNS =
  "id, workspace_id, resource_id, form, subdirectory, branch, branches, default_branch";

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
});

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "workspace.query",
  field: "createdAt",
  direction,
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

    /** The sessions in each of these workspaces that have not exited. */
    sessionIdsOf: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly id: Uint8Array; readonly workspace_id: Uint8Array }>`
              SELECT id, workspace_id FROM sessions
              WHERE workspace_id IN ${sql.in(ids.map(uuidFromString))} AND status <> 'exited'
              ORDER BY created_at, id
            `,
            (rows) => {
              const found = new Map<string, Array<string>>();
              for (const row of rows) {
                const key = uuidToString(row.workspace_id);
                const list = found.get(key) ?? [];
                list.push(uuidToString(row.id));
                found.set(key, list);
              }
              return found;
            },
          ),

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
                                   branches, default_branch, position, created_at)
            VALUES (${id}, ${uuidFromString(workspaceId)}, ${uuidFromString(checkout.resourceId)},
                    ${checkout.form}, ${checkout.subdirectory}, ${checkout.branch},
                    '[]', NULL, ${position}, ${at})
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
     * Marks a live workspace as `deleted`, and returns whether the status
     * changed, for the same reason as `markFailed`.
     */
    markDisposed: (id: string, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE workspaces SET status = 'deleted', disposed_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status IN ${sql.literal(LIVE_STATUSES)}
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /** Marks every live workspace on a retired runner as `lost`, because they are gone with it. */
    lostOnRunner: (runnerId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE workspaces SET status = 'lost', disposed_at = ${at}
        WHERE runner_id = ${uuidFromString(runnerId)}
          AND status IN ${sql.literal(LIVE_STATUSES)}
      `),

    /** Marks a workspace as used just now, which keeps the sweep from expiring it. */
    touched: (workspaceId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE workspaces SET last_used_at = ${at} WHERE id = ${uuidFromString(workspaceId)}
      `),

    /**
     * Returns every ephemeral workspace the sweep could act on: each one that
     * is ready, on a runner that is online to receive the dispose frame. The
     * service decides from the counts which ones to keep.
     */
    sweepCandidates: (): Effect.Effect<ReadonlyArray<SweepCandidate>, SqlError> =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly runner_id: Uint8Array;
          readonly live: number;
          readonly resumable: number;
          readonly used_at: string;
        }>`
          SELECT w.id, w.runner_id,
                 (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.id
                  AND s.status IN ('queued', 'starting', 'idle', 'busy')) AS live,
                 (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.id
                  AND ${sql.literal(buildResumableClause("s"))}) AS resumable,
                 COALESCE(w.last_used_at, w.created_at) AS used_at
          FROM workspaces w JOIN runners r ON r.id = w.runner_id
          WHERE w.kind = 'ephemeral' AND w.status = 'ready'
            AND ${sql.literal(buildOnlineClause("r"))}
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            runnerId: uuidToString(row.runner_id),
            liveSessions: row.live,
            resumableSessions: row.resumable,
            usedAt: row.used_at,
          })),
      ),

    list: (
      request: WorkspacePageRequest,
    ): Effect.Effect<Page<StoredWorkspace>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = buildKeyset(
          sql,
          ["created_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
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
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),
  };
});

/** Everything the workspace service reads and writes. */
export const workspaceRepository = make;
