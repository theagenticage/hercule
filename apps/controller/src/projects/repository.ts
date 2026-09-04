/**
 * Project rows. Nothing here decides policy - who may write, what a change
 * means, what gets logged - it only reads and writes.
 *
 * One walk answers a listing: a keyset over one sortable column plus the id,
 * which the partial indexes on `projects` serve. There is no search and no
 * filter, so there is no second walk.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Project, SortDirection } from "@hydra/contract";
import {
  decodeCursor,
  encodeCursor,
  mintUuid,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** The column a keyset walk orders by. */
export type ProjectSortField = "name" | "createdAt" | "updatedAt";

/** What a listing asks for. */
export interface ProjectPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly field: ProjectSortField;
  readonly direction: SortDirection;
}

/** Everything a new project row holds. */
export interface NewProject {
  readonly name: string;
  readonly description: string | undefined;
  readonly at: string;
}

/** The columns an edit may set. An absent one is left as it was. */
export interface ProjectEdit {
  readonly name?: string;
  readonly description?: string | null;
}

interface ProjectRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly description: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

const COLUMNS = "id, name, description, created_at, updated_at, deleted_at";

const SORT_COLUMN: Record<ProjectSortField, string> = {
  name: "name",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const scopeOf = (field: ProjectSortField, direction: SortDirection): CursorScope => ({
  op: "project.query",
  field,
  direction,
});

const toProject = (row: ProjectRow): Project => ({
  id: uuidToString(row.id),
  name: row.name,
  ...(row.description === null ? {} : { description: row.description }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
});

const sortKeyOf = (project: Project, field: ProjectSortField): string => {
  switch (field) {
    case "name":
      return project.name;
    case "createdAt":
      return project.createdAt;
    case "updatedAt":
      return project.updatedAt;
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** The project with that id, unless it has been deleted. */
    live: (id: string): Effect.Effect<Option.Option<Project>, SqlError> =>
      Effect.map(
        sql<ProjectRow>`SELECT ${sql.literal(COLUMNS)} FROM projects
                        WHERE id = ${uuidFromString(id)} AND deleted_at IS NULL`,
        (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toProject)),
      ),

    /** Writes a new project. */
    insert: (project: NewProject): Effect.Effect<Project, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO projects (id, name, description, created_at, updated_at)
          VALUES (${id}, ${project.name}, ${project.description ?? null},
                  ${project.at}, ${project.at})
        `;
        return {
          id: uuidToString(id),
          name: project.name,
          ...(project.description === undefined ? {} : { description: project.description }),
          createdAt: project.at,
          updatedAt: project.at,
        };
      }),

    /** Applies an edit. Only the columns the edit names are written. */
    update: (id: string, edit: ProjectEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.name !== undefined) sets.push(sql`name = ${edit.name}`);
      if (edit.description !== undefined) sets.push(sql`description = ${edit.description}`);
      return Effect.asVoid(
        sql`UPDATE projects SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /**
     * Marks the project deleted. The row stays, and so does every task and
     * every resource link that names it.
     */
    softDelete: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`UPDATE projects SET deleted_at = ${at} WHERE id = ${uuidFromString(id)}`),

    /** One page of the live projects, in the order the request asks for. */
    list: (request: ProjectPageRequest): Effect.Effect<Page<Project>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = scopeOf(request.field, request.direction);
        const column = sql.literal(SORT_COLUMN[request.field]);
        const after =
          request.cursor === undefined ? undefined : yield* decodeCursor(request.cursor, scope);
        const ascending = request.direction === "asc";
        const keyset =
          after === undefined
            ? sql`1 = 1`
            : ascending
              ? sql`(${column}, id) > (${after[0]}, ${uuidFromString(after[1])})`
              : sql`(${column}, id) < (${after[0]}, ${uuidFromString(after[1])})`;
        const order = ascending
          ? sql`ORDER BY ${column} ASC, id ASC`
          : sql`ORDER BY ${column} DESC, id DESC`;
        // One row more than asked for: whether it came back is whether there is
        // a next page, which is why no count query is needed to know.
        const rows = yield* sql<ProjectRow>`
          SELECT ${sql.literal(COLUMNS)} FROM projects
          WHERE deleted_at IS NULL AND ${keyset} ${order} LIMIT ${request.limit + 1}
        `;
        const items = rows.slice(0, request.limit).map(toProject);
        const last = items[items.length - 1];
        return {
          items,
          nextCursor:
            rows.length > request.limit && last !== undefined
              ? encodeCursor(scope, sortKeyOf(last, request.field), last.id)
              : undefined,
        };
      }),
  };
});

/** Everything the project service reads and writes. */
export const projectRepository = make;
