/**
 * Workspace rows and the checkouts inside them. Nothing here decides policy:
 * what may be provisioned, what may be torn down and what has expired are the
 * service's.
 *
 * What is asked of the sessions table from here - which sessions are living in
 * a workspace, and which could still be picked up in one - are facts about the
 * workspace: they are what the sweep decides on. Nothing else about a session is
 * read, and this domain imports nothing from that one.
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
import { onlineWhere } from "../runners";
import {
  decodeCursor,
  encodeCursor,
  keysetOver,
  mintUuid,
  pageOf,
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
  /** The Connection the work in it acts through, settled when it was opened. */
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

/** One working copy to write beside a new workspace. */
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

/** What one checkout turned out to be, as the machine reported it. */
export interface CheckoutState {
  readonly checkoutId: string;
  /** What the machine said is checked out; null where it could not read one. */
  readonly branch: string | null;
  readonly branches: ReadonlyArray<string>;
  readonly defaultBranch: string | null;
}

/**
 * One ephemeral workspace the sweep is looking at: how many sessions are living
 * in it, how many could still be resumed into it, and when it was last used.
 */
export interface SweepCandidate {
  readonly id: string;
  readonly runnerId: string;
  readonly liveSessions: number;
  readonly resumableSessions: number;
  readonly usedAt: string;
}

/**
 * Whether the working area a session row names is one it can be placed into, as
 * one SQL expression over a row of `sessions` under the alias given. A session
 * with no workspace at all is placed anywhere; one whose workspace is still
 * being made, or is gone, is not.
 *
 * Exported because the sessions domain asks it twice - a queued session waits
 * for it before it is dispatched, and an exited one cannot be resumed without it
 * - and three spellings of "the workspace stands" would be three answers.
 */
export const readyWhere = (alias: string): string =>
  `(${alias}.workspace_id IS NULL OR EXISTS (SELECT 1 FROM workspaces ` +
  `WHERE workspaces.id = ${alias}.workspace_id AND workspaces.status = 'ready'))`;

/**
 * Whether a session can be picked up again, as one SQL expression over a row of
 * `sessions` under the alias given. Three things have to hold: the process is
 * gone, the provider-native transcript is still there, and the machine and the
 * working area it was in are both still there to open it in.
 *
 * It lives here rather than in the sessions domain because the sweep below is
 * written in it - a thread that can still be picked up keeps its worktree, so
 * its workspace expires on the long window rather than the short one - and the
 * sessions listing reads the same one to answer `resumable`. One owner, and the
 * only owner both can import without the two domains importing each other.
 */
export const resumableWhere = (alias: string): string =>
  `${alias}.status = 'exited' AND ${alias}.native_session_id IS NOT NULL ` +
  `AND EXISTS (SELECT 1 FROM runners WHERE runners.id = ${alias}.runner_id ` +
  `AND runners.lifecycle <> 'retired') ` +
  `AND ${readyWhere(alias)}`;

/** The statuses a workspace can still leave: everything else is where it ends. */
const LIVE_STATUSES = "('provisioning', 'ready', 'failed')";

/**
 * What makes a repo's checkout on a machine taken. A primary that could not be
 * made holds nothing, so it does not stand in the way of making another.
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

const scopeOf = (direction: SortDirection): CursorScope => ({
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

  const checkoutsOf = (
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
    checkoutsOf,

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
     * The primary of this resource on this machine that is standing or on its
     * way: what makes a second one a conflict, and what a thread asking for the
     * main workspace is given.
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

    /** Every workspace this machine has been asked for and not yet reported on. */
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
     * Stands a failed primary of this resource down, so a fresh one can be made
     * in its place. The row stays, `deleted`: what was attempted and what the
     * machine said about it is a record, not a workspace.
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
     * The machine's report: the workspace stands, and this is what is in it.
     *
     * Two separate things, because the machine says this more than once. The
     * status moves only out of `provisioning`, and that transition is what the
     * answer reports - it is what releases the sessions waiting on the
     * workspace, and a second report must not release them twice. The checkouts
     * are written whenever the workspace is `ready`, transition or not: a
     * primary is re-reported after every session that ran in it, and that report
     * is the only thing that tells the branch listing what the agent left it on.
     * A workspace that is `deleted`, `lost` or `failed` takes neither: its
     * directory is gone or was never made, so there are no branches to record.
     */
    markReady: (
      id: string,
      checkouts: ReadonlyArray<CheckoutState>,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        // `last_used_at` is left alone: it counts work done in the workspace,
        // which is a session starting or ending, not the machine reporting.
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
     * Answers whether it moved the workspace. A report that arrives twice, or
     * about a workspace that came up in the meantime, moves nothing - and
     * nothing must follow from it either.
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

    /** Answers whether it moved the workspace, for the same reason as above. */
    markDisposed: (id: string, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE workspaces SET status = 'deleted', disposed_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status IN ${sql.literal(LIVE_STATUSES)}
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /** Everything on a retired machine is gone with it, whatever it held. */
    lostOnRunner: (runnerId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE workspaces SET status = 'lost', disposed_at = ${at}
        WHERE runner_id = ${uuidFromString(runnerId)}
          AND status IN ${sql.literal(LIVE_STATUSES)}
      `),

    /** Marks a workspace as worked in just now, which is what keeps it alive. */
    touched: (workspaceId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE workspaces SET last_used_at = ${at} WHERE id = ${uuidFromString(workspaceId)}
      `),

    /**
     * Every ephemeral workspace the sweep could act on: one that stands, on a
     * machine that is there to be told. What each is worth keeping is the
     * service's to decide from the counts.
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
                  AND ${sql.literal(resumableWhere("s"))}) AS resumable,
                 COALESCE(w.last_used_at, w.created_at) AS used_at
          FROM workspaces w JOIN runners r ON r.id = w.runner_id
          WHERE w.kind = 'ephemeral' AND w.status = 'ready'
            AND ${sql.literal(onlineWhere("r"))}
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
        const scope = scopeOf(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = keysetOver(
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
        return yield* pageOf(
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
