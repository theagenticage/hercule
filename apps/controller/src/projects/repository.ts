/**
 * Reads and writes project rows. Nothing here decides policy - who may write,
 * what a change means, what gets logged.
 *
 * A list is one keyset query over one sortable column plus the id, which the
 * partial indexes on `projects` cover. There is no search and no filter, so no
 * other query is needed.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Project, SortDirection } from "@hercule/contract";
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

/** The column a project list is sorted by. */
export type ProjectSortField = "name" | "createdAt" | "updatedAt";

/** The page size, cursor and sort order of a project list. */
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

/** The columns an edit may set. A column that is absent is left unchanged. */
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

const buildCursorScope = (field: ProjectSortField, direction: SortDirection): CursorScope => ({
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

const readSortKey = (project: Project, field: ProjectSortField): string => {
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
    /** Returns the project with that id, or `None` if there is none or it has been deleted. */
    live: (id: string): Effect.Effect<Option.Option<Project>, SqlError> =>
      Effect.map(
        sql<ProjectRow>`SELECT ${sql.literal(COLUMNS)} FROM projects
                        WHERE id = ${uuidFromString(id)} AND deleted_at IS NULL`,
        (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toProject)),
      ),

    /** Inserts a new project and returns it. */
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

    /** Applies an edit. Only the columns set in the edit are written, plus `updated_at`. */
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
     * every resource link that refers to it.
     */
    softDelete: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`UPDATE projects SET deleted_at = ${at} WHERE id = ${uuidFromString(id)}`),

    /**
     * Returns one page of the projects that are not deleted, in the requested
     * order. Fails with a `CursorError` if the cursor is invalid.
     */
    list: (request: ProjectPageRequest): Effect.Effect<Page<Project>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.field, request.direction);
        // Every sortable column of a project holds text.
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = buildKeyset(
          sql,
          [SORT_COLUMN[request.field], "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const rows = yield* sql<ProjectRow>`
          SELECT ${sql.literal(COLUMNS)} FROM projects
          WHERE deleted_at IS NULL AND ${keyset} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toProject)),
          (last) => encodeCursor(scope, readSortKey(last, request.field), last.id),
        );
      }),
  };
});

/** The repository for project rows, used by the project service. */
export const projectRepository = make;
