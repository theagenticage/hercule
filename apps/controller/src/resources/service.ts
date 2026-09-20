/**
 * Resources as the API sees them: `resource.query`, `read`, `create`, `update`
 * and `delete`.
 *
 * What a kind requires is decided here rather than in the schema: a repo is a
 * remote and a folder is a label, and a caller writing the wrong one gets an
 * issue naming the field instead of a union that matched nothing. A repo is
 * identified by the canonical form of its remote, and the unique index on that
 * column is what makes a second spelling of one repository a conflict.
 *
 * A repo's Connection has to be a GitHub one: it is what a push authenticates
 * with, and any other account would be a credential that cannot work.
 *
 * Delete is real, not soft: a resource is a pointer at something outside Hydra,
 * and a pointer nobody wants is gone. It is refused while a workspace stands on
 * it, because that workspace is a working copy on a machine.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  conflict,
  DEFAULT_PAGE_LIMIT,
  Id,
  notFound,
  invalidState,
  RESOURCE_SORT_FIELDS,
  RESOURCE_UPDATE_FIELDS,
  ResourceCreateInput,
  ResourceFilter,
  validation,
  validationOf,
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
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { canonicalRemoteOf, isClonableRemote } from "./remote";
import { composeResource, resourceRepository, type StoredResource } from "./repository";

const QueryInput = Schema.Struct({
  ...ResourceFilter.fields,
  ...pageInput(RESOURCE_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...RESOURCE_UPDATE_FIELDS });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(ResourceCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

export interface ResourcePage {
  readonly items: ReadonlyArray<Resource>;
  readonly nextCursor?: string;
}

/** Oldest first: the list reads as the one the user built up. */
const DEFAULT_DIRECTION: SortDirection = "asc";

const NO_SUCH_RESOURCE = "no such resource";

/** A repo is named by the remote it is; a second name nothing reads is refused. */
const REPO_IS_ITS_REMOTE = "a repo is named by its remote, so it takes no label";

/** What a kind that is never checked out has no use for. */
const noCheckout = (kind: string): string =>
  `a ${kind} is never checked out, so it has no setup command and nothing to include`;

/**
 * Which of the two checkout-only fields a non-repo was given, if either: they
 * are refused rather than stored where nothing would ever read them.
 */
const offRepo = (given: {
  readonly setupCommand?: unknown;
  readonly workspaceInclude?: unknown;
}): "setupCommand" | "workspaceInclude" | undefined =>
  given.setupCommand !== undefined && given.setupCommand !== null
    ? "setupCommand"
    : given.workspaceInclude !== undefined
      ? "workspaceInclude"
      : undefined;

const NOT_A_REMOTE =
  "that is not a remote Hydra can clone: write https://host/owner/repo or git@host:owner/repo";

