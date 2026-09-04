/**
 * Task rows, their provenance children, and the full-text index over them.
 *
 * The store speaks the contract's `Task`: a row and its provenance entries are
 * one value everywhere above this module, because that is what a caller reads
 * and what a `task.created` event carries. Nothing here decides policy - who
 * may write, what a change means, what gets logged - it only reads and writes.
 *
 * Two walks answer a listing. Without a search text the walk is a keyset over
 * one sortable column plus the id, which the partial indexes on `tasks` serve.
 * With one it is the full-text index ordered by relevance, and a rank no row
 * carries cannot be resumed from, so that walk pages by offset instead.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Statement } from "effect/unstable/sql/Statement";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  ExternalRef,
  ProvenanceEntry,
  SortDirection,
  Task,
  TaskPriority,
  TaskStatus,
} from "@hydra/contract";
import {
  decodeCursor,
  decodeOffsetCursor,
  encodeCursor,
  encodeOffsetCursor,
  mintUuid,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
  type SortKey,
} from "../db";

/** What narrows a listing. Values within a field are any-of, fields are and-ed. */
export interface TaskFilter {
  readonly refs?: ReadonlyArray<ExternalRef>;
  readonly labels?: ReadonlyArray<string>;
  readonly status?: ReadonlyArray<TaskStatus>;
  readonly projectId?: string;
}

/** The column a keyset walk orders by. */
export type TaskSortField = "updatedAt" | "createdAt" | "priority" | "status";

/**
 * How a listing is ordered: by a column, or by how well each row matches the
 * search text.
 */
export type TaskOrder =
  | { readonly _tag: "column"; readonly field: TaskSortField; readonly direction: SortDirection }
  | { readonly _tag: "relevance"; readonly text: string };

/** What a listing asks for beyond its filter. */
export interface TaskPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly order: TaskOrder;
}

/** A provenance entry as the caller hands it over, before it is stamped. */
export interface ProvenanceInput {
  readonly ref?: ExternalRef;
  readonly eventId?: number;
  readonly runId?: string;
}

/** Everything a new task row holds; the defaults are already applied. */
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

/** The column, or the expression, each sortable field orders by. */
const SORT_COLUMN: Record<TaskSortField, string> = {
  updatedAt: "tasks.updated_at",
  createdAt: "tasks.created_at",
  priority: "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END",
  status: "tasks.status",
};

/** The rank the priority index stores, so a cursor resumes on the same value. */
const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** The value a row hands the next cursor, in the type its column compares as. */
const sortKeyOf = (task: Task, field: TaskSortField): SortKey => {
  switch (field) {
    case "updatedAt":
      return task.updatedAt;
    case "createdAt":
      return task.createdAt;
    case "priority":
      return PRIORITY_RANK[task.priority];
    case "status":
      return task.status;
  }
};

/**
 * The `MATCH` expression for a caller's plain words: every token quoted, so
 * `AND`, `OR` and a stray bracket are terms rather than syntax, and joined with
 * `AND`, so a search narrows the way a search box implies. Splitting on
 * everything that is not a letter or a digit leaves no character inside a token
 * that would need escaping. `undefined` when the text holds no word at all: the
 * index holds no punctuation either, so such a search can match nothing.
 */
const matchExpression = (text: string): string | undefined => {
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
  return tokens.length === 0 ? undefined : tokens.map((token) => `"${token}"`).join(" AND ");
};

/**
 * The walk a cursor belongs to.
 *
 * A relevance walk resumes by counting rows rather than by comparing a key, so
 * a count from one result set means nothing in another: its scope has to name
 * everything the result set depends on, which is the terms it matched and the
 * filter it ran under. The terms are the expression rather than the text a
 * caller typed, so trimming the search box between pages keeps the walk.
 */
const columnScope = (field: TaskSortField, direction: SortDirection): CursorScope => ({
  op: "task.query",
  field,
  direction,
});

