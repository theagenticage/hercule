/**
 * Entity Links: finds the outside thing, such as a pull request, that belongs
 * to a Task because it is the Task's branch, and links it. It also tells a
 * plugin which branches to look up pull requests for.
 *
 * Hercule knows the branch each checkout of a Thread or a run is on. An
 * External Entity records the `(remote, branch)` its work comes from. When the
 * two are the same, the entity is the Task's. This is not the branch-name match
 * of ADR 0046: it reads the branch the checkout really has, and compares the
 * remote as well as the name.
 *
 * It lives in the controller daemon because it joins the workspaces, sessions,
 * Tasks and External Entities domains, and reads their tables in one
 * statement each. It writes only through `TaskService.linkMatchedEntities`,
 * which owns the rules of linking.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";
import type { NotFound, Validation } from "@hercule/contract";
import type { TrackedBranch } from "@hercule/plugin-host";
import { nowIso, uuidFromString, uuidToString, withTransaction } from "../../db";
import { LIVE_TASK_SQL, TaskService, type EntityLinkPair } from "../../tasks";

/**
 * Builds a `SELECT` that lists the Tasks that work on each branch, one row for
 * each distinct `(remote, branch, Task)`: `remote`, `branch`, `task_id` and
 * `since`, the creation time of the oldest workspace of the Task on the branch.
 * `alsoRequire` is a condition on the checkout `c` and its Resource `r` that a
 * row must meet too.
 *
 * A Task works on a branch when a session of the Task runs in an ephemeral
 * workspace with a checkout on it. The checkout's remote is the canonical
 * remote of its Resource. Left out:
 *
 * - workspaces of kind `primary`, because the branch of a main workspace says
 *   nothing about one Task;
 * - a checkout on its default branch, or on no branch;
 * - a Task that is not live (`LIVE_TASK_SQL`).
 *
 * Several sessions of one Task in one workspace are one row. The workspace's
 * status is not read, on purpose. A workspace that was swept away while its
 * Task is still live still says which branch the Task worked on, and the pull
 * request may be opened or merged after that. The cost does not grow with
 * history either, because the statement starts from live Tasks and reaches
 * only their sessions.
 *
 * The joins are written `CROSS JOIN` so that SQLite reads the live Tasks
 * first, then their sessions by `sessions_task_id`, and then the workspace and
 * its checkouts by key. Left to itself, SQLite has no statistics and reads
 * every session that has a workspace, which grows with all the work ever done.
 */
const buildTasksOnBranches = (
  sql: SqlClient.SqlClient,
  alsoRequire: Statement.Fragment,
): Statement.Fragment => sql`
  SELECT r.canonical_remote AS remote, c.branch AS branch, s.task_id AS task_id,
         MIN(w.created_at) AS since
  FROM tasks
  CROSS JOIN sessions s ON s.task_id = tasks.id
  CROSS JOIN workspaces w ON w.id = s.workspace_id
  CROSS JOIN checkouts c ON c.workspace_id = w.id
  CROSS JOIN resources r ON r.id = c.resource_id
  WHERE ${sql.literal(LIVE_TASK_SQL)}
    AND w.kind = 'ephemeral'
    AND r.canonical_remote IS NOT NULL
    AND c.branch IS NOT NULL
    AND c.branch IS NOT c.default_branch
    AND ${alsoRequire}
  GROUP BY r.canonical_remote, c.branch, s.task_id`;

/** One row of the match: a Task and an entity on its branch, and how many Tasks share the branch. */
interface BranchMatchRow {
  readonly task_id: Uint8Array;
  readonly ref: string;
  readonly remote: string;
  readonly branch: string;
  readonly task_count: number;
}

/** A branch that two or more live Tasks work on, so no entity on it is linked to any of them. */
interface SharedBranch {
  readonly remote: string;
  readonly branch: string;
  readonly taskCount: number;
}

