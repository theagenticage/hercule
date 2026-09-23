/**
 * Tasks as the API sees them: `task.query`, `read`, `create`, `update` and
 * `delete`.
 *
 * Every mutation writes one event in the same transaction as the row it
 * describes, so the log never claims a change that was rolled back and never
 * misses one that happened. The actor is stamped here, on the event envelope
 * and on every provenance entry the call appends; no payload repeats it.
 *
 * Input is decoded against the contract's own schemas rather than trusted. A
 * request has already been decoded by the transport, but a built-in workflow
 * action calls these methods directly, and the title cap, the External Ref
 * grammar and the rule that a provenance entry names something are the same
 * rules whichever way the call arrived.
 *
 * Delete is soft: `deletedAt` is set and everything that reads a task stops
 * seeing it. There is no include-deleted option.
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
  MAX_TASK_LABELS,
  notFound,
  TASK_SORT_FIELDS,
  TaskCreateInput,
  TaskFilter,
  TaskUpdateInput,
  refuseEmptyTaskUpdate,
  validation,
  validationOf,
  type Forbidden,
  type NotFound,
  type ProvenanceEntry,
  type Task,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { taskRepository, type TaskOrder } from "./repository";

/** What listing takes: the filter, and how much of it in what order. */
const QueryInput = Schema.Struct({ ...TaskFilter.fields, ...pageInput(TASK_SORT_FIELDS) });

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

/**
 * What identifies one task: the id, and what an edit does to it. The edit is
 * refused when it names no field to change, by the rule the request's own
 * schema carries.
 */
