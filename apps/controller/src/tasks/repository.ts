/**
 * Task rows, their provenance children, and the full-text index over them.
 *
 * This module reads and writes the contract's `Task`: a row and its provenance
 * entries are one value everywhere above this module, because that is what a
 * caller reads and what a `task.created` event carries. Nothing here decides
 * policy (who may write, what a change means, what gets logged); it only reads
 * and writes.
 *
 * A listing pages in one of two ways:
 *
 * - Without a search text, it uses a keyset over the sort keys plus the id.
 *   The partial indexes on `tasks` serve a sort on one key. A sort on several
 *   keys has no index of its own, so SQLite sorts the matching rows in memory.
 * - With a search text, it uses the full-text index ordered by relevance. No
 *   row stores its rank, so paging cannot resume from a rank and uses an
 *   offset instead.
 *
 * The two behave differently when rows are written between pages. A keyset
 * boundary is a value, so a row inserted or deleted elsewhere in the order
 * does not affect the pages already returned. An offset is a count, so a
 * matching row created between two pages pushes one row across the boundary
 * and that row is returned twice, and a deleted row pulls one row across and
 * that row is skipped. So a relevance listing returns each row exactly once
 * only if the database does not change while it is read. A rank is not a key
 * to resume from, and there is nothing else to page by.
 */
import type * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import {
  BOARD_STAGES,
  type BoardStage,
  FINISHED_STAGES,
  isFinishedStage,
  MAX_TRACKING_HANDOFFS,
} from "@hercule/contract";
import type { SqlError } from "effect/sql/SqlError";
import type {
  ExternalRef,
  ProvenanceEntry,
  Task,
  TaskPriority,
  TaskStage,
  TaskStatus,
} from "@hercule/contract";
import {
  buildMatchExpression,
  decodeOffsetCursor,
  encodeOffsetCursor,
  mintUuid,
  buildPage,
  prepareKeysetListing,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
  type ResolvedSortKey,
  type SortColumn,
} from "../db";
import { chooseRankBetween, spreadBoardRanks } from "./board-rank";

/**
 * The filter of a listing. A task matches a field if it has any of the
 * field's values, and it must match every field.
 */
export interface TaskFilter {
  readonly refs?: ReadonlyArray<ExternalRef>;
  readonly labels?: ReadonlyArray<string>;
  readonly status?: ReadonlyArray<TaskStatus>;
  readonly stage?: ReadonlyArray<TaskStage>;
  readonly projectId?: string;
  /** `true` keeps the tasks with a handoff entry, `false` the tasks without one. */
  readonly handedOff?: boolean;
}

/** A field a keyset listing can order by. */
export type TaskSortField = "updatedAt" | "createdAt" | "priority" | "status";

/**
 * How a listing is ordered: by its sort keys, most significant first, or by
 * how well each row matches the search text.
 */
export type TaskOrder =
  | {
      readonly _tag: "column";
      readonly sort: Arr.NonEmptyReadonlyArray<ResolvedSortKey<TaskSortField>>;
    }
  | { readonly _tag: "relevance"; readonly text: string };

/** The page size, cursor and order of a listing. */
export interface TaskPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly order: TaskOrder;
}

/** A provenance entry as the caller passes it, before `at` and `actor` are added. */
export interface ProvenanceInput {
  readonly ref?: ExternalRef;
  readonly eventId?: number;
  readonly runId?: string;
  readonly signalId?: string;
}

/** One handoff of a Task: the provenance entry that names the signal and the run. */
export interface TrackedHandoff {
  readonly signalId: string;
  readonly runId: string;
  readonly at: string;
}

/**
 * One handoff entry of a non-deleted Task, found by the run it started, with
 * the Task's status and the handoff entry appended right after it.
 */
export interface LegHandoff {
  readonly runId: string;
  readonly signalId: string;
  readonly taskId: string;
  readonly taskStatus: TaskStatus;
  /** The Task's next handoff entry, by time then append order. Absent for the Task's newest handoff. */
  readonly next?: TrackedHandoff;
}

/** An open Task and one External Ref its provenance carries. */
export interface OpenTaskOnRef {
  readonly ref: ExternalRef;
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly updatedAt: string;
}

/** The active Task of a ref (see `findActiveTaskForRef`), with the columns a card shows. */
export interface ActiveTaskOnRef {
  readonly ref: ExternalRef;
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly stage: TaskStage;
}

/**
 * What a Task has gathered since it was created, for the check that decides
 * whether the Task can still be taken back (`readTraces`).
 */
export interface TaskTraces {
  /** True when an edit moved `updated_at` past `created_at`. */
  readonly edited: boolean;
  /** True when a Thread (a session) belongs to the Task. */
  readonly hasSession: boolean;
  /** True when a run works on the Task. */
  readonly hasRun: boolean;
  /** How many refs the Task links. */
  readonly linkCount: number;
}

/** A Task that Tracking follows, with its newest handoffs, newest first. */
export interface TrackedTask {
  readonly id: string;
  readonly title: string;
  readonly handoffs: ReadonlyArray<TrackedHandoff>;
}

/**
 * A Task as the Work board reads it: its place and the fields a card shows,
 * and none of the Task's description or provenance.
 */
export interface BoardTask {
  readonly id: string;
  readonly title: string;
  readonly stage: BoardStage;
  readonly priority: TaskPriority;
  /** The Task's project, or `undefined` for the "No project" lane, which a deleted project is. */
  readonly projectId: string | undefined;
  readonly boardRank: string;
  readonly createdAt: string;
  readonly stageChangedAt: string;
  /** The run whose failure the Task shows, if any. */
  readonly failedRunId: string | undefined;
}

/** The fields of a new task row, with the defaults already applied. */
export interface NewTask {
  /** The task's id, when the caller chose it; a new one is made when absent. */
  readonly id?: string;
  readonly title: string;
  readonly description: string;
  readonly stage: TaskStage;
  /** The coarse reading of `stage`, already derived by the caller. */
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly labels: ReadonlyArray<string>;
  readonly projectId: string | undefined;
  readonly provenance: ReadonlyArray<ProvenanceInput>;
  /**
   * True when the Task is linked to its refs only because the user added them
   * to Work from nothing that concerned them (`task_entity_links.following`).
   * Absent means false.
   */
  readonly following?: boolean;
  readonly at: string;
  readonly actor: string;
}

/**
 * A cell of the Work board: the Tasks of one project, or of no project, at
 * one stage. The cards of a cell are ordered by their `boardRank`.
 */
export interface BoardCell {
  /** `null` is the "No project" lane. */
  readonly projectId: string | null;
  readonly stage: BoardStage;
}

