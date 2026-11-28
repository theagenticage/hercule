/**
 * The rows behind blockers: `task_blockers`, one row for each "this Task waits
 * on that Task". The row is stored one way only (`task_id` waits on
 * `blocked_by_task_id`), and "blocks" is the same rows read from the other
 * end.
 *
 * The stored relation is always a DAG: the Task service checks, before every
 * write, that the write closes no loop. Every edge stays as history after its
 * blocker finishes, so the loop check reads all of them. Deleting a Task
 * removes its edges, and a merge moves them to the survivor, so no row ever
 * names a deleted or a merged Task.
 *
 * This module only reads and writes rows. The rules (who may write, the words
 * of a refusal, the events) live in the Task service.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";
import {
  FINISHED_STAGES,
  MAX_CARD_BLOCKERS,
  MAX_DETAIL_BLOCKERS,
  type TaskStage,
  type WorkCardBlocker,
} from "@hercule/contract";
import { uuidFromString, uuidToString } from "../db";
import { cutTextAtWord } from "../text";
import { buildLiveTaskCondition } from "./repository";

/**
 * The stages at which a blocker no longer blocks the Task that waits on it.
 * The edge stays, as history, but a card does not count it.
 */
const STAGES_THAT_STOP_BLOCKING: ReadonlyArray<TaskStage> = ["landed", ...FINISHED_STAGES];

const STOPS_BLOCKING_SQL = STAGES_THAT_STOP_BLOCKING.map((stage) => `'${stage}'`).join(", ");

/** What a card shows of the Tasks that still block it. */
export interface CardBlocking {
  /** At most `MAX_CARD_BLOCKERS` of them, in the order they were added. */
  readonly blockedBy: ReadonlyArray<WorkCardBlocker>;
  /** How many Tasks still block the card, which may be more than `blockedBy` lists. */
  readonly blockedByCount: number;
}

/** What a card shows when nothing blocks it. */
export const NOT_BLOCKED: CardBlocking = { blockedBy: [], blockedByCount: 0 };

/** What a pane shows of the blockers of a Task: every edge, whatever the stage of the other end. */
export interface DetailBlocking {
  /** The Tasks the Task waits on, at most `MAX_DETAIL_BLOCKERS`, in the order they were added. */
  readonly blockers: ReadonlyArray<WorkCardBlocker>;
  readonly blockerCount: number;
  /** The Tasks that wait on the Task, at most `MAX_DETAIL_BLOCKERS`, in the order they were added. */
  readonly blocks: ReadonlyArray<WorkCardBlocker>;
  readonly blockCount: number;
}