const relevanceScope = (filter: TaskFilter, match: string): CursorScope => ({
  op: "task.query",
  field: `relevance:${JSON.stringify([
    match,
    filter.refs ?? null,
    filter.labels ?? null,
    filter.status ?? null,
    filter.projectId ?? null,
  ])}`,
  direction: "asc",
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** `IN` over a list, and the empty list is the condition that matches nothing. */
  const anyOf = (column: string, values: ReadonlyArray<unknown>) =>
    values.length === 0 ? sql`1 = 0` : sql`${sql.literal(column)} IN ${sql.in(values)}`;

  const conditions = (filter: TaskFilter) => {
    const clauses = [sql`tasks.deleted_at IS NULL`];
    if (filter.status !== undefined) clauses.push(anyOf("tasks.status", filter.status));
    if (filter.projectId !== undefined) {
      clauses.push(sql`tasks.project_id = ${uuidFromString(filter.projectId)}`);
    }
    if (filter.labels !== undefined) {
      clauses.push(
        sql`EXISTS (SELECT 1 FROM json_each(tasks.labels) WHERE ${anyOf("value", filter.labels)})`,
      );
    }
    if (filter.refs !== undefined) {
      clauses.push(
        // Driven from the ref rather than from the task: a correlated EXISTS
        // makes SQLite scan every live task and probe provenance once each,
        // where this seeks `task_provenance_ref` first and then the few ids it
        // names. The duplicate-signal check runs before every triage.
        sql`tasks.id IN (SELECT p.task_id FROM task_provenance p
                         WHERE ${anyOf("p.ref", filter.refs)})`,
      );
    }
    return sql.and(clauses);
  };

  /**
   * The tasks of one page with their provenance, in append order. One query for
   * the entries of every task on the page: a query per task would put the page
   * size into the round trip count.
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

  /** One page of rows, and whether the walk has another. */
  const walk = (
    statement: Statement<TaskRow>,
    limit: number,
  ): Effect.Effect<{ rows: ReadonlyArray<TaskRow>; more: boolean }, SqlError> =>
    Effect.map(statement, (rows) => ({ rows: rows.slice(0, limit), more: rows.length > limit }));

  return {
    /** The task with that id, unless it has been deleted. */
    live: (id: string): Effect.Effect<Option.Option<Task>, SqlError> =>
      sql<TaskRow>`SELECT ${sql.literal(COLUMNS)} FROM tasks
                   WHERE tasks.id = ${uuidFromString(id)} AND tasks.deleted_at IS NULL`.pipe(
        Effect.flatMap(hydrate),
        Effect.map((tasks) => Option.fromNullishOr(tasks[0])),
      ),

    /** Whether a project exists and has not been deleted. */
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
     * Applies an edit and appends provenance. Only the columns the edit names
     * are written, which is also what keeps a change of anything but the title
     * or the description out of the full-text index.
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

    /** One page of the tasks a filter matches, in the order the request asks for. */
    list: (
      filter: TaskFilter,
      request: TaskPageRequest,
    ): Effect.Effect<Page<Task>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const where = conditions(filter);

        if (request.order._tag === "relevance") {
          const match = matchExpression(request.order.text);
          if (match === undefined) return { items: [], nextCursor: undefined };
          const scope = relevanceScope(filter, match);
          const offset =
            request.cursor === undefined ? 0 : yield* decodeOffsetCursor(request.cursor, scope);
          // The relevance order is bm25's, which is most negative first.
          const page = yield* walk(
            sql<TaskRow>`
              SELECT ${sql.literal(COLUMNS)}
              FROM tasks_fts JOIN tasks ON tasks.rowid = tasks_fts.rowid
              WHERE tasks_fts MATCH ${match} AND ${where}
              ORDER BY bm25(tasks_fts), tasks.id
              LIMIT ${request.limit + 1} OFFSET ${offset}
            `,
            request.limit,
          );
          return {
            items: yield* hydrate(page.rows),
            nextCursor: page.more ? encodeOffsetCursor(scope, offset + request.limit) : undefined,
          };
        }

        const { field, direction } = request.order;
        const scope = columnScope(field, direction);
        const column = sql.literal(SORT_COLUMN[field]);
        const after =
          request.cursor === undefined ? undefined : yield* decodeCursor(request.cursor, scope);
        const ascending = direction === "asc";
        const keyset =
          after === undefined
            ? sql`1 = 1`
            : ascending
              ? sql`(${column}, tasks.id) > (${after[0]}, ${uuidFromString(after[1])})`
              : sql`(${column}, tasks.id) < (${after[0]}, ${uuidFromString(after[1])})`;
        const order = ascending
          ? sql`ORDER BY ${column} ASC, tasks.id ASC`
          : sql`ORDER BY ${column} DESC, tasks.id DESC`;
        // One row more than asked for: whether it came back is whether there is
        // a next page, which is why no count query is needed to know.
        const page = yield* walk(
          sql<TaskRow>`
            SELECT ${sql.literal(COLUMNS)} FROM tasks
            WHERE ${where} AND ${keyset} ${order} LIMIT ${request.limit + 1}
          `,
          request.limit,
        );
        const items = yield* hydrate(page.rows);
        const last = items[items.length - 1];
        return {
          items,
          nextCursor:
            page.more && last !== undefined
              ? encodeCursor(scope, sortKeyOf(last, field), last.id)
              : undefined,
        };
      }),
  };
});

/** Everything the task service reads and writes. */
export const taskRepository = make;