/** A Task's place in its cell. */
export interface RankedTask {
  readonly id: string;
  readonly boardRank: string;
}

/**
 * What the Task row says about its failure, and the two facts that decide
 * whether a failure may be restored to it.
 */
export interface TaskFailureState {
  /** The run whose failure the Task shows, or `undefined` when it shows none. */
  readonly failedRunId: string | undefined;
  /** Rises on every change to who is handling the failure (`failure_revision`). */
  readonly failureRevision: number;
  readonly stage: TaskStage;
  readonly deleted: boolean;
}

/** One row of `task_failure_recoveries`: a run start that ended a failure. */
export interface FailureRecovery {
  readonly runId: string;
  readonly taskId: string;
  /** The run the Task was showing when the start ended its failure. */
  readonly failedRunId: string;
  /** The Task's `failure_revision` right after the start. */
  readonly revisionAfter: number;
  /** When the failure was restored, or `undefined` while it is not. */
  readonly restoredAt: string | undefined;
}

/** The columns an edit may set. An absent one is left as it was. */
export interface TaskEdit {
  readonly title?: string;
  readonly description?: string;
  readonly stage?: TaskStage;
  /** Must be the coarse reading of `stage`; it is written only when it changed. */
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority;
  readonly projectId?: string | null;
  readonly labels?: ReadonlyArray<string>;
  /** The rank in the Task's cell after the edit; see `chooseLastRankOfCell`. */
  readonly boardRank?: string;
}

interface TaskRow {
  readonly id: Uint8Array;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: string;
  readonly labels: string;
  readonly project_id: Uint8Array | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly status_changed_at: string;
  readonly stage_changed_at: string;
  readonly deleted_at: string | null;
}

interface ProvenanceRow {
  readonly task_id: Uint8Array;
  readonly ref: string | null;
  readonly event_id: number | null;
  readonly run_id: Uint8Array | null;
  readonly signal_id: Uint8Array | null;
  readonly at: string;
  readonly actor: string;
}

const COLUMNS =
  "tasks.id, tasks.title, tasks.description, tasks.status, tasks.stage, tasks.priority, tasks.labels, " +
  "tasks.project_id, tasks.created_at, tasks.updated_at, tasks.status_changed_at, " +
  "tasks.stage_changed_at, tasks.deleted_at";

/**
 * The rank of each priority, lowest first. It matches the `priority_rank`
 * column, so a cursor resumes on the value the `tasks_priority` index holds.
 */
const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/**
 * The rank of each status, in the order work moves through them. It matches
 * the `status_rank` column, so a cursor resumes on the value the
 * `tasks_status` index holds.
 */
const STATUS_RANK: Record<TaskStatus, number> = {
  open: 0,
  "in-progress": 1,
  done: 2,
  cancelled: 3,
};

/**
 * The sortable fields of a task listing, and how each one sorts. Priority and
 * status order by their rank rather than alphabetically, through the rank
 * columns migration 0041 adds.
 *
 * It is exported for the test of migration 0041, which checks that a sort on
 * these columns seeks that migration's indexes.
 */
export const TASK_SORT_COLUMNS: Record<TaskSortField, SortColumn<Task>> = {
  updatedAt: {
    column: "tasks.updated_at",
    valueType: "string",
    readValue: (task) => task.updatedAt,
  },
  createdAt: {
    column: "tasks.created_at",
    valueType: "string",
    readValue: (task) => task.createdAt,
  },
  priority: {
    column: "tasks.priority_rank",
    valueType: "number",
    readValue: (task) => PRIORITY_RANK[task.priority],
  },
  status: {
    column: "tasks.status_rank",
    valueType: "number",
    readValue: (task) => STATUS_RANK[task.status],
  },
};

/**
 * Builds the cursor scope of a relevance listing.
 *
 * A relevance listing resumes by counting rows rather than by comparing a key,
 * so a count from one result set means nothing in another. The scope must
 * therefore include everything the result set depends on: the terms it matched
 * and the filter it ran under. The terms are taken from the `MATCH` expression
 * rather than the text the caller typed, so trimming spaces in the search box
 * between pages keeps the cursor valid.
 */
const buildRelevanceScope = (filter: TaskFilter, match: string): CursorScope => ({
  op: "task.query",
  sort: [
    {
      field: `relevance:${JSON.stringify([
        match,
        filter.refs ?? null,
        filter.labels ?? null,
        filter.status ?? null,
        filter.stage ?? null,
        filter.projectId ?? null,
        filter.handedOff ?? null,
      ])}`,
      direction: "asc",
    },
  ],
});

/**
 * The condition that the partial index `tasks_board_rank` carries, written as
 * the index writes it. SQLite uses a partial index only for a query whose
 * `WHERE` holds the index's own condition, character for character, so every
 * read of that index repeats this text. The index leaves out Tasks at `done`
 * and `dropped`, so its size follows the board and not the history.
 */
const ON_BOARD = "stage NOT IN ('done', 'dropped')";

/** Returns true if the stage is one of the board's five stages. */
const isBoardStage = (stage: TaskStage): stage is BoardStage =>
  (BOARD_STAGES as ReadonlyArray<string>).includes(stage);

/**
 * Orders cards by project (none first), then by stage in the order of the
 * board's stages, then by rank, then by id. Ids and ranks sort as text.
 */
