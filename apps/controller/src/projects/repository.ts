/**
 * Reads and writes project rows. Nothing here decides policy - who may write,
 * what a change means, what gets logged.
 *
 * A list is one keyset query over the caller's sort columns plus the id. A
 * list sorted by one column is served by the partial indexes on `projects`;
 * a list sorted by several columns is sorted in memory, which is fine for the
 * few projects anyone has. There is no search and no filter, so no other query
 * is needed.
 */
import type * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Project } from "@hercule/contract";
import {
  mintUuid,
  buildPage,
  prepareKeysetListing,
  uuidFromString,
  uuidHexToString,
  uuidToString,
  type CursorError,
  type Page,
  type ResolvedSortKey,
  type SortColumn,
} from "../db";

/** A field a project list can be sorted by. */
export type ProjectSortField = "name" | "createdAt" | "updatedAt";

/**
 * The page size, cursor and sort keys of a project list. `sort` holds the
 * keys most significant first, with their directions resolved.
 */
export interface ProjectPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly sort: Arr.NonEmptyReadonlyArray<ResolvedSortKey<ProjectSortField>>;
}

/** Everything a new project row holds. */
export interface NewProject {
  readonly name: string;
  readonly description: string | undefined;
  readonly modelProfileId?: string | undefined;
  /** The ids of the MCP Servers the project starts a Thread with, in order. */
  readonly mcpServerIds: ReadonlyArray<string>;
  readonly at: string;
}

/** The columns an edit may set. A column that is absent is left unchanged. */
export interface ProjectEdit {
  readonly name?: string;
  readonly description?: string | null;
  readonly modelProfileId?: string | null;
}

interface ProjectRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly description: string | null;
  readonly model_profile_id: Uint8Array | null;
  /** A JSON array of the hex of each MCP Server id, in list order. */
  readonly mcp_server_ids: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

// The list is one subquery, so a page of projects costs one query.
const COLUMNS =
  "id, name, description, model_profile_id, created_at, updated_at, deleted_at, " +
  "(SELECT json_group_array(hex(mcp_server_id)) FROM (SELECT mcp_server_id " +
  "FROM project_mcp_servers WHERE project_id = projects.id ORDER BY position)) AS mcp_server_ids";

/** How a project list sorts by each of its sortable fields. */
const PROJECT_SORT_COLUMNS: Record<ProjectSortField, SortColumn<Project>> = {
  name: { column: "name", valueType: "string", readValue: (project) => project.name },
  createdAt: {
    column: "created_at",
    valueType: "string",
    readValue: (project) => project.createdAt,
  },
  updatedAt: {
    column: "updated_at",
    valueType: "string",
    readValue: (project) => project.updatedAt,
  },
};

const toProject = (row: ProjectRow): Project => ({
  id: uuidToString(row.id),
  name: row.name,
  ...(row.description === null ? {} : { description: row.description }),
  ...(row.model_profile_id === null ? {} : { modelProfileId: uuidToString(row.model_profile_id) }),
  mcpServerIds: (JSON.parse(row.mcp_server_ids) as ReadonlyArray<string>).map(uuidHexToString),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Writes the project's list of MCP Servers, one row per id, at the position given. */
  const insertMcpServers = (
    projectId: Uint8Array,
    mcpServerIds: ReadonlyArray<string>,
  ): Effect.Effect<void, SqlError> =>
    Effect.forEach(
      mcpServerIds,
      (mcpServerId, position) =>
        sql`INSERT INTO project_mcp_servers (project_id, position, mcp_server_id)
            VALUES (${projectId}, ${position}, ${uuidFromString(mcpServerId)})`,
      { discard: true },
    );

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
          INSERT INTO projects (id, name, description, model_profile_id, created_at, updated_at)
          VALUES (${id}, ${project.name}, ${project.description ?? null},
                  ${project.modelProfileId === undefined ? null : uuidFromString(project.modelProfileId)},
                  ${project.at}, ${project.at})
        `;
        yield* insertMcpServers(id, project.mcpServerIds);
        return {
          id: uuidToString(id),
          name: project.name,
          ...(project.description === undefined ? {} : { description: project.description }),
          ...(project.modelProfileId === undefined
            ? {}
            : { modelProfileId: project.modelProfileId }),
          mcpServerIds: project.mcpServerIds,
          createdAt: project.at,
          updatedAt: project.at,
        };
      }),

    /** Applies an edit. Only the columns set in the edit are written, plus `updated_at`. */
    update: (id: string, edit: ProjectEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.name !== undefined) sets.push(sql`name = ${edit.name}`);
      if (edit.description !== undefined) sets.push(sql`description = ${edit.description}`);
      if (edit.modelProfileId !== undefined) {
        sets.push(
          sql`model_profile_id = ${edit.modelProfileId === null ? null : uuidFromString(edit.modelProfileId)}`,
        );
      }
      return Effect.asVoid(
        sql`UPDATE projects SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /** Replaces the project's list of MCP Servers with the ids given, in that order. */
    replaceMcpServers: (
      id: string,
      mcpServerIds: ReadonlyArray<string>,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const projectId = uuidFromString(id);
        yield* sql`DELETE FROM project_mcp_servers WHERE project_id = ${projectId}`;
        yield* insertMcpServers(projectId, mcpServerIds);
      }),

    /** Returns the projects that are not deleted and have the MCP Server in their list. */
    liveHoldingMcpServer: (mcpServerId: string): Effect.Effect<ReadonlyArray<Project>, SqlError> =>
      Effect.map(
        sql<ProjectRow>`
          SELECT ${sql.literal(COLUMNS)} FROM projects
          WHERE deleted_at IS NULL AND id IN (SELECT project_id FROM project_mcp_servers
                                              WHERE mcp_server_id = ${uuidFromString(mcpServerId)})
          ORDER BY id`,
        (rows) => rows.map(toProject),
      ),

    /**
     * Removes the MCP Server from every project's list, deleted projects
     * included, and sets `updated_at` of each project that held it. The
     * projects' other entries keep their order.
     */
    removeMcpServer: (mcpServerId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const server = uuidFromString(mcpServerId);
        yield* sql`
          UPDATE projects SET updated_at = ${at}
          WHERE id IN (SELECT project_id FROM project_mcp_servers WHERE mcp_server_id = ${server})
        `;
        yield* sql`DELETE FROM project_mcp_servers WHERE mcp_server_id = ${server}`;
      }),

    /**
     * Clears the Model Profile from every project row that names it, deleted
     * projects included, and sets their `updated_at`. Returns the ids of the
     * projects that are not deleted, which are the ones whose change is
     * recorded.
     */
    clearModelProfile: (
      modelProfileId: string,
      at: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array; readonly deleted_at: string | null }>`
          UPDATE projects SET model_profile_id = NULL, updated_at = ${at}
          WHERE model_profile_id = ${uuidFromString(modelProfileId)}
          RETURNING id, deleted_at
        `,
        (rows) => rows.filter((row) => row.deleted_at === null).map((row) => uuidToString(row.id)),
      ),

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
        const { keyset, order, encodeNextCursor } = yield* prepareKeysetListing(
          sql,
          "project.query",
          request.sort,
          PROJECT_SORT_COLUMNS,
          "id",
          request.cursor,
        );
        const rows = yield* sql<ProjectRow>`
          SELECT ${sql.literal(COLUMNS)} FROM projects
          WHERE deleted_at IS NULL AND ${keyset} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toProject)),
          encodeNextCursor,
        );
      }),
  };
});

/** The repository for project rows, used by the project service. */
export const projectRepository = make;