/** What a write did to the blockers of one Task: the Tasks it began and stopped waiting on. */
export interface BlockedByChange {
  readonly taskId: string;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

/** An edge, as the Task that waits and the Task it waits on. */
export interface Edge {
  readonly taskId: string;
  readonly blockedById: string;
}

/** What a write of edges changed. */
export interface EdgeWrite {
  /** One change for each Task whose blockers changed, in id order. */
  readonly changes: ReadonlyArray<BlockedByChange>;
  /**
   * Every Task at either end of an edge that was added or removed, once, in id
   * order. A Task that only gained or lost a Task waiting on it has no change,
   * but its pane lists that Task, so it is announced all the same.
   */
  readonly touchedTaskIds: ReadonlyArray<string>;
}

/** One Task on a path of waits, with its title for the words of a refusal. */
export interface WaitPathStep {
  readonly id: string;
  readonly title: string;
}

interface EdgeRow {
  readonly task_id: Uint8Array;
  readonly blocked_by_task_id: Uint8Array;
}

interface BlockerRow {
  readonly id: Uint8Array;
  readonly title: string;
  readonly stage: TaskStage;
  readonly total: number;
}

interface CardBlockerRow extends BlockerRow {
  readonly task_id: Uint8Array;
}

const buildBlocker = (row: BlockerRow): WorkCardBlocker => ({
  id: uuidToString(row.id),
  title: row.title,
  stage: row.stage,
});

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Returns what a write changed, from the edges it added and the edges it
 * removed: one change for each Task that waits, and the Tasks at either end.
 */
export const buildEdgeWrite = (
  added: ReadonlyArray<Edge>,
  removed: ReadonlyArray<Edge>,
): EdgeWrite => {
  const byTask = new Map<string, { added: string[]; removed: string[] }>();
  const entry = (taskId: string) => {
    const found = byTask.get(taskId) ?? { added: [], removed: [] };
    byTask.set(taskId, found);
    return found;
  };
  for (const edge of added) entry(edge.taskId).added.push(edge.blockedById);
  for (const edge of removed) entry(edge.taskId).removed.push(edge.blockedById);
  const touched = new Set(
    [...added, ...removed].flatMap((edge) => [edge.taskId, edge.blockedById]),
  );
  return {
    changes: [...byTask]
      .toSorted(([left], [right]) => compareText(left, right))
      .map(([taskId, change]) => ({
        taskId,
        added: change.added.toSorted(compareText),
        removed: change.removed.toSorted(compareText),
      })),
    touchedTaskIds: [...touched].toSorted(compareText),
  };
};

/** The longest title a refusal quotes. Longer titles are cut at a word. */
const MAX_QUOTED_TITLE = 60;

/** The most Tasks a refusal names between the two ends of a loop. */
const MAX_NAMED_IN_LOOP = 6;

/** Returns the titles between the ends of a path, cut and joined for a sentence: "A, B and 2 more". */
const nameTasksInTheMiddle = (path: ReadonlyArray<WaitPathStep>): string => {
  const titles = path.slice(1, -1).map((step) => cutTextAtWord(step.title, MAX_QUOTED_TITLE));
  if (titles.length <= MAX_NAMED_IN_LOOP) return titles.join(", ");
  const rest = titles.length - MAX_NAMED_IN_LOOP;
  return `${titles.slice(0, MAX_NAMED_IN_LOOP).join(", ")} and ${String(rest)} more`;
};

/**
 * Returns the words that refuse a blocker which would close a loop. `path` is
 * the path of waits that exists already, from the Task that would be the
 * blocker to the Task that would wait: "A already waits on this Task, through
 * B, C." (without the "through" part for an edge between the two).
 */
export const describeBlockerLoop = (path: ReadonlyArray<WaitPathStep>): string => {
  const blocker = cutTextAtWord(path[0]!.title, MAX_QUOTED_TITLE);
  return path.length <= 2
    ? `${blocker} already waits on this Task.`
    : `${blocker} already waits on this Task, through ${nameTasksInTheMiddle(path)}.`;
};

/**
 * Returns the words that refuse a merge which would close a loop. `path` is a
 * path of waits between the two Tasks, with other Tasks between them, and
 * `survivorTitle` is the title of the Task that would wait on itself.
 */
export const describeMergeLoop = (
  survivorTitle: string,
  path: ReadonlyArray<WaitPathStep>,
): string =>
  `Merging these Tasks would make ${cutTextAtWord(survivorTitle, MAX_QUOTED_TITLE)} wait on itself, ` +
  `through ${nameTasksInTheMiddle(path)}.`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Reads the Tasks that still block the Tasks whose edges `edgeScope` selects
   * (it must select `task_id`, `blocked_by_task_id` and `created_at`), as one
   * statement for all of them: each Task's first `MAX_CARD_BLOCKERS` blockers
   * in the order they were added, with the Task's count of blockers before the
   * cut. A blocker still blocks while it is live and not at `landed`, `done`
   * or `dropped`. A blocker's title and stage come from its own row, so a
   * blocker that is not on the board is listed too.
   */
  const readStillBlocking = (edgeScope: Statement.Statement<unknown>) =>
    sql<CardBlockerRow>`
      WITH edges AS (${edgeScope})
      SELECT w.task_id, w.id, w.title, w.stage, w.total
      FROM (
        SELECT edges.task_id AS task_id, t.id AS id, t.title AS title, t.stage AS stage,
               ROW_NUMBER() OVER (
                 PARTITION BY edges.task_id ORDER BY edges.created_at, edges.blocked_by_task_id
               ) AS position,
               COUNT(*) OVER (PARTITION BY edges.task_id) AS total
        FROM edges JOIN tasks t ON t.id = edges.blocked_by_task_id
        WHERE ${sql.literal(buildLiveTaskCondition("t"))}
          AND t.stage NOT IN (${sql.literal(STOPS_BLOCKING_SQL)})
      ) w
      WHERE w.position <= ${MAX_CARD_BLOCKERS}
      ORDER BY w.task_id, w.position`;