const compareBoardOrder = (left: BoardTask, right: BoardTask): number => {
  const leftProject = left.projectId ?? "";
  const rightProject = right.projectId ?? "";
  if (leftProject !== rightProject) return leftProject < rightProject ? -1 : 1;
  if (left.stage !== right.stage) {
    return BOARD_STAGES.indexOf(left.stage) - BOARD_STAGES.indexOf(right.stage);
  }
  if (left.boardRank !== right.boardRank) return left.boardRank < right.boardRank ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Builds an `IN` clause over a list. An empty list gives a clause that matches nothing. */
  const buildAnyOfClause = (column: string, values: ReadonlyArray<unknown>) =>
    values.length === 0 ? sql`1 = 0` : sql`${sql.literal(column)} IN ${sql.in(values)}`;

  const buildConditions = (filter: TaskFilter) => {
    const clauses = [sql`tasks.deleted_at IS NULL`];
    if (filter.status !== undefined) {
      // Without statistics, SQLite starts a listing sorted by `updated_at`
      // from the status index and scans every open task. A listing that names
      // refs should start from the ref index, whose few rows are the selective
      // part. The unary `+` makes the status column an expression, so the
      // planner cannot use an index on it, and the status is only checked.
      clauses.push(
        buildAnyOfClause(
          filter.refs === undefined ? "tasks.status" : "+tasks.status",
          filter.status,
        ),
      );
    }
    if (filter.stage !== undefined) {
      // Same reason as the status clause above.
      clauses.push(
        buildAnyOfClause(filter.refs === undefined ? "tasks.stage" : "+tasks.stage", filter.stage),
      );
    }
    if (filter.projectId !== undefined) {
      clauses.push(sql`tasks.project_id = ${uuidFromString(filter.projectId)}`);
    }
    if (filter.handedOff !== undefined) {
      // `task_provenance_handoff` and `task_provenance_handoff_run` hold exactly
      // the entries that name a signal and the Task, so both forms read one of
      // them alone. `task_id` is never NULL,
      // so NOT IN cannot match nothing by mistake.
      clauses.push(
        filter.handedOff
          ? sql`tasks.id IN (SELECT task_id FROM task_provenance WHERE signal_id IS NOT NULL)`
          : sql`tasks.id NOT IN (SELECT task_id FROM task_provenance WHERE signal_id IS NOT NULL)`,
      );
    }
    if (filter.labels !== undefined) {
      clauses.push(
        sql`EXISTS (SELECT 1 FROM json_each(tasks.labels) WHERE ${buildAnyOfClause("value", filter.labels)})`,
      );
    }
    if (filter.refs !== undefined) {
      clauses.push(
        // Start from the ref rather than from the task. A correlated EXISTS
        // makes SQLite scan every live task and look up its provenance, while
        // this looks up `task_provenance_ref` first and then only the few ids
        // it returns. This matters because the duplicate-signal check runs
        // before every triage.
        sql`tasks.id IN (SELECT p.task_id FROM task_provenance p
                         WHERE ${buildAnyOfClause("p.ref", filter.refs)})`,
      );
    }
    return sql.and(clauses);
  };

  /**
   * Returns the tasks of one page with their provenance, in append order. It
   * reads the entries of every task on the page in one query, because a query
   * per task would make the number of round trips grow with the page size.
   */
  const hydrate = (rows: ReadonlyArray<TaskRow>): Effect.Effect<ReadonlyArray<Task>, SqlError> =>
    rows.length === 0
      ? Effect.succeed([])
      : Effect.map(
          sql<ProvenanceRow>`
            SELECT task_id, ref, event_id, run_id, signal_id, at, actor FROM task_provenance
            WHERE ${sql.in(
              "task_id",
              rows.map((row) => row.id),
            )}
            ORDER BY task_id, id
          `,
          (entries) => {
            const byTask = new Map<string, Array<ProvenanceEntry>>();
            for (const entry of entries) {
              const id = uuidToString(entry.task_id);
              const list = byTask.get(id) ?? [];
              list.push({
                ...(entry.ref === null ? {} : { ref: entry.ref }),
                ...(entry.event_id === null ? {} : { eventId: entry.event_id }),
                ...(entry.run_id === null ? {} : { runId: uuidToString(entry.run_id) }),
                ...(entry.signal_id === null ? {} : { signalId: uuidToString(entry.signal_id) }),
                at: entry.at,
                actor: entry.actor,
              });
              byTask.set(id, list);
            }
            return rows.map((row) => {
              const id = uuidToString(row.id);
              return {
                id,
                title: row.title,
                description: row.description,
                status: row.status as TaskStatus,
                stage: row.stage as TaskStage,
                priority: row.priority as TaskPriority,
                labels: JSON.parse(row.labels) as ReadonlyArray<string>,
                ...(row.project_id === null ? {} : { projectId: uuidToString(row.project_id) }),
                provenance: byTask.get(id) ?? [],
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                statusChangedAt: row.status_changed_at,
                stageChangedAt: row.stage_changed_at,
                ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
              };
            });
          },
        );

  /**
   * Links the Task to each ref its new provenance entries carry. A pair that
   * is already linked keeps its row, so the oldest `linked_at` stays and the
   * active Task of a ref does not change when the Task is updated.
   */
  const insertLinks = (
    taskId: Uint8Array,
    entries: ReadonlyArray<ProvenanceInput>,
    link: { readonly at: string; readonly actor: string; readonly following: boolean },
  ) =>
    Effect.forEach(
      entries.flatMap((entry) => (entry.ref === undefined ? [] : [entry.ref])),
      (ref) => sql`
        INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by, following)
        VALUES (${taskId}, ${ref}, ${link.at}, ${link.actor}, ${link.following ? 1 : 0})
        ON CONFLICT (task_id, ref) DO NOTHING
      `,
      { discard: true },
    );

  const insertProvenance = (
    taskId: Uint8Array,
    entries: ReadonlyArray<ProvenanceInput>,
    at: string,
    actor: string,
  ) =>
    Effect.forEach(
      entries,
      (entry) => sql`
        INSERT INTO task_provenance (id, task_id, ref, event_id, run_id, signal_id, at, actor)
        VALUES (${mintUuid()}, ${taskId}, ${entry.ref ?? null}, ${entry.eventId ?? null},
                ${entry.runId === undefined ? null : uuidFromString(entry.runId)},
                ${entry.signalId === undefined ? null : uuidFromString(entry.signalId)},
                ${at}, ${actor})
      `,
      { discard: true },
    );

  /** Returns true if a project exists and has not been deleted. */
  const isLiveProject = (id: string): Effect.Effect<boolean, SqlError> =>
    Effect.map(
      sql<{ readonly id: Uint8Array }>`SELECT id FROM projects
                                       WHERE id = ${uuidFromString(id)} AND deleted_at IS NULL`,
      (rows) => rows.length === 1,
    );

  /**
   * Returns the cell the board draws a Task of `cell` in. A Task whose project
   * was deleted keeps its `project_id`, and every client draws it in the "No
   * project" lane. So the board treats it as in that lane, and the cell of a
   * deleted project is the cell of no project. This is the one place that says
   * so; `listCellRanks`, `respreadCell` and the board read all follow it.
   */
  const resolveCell = (cell: BoardCell): Effect.Effect<BoardCell, SqlError> =>
    cell.projectId === null
      ? Effect.succeed(cell)
      : Effect.map(isLiveProject(cell.projectId), (live) =>
          live ? cell : { projectId: null, stage: cell.stage },
        );

  /** Orders ranks as the database does: by rank, then by id. Ids sort the same as text and as bytes. */
  const compareRanked = (left: RankedTask, right: RankedTask): number => {
    if (left.boardRank !== right.boardRank) return left.boardRank < right.boardRank ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  };

  /**
   * Returns the live Tasks of a cell with their ranks, in rank order. The cell
   * must be one `resolveCell` returned. A project cell reads `tasks_board_rank`
   * in rank order. The cell of no project reads the same way, then adds the
   * Tasks of deleted projects, which are none unless a project was deleted.
   */
  const listCellRanks = (cell: BoardCell): Effect.Effect<ReadonlyArray<RankedTask>, SqlError> =>
    Effect.gen(function* () {
      const readRanked = (
        rows: ReadonlyArray<{ readonly id: Uint8Array; readonly board_rank: string }>,
      ): ReadonlyArray<RankedTask> =>
        rows.map((row) => ({ id: uuidToString(row.id), boardRank: row.board_rank }));
      if (cell.projectId !== null) {
        return readRanked(
          yield* sql<{ readonly id: Uint8Array; readonly board_rank: string }>`
            SELECT id, board_rank FROM tasks
            WHERE project_id = ${uuidFromString(cell.projectId)} AND stage = ${cell.stage}
              AND deleted_at IS NULL AND ${sql.literal(ON_BOARD)}
            ORDER BY board_rank`,
        );
      }
      const own = readRanked(
        yield* sql<{ readonly id: Uint8Array; readonly board_rank: string }>`
          SELECT id, board_rank FROM tasks
          WHERE project_id IS NULL AND stage = ${cell.stage} AND deleted_at IS NULL
            AND ${sql.literal(ON_BOARD)}
          ORDER BY board_rank`,
      );
      const ofDeletedProjects = readRanked(
        yield* sql<{ readonly id: Uint8Array; readonly board_rank: string }>`
          SELECT tasks.id, tasks.board_rank FROM projects
          CROSS JOIN tasks ON tasks.project_id = projects.id AND tasks.stage = ${cell.stage}
                          AND tasks.deleted_at IS NULL AND tasks.${sql.literal(ON_BOARD)}
          WHERE projects.deleted_at IS NOT NULL`,
      );
      return ofDeletedProjects.length === 0
        ? own
        : [...own, ...ofDeletedProjects].toSorted(compareRanked);
    });

  /**
   * Gives the live Tasks of a cell new ranks, spread evenly and in the order
   * they have now. Only the rank column of the rows that need it is written.
   * The cell must be one `resolveCell` returned.
   */
  const respreadCell = (cell: BoardCell): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const ranked = yield* listCellRanks(cell);
      const spread = spreadBoardRanks(ranked.length);
      for (const [index, task] of ranked.entries()) {
        if (task.boardRank === spread[index]) continue;
        yield* sql`UPDATE tasks SET board_rank = ${spread[index]!} WHERE id = ${uuidFromString(task.id)}`;
      }
    });

  /**
   * Returns the greatest rank of a cell `resolveCell` returned, or `undefined`
   * when it has no card. It reads one row from the end of `tasks_board_rank`,
   * not the whole cell.
   */
  const readLastRank = (cell: BoardCell): Effect.Effect<string | undefined, SqlError> =>
    Effect.gen(function* () {
      const own = (yield* sql<{ readonly board_rank: string }>`
        SELECT board_rank FROM tasks
        WHERE project_id IS ${cell.projectId === null ? null : uuidFromString(cell.projectId)}
          AND stage = ${cell.stage} AND deleted_at IS NULL AND ${sql.literal(ON_BOARD)}
        ORDER BY board_rank DESC LIMIT 1`)[0]?.board_rank;
      if (cell.projectId !== null) return own;
      const ofDeletedProjects = (yield* sql<{ readonly board_rank: string | null }>`
        SELECT MAX(tasks.board_rank) AS board_rank FROM projects
        CROSS JOIN tasks ON tasks.project_id = projects.id AND tasks.stage = ${cell.stage}
                        AND tasks.deleted_at IS NULL AND tasks.${sql.literal(ON_BOARD)}
        WHERE projects.deleted_at IS NOT NULL`)[0]?.board_rank;
      // An aggregate over no rows gives one row holding null.
      const found = [own, ofDeletedProjects ?? undefined].filter((rank) => rank !== undefined);
      return found.length === 0 ? undefined : found.reduce((a, b) => (a > b ? a : b));
    });

  /**
   * Returns a rank that puts a card last in the cell. When the last rank is
   * too long to go after, the cell is spread again first, which keeps the
   * order of its cards.
   *
   * A cell at `done` or `dropped` is never shown in rank order, and
   * `tasks_board_rank` leaves its Tasks out. So a Task going there takes the
   * rank of an empty cell and nothing is read. A Task that comes back to a
   * board stage takes a new last rank in that cell.
   */
  const chooseLastRankOfCell = (cell: {
    readonly projectId: string | null;
    readonly stage: TaskStage;
  }): Effect.Effect<string, SqlError> =>
    Effect.gen(function* () {
      if (!isBoardStage(cell.stage)) return chooseRankBetween(undefined, undefined)!;
      const resolved = yield* resolveCell({ projectId: cell.projectId, stage: cell.stage });
      const rank = chooseRankBetween(yield* readLastRank(resolved), undefined);
      if (rank !== undefined) return rank;
      yield* respreadCell(resolved);
      // A spread cell has room after its last rank, so this always gives one.
      return chooseRankBetween(yield* readLastRank(resolved), undefined)!;
    });

  return {
    /** Returns the task with that id, or none if it does not exist or has been deleted. */
    live: (id: string): Effect.Effect<Option.Option<Task>, SqlError> =>
      sql<TaskRow>`SELECT ${sql.literal(COLUMNS)} FROM tasks
                   WHERE tasks.id = ${uuidFromString(id)} AND tasks.deleted_at IS NULL`.pipe(
        Effect.flatMap(hydrate),
        Effect.map((tasks) => Option.fromNullishOr(tasks[0])),
      ),

    /**
     * Returns the stage of the Task with that id, or none if it does not exist
     * or has been deleted. It reads one column, so it costs the same however
     * much provenance the Task has.
     */
    readStage: (id: string): Effect.Effect<Option.Option<TaskStage>, SqlError> =>
      Effect.map(
        sql<{ readonly stage: TaskStage }>`SELECT stage FROM tasks
                                           WHERE id = ${uuidFromString(id)} AND deleted_at IS NULL`,
        (rows) => Option.fromNullishOr(rows[0]?.stage),
      ),

    /**
     * Returns the cell the board draws a Task of the given cell in: the same
     * cell, except that a cell of a deleted project is the cell of no project.
     */
    resolveCell,

    /**
     * Returns the live Tasks of a cell with their ranks, in rank order. The
     * cell must come from `resolveCell`.
     */
    listCellRanks,

    /**
     * Gives the live Tasks of a cell new ranks, spread evenly, keeping their
     * order. `task.move` calls it when a rank would pass the length limit.
     * The cell must come from `resolveCell`.
     * It writes only the rank column, so it reports no change.
     */
    respreadCell,

    /**
     * Returns a rank that puts a card last in the cell, spreading the cell
     * again first when its last rank is too long to go after.
     */
    chooseLastRankOfCell,

    /** Returns the rank of the live Task with that id, or none. */
    readBoardRank: (id: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly board_rank: string }>`SELECT board_rank FROM tasks
                                             WHERE id = ${uuidFromString(id)} AND deleted_at IS NULL`,
        (rows) => Option.fromNullishOr(rows[0]?.board_rank),
      ),

    /** Returns the failure state of the Task with that id, deleted or not, or none if there is no row. */
    readFailureState: (id: string): Effect.Effect<Option.Option<TaskFailureState>, SqlError> =>
      Effect.map(
        sql<{
          readonly failed_run_id: Uint8Array | null;
          readonly failure_revision: number;
          readonly stage: TaskStage;
          readonly deleted_at: string | null;
        }>`SELECT failed_run_id, failure_revision, stage, deleted_at FROM tasks
           WHERE id = ${uuidFromString(id)}`,
        (rows) => {
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                failedRunId:
                  row.failed_run_id === null ? undefined : uuidToString(row.failed_run_id),
                failureRevision: row.failure_revision,
                stage: row.stage,
                deleted: row.deleted_at !== null,
              });
        },
      ),

    /**
     * Makes the run the failure the live Task shows, and raises its failure
     * revision. Does nothing for a Task that is deleted or has no row.
     * Returns true when a Task changed.
     */
    setFailedRun: (taskId: string, runId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`UPDATE tasks SET failed_run_id = ${uuidFromString(runId)},
                             failure_revision = failure_revision + 1
            WHERE id = ${uuidFromString(taskId)} AND deleted_at IS NULL RETURNING id`,
        (rows) => rows.length > 0,
      ),

    /**
     * Records that the run `runId` started on the Task: raises the Task's
     * failure revision, and when the Task shows a failure, clears it and
     * writes the row an Undo restores it from. Does nothing when the Task
     * has no row yet. Returns true when a failure was cleared, else false.
     */
    recordRunStart: (taskId: string, runId: string): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(taskId);
        const rows = yield* sql<{
          readonly failed_run_id: Uint8Array | null;
          readonly failure_revision: number;
        }>`SELECT failed_run_id, failure_revision FROM tasks WHERE id = ${key}`;
        const row = rows[0];
        if (row === undefined) return false;
        const revision = row.failure_revision + 1;
        yield* sql`UPDATE tasks SET failure_revision = ${revision}, failed_run_id = NULL
                   WHERE id = ${key}`;
        if (row.failed_run_id === null) return false;
        yield* sql`
          INSERT INTO task_failure_recoveries (run_id, task_id, failed_run_id, revision_after)
          VALUES (${uuidFromString(runId)}, ${key}, ${row.failed_run_id}, ${revision})`;
        return true;
      }),

    /** Returns the row of the run start that ended a failure, or none. */
    readFailureRecovery: (runId: string): Effect.Effect<Option.Option<FailureRecovery>, SqlError> =>
      Effect.map(
        sql<{
          readonly task_id: Uint8Array;
          readonly failed_run_id: Uint8Array;
          readonly revision_after: number;
          readonly restored_at: string | null;
        }>`SELECT task_id, failed_run_id, revision_after, restored_at
           FROM task_failure_recoveries WHERE run_id = ${uuidFromString(runId)}`,
        (rows) => {
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                runId,
                taskId: uuidToString(row.task_id),
                failedRunId: uuidToString(row.failed_run_id),
                revisionAfter: row.revision_after,
                restoredAt: row.restored_at ?? undefined,
              });
        },
      ),

    /**
     * Puts back the failure that the start of the run `runId` ended, in one
     * statement that checks everything it depends on: the recovery row was
     * not used, the Task is not deleted or finished, and its failure revision
     * is still the one right after that start. Then it raises the revision
     * and stamps the row. Returns the Task's id, or none when it changed
     * nothing.
     */
    restoreFailure: (runId: string, at: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(runId);
        const rows = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE tasks SET failed_run_id = r.failed_run_id,
                           failure_revision = tasks.failure_revision + 1
          FROM task_failure_recoveries r
          WHERE r.run_id = ${key} AND r.restored_at IS NULL AND tasks.id = r.task_id
            AND tasks.deleted_at IS NULL AND tasks.stage NOT IN ${sql.in(FINISHED_STAGES)}
            AND tasks.failure_revision = r.revision_after
          RETURNING tasks.id`;
        const row = rows[0];
        if (row === undefined) return Option.none();
        yield* sql`UPDATE task_failure_recoveries SET restored_at = ${at} WHERE run_id = ${key}`;
        return Option.some(uuidToString(row.id));
      }),

    /**
     * Returns the oldest handoff entry of a Task: the provenance entry that
     * names a signal, earliest `at` first. It is none when the Task does not
     * exist, is deleted, or has no handoff entry. One lookup on
     * `task_provenance_handoff` that reads one entry, however many the Task
     * has, and none of the Task's other provenance.
     */
    readFirstHandoff: (id: string): Effect.Effect<Option.Option<TrackedHandoff>, SqlError> =>
      Effect.map(
        sql<{
          readonly signal_id: Uint8Array;
          readonly run_id: Uint8Array | null;
          readonly at: string;
        }>`
          SELECT p.signal_id, p.run_id, p.at
          FROM tasks t CROSS JOIN task_provenance p ON p.rowid = (
            SELECT rowid FROM task_provenance
            WHERE task_id = t.id AND signal_id IS NOT NULL
            ORDER BY at, rowid LIMIT 1)
          WHERE t.id = ${uuidFromString(id)} AND t.deleted_at IS NULL`,
        (rows) => {
          const row = rows[0];
          // A handoff entry always names the run it started.
          return row === undefined || row.run_id === null
            ? Option.none()
            : Option.some({
                signalId: uuidToString(row.signal_id),
                runId: uuidToString(row.run_id),
                at: row.at,
              });
        },
      ),

    /**
     * Returns, for each `{ runId, taskId }` pair, the handoff entry of the
     * Task `taskId` that started the run `runId`, with the Task's status and the
     * Task's next handoff entry. A pair whose Task is deleted, or has no
     * handoff entry for that run, is left out. The next handoff entry is the
     * one that follows this one by time, then by the order it was appended
     * (`at`, then `rowid`): the same order `readFirstHandoff` and `listTracked`
     * use. It is looked for among all the Task's handoff entries.
     *
     * One statement, and its work follows the pairs, never the handoffs of
     * their Tasks. Each pair finds its entry by the run and the Task on
     * `task_provenance_handoff_run`, then its Task by key, then the next entry
     * by seeking `task_provenance_handoff` (task, then time) just after the
     * entry, which reads one entry however long the Task's history is. The
     * pairs reach SQLite as one JSON text, so the statement does not grow
     * with the number of pairs.
     */
    listLegHandoffs: (
      pairs: ReadonlyArray<{ readonly runId: string; readonly taskId: string }>,
    ): Effect.Effect<ReadonlyArray<LegHandoff>, SqlError> =>
      pairs.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{
              readonly run_id: Uint8Array;
              readonly signal_id: Uint8Array;
              readonly task_id: Uint8Array;
              readonly status: TaskStatus;
              readonly next_run_id: Uint8Array | null;
              readonly next_signal_id: Uint8Array | null;
              readonly next_at: string | null;
            }>`
              SELECT p.run_id, p.signal_id, t.id AS task_id, t.status,
                     n.run_id AS next_run_id, n.signal_id AS next_signal_id, n.at AS next_at
              FROM json_each(${JSON.stringify(
                pairs.map((pair) => [
                  pair.runId.replaceAll("-", ""),
                  pair.taskId.replaceAll("-", ""),
                ]),
              )}) j
              CROSS JOIN task_provenance p ON p.run_id = unhex(json_extract(j.value, '$[0]'))
                                          AND p.signal_id IS NOT NULL
                                          AND p.task_id = unhex(json_extract(j.value, '$[1]'))
              CROSS JOIN tasks t ON t.id = p.task_id AND t.deleted_at IS NULL
              LEFT JOIN task_provenance n ON n.rowid = (
                SELECT s.rowid FROM task_provenance s
                WHERE s.task_id = p.task_id AND s.signal_id IS NOT NULL
                  AND (s.at, s.rowid) > (p.at, p.rowid)
                ORDER BY s.at, s.rowid LIMIT 1)`,
            (rows) =>
              rows.map((row) => ({
                runId: uuidToString(row.run_id),
                signalId: uuidToString(row.signal_id),
                taskId: uuidToString(row.task_id),
                taskStatus: row.status,
                // A handoff entry always names the run it started.
                ...(row.next_run_id === null || row.next_signal_id === null || row.next_at === null
                  ? {}
                  : {
                      next: {
                        signalId: uuidToString(row.next_signal_id),
                        runId: uuidToString(row.next_run_id),
                        at: row.next_at,
                      },
                    }),
              })),
          ),

    /**
     * Returns the cards of the Work board: the live Tasks at a board stage,
     * ordered by project (none first), then stage in the order of the board,
     * then rank. It returns one Task more than `limit` at most, so the caller
     * can tell that there were more.
     *
     * A Task of a deleted project is returned with no `projectId` and ordered
     * with the Tasks that have none, as `resolveCell` explains.
     *
     * One statement. It walks `tasks_board_rank` in its own order, which is
     * project, stage, rank, so it sorts nothing and stops after `limit + 1`
     * Tasks. The index leaves out finished and deleted Tasks, so the walk never
     * meets them. The index order puts stages in alphabetical order, so the
     * rows are put in board order afterwards, in memory. It reads no
     * description and no provenance. The statement names the index, because
     * left to itself the planner reads `tasks_stage` and sorts.
     */
    listBoardTasks: (limit: number): Effect.Effect<ReadonlyArray<BoardTask>, SqlError> =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly title: string;
          readonly stage: BoardStage;
          readonly priority: TaskPriority;
          readonly project_id: Uint8Array | null;
          readonly board_rank: string;
          readonly created_at: string;
          readonly stage_changed_at: string;
          readonly failed_run_id: Uint8Array | null;
        }>`
          SELECT t.id, t.title, t.stage, t.priority, p.id AS project_id, t.board_rank,
                 t.created_at, t.stage_changed_at, t.failed_run_id
          FROM tasks t INDEXED BY tasks_board_rank
          LEFT JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
          WHERE t.${sql.literal(ON_BOARD)} AND t.deleted_at IS NULL
          ORDER BY t.project_id, t.stage, t.board_rank
          LIMIT ${limit + 1}`,
        (rows) =>
          rows
            .map((row) => ({
              id: uuidToString(row.id),
              title: row.title,
              stage: row.stage,
              priority: row.priority,
              projectId: row.project_id === null ? undefined : uuidToString(row.project_id),
              boardRank: row.board_rank,
              createdAt: row.created_at,
              stageChangedAt: row.stage_changed_at,
              failedRunId: row.failed_run_id === null ? undefined : uuidToString(row.failed_run_id),
            }))
            .toSorted(compareBoardOrder),
      ),

    /**
     * Returns every Task that is not finished and has a handoff entry, the
     * most recently updated Task first. A Task is finished at `done` or
     * `dropped`; the other five stages are the board stages. Each Task holds
     * its newest handoff entries, at most `MAX_TRACKING_HANDOFFS`, newest
     * first: by time, then by the order they were appended, as in
     * `readFirstHandoff` and `listLegHandoffs`. A deleted Task is left out.
     *
     * One statement, and its work follows the unfinished Tasks, not the
     * handoffs ever made. It walks them on the stage index (one range per
     * stage), and for each one looks up the end of its range in
     * `task_provenance_handoff` (task, then time), so a Task that has no
     * handoff costs one probe, and a Task with thousands reads ten entries.
     * The handoffs of finished Tasks are never touched. `CROSS JOIN` makes
     * SQLite keep that order, because it never reorders one.
     */
    listTracked: (): Effect.Effect<ReadonlyArray<TrackedTask>, SqlError> =>
      Effect.map(
        sql<{
          readonly task_id: Uint8Array;
          readonly title: string;
          readonly updated_at: string;
          readonly signal_id: Uint8Array;
          readonly run_id: Uint8Array | null;
          readonly at: string;
          readonly appended: number;
        }>`
          SELECT t.id AS task_id, t.title, t.updated_at, p.signal_id, p.run_id, p.at,
                 p.rowid AS appended
          FROM tasks t CROSS JOIN task_provenance p ON p.rowid IN (
            SELECT rowid FROM task_provenance
            WHERE task_id = t.id AND signal_id IS NOT NULL
            ORDER BY at DESC, rowid DESC LIMIT ${MAX_TRACKING_HANDOFFS})
          WHERE t.stage IN ${sql.in(BOARD_STAGES)} AND t.deleted_at IS NULL`,
        (rows) => {
          const byTask = new Map<
            string,
            {
              id: string;
              title: string;
              updatedAt: string;
              handoffs: Array<TrackedHandoff & { readonly appended: number }>;
            }
          >();
          for (const row of rows) {
            // A handoff entry always names the run it started.
            if (row.run_id === null) continue;
            const id = uuidToString(row.task_id);
            const task = byTask.get(id);
            const handoff = {
              signalId: uuidToString(row.signal_id),
              runId: uuidToString(row.run_id),
              at: row.at,
              appended: row.appended,
            };
            if (task === undefined) {
              byTask.set(id, {
                id,
                title: row.title,
                updatedAt: row.updated_at,
                handoffs: [handoff],
              });
            } else {
              task.handoffs.push(handoff);
            }
          }
          return [...byTask.values()]
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
            .map(({ id, title, handoffs }) => ({
              id,
              title,
              handoffs: handoffs
                .toSorted((a, b) => b.at.localeCompare(a.at) || b.appended - a.appended)
                .map(({ signalId, runId, at }) => ({ signalId, runId, at })),
            }));
        },
      ),

    /**
     * Returns the active Task of a ref, or none: the Task with the lowest
     * `(linked_at, task_id)` among the Tasks that link the ref and are live.
     * Live means not deleted and not finished (`done` or `dropped`). Oldest
     * link wins, so a summary or any other update of a Task never changes the
     * answer. A Task cannot be merged into another yet; when merging exists,
     * both reads here must leave a merged Task out too.
     *
     * One statement that reads `task_entity_links_ref` in order and stops at
     * the first live Task, so its work follows the Tasks that link the ref.
     */
    findActiveTaskForRef: (ref: ExternalRef): Effect.Effect<Option.Option<Task>, SqlError> =>
      sql<TaskRow>`
        SELECT ${sql.literal(COLUMNS)}
        FROM task_entity_links l CROSS JOIN tasks ON tasks.id = l.task_id
        WHERE l.ref = ${ref} AND tasks.deleted_at IS NULL
          AND tasks.stage NOT IN ${sql.in(FINISHED_STAGES)}
        ORDER BY l.linked_at, l.task_id LIMIT 1`.pipe(
        Effect.flatMap(hydrate),
        Effect.map((found) => Option.fromNullishOr(found[0])),
      ),

    /**
     * Returns the active Task of each of `refs` that has one, by the rule of
     * `findActiveTaskForRef`, in one statement however many refs there are.
     * A ref with no active Task has no row.
     */
    listActiveTasksForRefs: (
      refs: ReadonlyArray<ExternalRef>,
    ): Effect.Effect<ReadonlyArray<ActiveTaskOnRef>, SqlError> =>
      refs.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{
              readonly ref: string;
              readonly id: Uint8Array;
              readonly title: string;
              readonly status: string;
              readonly stage: string;
            }>`
              SELECT ref, id, title, status, stage FROM (
                SELECT l.ref, tasks.id, tasks.title, tasks.status, tasks.stage,
                       ROW_NUMBER() OVER (PARTITION BY l.ref ORDER BY l.linked_at, l.task_id) AS position
                FROM task_entity_links l CROSS JOIN tasks ON tasks.id = l.task_id
                WHERE l.ref IN ${sql.in(refs)} AND tasks.deleted_at IS NULL
                  AND tasks.stage NOT IN ${sql.in(FINISHED_STAGES)}
              ) WHERE position = 1`,
            (rows) =>
              rows.map((row) => ({
                ref: row.ref,
                id: uuidToString(row.id),
                title: row.title,
                status: row.status as TaskStatus,
                stage: row.stage as TaskStage,
              })),
          ),

    /**
     * Returns what the Task has gathered since it was created, or none when
     * there is no such Task or it is deleted. Reads the Task by its own id.
     * Each answer comes from an index: the Thread and run checks use the
     * partial indexes on `sessions.task_id` and `runs.task_id`.
     */
    readTraces: (id: string): Effect.Effect<Option.Option<TaskTraces>, SqlError> =>
      Effect.map(
        sql<{
          readonly edited: number;
          readonly has_session: number;
          readonly has_run: number;
          readonly link_count: number;
        }>`
          SELECT tasks.updated_at <> tasks.created_at AS edited,
                 EXISTS (SELECT 1 FROM sessions WHERE sessions.task_id = tasks.id) AS has_session,
                 EXISTS (SELECT 1 FROM runs WHERE runs.task_id = tasks.id) AS has_run,
                 (SELECT count(*) FROM task_entity_links WHERE task_id = tasks.id) AS link_count
          FROM tasks WHERE tasks.id = ${uuidFromString(id)} AND tasks.deleted_at IS NULL`,
        (rows) => {
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                edited: row.edited === 1,
                hasSession: row.has_session === 1,
                hasRun: row.has_run === 1,
                linkCount: row.link_count,
              });
        },
      ),

    /**
     * Returns, for each open task (status `open` or `in-progress`, not
     * deleted) whose provenance carries one of `refs`, one row per ref it
     * carries. It reads only the columns of the row, never the description or
     * the provenance.
     *
     * One statement that starts from the ref index `task_provenance_ref`, so
     * its work follows the tasks that carry the refs, not the tasks or the
     * provenance entries there are. The unary `+` on the status keeps SQLite
     * from starting at the status index and scanning every open task.
     */
    listOpenOnRefs: (
      refs: ReadonlyArray<ExternalRef>,
    ): Effect.Effect<ReadonlyArray<OpenTaskOnRef>, SqlError> =>
      refs.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{
              readonly ref: string;
              readonly id: Uint8Array;
              readonly title: string;
              readonly status: string;
              readonly updated_at: string;
            }>`
              SELECT DISTINCT p.ref, t.id, t.title, t.status, t.updated_at
              FROM task_provenance p JOIN tasks t ON t.id = p.task_id
              WHERE p.ref IN ${sql.in(refs)}
                AND +t.status IN ('open', 'in-progress') AND t.deleted_at IS NULL`,
            (rows) =>
              rows.map((row) => ({
                ref: row.ref,
                id: uuidToString(row.id),
                title: row.title,
                status: row.status as TaskStatus,
                updatedAt: row.updated_at,
              })),
          ),

    /**
     * Returns the id of the Task that the workspace's row in `task_workspaces`
     * names, or none when the workspace has no row or the Task is deleted or
     * finished (the contract's `FINISHED_STAGES`). One query that joins the
     * row to its Task. Only an ephemeral workspace ever has a row
     * (`recordWorkspaceTask`), so a main workspace always reads as none.
     */
    readJoinableTaskIdOfWorkspace: (
      workspaceId: string,
    ): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly task_id: Uint8Array }>`
          SELECT w.task_id FROM task_workspaces w JOIN tasks ON tasks.id = w.task_id
          WHERE w.workspace_id = ${uuidFromString(workspaceId)}
            AND tasks.deleted_at IS NULL AND tasks.stage NOT IN ${sql.in(FINISHED_STAGES)}`,
        (rows) => {
          const row = rows[0];
          return row === undefined ? Option.none() : Option.some(uuidToString(row.task_id));
        },
      ),

    /**
     * Records that the workspace belongs to the Task, replacing the row the
     * workspace already has. A row that names a finished Task is replaced this
     * way when the workspace is used again.
     *
     * Writes a row only for an ephemeral workspace: a main workspace is shared
     * by whatever runs in it, so it has no Task of its own. A workspace that no
     * longer exists writes nothing either. This is the one place that reads the
     * workspace's `kind`. The repository reads this one column of a table it
     * does not own, as `projectExists` reads `projects`.
     */
    recordWorkspaceTask: (
      workspaceId: string,
      taskId: string,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO task_workspaces (workspace_id, task_id, joined_at)
        SELECT id, ${uuidFromString(taskId)}, ${at} FROM workspaces
        WHERE id = ${uuidFromString(workspaceId)} AND kind = 'ephemeral'
        ON CONFLICT (workspace_id) DO UPDATE SET task_id = excluded.task_id,
                                                 joined_at = excluded.joined_at`),

    /** Returns true if a project exists and has not been deleted. */
    projectExists: isLiveProject,

    /** Writes a new task and its first provenance entries. */
    insert: (task: NewTask): Effect.Effect<Task, SqlError> =>
      Effect.gen(function* () {
        const id = task.id === undefined ? mintUuid() : uuidFromString(task.id);
        // A new Task goes last in its cell, so no card the user is looking at moves.
        const boardRank = yield* chooseLastRankOfCell({
          projectId: task.projectId ?? null,
          stage: task.stage,
        });
        yield* sql`
          INSERT INTO tasks
            (id, title, description, status, stage, priority, labels, project_id,
             created_at, updated_at, status_changed_at, stage_changed_at, board_rank)
          VALUES
            (${id}, ${task.title}, ${task.description}, ${task.status}, ${task.stage}, ${task.priority},
             ${JSON.stringify(task.labels)},
             ${task.projectId === undefined ? null : uuidFromString(task.projectId)},
             ${task.at}, ${task.at}, ${task.at}, ${task.at}, ${boardRank})
        `;
        yield* insertProvenance(id, task.provenance, task.at, task.actor);
        yield* insertLinks(id, task.provenance, {
          at: task.at,
          actor: task.actor,
          following: task.following ?? false,
        });
        return {
          id: uuidToString(id),
          title: task.title,
          description: task.description,
          status: task.status,
          stage: task.stage,
          priority: task.priority,
          labels: task.labels,
          ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
          provenance: task.provenance.map((entry) => ({
            ...entry,
            at: task.at,
            actor: task.actor,
          })),
          createdAt: task.at,
          updatedAt: task.at,
          statusChangedAt: task.at,
          stageChangedAt: task.at,
        };
      }),

    /**
     * Applies an edit and appends provenance. Only the columns in the edit are
     * written, which also means that a change to anything other than the title
     * or the description does not touch the full-text index.
     */
    update: (
      id: string,
      edit: TaskEdit,
      provenance: ReadonlyArray<ProvenanceInput>,
      at: string,
      actor: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(id);
        const sets = [sql`updated_at = ${at}`];
        if (edit.title !== undefined) sets.push(sql`title = ${edit.title}`);
        if (edit.description !== undefined) sets.push(sql`description = ${edit.description}`);
        if (edit.priority !== undefined) sets.push(sql`priority = ${edit.priority}`);
        if (edit.labels !== undefined) sets.push(sql`labels = ${JSON.stringify(edit.labels)}`);
        if (edit.projectId !== undefined) {
          sets.push(
            sql`project_id = ${edit.projectId === null ? null : uuidFromString(edit.projectId)}`,
          );
        }
        if (edit.status !== undefined) {
          sets.push(sql`status = ${edit.status}`, sql`status_changed_at = ${at}`);
        }
        if (edit.stage !== undefined) {
          sets.push(sql`stage = ${edit.stage}`, sql`stage_changed_at = ${at}`);
          // Done and Drop change who handles a failure: the board stops
          // listing the Task, and no earlier Undo may bring a failure back.
          if (isFinishedStage(edit.stage)) sets.push(sql`failure_revision = failure_revision + 1`);
        }
        if (edit.boardRank !== undefined) sets.push(sql`board_rank = ${edit.boardRank}`);
        yield* sql`UPDATE tasks SET ${sql.csv(sets)} WHERE id = ${key}`;
        yield* insertProvenance(key, provenance, at, actor);
        yield* insertLinks(key, provenance, { at, actor, following: false });
      }),

    /** Marks the task deleted. The row and its provenance stay where they are. */
    softDelete: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`UPDATE tasks SET deleted_at = ${at} WHERE id = ${uuidFromString(id)}`),

    /** Returns one page of the tasks that match a filter, in the requested order. */
    list: (
      filter: TaskFilter,
      request: TaskPageRequest,
    ): Effect.Effect<Page<Task>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const where = buildConditions(filter);

        if (request.order._tag === "relevance") {
          const match = buildMatchExpression(request.order.text);
          if (match === undefined) return { items: [], nextCursor: undefined };
          const scope = buildRelevanceScope(filter, match);
          const offset =
            request.cursor === undefined ? 0 : yield* decodeOffsetCursor(request.cursor, scope);
          // The relevance order is bm25's, which is most negative first.
          const rows = yield* sql<TaskRow>`
            SELECT ${sql.literal(COLUMNS)}
            FROM tasks_fts JOIN tasks ON tasks.rowid = tasks_fts.rowid
            WHERE tasks_fts MATCH ${match} AND ${where}
            ORDER BY bm25(tasks_fts), tasks.id
            LIMIT ${request.limit + 1} OFFSET ${offset}
          `;
          // The next page resumes by counting rows, not from the last row, so
          // the cursor does not depend on that row.
          return yield* buildPage(rows, request.limit, hydrate, () =>
            encodeOffsetCursor(scope, offset + request.limit),
          );
        }

        const { keyset, order, encodeNextCursor } = yield* prepareKeysetListing(
          sql,
          "task.query",
          request.order.sort,
          TASK_SORT_COLUMNS,
          "tasks.id",
          request.cursor,
        );
        const rows = yield* sql<TaskRow>`
          SELECT ${sql.literal(COLUMNS)} FROM tasks
          WHERE ${where} AND ${keyset} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(rows, request.limit, hydrate, encodeNextCursor);
      }),
  };
});

/** Everything the task service reads and writes. */
export const taskRepository = make;