const STANDS_ON =
  "a workspace still stands on that resource; dispose of it before removing the resource";

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const resources = yield* resourceRepository;
  const connections = yield* connectionRepository;
  const audit = yield* AuditLog;

  const stored = (id: string): Effect.Effect<StoredResource, NotFound | SqlError> =>
    Effect.flatMap(
      resources.one(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_RESOURCE)),
        onSome: Effect.succeed,
      }),
    );

  const composed = (row: StoredResource): Effect.Effect<Resource, SqlError> =>
    Effect.map(resources.projectsOf([row.id]), (projects) =>
      composeResource(row, projects.get(row.id) ?? []),
    );

  /** The connection a resource may name, or the issue saying why it may not. */
  const namedConnection = (
    kind: ResourceKind,
    connectionId: string,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const found = yield* connections.one(connectionId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          validation([{ path: ["connectionId"], message: "no such connection" }]),
        );
      }
      if (kind === "repo" && !isGithubConnection(found.value)) {
        return yield* Effect.fail(
          validation([
            { path: ["connectionId"], message: "a repo acts through a github connection" },
          ]),
        );
      }
    });

  /** Every project named has to exist, or the link would point at nothing. */
  const namedProjects = (
    projectIds: ReadonlyArray<string>,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const live = new Set(yield* resources.liveProjects(projectIds));
      const missing = projectIds.filter((id) => !live.has(id));
      if (missing.length > 0) {
        return yield* Effect.fail(
          validation(missing.map(() => ({ path: ["projectIds"], message: "no such project" }))),
        );
      }
    });

  /**
   * The canonical form of a remote, refusing one that names no repository and
   * one another resource already holds.
   */
  const freeRemote = (
    remote: string,
    self: string | undefined,
  ): Effect.Effect<string, Validation | Conflict | SqlError> =>
    Effect.gen(function* () {
      const canonical = isClonableRemote(remote) ? canonicalRemoteOf(remote) : undefined;
      if (canonical === undefined) {
        return yield* Effect.fail(validation([{ path: ["remote"], message: NOT_A_REMOTE }]));
      }
      const held = yield* resources.byCanonicalRemote(canonical);
      if (Option.isSome(held) && held.value.id !== self) {
        return yield* Effect.fail(conflict(`another resource already names ${canonical}`));
      }
      return canonical;
    });

  return {
    query: (input: QueryInput): Effect.Effect<ResourcePage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("resource.query");
        const { limit, cursor, sort, kind, projectId } = yield* Effect.mapError(
          decodeQuery(input),
          validationOf,
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

    read: (input: Identified): Effect.Effect<Resource, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("resource.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* Effect.flatMap(stored(id), composed);
      }),

    create: (
      input: ResourceCreateInput,
    ): Effect.Effect<Resource, ReadError | Conflict | Validation> =>
      Effect.gen(function* () {
        yield* requireGrant("resource.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), validationOf);
        if (decoded.kind === "repo" && decoded.remote === undefined) {
          return yield* Effect.fail(
            validation([{ path: ["remote"], message: "a repo is named by its remote" }]),
          );
        }
        if (decoded.kind === "repo" && decoded.label !== undefined) {
          return yield* Effect.fail(validation([{ path: ["label"], message: REPO_IS_ITS_REMOTE }]));
        }
        if (decoded.kind !== "repo") {
          if (decoded.remote !== undefined) {
            return yield* Effect.fail(
              validation([
                { path: ["remote"], message: `a ${decoded.kind} has no remote to check out` },
              ]),
            );
          }
          if (decoded.label === undefined) {
            return yield* Effect.fail(
              validation([{ path: ["label"], message: `a ${decoded.kind} is named by its label` }]),
            );
          }
          const off = offRepo(decoded);
          if (off !== undefined) {
            return yield* Effect.fail(
              validation([{ path: [off], message: noCheckout(decoded.kind) }]),
            );
          }
        }
        if (decoded.connectionId !== undefined) {
          yield* namedConnection(decoded.kind, decoded.connectionId);
        }
        // A project named twice is the same link: what the caller asked for is
        // the set, and the join table holds one row per pair.
        const projectIds = [...new Set(decoded.projectIds ?? [])];
        yield* namedProjects(projectIds);

        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const canonicalRemote =
              decoded.remote === undefined ? null : yield* freeRemote(decoded.remote, undefined);
            const row = yield* resources.insert({
              kind: decoded.kind,
              remote: decoded.remote ?? null,
              canonicalRemote,
              label: decoded.label ?? null,
              connectionId: decoded.connectionId ?? null,
              setupCommand: decoded.setupCommand ?? null,
              // On unless it is turned off, and never on off a repo: a fresh
              // worktree that silently lacked the files the user works with is
              // the surprising answer, and a folder has no worktree to fill.
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
        const { id, ...patch } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        if (Object.keys(patch).length === 0) {
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* stored(id);
            if (patch.connectionId !== undefined && patch.connectionId !== null) {
              yield* namedConnection(before.kind, patch.connectionId);
            }
            if (before.kind === "repo") {
              if (patch.label !== undefined && patch.label !== null) {
                return yield* Effect.fail(
                  validation([{ path: ["label"], message: REPO_IS_ITS_REMOTE }]),
                );
              }
            } else {
              if (patch.remote !== undefined) {
                return yield* Effect.fail(
                  validation([
                    { path: ["remote"], message: `a ${before.kind} has no remote to check out` },
                  ]),
                );
              }
              const off = offRepo(patch);
              if (off !== undefined) {
                return yield* Effect.fail(
                  validation([{ path: [off], message: noCheckout(before.kind) }]),
                );
              }
            }
            const canonicalRemote =
              patch.remote === undefined ? undefined : yield* freeRemote(patch.remote, id);
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
              yield* namedProjects(projectIds);
              yield* resources.setProjects(id, projectIds);
            }
            yield* audit.append({
              kind: "resource.updated",
              actor: USER_ACTOR,
              payload: { resourceId: id, changed: Object.keys(patch).sort() },
              at,
            });
            // Read back, so what the caller gets is the row that was written.
            return yield* Effect.flatMap(stored(id), composed);
          }),
        );
      }),

    delete: (
      input: Identified,
    ): Effect.Effect<Record<string, never>, ReadError | NotFound | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("resource.delete");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const resource = yield* Effect.flatMap(stored(id), composed);
            if (yield* resources.standsOn(id)) {
              return yield* Effect.fail(invalidState(STANDS_ON));
            }
            yield* resources.delete(id);
            // The final snapshot, because nothing can read the row afterwards.
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
>()("hydra/controller/resources/ResourceService") {}

export const ResourceServiceLayer: Layer.Layer<
  ResourceService,
  never,
  SqlClient.SqlClient | AuditLog
> = Layer.effect(ResourceService)(make);
