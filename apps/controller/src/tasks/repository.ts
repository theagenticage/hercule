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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  ExternalRef,
  ProvenanceEntry,
  Task,
  TaskPriority,
  TaskStatus,
} from "@hercule/contract";
import {
  decodeCursor,
  decodeOffsetCursor,
  encodeCursor,
  encodeOffsetCursor,
  buildKeyset,
  mintUuid,
  buildPage,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
  type ResolvedSortKey,
  type SortableField,
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
}

/** A field a keyset listing can order by. */
export type TaskSortField = "updatedAt" | "createdAt" | "priority" | "status";

/**
 * How a listing is ordered: by a column, or by how well each row matches the
 * search text.
 */
export type TaskOrder =
  | { readonly _tag: "column"; readonly keys: ReadonlyArray<ResolvedSortKey<TaskSortField>> }
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
}

/** The fields of a new task row, with the defaults already applied. */
export interface NewTask {
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
  readonly at: string;
  readonly actor: string;
}

const COLUMNS =
  "tasks.id, tasks.title, tasks.description, tasks.status, tasks.priority, tasks.labels, " +
  "tasks.project_id, tasks.created_at, tasks.updated_at, tasks.status_changed_at, tasks.deleted_at";

/** The rank of each priority, lowest first, as the priority sort stores it. */
const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** The rank of each status, in the order work moves through them, as the status sort stores it. */
const STATUS_RANK: Record<TaskStatus, number> = {
  open: 0,
  "in-progress": 1,
  done: 2,
  cancelled: 3,
};

/**
 * The sortable fields of a task listing, and how each one sorts. Priority and
 * status order by their rank rather than alphabetically, so their column is a
 * `CASE` expression, written exactly as the index in migration 0041 writes it;
 * any other expression would sort every page in memory, with no error. The
 * ranks read from a task match the ranks the expressions compute, so a cursor
 * resumes on the same value the index holds.
 *
 * It is exported for the test of migration 0041, which checks that these
 * expressions are served by that migration's indexes.
 */
export const TASK_SORT_COLUMNS: Record<TaskSortField, SortableField<Task>> = {
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
    column: "CASE priority WHEN 'low' THEN 0 WHEN 'normal' THEN 1 WHEN 'high' THEN 2 ELSE 3 END",
    valueType: "number",
    readValue: (task) => PRIORITY_RANK[task.priority],
  },
  status: {
    column:
      "CASE status WHEN 'open' THEN 0 WHEN 'in-progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END",
    valueType: "number",
    readValue: (task) => STATUS_RANK[task.status],
  },
};

/**
 * Builds the `MATCH` expression for a caller's plain words.
 *
 * - Every token is quoted, so `AND`, `OR` and a stray bracket are search terms
 *   rather than syntax.
 * - Tokens are joined with `AND`, so each extra word narrows the search, as a
 *   search box suggests.
 * - The text is split on everything that is not a letter or a digit, so no
 *   token contains a character that needs escaping.
 *
 * Returns `undefined` when the text contains no word at all. The index holds
 * no punctuation either, so such a search can match nothing.
 */
const buildMatchExpression = (text: string): string | undefined => {
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
  return tokens.length === 0 ? undefined : tokens.map((token) => `"${token}"`).join(" AND ");
};

const buildColumnScope = (keys: ReadonlyArray<ResolvedSortKey<TaskSortField>>): CursorScope => ({
  op: "task.query",
  sort: keys,
});

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
    if (filter.status !== undefined) clauses.push(buildAnyOfClause("tasks.status", filter.status));
    if (filter.projectId !== undefined) {
      clauses.push(sql`tasks.project_id = ${uuidFromString(filter.projectId)}`);
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
            SELECT task_id, ref, event_id, run_id, at, actor FROM task_provenance
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
        INSERT INTO task_provenance (id, task_id, ref, event_id, run_id, at, actor)
        VALUES (${mintUuid()}, ${taskId}, ${entry.ref ?? null}, ${entry.eventId ?? null},
                ${entry.runId === undefined ? null : uuidFromString(entry.runId)}, ${at}, ${actor})
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
        const id = mintUuid();
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

        const { keys } = request.order;
        const scope = buildColumnScope(keys);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(
                request.cursor,
                scope,
                keys.map(({ field }) => TASK_SORT_COLUMNS[field].valueType),
              );
        const { keyset, order } = buildKeyset(
          sql,
          keys.map(({ field, direction }) => ({
            column: TASK_SORT_COLUMNS[field].column,
            direction,
          })),
          ["tasks.id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const rows = yield* sql<TaskRow>`
          SELECT ${sql.literal(COLUMNS)} FROM tasks
          WHERE ${where} AND ${keyset} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(rows, request.limit, hydrate, (last) =>
          encodeCursor(
            scope,
            keys.map(({ field }) => TASK_SORT_COLUMNS[field].readValue(last)),
            last.id,
          ),
        );
      }),
  };
});

/** Everything the task service reads and writes. */
export const taskRepository = make;
