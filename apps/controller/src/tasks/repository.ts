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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MAX_TRACKING_HANDOFFS } from "@hercule/contract";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  ExternalRef,
  ProvenanceEntry,
  Task,
  TaskPriority,
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

/**
 * The filter of a listing. A task matches a field if it has any of the
 * field's values, and it must match every field.
 */
export interface TaskFilter {
  readonly refs?: ReadonlyArray<ExternalRef>;
  readonly labels?: ReadonlyArray<string>;
  readonly status?: ReadonlyArray<TaskStatus>;
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

/** A Task that Tracking follows, with its newest handoffs, newest first. */
export interface TrackedTask {
  readonly id: string;
  readonly title: string;
  readonly handoffs: ReadonlyArray<TrackedHandoff>;
}

/** The fields of a new task row, with the defaults already applied. */
export interface NewTask {
  /** The task's id, when the caller chose it; a new one is made when absent. */
  readonly id?: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly labels: ReadonlyArray<string>;
  readonly projectId: string | undefined;
  readonly provenance: ReadonlyArray<ProvenanceInput>;
  readonly at: string;
  readonly actor: string;
}

/** The columns an edit may set. An absent one is left as it was. */
export interface TaskEdit {
  readonly title?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority;
  readonly projectId?: string | null;
  readonly labels?: ReadonlyArray<string>;
}

interface TaskRow {
  readonly id: Uint8Array;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly priority: string;
  readonly labels: string;
  readonly project_id: Uint8Array | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly status_changed_at: string;
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
  "tasks.id, tasks.title, tasks.description, tasks.status, tasks.priority, tasks.labels, " +
  "tasks.project_id, tasks.created_at, tasks.updated_at, tasks.status_changed_at, tasks.deleted_at";

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
        filter.projectId ?? null,
        filter.handedOff ?? null,
      ])}`,
      direction: "asc",
    },
  ],
});

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
                priority: row.priority as TaskPriority,
                labels: JSON.parse(row.labels) as ReadonlyArray<string>,
                ...(row.project_id === null ? {} : { projectId: uuidToString(row.project_id) }),
                provenance: byTask.get(id) ?? [],
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                statusChangedAt: row.status_changed_at,
                ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
              };
            });
          },
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

  return {
    /** Returns the task with that id, or none if it does not exist or has been deleted. */
    live: (id: string): Effect.Effect<Option.Option<Task>, SqlError> =>
      sql<TaskRow>`SELECT ${sql.literal(COLUMNS)} FROM tasks
                   WHERE tasks.id = ${uuidFromString(id)} AND tasks.deleted_at IS NULL`.pipe(
        Effect.flatMap(hydrate),
        Effect.map((tasks) => Option.fromNullishOr(tasks[0])),
      ),

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
     * Returns every in-progress task that has a handoff entry, the most
     * recently updated task first. Each task holds its newest handoff entries,
     * at most `MAX_TRACKING_HANDOFFS`, newest first: by time, then by the
     * order they were appended, as in `readFirstHandoff` and
     * `listLegHandoffs`. A deleted task is left out.
     *
     * One statement, and its work follows the in-progress tasks, not the
     * handoffs ever made. It walks the in-progress tasks on the status index,
     * and for each one looks up the end of its range in
     * `task_provenance_handoff` (task, then time), so a task that has no
     * handoff costs one probe, and a task with thousands reads ten entries.
     * The handoffs of tasks that are done are never touched. `CROSS JOIN`
     * makes SQLite keep that order, because it never reorders one.
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
          WHERE t.status = 'in-progress' AND t.deleted_at IS NULL`,
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

    /** Returns true if a project exists and has not been deleted. */
    projectExists: (id: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`SELECT id FROM projects
                                         WHERE id = ${uuidFromString(id)} AND deleted_at IS NULL`,
        (rows) => rows.length === 1,
      ),

    /** Writes a new task and its first provenance entries. */
    insert: (task: NewTask): Effect.Effect<Task, SqlError> =>
      Effect.gen(function* () {
        const id = task.id === undefined ? mintUuid() : uuidFromString(task.id);
        yield* sql`
          INSERT INTO tasks
            (id, title, description, status, priority, labels, project_id,
             created_at, updated_at, status_changed_at)
          VALUES
            (${id}, ${task.title}, ${task.description}, ${task.status}, ${task.priority},
             ${JSON.stringify(task.labels)},
             ${task.projectId === undefined ? null : uuidFromString(task.projectId)},
             ${task.at}, ${task.at}, ${task.at})
        `;
        yield* insertProvenance(id, task.provenance, task.at, task.actor);
        return {
          id: uuidToString(id),
          title: task.title,
          description: task.description,
          status: task.status,
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
        yield* sql`UPDATE tasks SET ${sql.csv(sets)} WHERE id = ${key}`;
        yield* insertProvenance(key, provenance, at, actor);
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
