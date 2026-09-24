/**
 * The project operations of the API: `project.query`, `read`, `create`,
 * `update` and `delete`.
 *
 * A project has no behaviour of its own. It groups information: a task refers
 * to one project through `projectId`, and a resource can belong to any number
 * of projects through `project_resources`.
 *
 * Every mutation writes one event in the same transaction as the row it
 * describes, so the log never records a change that was rolled back and never
 * misses one that happened. The actor is stamped here, on the event envelope;
 * no payload repeats it.
 *
 * Input is decoded against the contract's schemas rather than trusted. The
 * transport has already decoded a request, but a built-in workflow action
 * calls these methods directly, and the limit on name length must apply
 * however the call arrives. A method that takes only an id does not decode it
 * again: the transport has already decoded a request's id against the
 * contract, and a caller inside the controller passes an id it read from a
 * stored row.
 *
 * Delete is soft: `deletedAt` is set and every read of projects stops
 * returning the project, while its tasks keep their `projectId` and its
 * resource links stay. There is no include-deleted option.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createNotFoundError,
  createValidationError,
  DEFAULT_PAGE_LIMIT,
  Id,
  PROJECT_SORT_FIELDS,
  ProjectCreateInput,
  ProjectUpdateInput,
  type Forbidden,
  type NotFound,
  type Project,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, buildPageInputFields, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { projectRepository, type ProjectSortField } from "./repository";

/** The input of `project.query`: the page size, cursor and sort order. */
const QueryInput = Schema.Struct(buildPageInputFields(PROJECT_SORT_FIELDS));

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

/** The input of `project.update`: the project id and the fields to change. */
const UpdateInput = Schema.Struct({ id: Id, ...ProjectUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(ProjectCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);

/** One page of projects, in the contract's shape. */
export interface ProjectPage {
  readonly items: ReadonlyArray<Project>;
  readonly nextCursor?: string;
}

/** The old and new value of a changed field, as the `project.updated` event records them. */
interface ScalarChange {
  readonly old: unknown;
  readonly new: unknown;
}

/**
 * Sorted by name: people read a project list to pick a project, and there are
 * few enough projects that the name helps more than how recent it is.
 */
const DEFAULT_SORT: { field: ProjectSortField; direction: SortDirection } = {
  field: "name",
  direction: "asc",
};

const NO_SUCH_PROJECT = "no such project";

/** The fields an edit may change, in the order the event lists them. */
const FIELDS = ["name", "description"] as const;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* projectRepository;
  const audit = yield* AuditLog;

  const readLiveProjectOrFail = (id: string): Effect.Effect<Project, NotFound | SqlError> =>
    Effect.flatMap(
      projects.live(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_PROJECT)),
        onSome: Effect.succeed,
      }),
    );

  return {
    /** Returns one page of the projects that are not deleted. */
    query: (
      input: QueryInput,
    ): Effect.Effect<ProjectPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("project.query");
        const { limit, cursor, sort } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const order =
          sort === undefined
            ? DEFAULT_SORT
            : { field: sort.field, direction: sort.direction ?? "asc" };
        const listing = yield* refuseCursor(
          projects.list({ limit: limit ?? DEFAULT_PAGE_LIMIT, cursor, ...order }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /** Returns one project by id. Fails with `NotFound` if there is none or it is deleted. */
    read: (id: Id): Effect.Effect<Project, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("project.read");
        return yield* readLiveProjectOrFail(id);
      }),

    /** Creates a project and returns it. */
    create: (
      input: ProjectCreateInput,
    ): Effect.Effect<Project, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("project.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // One clock read, inside the transaction: the row and the event
            // that records it carry the same instant.
            const at = yield* nowIso;
            const project = yield* projects.insert({
              name: decoded.name,
              description: decoded.description,
              at,
            });
            yield* audit.append({
              kind: "project.created",
              actor: yield* currentStamp,
              payload: { project },
              at,
            });
            return project;
          }),
        );
      }),

    /**
     * Updates a project and returns it as it is after the update.
     *
     * A patch that sets no field fails with a validation error, and a patch
     * that only repeats the current values writes nothing. Otherwise either
     * patch would change `updatedAt` and record a `project.updated` event with
     * no changes in it.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<Project, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("project.update");
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
            const before = yield* readLiveProjectOrFail(id);

            // A project without a description carries no key at all, and
            // `null` is how an edit removes the description. Both count as
            // `null` in the diff, so the event is the same either way.
            const changes: Record<string, ScalarChange> = {};
            const edit: Record<string, string | null> = {};
            for (const field of FIELDS) {
              const next = patch[field];
              if (next === undefined) continue;
              const current = before[field] ?? null;
              if (next !== current) {
                changes[field] = { old: current, new: next };
                edit[field] = next;
              }
            }

            // No field changed, so return the project as it is, without writing
            // the row or recording an event.
            if (Object.keys(changes).length === 0) return before;

            yield* projects.update(id, edit, at);
            yield* audit.append({
              kind: "project.updated",
              actor: yield* currentStamp,
              payload: { projectId: id, changes },
              at,
            });
            // Read the row back rather than merge in memory, so the caller gets
            // exactly the row that was written.
            return yield* readLiveProjectOrFail(id);
          }),
        );
      }),

    /**
     * Deletes a project (a soft delete) and returns an empty object. The row
     * stays, so the tasks and resource links that refer to it still point at
     * a row. Fails with `NotFound` if the project does not exist.
     */
    delete: (
      id: Id,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("project.delete");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const project = yield* readLiveProjectOrFail(id);
            yield* projects.softDelete(id, at);
            // The event holds a final snapshot, because no read returns the row afterwards.
            yield* audit.append({
              kind: "project.deleted",
              actor: yield* currentStamp,
              payload: { projectId: id, snapshot: { ...project, deletedAt: at } },
              at,
            });
            return {};
          }),
        );
      }),
  };
});

/** The project service. */
export class ProjectService extends Context.Service<ProjectService, Effect.Success<typeof make>>()(
  "hercule/controller/projects/ProjectService",
) {}

export const ProjectServiceLayer: Layer.Layer<
  ProjectService,
  never,
  SqlClient.SqlClient | AuditLog
> = Layer.effect(ProjectService)(make);