  const buildCardBlocking = (rows: ReadonlyArray<CardBlockerRow>): CardBlocking => ({
    blockedBy: rows.map(buildBlocker),
    blockedByCount: rows[0]?.total ?? 0,
  });

  /**
   * Returns one path of waits from the Task `from` to the Task `to`, as the
   * Tasks on it in order (`from` first, `to` last), or an empty list when
   * `from` does not wait on `to`, directly or through other Tasks. It reads
   * every stored edge, finished blockers included.
   *
   * With `directEdgeCounts` false, the edge "`from` waits on `to`" itself
   * is not followed, so only a path through at least one other Task is
   * found. `findMergeLoop` asks that; `findBlockerLoop` does not.
   *
   * One statement, in three parts:
   * - `reach` walks the edges from `from` and keeps each Task it reaches
   *   once, whatever the number of paths to it, so the walk costs at most
   *   the edges `from` reaches.
   * - `parent` picks, for each Task reached, one Task that waits on it
   *   (the lowest id), among `from` and the Tasks reached. `CROSS JOIN`
   *   makes SQLite read the edges of those Tasks by the primary key,
   *   rather than scan every edge.
   * - `path` walks back from `to` along those parents, which is the
   *   witness path. The stored edges are a DAG, so the walk ends at
   *   `from`. Should a loop ever be in the table, the depth limit (one
   *   step per Task reached) ends the walk instead of hanging the writer
   *   transaction.
   */
  const findWaitPath = (input: {
    readonly from: string;
    readonly to: string;
    readonly directEdgeCounts: boolean;
  }): Effect.Effect<ReadonlyArray<WaitPathStep>, SqlError> =>
    Effect.map(
      sql<{ readonly id: Uint8Array; readonly title: string }>`
        WITH RECURSIVE
          reach (id) AS (
            SELECT e.blocked_by_task_id
            FROM task_blockers e
            WHERE e.task_id = ${uuidFromString(input.from)}
              AND (${input.directEdgeCounts ? 1 : 0}
                   OR e.blocked_by_task_id <> ${uuidFromString(input.to)})
            UNION
            SELECT e.blocked_by_task_id
            FROM reach JOIN task_blockers e ON e.task_id = reach.id
          ),
          parent (id, via) AS (
            SELECT e.blocked_by_task_id, MIN(e.task_id)
            FROM (SELECT ${uuidFromString(input.from)} AS id UNION SELECT id FROM reach) scope
              CROSS JOIN task_blockers e ON e.task_id = scope.id
            WHERE ${input.directEdgeCounts ? 1 : 0}
              OR e.task_id <> ${uuidFromString(input.from)}
              OR e.blocked_by_task_id <> ${uuidFromString(input.to)}
            GROUP BY e.blocked_by_task_id
          ),
          path (id, depth) AS (
            SELECT ${uuidFromString(input.to)}, 0
            WHERE EXISTS (SELECT 1 FROM reach WHERE id = ${uuidFromString(input.to)})
            UNION ALL
            SELECT parent.via, path.depth + 1
            FROM path JOIN parent ON parent.id = path.id
            WHERE path.depth < (SELECT COUNT(*) FROM reach)
          )
        SELECT path.id, (SELECT tasks.title FROM tasks WHERE tasks.id = path.id) AS title
        FROM path
        ORDER BY path.depth DESC`,
      (rows) => rows.map((row) => ({ id: uuidToString(row.id), title: row.title })),
    );

