/**
 * Resource rows and their project links. Nothing here decides policy: the
 * service decides what each kind requires, what a canonical remote is, and who
 * may write.
 *
 * The project links are read in one query for a whole page rather than per
 * row, so a listing takes two statements however many resources it returns.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Resource, ResourceKind, SortDirection } from "@hercule/contract";
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

/** The fields every resource row has, whatever its kind. */
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
 * A repo: the only kind that is checked out, and the only kind with a remote.
 * The table enforces this too, so code reading a repo never has to handle a
 * missing remote.
 */
export interface StoredRepo extends ResourceFields {
  readonly kind: "repo";
  readonly remote: string;
  readonly canonicalRemote: string;
}

/** A folder or a mailbox: a record of something outside Hercule, with no remote. */
export interface StoredRecordResource extends ResourceFields {
  readonly kind: "folder" | "mailbox";
  readonly remote: null;
  readonly canonicalRemote: null;
}

/** A resource row, without the projects it is filed under. */
export type StoredResource = StoredRepo | StoredRecordResource;

/**
 * Checks whether a checkout can be made from this resource. Only a repo
 * qualifies: a folder and a mailbox are records of something outside Hercule.
 * Every operation that checks something out uses this check, and fails with
 * the `NOT_CHECKED_OUT` message below, in whichever error type it returns.
 */
export const isCheckedOut = (resource: StoredResource): resource is StoredRepo =>
  resource.kind === "repo";

/**
 * The error message for an operation that checks out a resource that is not a
 * repo. It lives here rather than in the contract because it is an error this
 * controller returns, not a schema the API declares. The CLI help repeats the
 * same text for the `invalid_state` error.
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

/** The columns an update may set. An absent field leaves its column unchanged. */
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

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "resource.query",
  sort: [{ field: "createdAt", direction }],
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
  // The table's CHECK constraint guarantees these two are non-null on a repo.
  return row.kind === "repo"
    ? { ...fields, kind: "repo", remote: row.remote!, canonicalRemote: row.canonical_remote! }
    : {
        ...fields,
        kind: row.kind as StoredRecordResource["kind"],
        remote: null,
        canonicalRemote: null,
      };
};

/** Builds the API record from the row and the projects it is filed under. */
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

    /** Returns these resources keyed by id, in one query, as a page of workspaces needs. */
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

    /** Returns the resource with this canonical remote, however the remote was written. */
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
        // Built through the same mapper a SELECT uses, so an inserted repo has
        // the same shape as one that is read.
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
     * Deletes the resource, its project links, and its checkouts. Those
     * checkouts belong to workspaces that are already deleted or lost: the
     * service rejects the delete while a workspace that is neither deleted
     * nor lost has a checkout of the resource.
     */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(id);
        yield* sql`DELETE FROM project_resources WHERE resource_id = ${key}`;
        yield* sql`DELETE FROM checkouts WHERE resource_id = ${key}`;
        yield* sql`DELETE FROM resources WHERE id = ${key}`;
      }),

    /** Returns the projects each of these resources is filed under, keyed by resource id. */
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

    /** Replaces the projects this resource is filed under with the given ones. */
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
     * Checks whether any workspace with a checkout of this resource is neither
     * `deleted` nor `lost`. The check decides whether the resource may be
     * deleted, so it belongs to this domain rather than the workspaces domain.
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

    /**
     * Returns every resource that acts through the connection, oldest first.
     * An ingest handle reads this list to learn which repos to watch.
     */
    listLinkedToConnection: (
      connectionId: string,
    ): Effect.Effect<ReadonlyArray<StoredResource>, SqlError> =>
      Effect.map(
        sql<ResourceRow>`
          SELECT ${sql.literal(COLUMNS)} FROM resources
          WHERE connection_id = ${uuidFromString(connectionId)}
          ORDER BY created_at, id
        `,
        (rows) => rows.map(toResource),
      ),

    /**
     * Returns every resource that acts through the connection, with its name:
     * a repo's remote, or a folder's or mailbox's label, which may be `null`.
     * Sorted by name, then by id. The list decides whether the connection may
     * be deleted, and names the resources in the refusal.
     */
    listActingThroughConnection: (
      connectionId: string,
    ): Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly name: string | null }>,
      SqlError
    > =>
      Effect.map(
        sql<{ readonly id: Uint8Array; readonly name: string | null }>`
          SELECT id, COALESCE(remote, label) AS name FROM resources
          WHERE connection_id = ${uuidFromString(connectionId)}
          ORDER BY name, id
        `,
        (rows) => rows.map((row) => ({ id: uuidToString(row.id), name: row.name })),
      ),

    /**
     * Returns the given project ids that exist and are not deleted, so a link
     * never points at nothing.
     */
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
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "created_at", direction: request.direction }],
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
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
        return yield* buildPage(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toResource)),
          (last) => encodeCursor(scope, [last.createdAt], last.id),
        );
      }),
  };
});

/** Everything the resource service reads and writes. */
export const resourceRepository = make;
