/**
 * The task operations: `task.query`, `read`, `create`, `update` and `delete`.
 *
 * Every mutation writes one event in the same transaction as the row it
 * describes, so the log never claims a change that was rolled back and never
 * misses one that happened. The actor is stamped here, on the event envelope
 * and on every provenance entry the call appends; no payload repeats it.
 *
 * Input is decoded against the contract's own schemas rather than trusted. A
 * request has already been decoded by the transport, but a built-in workflow
 * action calls these methods directly. The same rules apply whichever way the
 * call arrives: the title length cap, the External Ref syntax, and the rule
 * that a provenance entry must reference something. A method that takes only
 * an id does not decode it again: the transport has already decoded a
 * request's id against the contract, and a caller inside the controller
 * passes an id it read from a stored row.
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
import type { Mutable } from "effect/Types";
import {
  createDecodeValidationError,
  createNotFoundError,
  createValidationError,
  DEFAULT_PAGE_LIMIT,
  Id,
  MAX_TASK_LABELS,
  TASK_SORT_FIELDS,
  TaskCreateInput,
  TaskFilter,
  TaskUpdateInput,
  refuseEmptyTaskUpdate,
  type Forbidden,
  type NotFound,
  type ProvenanceEntry,
  type Task,
  type TaskUpdatedEventPayload,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { announce, nowIso, buildPageInputFields, refuseCursor, withTransaction } from "../db";
import { AuditLog, PlatformEvents } from "../events";
import { Notifier } from "../notifications";
import { taskRepository, type TaskEdit, type TaskOrder } from "./repository";

/** The input of `task.query`: the filter, plus the page size, cursor and sort. */
const QueryInput = Schema.Struct({
  ...TaskFilter.fields,
  ...buildPageInputFields(TASK_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

/**
 * The input of `task.update`: the task's id and the fields to change. Decoding
 * fails when the edit sets no field. The check is the same one the request
 * schema uses, so both reject the same edits.
 */
const UpdateInput = Schema.Struct({ id: Id, ...TaskUpdateInput.fields }).check(
  refuseEmptyTaskUpdate,
);

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(TaskCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);

/** One page of tasks, in the contract's shape. */
export interface TaskPage {
  readonly items: ReadonlyArray<Task>;
  readonly nextCursor?: string;
}

/** Newest work first: a task list is read to see what is going on now. */
const DEFAULT_ORDER: TaskOrder = { _tag: "column", field: "updatedAt", direction: "desc" };

const NO_SUCH_TASK = "no such task";
const NO_SUCH_PROJECT = "no such project";

/** Returns true if an edit gives a field a value other than the one it holds. */
const isNewValue = <Value>(next: Value | undefined, held: Value): next is Value =>
  next !== undefined && next !== held;

/** Returns the values with duplicates removed, keeping the first of each. */
const removeDuplicates = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

/**
 * Returns how a listing is ordered: by relevance for a full-text search,
 * otherwise by the requested column or the default. Fails with `Validation` if
 * the request has both a search and a sort.
 *
 * Relevance is not a column, so a search cannot also be sorted. Supporting
 * both would need two paging strategies chosen per request, and ignoring the
 * sort would silently return an order nobody asked for.
 */
const chooseOrder = (
  text: QueryInput["text"],
  sort: QueryInput["sort"],
): Effect.Effect<TaskOrder, Validation> => {
  if (text !== undefined && sort !== undefined) {
    return Effect.fail(
      createValidationError([
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
  const notifier = yield* Notifier;
  const platformEvents = yield* PlatformEvents;

  const readLiveTaskOrFail = (id: string): Effect.Effect<Task, NotFound | SqlError> =>
    Effect.flatMap(
      tasks.live(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_TASK)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Checks that the project a task points at exists. Fails with `NotFound` if
   * it does not. Does nothing for an absent or null id.
   */
  const ensureProjectExists = (
    id: string | null | undefined,
  ): Effect.Effect<void, NotFound | SqlError> =>
    id === undefined || id === null
      ? Effect.void
      : Effect.flatMap(tasks.projectExists(id), (exists) =>
          exists ? Effect.void : Effect.fail(createNotFoundError(NO_SUCH_PROJECT)),
        );

  return {
    /** Returns one page of the tasks that match a filter. */
    query: (
      input: QueryInput,
    ): Effect.Effect<TaskPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.query");
        const decoded = yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
        const { limit, cursor, sort, text, ...filter } = decoded;
        const order = yield* chooseOrder(text, sort);
        const listing = yield* refuseCursor(
          tasks.list(filter, { limit: limit ?? DEFAULT_PAGE_LIMIT, cursor, order }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Returns one task by id, including its provenance. Fails with `NotFound`
     * if the task does not exist or has been deleted.
     */
    read: (id: Id): Effect.Effect<Task, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        return yield* readLiveTaskOrFail(id);
      }),

    /**
     * Creates a task and returns it. Fails with `NotFound` if the project does
     * not exist.
     *
     * A task that a run's step creates gets one more provenance entry, `{
     * runId }`, after the ones the step's params give, unless one of those
     * already names the run. Provenance records what created the task, and
     * that was the run. The entry is the core's own, so it does not count
     * toward `MAX_PROVENANCE_APPEND`.
     */
    create: (
      input: TaskCreateInput,
    ): Effect.Effect<Task, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("task.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const given = decoded.provenance ?? [];
        const provenance =
          caller._tag === "run" && !given.some((entry) => entry.runId === caller.runId)
            ? [...given, { runId: caller.runId }]
            : given;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // One clock read, inside the transaction: the row and the event
            // that records it carry the same instant.
            const at = yield* nowIso;
            const actor = yield* currentStamp;
            yield* ensureProjectExists(decoded.projectId);
            const task = yield* tasks.insert({
              title: decoded.title,
              description: decoded.description,
              status: "open",
              priority: decoded.priority ?? "normal",
              labels: removeDuplicates(decoded.labels ?? []),
              projectId: decoded.projectId,
              provenance,
              at,
              actor,
            });
            yield* platformEvents.emit({ kind: "task.created", actor, payload: { task }, at });
            yield* announce({ _tag: "record", topic: "task", id: task.id, kind: "created" });
            return task;
          }),
        );
      }),

    /**
     * Updates a task and returns it as stored. The `task.updated` event lists
     * what changed.
     *
     * A patch that sets no field fails to decode with a `Validation` error, and
     * a patch that asks for the values the task already has writes nothing.
     * Otherwise either one would move `updatedAt` and write a `task.updated`
     * event that describes no change, and a workflow triggered by that event
     * would run for nothing.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<Task, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.update");
        const { id, ...patch } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const actor = yield* currentStamp;
            const before = yield* readLiveTaskOrFail(id);
            yield* ensureProjectExists(patch.projectId);

            // Each field is compared on its own, rather than in a loop over
            // the field names, so each change keeps the type of its field.
            const changes: Mutable<TaskUpdatedEventPayload["changes"]> = {};
            const edit: Mutable<TaskEdit> = {};
            if (isNewValue(patch.title, before.title)) {
              changes.title = { old: before.title, new: patch.title };
              edit.title = patch.title;
            }
            if (isNewValue(patch.description, before.description)) {
              changes.description = { old: before.description, new: patch.description };
              edit.description = patch.description;
            }
            if (isNewValue(patch.status, before.status)) {
              changes.status = { old: before.status, new: patch.status };
              edit.status = patch.status;
            }
            if (isNewValue(patch.priority, before.priority)) {
              changes.priority = { old: before.priority, new: patch.priority };
              edit.priority = patch.priority;
            }
            const project = before.projectId ?? null;
            if (isNewValue(patch.projectId, project)) {
              changes.projectId = { old: project, new: patch.projectId };
              edit.projectId = patch.projectId;
            }

            // A label in both lists is added and removed in one call, so the
            // task keeps it. Reporting it as removed would trigger every
            // workflow that watches for that label being removed.
            const adding = removeDuplicates(patch.addLabels ?? []);
            const removed = removeDuplicates(patch.removeLabels ?? []).filter(
              (label) => !adding.includes(label) && before.labels.includes(label),
            );
            const kept = before.labels.filter((label) => !removed.includes(label));
            const added = adding.filter((label) => !kept.includes(label));
            if (added.length > 0 || removed.length > 0) {
              // The contract limits the labels in one call; the total is
              // checked here, because labels are added a few at a time and the
              // cap applies to the task's final labels, not to one edit.
              if (kept.length + added.length > MAX_TASK_LABELS) {
                return yield* Effect.fail(
                  createValidationError([
                    {
                      path: ["addLabels"],
                      message: `A task carries at most ${String(MAX_TASK_LABELS)} labels.`,
                    },
                  ]),
                );
              }
              changes.labels = { added, removed };
              edit.labels = [...kept, ...added];
            }

            const appended = patch.provenance ?? [];
            if (appended.length > 0) {
              const entries: ReadonlyArray<ProvenanceEntry> = appended.map((entry) => ({
                ...entry,
                at,
                actor,
              }));
              changes.provenance = { added: entries, removed: [] };
            }

            // If nothing changes, the task is returned as it is, with no row
            // written and no event recorded.
            if (Object.keys(changes).length === 0) return before;

            yield* tasks.update(id, edit, appended, at, actor);
            yield* platformEvents.emit({
              kind: "task.updated",
              actor,
              payload: { taskId: id, changes },
              at,
            });
            yield* announce({ _tag: "record", topic: "task", id, kind: "updated" });
            // Read back rather than merged in memory, so the caller gets the
            // row that was written, whatever the edit changed.
            return yield* readLiveTaskOrFail(id);
          }),
        );
      }),

    /**
     * Soft-deletes a task, and withdraws the open decisions about it. The row
     * stays, so the log and the runs that reference the task still point at
     * something. Fails with `NotFound` if the task does not exist or is
     * already deleted.
     */
    delete: (
      id: Id,
    ): Effect.Effect<Record<string, never>, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.delete");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const actor = yield* currentStamp;
            const task = yield* readLiveTaskOrFail(id);
            yield* tasks.softDelete(id, at);
            // The event holds a final snapshot, because nothing can read the
            // row afterwards.
            yield* audit.append({
              kind: "task.deleted",
              actor,
              record: { topic: "task", id },
              payload: { taskId: id, snapshot: { ...task, deletedAt: at } },
              at,
            });
            yield* notifier.withdrawDecisionsAbout([{ kind: "task", id }], "task deleted");
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

export const TaskServiceLayer: Layer.Layer<
  TaskService,
  never,
  SqlClient.SqlClient | AuditLog | PlatformEvents | Notifier
> = Layer.effect(TaskService)(make);
