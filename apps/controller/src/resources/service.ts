/**
 * The resource operations: `resource.query`, `read`, `create`, `update` and
 * `delete`.
 *
 * The fields each kind requires are checked here rather than in the schema: a
 * repo needs a remote and a folder needs a label. A caller who sends the wrong
 * field gets an error that names it, instead of a union error that matched no
 * member. A repo is identified by the canonical form of its remote, and the
 * unique index on that column makes a second spelling of the same repository
 * a conflict.
 *
 * A repo's Connection must be a GitHub connection: a push authenticates with
 * it, and a credential for any other account could not work.
 *
 * Delete is a hard delete, not a soft one: a resource only points at something
 * outside Hercule, and a pointer nobody wants can simply go. The delete fails
 * while a workspace still uses the resource, because that workspace is a
 * checkout on a runner.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createConflictError,
  DEFAULT_PAGE_LIMIT,
  Id,
  createNotFoundError,
  createInvalidStateError,
  RESOURCE_SORT_FIELDS,
  RESOURCE_UPDATE_FIELDS,
  ResourceCreateInput,
  ResourceFilter,
  createValidationError,
  createDecodeValidationError,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Resource,
  type ResourceKind,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant, USER_ACTOR } from "../actor";
import { connectionRepository, isGithubConnection } from "../connections";
import { nowIso, buildPageInputFields, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { canonicalizeRemote, isClonableRemote } from "./remote";
import { composeResource, resourceRepository, type StoredResource } from "./repository";

const QueryInput = Schema.Struct({
  ...ResourceFilter.fields,
  ...buildPageInputFields(RESOURCE_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...RESOURCE_UPDATE_FIELDS });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(ResourceCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);

export interface ResourcePage {
  readonly items: ReadonlyArray<Resource>;
  readonly nextCursor?: string;
}

/** Oldest first, so the list is in the order the user added resources. */
const DEFAULT_DIRECTION: SortDirection = "asc";

const NO_SUCH_RESOURCE = "no such resource";

/** A repo is named by its remote, so a label would be a second name nothing reads. */
const REPO_IS_ITS_REMOTE = "a repo is named by its remote, so it cannot have a label";

/** Returns the error for a checkout-only field set on a kind that is never checked out. */
const describeNoCheckout = (kind: string): string =>
  `a ${kind} is never checked out, so it cannot have a setup command or workspaceInclude`;

/**
 * Returns which of the two checkout-only fields a non-repo was given, if
 * either. They are rejected rather than stored where nothing would ever read
 * them.
 */
const findRepoOnlyField = (given: {
  readonly setupCommand?: unknown;
  readonly workspaceInclude?: unknown;
}): "setupCommand" | "workspaceInclude" | undefined =>
  given.setupCommand !== undefined && given.setupCommand !== null
    ? "setupCommand"
    : given.workspaceInclude !== undefined
      ? "workspaceInclude"
      : undefined;

const NOT_A_REMOTE =
  "that is not a remote Hercule can clone: write https://host/owner/repo or git@host:owner/repo";

