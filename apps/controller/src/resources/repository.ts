/**
 * Resource rows and the project links beside them. Nothing here decides policy:
 * what a kind requires, what a canonical remote is and who may write are the
 * service's.
 *
 * The project links are read in one query for a whole page rather than per row,
 * so a listing stays two statements however many resources it hands back.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Resource, ResourceKind, SortDirection } from "@hydra/contract";
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

/** What every resource row holds, whatever kind it is. */
interface ResourceFields {
  readonly id: string;
  readonly label: string | null;
  readonly connectionId: string | null;
  readonly setupCommand: string | null;
  readonly workspaceInclude: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A repo: the one kind that is checked out, and the one that has a remote. The
 * table says so too, so nothing reading a repo has to stand in for a remote it
 * should have had.
 */
export interface StoredRepo extends ResourceFields {
  readonly kind: "repo";
  readonly remote: string;
  readonly canonicalRemote: string;
}

/** A folder or a mailbox: a record of something outside Hydra, with no remote. */
export interface StoredRecordResource extends ResourceFields {
  readonly kind: "folder" | "mailbox";
  readonly remote: null;
  readonly canonicalRemote: null;
}

/** A resource row, without the projects it is filed under. */
export type StoredResource = StoredRepo | StoredRecordResource;

/**
 * Whether this resource is one a working copy is made from. Only a repo is: a
 * folder and a mailbox are records of something outside Hydra. Every door that
 * checks something out asks this one question and refuses with the one sentence
 * below, in whatever error its own shape calls for.
 */
export const isCheckedOut = (resource: StoredResource): resource is StoredRepo =>
  resource.kind === "repo";

/**
 * What a caller is told when it points an operation that checks something out
 * at a resource that is not a repo. Here rather than in the contract: it is a
 * refusal this controller makes, not a shape the API declares, and the CLI
 * restates it as the gloss beside the flag.
 */
export const NOT_CHECKED_OUT = "only a repo is checked out; a folder and a mailbox are records";

export interface NewResource {
  readonly kind: ResourceKind;
  readonly remote: string | null;
  readonly canonicalRemote: string | null;
  readonly label: string | null;
  readonly connectionId: string | null;
  readonly setupCommand: string | null;
  readonly workspaceInclude: boolean;
  readonly at: string;
}

/** The columns an edit may set. An absent one is left as it was. */
export interface ResourceEdit {
  readonly remote?: string;
  readonly canonicalRemote?: string;
  readonly label?: string | null;
  readonly connectionId?: string | null;
  readonly setupCommand?: string | null;
  readonly workspaceInclude?: boolean;
}

export interface ResourcePageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly kind: ResourceKind | undefined;
  readonly projectId: string | undefined;
}

interface ResourceRow {
  readonly id: Uint8Array;
  readonly kind: string;
  readonly remote: string | null;
  readonly canonical_remote: string | null;
  readonly label: string | null;
  readonly connection_id: Uint8Array | null;
  readonly setup_command: string | null;
  readonly workspace_include: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  "id, kind, remote, canonical_remote, label, connection_id, setup_command, " +
  "workspace_include, created_at, updated_at";

const scopeOf = (direction: SortDirection): CursorScope => ({
  op: "resource.query",
  field: "createdAt",
  direction,
});

const toResource = (row: ResourceRow): StoredResource => {
  const fields: ResourceFields = {
    id: uuidToString(row.id),
    label: row.label,
    connectionId: row.connection_id === null ? null : uuidToString(row.connection_id),
    setupCommand: row.setup_command,
    workspaceInclude: row.workspace_include === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // The table's own CHECK is what makes these two non-null on a repo.
  return row.kind === "repo"
    ? { ...fields, kind: "repo", remote: row.remote!, canonicalRemote: row.canonical_remote! }
    : {
        ...fields,
        kind: row.kind as StoredRecordResource["kind"],
        remote: null,
        canonicalRemote: null,
      };
};

/** The record as the API hands it out: the row plus the projects it is under. */
export const composeResource = (
  row: StoredResource,
  projectIds: ReadonlyArray<string>,
): Resource => ({ ...row, projectIds });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const one = (id: string): Effect.Effect<Option.Option<StoredResource>, SqlError> =>
    Effect.map(
      sql<ResourceRow>`SELECT ${sql.literal(COLUMNS)} FROM resources
                       WHERE id = ${uuidFromString(id)}`,
      (rows) => Option.map(Option.fromNullishOr(rows[0]), toResource),
    );

  return {
    one,

    /** These resources, by id: what a page of workspaces reads in one query. */
    byIds: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, StoredResource>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<ResourceRow>`
              SELECT ${sql.literal(COLUMNS)} FROM resources
              WHERE id IN ${sql.in(ids.map(uuidFromString))}
            `,
            (rows) => new Map(rows.map((row) => [uuidToString(row.id), toResource(row)])),
          ),

    /** The resource this remote names, whichever way it was spelled. */
    byCanonicalRemote: (
      canonicalRemote: string,
    ): Effect.Effect<Option.Option<StoredResource>, SqlError> =>
      Effect.map(
        sql<ResourceRow>`SELECT ${sql.literal(COLUMNS)} FROM resources
                         WHERE canonical_remote = ${canonicalRemote}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toResource),
      ),

    insert: (resource: NewResource): Effect.Effect<StoredResource, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO resources (id, kind, remote, canonical_remote, label, connection_id,
                                 setup_command, workspace_include, created_at, updated_at)
          VALUES (${id}, ${resource.kind}, ${resource.remote}, ${resource.canonicalRemote},
                  ${resource.label},
                  ${resource.connectionId === null ? null : uuidFromString(resource.connectionId)},
                  ${resource.setupCommand}, ${resource.workspaceInclude ? 1 : 0},
                  ${resource.at}, ${resource.at})
        `;
        // Read back through the same mapper a select goes through, so an
        // inserted repo is the same shape a read one is.
        return toResource({
          id,
          kind: resource.kind,
          remote: resource.remote,
          canonical_remote: resource.canonicalRemote,
          label: resource.label,
          connection_id:
            resource.connectionId === null ? null : uuidFromString(resource.connectionId),
          setup_command: resource.setupCommand,
          workspace_include: resource.workspaceInclude ? 1 : 0,
          created_at: resource.at,
          updated_at: resource.at,
        });
      }),

