/**
 * Projects as the API sees them: `project.query`, `read`, `create`, `update`
 * and `delete`.
 *
 * A project carries no behaviour. It groups information: a task points at one
 * through `projectId` and a resource joins any number of them through
 * `project_resources`.
 *
 * Every mutation writes one event in the same transaction as the row it
 * describes, so the log never claims a change that was rolled back and never
 * misses one that happened. The actor is stamped here, on the event envelope;
 * no payload repeats it.
 *
 * Input is decoded against the contract's own schemas rather than trusted. A
 * request has already been decoded by the transport, but a built-in workflow
 * action calls these methods directly, and the name cap is the same rule
 * whichever way the call arrived.
 *
 * Delete is soft: `deletedAt` is set and everything that reads a project stops
 * seeing it, while its tasks keep the `projectId` they were given and its
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
  DEFAULT_PAGE_LIMIT,
  Id,
  notFound,
  PROJECT_SORT_FIELDS,
  ProjectCreateInput,
  ProjectUpdateInput,
  validation,
  validationOf,
  type Forbidden,
  type NotFound,
  type Project,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { projectRepository, type ProjectSortField } from "./repository";

/** What listing takes: how much of it, in what order. */
const QueryInput = Schema.Struct(pageInput(PROJECT_SORT_FIELDS));

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

/** What identifies one project: the id, and what an edit does to it. */
const UpdateInput = Schema.Struct({ id: Id, ...ProjectUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(ProjectCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

/** One page of projects, in the contract's shape. */
export interface ProjectPage {
  readonly items: ReadonlyArray<Project>;
  readonly nextCursor?: string;
}

/** What an update reports for a field that changed. */
interface ScalarChange {
  readonly old: unknown;
  readonly new: unknown;
}

/**
 * Alphabetical: a project list is read to pick one, and there are few enough
 * of them that recency says less about which than the name does.
 */
const DEFAULT_SORT: { field: ProjectSortField; direction: SortDirection } = {
  field: "name",
  direction: "asc",
};

const NO_SUCH_PROJECT = "no such project";

/** The fields an edit may change, in the order an event reports them. */
const FIELDS = ["name", "description"] as const;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* projectRepository;
  const audit = yield* AuditLog;

  const live = (id: string): Effect.Effect<Project, NotFound | SqlError> =>
    Effect.flatMap(
      projects.live(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_PROJECT)),
        onSome: Effect.succeed,
      }),
    );

  return {
    /** One page of the live projects. */
    query: (
      input: QueryInput,
    ): Effect.Effect<ProjectPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("project.query");
        const { limit, cursor, sort } = yield* Effect.mapError(decodeQuery(input), validationOf);
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

    /** One project by id. A deleted project is not one. */
    read: (
      input: Identified,
    ): Effect.Effect<Project, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("project.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* live(id);
      }),

    /** Opens a place to group things under. */
    create: (
      input: ProjectCreateInput,
    ): Effect.Effect<Project, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("project.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), validationOf);
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
     * Changes a project and says what changed.
     *
     * A patch that names no field is refused, and a patch that asks for the
     * values the project already holds writes nothing at all: either would
     * move `updatedAt` and stamp a `project.updated` row describing nothing.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<Project, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("project.update");
        const { id, ...patch } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        if (Object.keys(patch).length === 0) {
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const before = yield* live(id);

            // A project without a description carries no key at all, and
            // `null` is how an edit puts it back in that state; both read as
            // `null` in the diff, so the event says the same thing either way.
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

            // Nothing to change is not a change: the project is handed back as
            // it is, with no row written and no event claiming one.
            if (Object.keys(changes).length === 0) return before;

            yield* projects.update(id, edit, at);
            yield* audit.append({
              kind: "project.updated",
              actor: yield* currentStamp,
              payload: { projectId: id, changes },
              at,
            });
            // Read back rather than merge in memory: what the caller gets is
            // then the row that was written, whatever the edit touched.
            return yield* live(id);
          }),
        );
      }),

    /**
     * Retires a project. The row stays, so the tasks and resource links that
     * name it keep pointing at something.
     */
    delete: (
      input: Identified,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("project.delete");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const project = yield* live(id);
            yield* projects.softDelete(id, at);
            // The final snapshot, because nothing can read the row afterwards.
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
  "hydra/controller/projects/ProjectService",
) {}

export const ProjectServiceLayer: Layer.Layer<
  ProjectService,
  never,
  SqlClient.SqlClient | AuditLog
> = Layer.effect(ProjectService)(make);