/**
 * Builds the statement that matches entities to Tasks by branch: one row for
 * each live Task that works on a branch and each entity whose
 * `repository.head` is that `(remote, branch)`, as `task_id`, `ref`, `remote`,
 * `branch` and `task_count`, the number of live Tasks on the branch.
 *
 * The Tasks on each branch are counted before the rest is filtered, so a Task
 * that unlinked the entity still counts. Left out afterwards: a pair the user
 * unlinked and a pair that is linked already.
 *
 * A pull request that is not open matches only if its last change at the
 * source is not older than the Task's workspace. Branch names get reused
 * (`fix-typo`), and without this an old merged or closed pull request on a
 * reused name would be linked to a new Task and land its card. An open pull
 * request always matches, and so does a record with no lifecycle.
 *
 * The join on the head looks each branch up in the index
 * `external_entities_head`. That needs two things. The JSON expressions are
 * written as the migration wrote them. And the branch columns carry a unary
 * plus: they have TEXT affinity and the expressions have none, so without the
 * plus SQLite converts the expression side of the comparison, cannot use the
 * index, and reads every entity with a head.
 */
export const buildBranchMatch = (sql: SqlClient.SqlClient) => sql<BranchMatchRow>`
  WITH tasks_on_branches AS MATERIALIZED (
    SELECT remote, branch, task_id, since,
           COUNT(*) OVER (PARTITION BY remote, branch) AS task_count
    FROM (${buildTasksOnBranches(sql, sql`1`)})
  )
  SELECT t.task_id, e.ref, t.remote, t.branch, t.task_count
  FROM tasks_on_branches t
  JOIN external_entities e
    ON json_extract(e.repository, '$.head.remote') = +t.remote
   AND json_extract(e.repository, '$.head.branch') = +t.branch
  WHERE (e.lifecycle IS NULL OR e.lifecycle = 'open' OR e.source_updated_at >= t.since)
    AND NOT EXISTS (
      SELECT 1 FROM task_entity_link_suppressions x
      WHERE x.task_id = t.task_id AND x.ref = e.ref)
    AND NOT EXISTS (
      SELECT 1 FROM task_entity_links l
      WHERE l.task_id = t.task_id AND l.ref = e.ref)`;

/**
 * Splits the rows of the match into the pairs to link and the branches that
 * too many Tasks share. A branch with exactly one Task gives its pairs. A
 * branch with more gives none and is reported once, however many entities sit
 * on it.
 */