    update: (id: string, edit: ResourceEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.remote !== undefined) sets.push(sql`remote = ${edit.remote}`);
      if (edit.canonicalRemote !== undefined) {
        sets.push(sql`canonical_remote = ${edit.canonicalRemote}`);
      }
      if (edit.label !== undefined) sets.push(sql`label = ${edit.label}`);
      if (edit.connectionId !== undefined) {
        sets.push(
          sql`connection_id = ${edit.connectionId === null ? null : uuidFromString(edit.connectionId)}`,
        );
      }
      if (edit.setupCommand !== undefined) sets.push(sql`setup_command = ${edit.setupCommand}`);
      if (edit.workspaceInclude !== undefined) {
        sets.push(sql`workspace_include = ${edit.workspaceInclude ? 1 : 0}`);
      }
      return Effect.asVoid(
        sql`UPDATE resources SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /**
     * Removes the resource, its project links, and the checkouts that named it.
     * Those checkouts belong to workspaces that are already gone: the service
     * refuses the delete while any workspace on it still stands.
     */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(id);
        yield* sql`DELETE FROM project_resources WHERE resource_id = ${key}`;
        yield* sql`DELETE FROM checkouts WHERE resource_id = ${key}`;
        yield* sql`DELETE FROM resources WHERE id = ${key}`;
      }),

    /** The projects these resources are filed under, by resource id. */
    projectsOf: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly resource_id: Uint8Array; readonly project_id: Uint8Array }>`
              SELECT resource_id, project_id FROM project_resources
              WHERE resource_id IN ${sql.in(ids.map(uuidFromString))}
              ORDER BY project_id
            `,
            (rows) => {
              const found = new Map<string, Array<string>>();
              for (const row of rows) {
                const key = uuidToString(row.resource_id);
                const list = found.get(key) ?? [];
                list.push(uuidToString(row.project_id));
                found.set(key, list);
              }
              return found;
            },
          ),

    /** Replaces the projects this resource is filed under with the ones named. */
    setProjects: (id: string, projectIds: ReadonlyArray<string>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(id);
        yield* sql`DELETE FROM project_resources WHERE resource_id = ${key}`;
        yield* Effect.forEach(
          projectIds,
          (projectId) =>
            sql`INSERT INTO project_resources (project_id, resource_id)
                VALUES (${uuidFromString(projectId)}, ${key})`,
          { discard: true },
        );
      }),

    /**
     * Whether a workspace still stands on this resource: one whose status is
     * neither `deleted` nor `lost`. The question is the resource's own - may it
     * be removed - so it is asked here rather than of another domain.
     */
    standsOn: (id: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT w.id FROM workspaces w JOIN checkouts c ON c.workspace_id = w.id
          WHERE c.resource_id = ${uuidFromString(id)}
            AND w.status NOT IN ('deleted', 'lost')
          LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /** The projects that exist among the ones named, so a link points somewhere. */
    liveProjects: (
      projectIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      projectIds.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{ readonly id: Uint8Array }>`
              SELECT id FROM projects
              WHERE id IN ${sql.in(projectIds.map(uuidFromString))} AND deleted_at IS NULL
            `,
            (rows) => rows.map((row) => uuidToString(row.id)),
          ),

    list: (
      request: ResourcePageRequest,
    ): Effect.Effect<Page<StoredResource>, CursorError | SqlError> =>
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
        if (request.kind !== undefined) clauses.push(sql`kind = ${request.kind}`);
        if (request.projectId !== undefined) {
          clauses.push(sql`id IN (SELECT resource_id FROM project_resources
                                  WHERE project_id = ${uuidFromString(request.projectId)})`);
        }
        const rows = yield* sql<ResourceRow>`
          SELECT ${sql.literal(COLUMNS)} FROM resources
          WHERE ${sql.and(clauses)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toResource)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),
  };
});

/** Everything the resource service reads and writes. */
export const resourceRepository = make;