  return {
    /**
     * Writes the edge "`taskId` waits on `blockedById`", stamped with the
     * actor, and returns true. Writes nothing and returns false when the edge
     * is there already. The caller has checked that the two Tasks differ and
     * that the edge closes no loop.
     */
    insertEdge: (
      taskId: string,
      blockedById: string,
      at: string,
      actor: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`INSERT INTO task_blockers (task_id, blocked_by_task_id, created_at, created_by)
            VALUES (${uuidFromString(taskId)}, ${uuidFromString(blockedById)}, ${at}, ${actor})
            ON CONFLICT (task_id, blocked_by_task_id) DO NOTHING
            RETURNING task_id`,
        (rows) => rows.length > 0,
      ),

    /** Removes the edge "`taskId` waits on `blockedById`" and returns true, or returns false when there is no such edge. */
    deleteEdge: (taskId: string, blockedById: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`DELETE FROM task_blockers
            WHERE task_id = ${uuidFromString(taskId)}
              AND blocked_by_task_id = ${uuidFromString(blockedById)}
            RETURNING task_id`,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns the ids of the Tasks on the other end of an edge of the Task
     * `taskId`, in either direction, in id order: the Tasks it waits on and the
     * Tasks that wait on it. Whatever their stage. Two index searches, one for
     * each direction.
     */
    readNeighbourIds: (taskId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT blocked_by_task_id AS id FROM task_blockers WHERE task_id = ${uuidFromString(taskId)}
          UNION
          SELECT task_id AS id FROM task_blockers WHERE blocked_by_task_id = ${uuidFromString(taskId)}`,
        (rows) => rows.map((row) => uuidToString(row.id)).toSorted(compareText),
      ),

    /**
     * Returns the path of waits that adding the edge "`taskId` waits on
     * `blockedByTaskId`" would close into a loop, as the Tasks on it from
     * `blockedByTaskId` to `taskId` (`describeBlockerLoop` words it), or an
     * empty list when the edge closes no loop. The edge between the two
     * Tasks the other way round counts.
     */
    findBlockerLoop: (
      taskId: string,
      blockedByTaskId: string,
    ): Effect.Effect<ReadonlyArray<WaitPathStep>, SqlError> =>
      findWaitPath({ from: blockedByTaskId, to: taskId, directEdgeCounts: true }),

    /**
     * Returns the path of waits that merging the Task `sourceId` into the Task
     * `survivorId` would turn into a loop, as the Tasks on it between the two
     * (`describeMergeLoop` words it), or an empty list when the merge closes
     * none. Once the two Tasks are one, a path between them in either
     * direction leads from the survivor back to itself. The edge between the
     * two Tasks themselves is no loop: the merge drops it, so only paths
     * through at least one other Task count.
     */
    findMergeLoop: (
      sourceId: string,
      survivorId: string,
    ): Effect.Effect<ReadonlyArray<WaitPathStep>, SqlError> =>
      Effect.gen(function* () {
        const forward = yield* findWaitPath({
          from: sourceId,
          to: survivorId,
          directEdgeCounts: false,
        });
        if (forward.length > 0) return forward;
        return yield* findWaitPath({ from: survivorId, to: sourceId, directEdgeCounts: false });
      }),

    /**
     * Removes every edge of the Task `taskId`, the ones where it waits and the
     * ones where it is waited on, and returns what that changed: the Task
     * itself loses its blockers, and each Task that waited on it loses it.
     */
    deleteEdgesOf: (taskId: string): Effect.Effect<EdgeWrite, SqlError> =>
      Effect.map(
        sql<EdgeRow>`
          DELETE FROM task_blockers
          WHERE task_id = ${uuidFromString(taskId)} OR blocked_by_task_id = ${uuidFromString(taskId)}
          RETURNING task_id, blocked_by_task_id`,
        (rows) =>
          buildEdgeWrite(
            [],
            rows.map((row) => ({
              taskId: uuidToString(row.task_id),
              blockedById: uuidToString(row.blocked_by_task_id),
            })),
          ),
      ),

    /**
     * Moves the edges of the Task `sourceId` to the Task `targetId`, in both
     * directions, for a merge: what waited on the source waits on the target,
     * and what the source waited on, the target waits on. An edge between the
     * two Tasks would be a self edge and is dropped, and an edge the target
     * has already is kept once, with its own stamp. Returns what that changed.
     * The caller has checked that no loop forms.
     */
    moveEdges: (sourceId: string, targetId: string): Effect.Effect<EdgeWrite, SqlError> =>
      Effect.gen(function* () {
        const source = uuidFromString(sourceId);
        const moved = yield* sql<
          EdgeRow & { readonly created_at: string; readonly created_by: string }
        >`
          DELETE FROM task_blockers
          WHERE task_id = ${source} OR blocked_by_task_id = ${source}
          RETURNING task_id, blocked_by_task_id, created_at, created_by`;
        const removed = moved.map((row) => ({
          taskId: uuidToString(row.task_id),
          blockedById: uuidToString(row.blocked_by_task_id),
        }));
        const added: Array<Edge> = [];
        for (const [index, edge] of removed.entries()) {
          const taskId = edge.taskId === sourceId ? targetId : edge.taskId;
          const blockedById = edge.blockedById === sourceId ? targetId : edge.blockedById;
          if (taskId === blockedById) continue;
          const row = moved[index]!;
          const inserted = yield* sql`
            INSERT INTO task_blockers (task_id, blocked_by_task_id, created_at, created_by)
            VALUES (${uuidFromString(taskId)}, ${uuidFromString(blockedById)},
                    ${row.created_at}, ${row.created_by})
            ON CONFLICT (task_id, blocked_by_task_id) DO NOTHING
            RETURNING task_id`;
          if (inserted.length > 0) added.push({ taskId, blockedById });
        }
        return buildEdgeWrite(added, removed);
      }),

    /**
     * Reads what the cards of the Tasks `taskIds` show of the Tasks that still
     * block them, as a map from a Task's id to its blockers. A Task that
     * nothing blocks has no entry. One statement, whatever the number of
     * cards: it reads the edges of the listed Tasks by the primary key of
     * `task_blockers`, so the work follows the board's cards and never the
     * number of edges in the database.
     */
    readCardBlockers: (
      taskIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, CardBlocking>, SqlError> =>
      taskIds.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            readStillBlocking(
              sql`SELECT task_id, blocked_by_task_id, created_at
                  FROM task_blockers
                  WHERE task_id IN (SELECT unhex(value) FROM json_each(${JSON.stringify(
                    taskIds.map((id) => id.replaceAll("-", "")),
                  )}))`,
            ),
            (rows) => {
              const byTask = new Map<string, CardBlockerRow[]>();
              for (const row of rows) {
                const key = uuidToString(row.task_id);
                byTask.set(key, [...(byTask.get(key) ?? []), row]);
              }
              return new Map([...byTask].map(([key, group]) => [key, buildCardBlocking(group)]));
            },
          ),

    /** Reads what the card of one Task shows of the Tasks that still block it, as `readCardBlockers` does for all cards. */
    readCardBlockersOf: (taskId: string): Effect.Effect<CardBlocking, SqlError> =>
      Effect.map(
        readStillBlocking(
          sql`SELECT task_id, blocked_by_task_id, created_at
              FROM task_blockers WHERE task_id = ${uuidFromString(taskId)}`,
        ),
        buildCardBlocking,
      ),

    /**
     * Reads the Tasks the Task `taskId` waits on and the Tasks that wait on
     * it, every edge whatever the stage of the other end, so a pane can show a
     * finished blocker and take it away. Two statements, each cut at
     * `MAX_DETAIL_BLOCKERS` and carrying the count before the cut.
     */
    readDetailBlocking: (taskId: string): Effect.Effect<DetailBlocking, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(taskId);
        const blockers = yield* sql<BlockerRow>`
          SELECT b.id, b.title, b.stage, COUNT(*) OVER () AS total
          FROM task_blockers e JOIN tasks b ON b.id = e.blocked_by_task_id
          WHERE e.task_id = ${key}
          ORDER BY e.created_at, e.blocked_by_task_id
          LIMIT ${MAX_DETAIL_BLOCKERS}`;
        const blocks = yield* sql<BlockerRow>`
          SELECT w.id, w.title, w.stage, COUNT(*) OVER () AS total
          FROM task_blockers e JOIN tasks w ON w.id = e.task_id
          WHERE e.blocked_by_task_id = ${key}
          ORDER BY e.created_at, e.task_id
          LIMIT ${MAX_DETAIL_BLOCKERS}`;
        return {
          blockers: blockers.map(buildBlocker),
          blockerCount: blockers[0]?.total ?? 0,
          blocks: blocks.map(buildBlocker),
          blockCount: blocks[0]?.total ?? 0,
        };
      }),
  };
});

/** Everything the task service and the reads of the board and the pane need of `task_blockers`. */
export const blockerRepository = make;