const decideBranchLinks = (
  rows: ReadonlyArray<BranchMatchRow>,
): {
  readonly pairs: ReadonlyArray<EntityLinkPair>;
  readonly shared: ReadonlyArray<SharedBranch>;
} => {
  const pairs: Array<EntityLinkPair> = [];
  const shared = new Map<string, SharedBranch>();
  for (const row of rows) {
    if (row.task_count === 1) {
      pairs.push({ taskId: uuidToString(row.task_id), ref: row.ref });
    } else {
      shared.set(`${row.remote}\n${row.branch}`, {
        remote: row.remote,
        branch: row.branch,
        taskCount: row.task_count,
      });
    }
  }
  return {
    pairs,
    shared: [...shared.values()].toSorted((left, right) =>
      `${left.remote}#${left.branch}`.localeCompare(`${right.remote}#${right.branch}`),
    ),
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const taskService = yield* TaskService;
  // The shared branches the last run reported, so a branch that stays shared is
  // reported once and not at every scan.
  const reportedSharedBranches = yield* Ref.make<ReadonlySet<string>>(new Set());

  /**
   * Logs each branch that is shared now and was not at the last run, and
   * remembers the shared branches for the next run.
   */
  const reportSharedBranches = (shared: ReadonlyArray<SharedBranch>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const previous = yield* Ref.getAndSet(
        reportedSharedBranches,
        new Set(shared.map(({ remote, branch }) => `${remote}\n${branch}`)),
      );
      for (const { remote, branch, taskCount } of shared) {
        if (previous.has(`${remote}\n${branch}`)) continue;
        yield* Effect.logInfo(
          `${String(taskCount)} live Tasks work on the branch ${branch} of ${remote}, so nothing on that branch was linked to any of them. Link it by hand to the Task it belongs to.`,
        );
      }
    });

  return {
    /**
     * Links the entities whose `repository.head` is the branch of a Task's
     * checkout, and returns the pairs it linked. When nothing is to be linked
     * it costs one statement.
     *
     * The match is the entities whose head is `(remote, branch)` of a branch
     * that exactly one live Task works on (see `buildTasksOnBranches`).
     * The Tasks on each branch are counted before the rest is filtered, so a
     * Task that unlinked the entity still counts: otherwise the other Task
     * would look alone on the branch and be given the link. A pair the user
     * unlinked, and a pair that is linked already, are left out. A fork's
     * entity has a head on another remote, so it matches no checkout.
     *
     * Runs after a commit and waits on nothing outside the database. Call it
     * after a scan or a refresh that wrote entities with a head, and after a
     * checkout's branch changed.
     */
    linkEntitiesByBranch: (): Effect.Effect<
      ReadonlyArray<EntityLinkPair>,
      SqlError | NotFound | Validation
    > =>
      Effect.gen(function* () {
        const rows = yield* buildBranchMatch(sql);
        const { pairs, shared } = decideBranchLinks(rows);
        yield* reportSharedBranches(shared);
        return yield* taskService.linkMatchedEntities(pairs);
      }),

    /**
     * Returns the branches the Connection should look up pull requests for,
     * at most `limit`, on remotes that start with `remotePrefix`, and marks
     * them as tried.
     *
     * A branch is listed when a live Task has a checkout of an ephemeral
     * workspace on it, the branch is not the checkout's default branch, it is
     * among the checkout's remote branches, and that Task does not link an
     * entity whose head is exactly this `(remote, branch)`. A Task that links
     * something else, or whose pull request the user unlinked, still lists its
     * branch. A branch that several Tasks track is returned once.
     *
     * The order is the branches never tried first, then the one tried longest
     * ago, so every branch gets its turn however many there are. The turn is
     * kept in `tracked_branch_attempts`, written before the caller reads
     * anything, so a read that fails still moves the rotation on. Rows for
     * branches that are not listed any more are deleted.
     */
    listTrackedBranches: (input: {
      readonly connectionId: string;
      readonly remotePrefix: string;
      readonly limit: number;
    }): Effect.Effect<ReadonlyArray<TrackedBranch>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const connection = uuidFromString(input.connectionId);
          const now = yield* nowIso;
          // SQLite reads a negative LIMIT as no limit at all.
          const limit = Math.max(Math.floor(input.limit), 0);
          const prefixLength = input.remotePrefix.length;
          const branchesToLookUp = sql`
            SELECT t.remote AS remote, t.branch AS branch
            FROM (${buildTasksOnBranches(
              sql,
              sql`substr(r.canonical_remote, 1, ${prefixLength}) = ${input.remotePrefix}
                AND EXISTS (SELECT 1 FROM json_each(c.remote_branches) WHERE value = c.branch)`,
            )}) t
            WHERE NOT EXISTS (
              SELECT 1 FROM task_entity_links l
              JOIN external_entities e ON e.ref = l.ref
              WHERE l.task_id = t.task_id
                AND json_extract(e.repository, '$.head.remote') = t.remote
                AND json_extract(e.repository, '$.head.branch') = t.branch)
            GROUP BY t.remote, t.branch`;
          yield* sql`
            WITH branches AS MATERIALIZED (${branchesToLookUp})
            DELETE FROM tracked_branch_attempts
            WHERE connection_id = ${connection}
              AND substr(remote, 1, ${prefixLength}) = ${input.remotePrefix}
              AND NOT EXISTS (
                SELECT 1 FROM branches b
                WHERE b.remote = tracked_branch_attempts.remote
                  AND b.branch = tracked_branch_attempts.branch)`;
          const branches = yield* sql<TrackedBranch>`
            WITH branches AS MATERIALIZED (${branchesToLookUp})
            SELECT b.remote, b.branch FROM branches b
            LEFT JOIN tracked_branch_attempts a
              ON a.connection_id = ${connection} AND a.remote = b.remote AND a.branch = b.branch
            ORDER BY a.last_attempted_at IS NOT NULL, a.last_attempted_at, b.remote, b.branch
            LIMIT ${limit}`;
          if (branches.length > 0) {
            yield* sql`
              INSERT INTO tracked_branch_attempts (connection_id, remote, branch, last_attempted_at)
              SELECT ${connection}, json_extract(value, '$.remote'), json_extract(value, '$.branch'), ${now}
              FROM json_each(${JSON.stringify(branches)}) WHERE true
              ON CONFLICT (connection_id, remote, branch) DO UPDATE SET
                last_attempted_at = excluded.last_attempted_at`;
          }
          return branches.map(({ remote, branch }) => ({ remote, branch }));
        }),
      ),
  };
});

/** Links entities to the Tasks whose branch they come from, and lists the branches a plugin should look up. */
export class EntityLinks extends Context.Service<EntityLinks, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/tasks/EntityLinks",
) {}

export const EntityLinksLayer: Layer.Layer<EntityLinks, never, SqlClient.SqlClient | TaskService> =
  Layer.effect(EntityLinks)(make);