const STANDS_ON =
  "a workspace still uses that resource; dispose of the workspace before deleting the resource, or retire its runner if it is a main workspace";

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const resources = yield* resourceRepository;
  const connections = yield* connectionRepository;
  const audit = yield* AuditLog;

  const readStoredResourceOrFail = (
    id: string,
  ): Effect.Effect<StoredResource, NotFound | SqlError> =>
    Effect.flatMap(
      resources.one(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_RESOURCE)),
        onSome: Effect.succeed,
      }),
    );

  const readResourceRecord = (row: StoredResource): Effect.Effect<Resource, SqlError> =>
    Effect.map(resources.projectsOf([row.id]), (projects) =>
      composeResource(row, projects.get(row.id) ?? []),
    );

  /**
   * Checks that a resource of this kind may use this connection. Fails with a
   * validation error if the connection does not exist, or if the resource is
   * a repo and the connection is not a GitHub connection.
   */
  const validateNamedConnection = (
    kind: ResourceKind,
    connectionId: string,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const found = yield* connections.one(connectionId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          createValidationError([{ path: ["connectionId"], message: "no such connection" }]),
        );
      }
      if (kind === "repo" && !isGithubConnection(found.value)) {
        return yield* Effect.fail(
          createValidationError([
            { path: ["connectionId"], message: "a repo's connection must be a GitHub connection" },
          ]),
        );
      }
    });

  /**
   * Checks that every given project exists, so no link points at nothing.
   * Fails with a validation error for each missing project.
   */
  const validateNamedProjects = (
    projectIds: ReadonlyArray<string>,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const live = new Set(yield* resources.liveProjects(projectIds));
      const missing = projectIds.filter((id) => !live.has(id));
      if (missing.length > 0) {
        return yield* Effect.fail(
          createValidationError(
            missing.map(() => ({ path: ["projectIds"], message: "no such project" })),
          ),
        );
      }
    });

  /**
   * Returns the canonical form of a remote. Fails with a validation error if
   * Hercule cannot clone the remote, and with a conflict if another resource
   * (not `self`) already has the same canonical remote.
   */
  const canonicalizeRemoteOrFail = (
    remote: string,
    self: string | undefined,
  ): Effect.Effect<string, Validation | Conflict | SqlError> =>
    Effect.gen(function* () {
      const canonical = isClonableRemote(remote) ? canonicalizeRemote(remote) : undefined;
      if (canonical === undefined) {
        return yield* Effect.fail(
          createValidationError([{ path: ["remote"], message: NOT_A_REMOTE }]),
        );
      }
      const held = yield* resources.byCanonicalRemote(canonical);
      if (Option.isSome(held) && held.value.id !== self) {
        return yield* Effect.fail(
          createConflictError(`another resource already names ${canonical}`),
        );
      }
      return canonical;
    });

  return {
    query: (input: QueryInput): Effect.Effect<ResourcePage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("resource.query");
        const { limit, cursor, sort, kind, projectId } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          resources.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            kind,
            projectId,
          }),
        );
        const projects = yield* resources.projectsOf(listing.items.map((one) => one.id));
        return {
          items: listing.items.map((one) => composeResource(one, projects.get(one.id) ?? [])),
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (id: Id): Effect.Effect<Resource, Exclude<ReadError | NotFound, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("resource.read");
        return yield* Effect.flatMap(readStoredResourceOrFail(id), readResourceRecord);
      }),

    create: (
      input: ResourceCreateInput,
    ): Effect.Effect<Resource, ReadError | Conflict | Validation> =>
      Effect.gen(function* () {
        yield* requireGrant("resource.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        if (decoded.kind === "repo" && decoded.remote === undefined) {
          return yield* Effect.fail(
            createValidationError([{ path: ["remote"], message: "a repo needs a remote" }]),
          );
        }
        if (decoded.kind === "repo" && decoded.label !== undefined) {
          return yield* Effect.fail(
            createValidationError([{ path: ["label"], message: REPO_IS_ITS_REMOTE }]),
          );
        }
        if (decoded.kind !== "repo") {
          if (decoded.remote !== undefined) {
            return yield* Effect.fail(
              createValidationError([
                {
                  path: ["remote"],
                  message: `a ${decoded.kind} is never checked out, so it cannot have a remote`,
                },
              ]),
            );
          }
          if (decoded.label === undefined) {
            return yield* Effect.fail(
              createValidationError([
                { path: ["label"], message: `a ${decoded.kind} needs a label` },
              ]),
            );
          }
          const off = findRepoOnlyField(decoded);
          if (off !== undefined) {
            return yield* Effect.fail(
              createValidationError([{ path: [off], message: describeNoCheckout(decoded.kind) }]),
            );
          }
        }
        // A project listed twice is the same link: the caller means a set, and
        // the join table holds one row per pair.
        const projectIds = [...new Set(decoded.projectIds ?? [])];

        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Checked in the insert's transaction, so a Connection or project
            // deleted after the check cannot leave the new resource naming it.
            if (decoded.connectionId !== undefined) {
              yield* validateNamedConnection(decoded.kind, decoded.connectionId);
            }
            yield* validateNamedProjects(projectIds);
            const at = yield* nowIso;
            const canonicalRemote =
              decoded.remote === undefined
                ? null
                : yield* canonicalizeRemoteOrFail(decoded.remote, undefined);
            const row = yield* resources.insert({
              kind: decoded.kind,
              remote: decoded.remote ?? null,
              canonicalRemote,
              label: decoded.label ?? null,
              connectionId: decoded.connectionId ?? null,
              setupCommand: decoded.setupCommand ?? null,
              // On by default for a repo, and always off for other kinds. A new
              // worktree that silently lacked the files the user works with
              // would be surprising, and a folder has no worktree to fill.
              workspaceInclude: decoded.kind === "repo" && (decoded.workspaceInclude ?? true),
              at,
            });
            yield* resources.setProjects(row.id, projectIds);
            yield* audit.append({
              kind: "resource.created",
              actor: USER_ACTOR,
              payload: { resource: composeResource(row, projectIds) },
              at,
            });
            return composeResource(row, projectIds);
          }),
        );
      }),

    update: (
      input: UpdateInput,
    ): Effect.Effect<Resource, ReadError | NotFound | Conflict | Validation> =>
      Effect.gen(function* () {
        yield* requireGrant("resource.update");
        const { id, ...patch } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        if (Object.keys(patch).length === 0) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name a field to change" }]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* readStoredResourceOrFail(id);
            if (patch.connectionId !== undefined && patch.connectionId !== null) {
              yield* validateNamedConnection(before.kind, patch.connectionId);
            }
            if (before.kind === "repo") {
              if (patch.label !== undefined && patch.label !== null) {
                return yield* Effect.fail(
                  createValidationError([{ path: ["label"], message: REPO_IS_ITS_REMOTE }]),
                );
              }
            } else {
              if (patch.remote !== undefined) {
                return yield* Effect.fail(
                  createValidationError([
                    {
                      path: ["remote"],
                      message: `a ${before.kind} is never checked out, so it cannot have a remote`,
                    },
                  ]),
                );
              }
              const off = findRepoOnlyField(patch);
              if (off !== undefined) {
                return yield* Effect.fail(
                  createValidationError([
                    { path: [off], message: describeNoCheckout(before.kind) },
                  ]),
                );
              }
            }
            const canonicalRemote =
              patch.remote === undefined
                ? undefined
                : yield* canonicalizeRemoteOrFail(patch.remote, id);
            yield* resources.update(
              id,
              {
                ...(patch.remote === undefined ? {} : { remote: patch.remote }),
                ...(canonicalRemote === undefined ? {} : { canonicalRemote }),
                ...(patch.label === undefined ? {} : { label: patch.label }),
                ...(patch.connectionId === undefined ? {} : { connectionId: patch.connectionId }),
                ...(patch.setupCommand === undefined ? {} : { setupCommand: patch.setupCommand }),
                ...(patch.workspaceInclude === undefined
                  ? {}
                  : { workspaceInclude: patch.workspaceInclude }),
              },
              at,
            );
            if (patch.projectIds !== undefined) {
              const projectIds = [...new Set(patch.projectIds)];
              yield* validateNamedProjects(projectIds);
              yield* resources.setProjects(id, projectIds);
            }
            yield* audit.append({
              kind: "resource.updated",
              actor: USER_ACTOR,
              payload: { resourceId: id, changed: Object.keys(patch).sort() },
              at,
            });
            // Read back, so the caller gets the row as it was written.
            return yield* Effect.flatMap(readStoredResourceOrFail(id), readResourceRecord);
          }),
        );
      }),

    delete: (
      id: Id,
    ): Effect.Effect<
      Record<string, never>,
      Exclude<ReadError | NotFound | InvalidState, Validation>
    > =>
      Effect.gen(function* () {
        yield* requireGrant("resource.delete");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const resource = yield* Effect.flatMap(
              readStoredResourceOrFail(id),
              readResourceRecord,
            );
            if (yield* resources.standsOn(id)) {
              return yield* Effect.fail(createInvalidStateError(STANDS_ON));
            }
            yield* resources.delete(id);
            // Store a final snapshot, because the row cannot be read afterwards.
            yield* audit.append({
              kind: "resource.deleted",
              actor: USER_ACTOR,
              payload: { resourceId: id, snapshot: resource },
              at,
            });
            return {};
          }),
        );
      }),
  };
});

export class ResourceService extends Context.Service<
  ResourceService,
  Effect.Success<typeof make>
>()("hercule/controller/resources/ResourceService") {}

export const ResourceServiceLayer: Layer.Layer<
  ResourceService,
  never,
  SqlClient.SqlClient | AuditLog
> = Layer.effect(ResourceService)(make);