const UpdateInput = Schema.Struct({ id: Id, ...TaskUpdateInput.fields }).check(
  refuseEmptyTaskUpdate,
);

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(TaskCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

/** One page of tasks, in the contract's shape. */
export interface TaskPage {
  readonly items: ReadonlyArray<Task>;
  readonly nextCursor?: string;
}

/** What an update reports for a field that holds one value. */
interface ScalarChange {
  readonly old: unknown;
  readonly new: unknown;
}

/** What it reports for a field that holds several. Provenance never loses one. */
interface ListChange {
  readonly added: ReadonlyArray<unknown>;
  readonly removed: ReadonlyArray<unknown>;
}

/** Newest work first: a task list is read to see what is going on now. */
const DEFAULT_ORDER: TaskOrder = { _tag: "column", field: "updatedAt", direction: "desc" };

const NO_SUCH_TASK = "no such task";
const NO_SUCH_PROJECT = "no such project";

/** The scalar fields an edit may change, in the order an event reports them. */
const SCALARS = ["title", "description", "status", "priority"] as const;

/** A value carried twice is carried once. */
const unique = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

/**
 * How a listing is ordered.
 *
 * Relevance is not a column, so a search cannot also be sorted: honouring both
 * would mean two paging strategies chosen per request, and ignoring the sort
 * would answer in an order nobody asked for without saying so.
 */
const orderOf = (
  text: QueryInput["text"],
  sort: QueryInput["sort"],
): Effect.Effect<TaskOrder, Validation> => {
  if (text !== undefined && sort !== undefined) {
    return Effect.fail(
      validation([
        { path: ["sort"], message: "a full-text search is ordered by relevance" },
        { path: ["text"], message: "a search cannot also be sorted; drop one of the two" },
      ]),
    );
  }
  if (text !== undefined) return Effect.succeed({ _tag: "relevance", text });
  if (sort === undefined) return Effect.succeed(DEFAULT_ORDER);
  return Effect.succeed({ _tag: "column", field: sort.field, direction: sort.direction ?? "desc" });
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* taskRepository;
  const audit = yield* AuditLog;

  const live = (id: string): Effect.Effect<Task, NotFound | SqlError> =>
    Effect.flatMap(
      tasks.live(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_TASK)),
        onSome: Effect.succeed,
      }),
    );

  /** A project a task points at has to be one that is there to point at. */
  const requireProject = (
    id: string | null | undefined,
  ): Effect.Effect<void, NotFound | SqlError> =>
    id === undefined || id === null
      ? Effect.void
      : Effect.flatMap(tasks.projectExists(id), (exists) =>
          exists ? Effect.void : Effect.fail(notFound(NO_SUCH_PROJECT)),
        );

  return {
    /** One page of the tasks a filter matches. */
    query: (
      input: QueryInput,
    ): Effect.Effect<TaskPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.query");
        const decoded = yield* Effect.mapError(decodeQuery(input), validationOf);
        const { limit, cursor, sort, text, ...filter } = decoded;
        const order = yield* orderOf(text, sort);
        const listing = yield* refuseCursor(
          tasks.list(filter, { limit: limit ?? DEFAULT_PAGE_LIMIT, cursor, order }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /** One task by id, provenance included. A deleted task is not one. */
    read: (
      input: Identified,
    ): Effect.Effect<Task, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* live(id);
      }),

    /** Writes down a piece of intent. */
    create: (
      input: TaskCreateInput,
    ): Effect.Effect<Task, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), validationOf);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // One clock read, inside the transaction: the row and the event
            // that records it carry the same instant.
            const at = yield* nowIso;
            const actor = yield* currentStamp;
            yield* requireProject(decoded.projectId);
            const task = yield* tasks.insert({
              title: decoded.title,
              description: decoded.description,
              status: "open",
              priority: decoded.priority ?? "normal",
              labels: unique(decoded.labels ?? []),
              projectId: decoded.projectId,
              provenance: decoded.provenance ?? [],
              at,
              actor,
            });
            yield* audit.append({
              kind: "task.created",
              actor,
              record: { topic: "task", id: task.id },
              payload: { task },
              at,
            });
            return task;
          }),
        );
      }),

    /**
     * Changes a task and says what changed.
     *
     * A patch that names no field is refused by the decode, and a patch that
     * asks for the values the task already holds writes nothing at all:
     * either would move `updatedAt` and stamp a `task.updated` row describing
     * nothing, and a workflow triggering on that event would wake for no
     * change.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<Task, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.update");
        const { id, ...patch } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const actor = yield* currentStamp;
            const before = yield* live(id);
            yield* requireProject(patch.projectId);

            const changes: Record<string, ScalarChange | ListChange> = {};
            const edit: Record<string, unknown> = {};
            for (const field of SCALARS) {
              const next = patch[field];
              if (next !== undefined && next !== before[field]) {
                changes[field] = { old: before[field], new: next };
                edit[field] = next;
              }
            }
            const project = before.projectId ?? null;
            if (patch.projectId !== undefined && patch.projectId !== project) {
              changes["projectId"] = { old: project, new: patch.projectId };
              edit["projectId"] = patch.projectId;
            }

            // A label named on both sides is added and removed in one call,
            // which leaves the task carrying it: reporting it as removed would
            // fire every workflow watching for that label to come off.
            const adding = unique(patch.addLabels ?? []);
            const removed = unique(patch.removeLabels ?? []).filter(
              (label) => !adding.includes(label) && before.labels.includes(label),
            );
            const kept = before.labels.filter((label) => !removed.includes(label));
            const added = adding.filter((label) => !kept.includes(label));
            if (added.length > 0 || removed.length > 0) {
              // One call is bounded by the contract; the row is bounded here,
              // because labels are added a few at a time and the cap is on
              // what the task ends up carrying, not on what one edit named.
              if (kept.length + added.length > MAX_TASK_LABELS) {
                return yield* Effect.fail(
                  validation([
                    {
                      path: ["addLabels"],
                      message: `A task carries at most ${String(MAX_TASK_LABELS)} labels.`,
                    },
                  ]),
                );
              }
              changes["labels"] = { added, removed };
              edit["labels"] = [...kept, ...added];
            }

            const appended = patch.provenance ?? [];
            if (appended.length > 0) {
              const entries: ReadonlyArray<ProvenanceEntry> = appended.map((entry) => ({
                ...entry,
                at,
                actor,
              }));
              changes["provenance"] = { added: entries, removed: [] };
            }

            // Nothing to change is not a change: the task is handed back as it
            // is, with no row written and no event claiming one.
            if (Object.keys(changes).length === 0) return before;

            yield* tasks.update(id, edit, appended, at, actor);
            yield* audit.append({
              kind: "task.updated",
              actor,
              record: { topic: "task", id },
              payload: { taskId: id, changes },
              at,
            });
            // Read back rather than merge in memory: what the caller gets is
            // then the row that was written, whatever the edit touched.
            return yield* live(id);
          }),
        );
      }),

    /**
     * Retires a task that should never have existed. The row stays, so the log
     * and the runs that reference it keep pointing at something.
     */
    delete: (
      input: Identified,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("task.delete");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const actor = yield* currentStamp;
            const task = yield* live(id);
            yield* tasks.softDelete(id, at);
            // The final snapshot, because nothing can read the row afterwards.
            yield* audit.append({
              kind: "task.deleted",
              actor,
              record: { topic: "task", id },
              payload: { taskId: id, snapshot: { ...task, deletedAt: at } },
              at,
            });
            return {};
          }),
        );
      }),
  };
});

/** The task service. */
export class TaskService extends Context.Service<TaskService, Effect.Success<typeof make>>()(
  "hercule/controller/tasks/TaskService",
) {}

export const TaskServiceLayer: Layer.Layer<TaskService, never, SqlClient.SqlClient | AuditLog> =
  Layer.effect(TaskService)(make);
