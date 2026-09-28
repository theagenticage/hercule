/**
 * Tasks: units of human intent.
 *
 * The row is deliberately minimal. There is one fixed status field with no
 * state machine, plain-string labels with no registry, and no assignee,
 * subtask or comment; anything a richer task engine would hard-code is left to
 * workflows. The core owns the shape below, the append-only provenance that
 * lets a repeated signal find its existing task, and the full-text query.
 *
 * Delete is soft. Reading a deleted task fails with `not_found`, it is left
 * out of `query` and search, and there is no option to include deleted tasks.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Actor, ExternalRef, Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";
import { EventId } from "./event";

/** The longest title. A title is a line, not a paragraph. */
export const MAX_TASK_TITLE_LENGTH = 512;

/** The longest description. It is markdown a person or an agent writes. */
export const MAX_TASK_DESCRIPTION_LENGTH = 64 * 1024;

/** The longest label. */
export const MAX_LABEL_LENGTH = 64;

/** The longest search text. Longer than a sentence is not a search. */
export const MAX_SEARCH_TEXT_LENGTH = 512;

/**
 * The most labels one task carries. Labels are a flat namespace with no
 * registry, so nothing else limits how many an edit can add to a row, and
 * every one of them is read on every page and copied into a `task.updated`
 * payload the log keeps for 90 days. The limit is far more than anyone reads
 * at a glance.
 */
export const MAX_TASK_LABELS = 64;

/**
 * The most provenance entries one call may append. The record itself grows
 * over a task's life and has no limit - that is its purpose - so this limits
 * only a single write.
 */
export const MAX_PROVENANCE_APPEND = 32;

/**
 * The most values one filter field takes. A filter matches any of the values
 * within a field, and a longer list than this is not a filter but a query the
 * caller should have split; the screens ask for four statuses and a handful of
 * labels.
 */
export const MAX_FILTER_VALUES = 64;

/** The fixed set of statuses. Every transition between them is allowed. */
export const TASK_STATUSES = ["open", "in-progress", "done", "cancelled"] as const;

export const TaskStatus = Schema.Literals(TASK_STATUSES);

export type TaskStatus = Schema.Schema.Type<typeof TaskStatus>;

/**
 * How much this matters. Shown as bars and font weight, never as colour. The
 * list is in ranking order, so a client that shows a picker uses it as is.
 */
export const TASK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;

export const TaskPriority = Schema.Literals(TASK_PRIORITIES);

export type TaskPriority = Schema.Schema.Type<typeof TaskPriority>;

/** A label: a bare string in one flat namespace. Nothing registers it. */
export const Label = bounded(1, MAX_LABEL_LENGTH);

const TaskTitle = bounded(1, MAX_TASK_TITLE_LENGTH);
const TaskDescription = bounded(0, MAX_TASK_DESCRIPTION_LENGTH);

/**
 * One entry in a task's record of what created or touched it: the external
 * thing, the event, the run, or any combination of the three.
 */
export const ProvenanceEntry = Schema.Struct({
  ref: Schema.optionalKey(ExternalRef),
  /** An event's id, which is its position in the log, and so an integer. */
  eventId: Schema.optionalKey(EventId),
  runId: Schema.optionalKey(Id),
  at: Timestamp,
  actor: Actor,
});

export type ProvenanceEntry = Schema.Schema.Type<typeof ProvenanceEntry>;

/**
 * A provenance field that the core sets when it stores the entry. Decoding
 * fails for any value a caller sends, with a message that explains why.
 */
const CoreStampedField = Schema.Never.annotate({
  description: "stamped by the core",
  message:
    "The core sets this field when it stores the entry, so a caller cannot write it. Remove the field.",
});

/**
 * A provenance entry as a caller writes it. `at` and `actor` are declared with
 * a schema no value matches, rather than left out: an unknown property would
 * be silently dropped, and a caller who thinks they set someone else's actor
 * on an entry should be told that they did not.
 */
const ProvenanceInput = Schema.Struct({
  ref: Schema.optionalKey(ExternalRef),
  eventId: Schema.optionalKey(EventId),
  runId: Schema.optionalKey(Id),
  at: Schema.optionalKey(CoreStampedField),
  actor: Schema.optionalKey(CoreStampedField),
}).check(
  Schema.makeFilter((entry) =>
    entry.ref === undefined && entry.eventId === undefined && entry.runId === undefined
      ? "A provenance entry must include at least one of ref, eventId and runId."
      : undefined,
  ),
);

export const Task = Schema.Struct({
  id: Id,
  title: TaskTitle,
  description: TaskDescription,
  status: TaskStatus,
  priority: TaskPriority,
  labels: atMost(Label, MAX_TASK_LABELS),
  /** At most one project, and it survives that project's deletion. */
  projectId: Schema.optionalKey(Id),
  provenance: Schema.Array(ProvenanceEntry),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Changes only when `status` changes. */
  statusChangedAt: Timestamp,
  /** Set by a delete. A deleted task is never returned, so a caller never sees this field. */
  deletedAt: Schema.optionalKey(Timestamp),
});

export type Task = Schema.Schema.Type<typeof Task>;

/**
 * The payload of `task.created`, which the controller emits when a task is
 * created: the task as it was stored. The event's `actor` holds who created
 * it.
 */
export const TaskCreatedEventPayload = Schema.Struct({ task: Task });

export type TaskCreatedEventPayload = Schema.Schema.Type<typeof TaskCreatedEventPayload>;

/** Returns the schema of a change to a field that holds one value: its old value and its new one. */
const buildValueChange = <Value extends Schema.Top>(value: Value) =>
  Schema.Struct({ old: value, new: value });

/**
 * The payload of `task.updated`, which the controller emits once per task
 * update: the task's id, and one entry in `changes` for each field the update
 * changed. A field that did not change has no entry, so a trigger can filter
 * on `has(event.payload.changes.status)`.
 *
 * - A field that holds one value reports `{ old, new }`.
 * - `labels` reports the labels `added` and `removed`.
 * - `provenance` reports the entries `added`. Provenance is only ever
 *   appended to, so `removed` is always empty.
 *
 * The event's `actor` holds who updated the task.
 */
export const TaskUpdatedEventPayload = Schema.Struct({
  taskId: Id,
  changes: Schema.Struct({
    title: Schema.optionalKey(buildValueChange(TaskTitle)),
    description: Schema.optionalKey(buildValueChange(TaskDescription)),
    status: Schema.optionalKey(buildValueChange(TaskStatus)),
    priority: Schema.optionalKey(buildValueChange(TaskPriority)),
    /** `null` when the task had, or now has, no project. */
    projectId: Schema.optionalKey(buildValueChange(Schema.NullOr(Id))),
    labels: Schema.optionalKey(
      Schema.Struct({ added: Schema.Array(Label), removed: Schema.Array(Label) }),
    ),
    provenance: Schema.optionalKey(
      Schema.Struct({ added: Schema.Array(ProvenanceEntry), removed: Schema.Tuple([]) }),
    ),
  }),
});

export type TaskUpdatedEventPayload = Schema.Schema.Type<typeof TaskUpdatedEventPayload>;

/**
 * The filters of `task.query`. Within one field, a task matches any of the
 * values; across fields, a task must match every field. There is no `or`
 * across fields and no negation. `text` is a full-text search over the title
 * and the description; it never matches labels or refs.
 */
export const TaskFilter = Schema.Struct({
  refs: Schema.optionalKey(atMost(ExternalRef, MAX_FILTER_VALUES)),
  labels: Schema.optionalKey(atMost(Label, MAX_FILTER_VALUES)),
  status: Schema.optionalKey(atMost(TaskStatus, MAX_FILTER_VALUES)),
  projectId: Schema.optionalKey(Id),
  text: Schema.optionalKey(bounded(1, MAX_SEARCH_TEXT_LENGTH)),
});

export type TaskFilter = Schema.Schema.Type<typeof TaskFilter>;

/** What a task listing may be sorted by, when it is not sorted by relevance. */
export const TASK_SORT_FIELDS = ["updatedAt", "createdAt", "priority", "status"] as const;

/**
 * The payload of `task.create`. The service decodes it too, so an in-process
 * caller must send the same shape as a request.
 */
export const TaskCreateInput = Schema.Struct({
  title: TaskTitle,
  description: TaskDescription,
  priority: Schema.optionalKey(TaskPriority),
  labels: Schema.optionalKey(atMost(Label, MAX_TASK_LABELS)),
  projectId: Schema.optionalKey(Id),
  provenance: Schema.optionalKey(atMost(ProvenanceInput, MAX_PROVENANCE_APPEND)),
});

export type TaskCreateInput = Schema.Schema.Type<typeof TaskCreateInput>;

/** The fields a task update can change. */
const TASK_UPDATE_FIELDS = {
  title: Schema.optionalKey(TaskTitle),
  description: Schema.optionalKey(TaskDescription),
  status: Schema.optionalKey(TaskStatus),
  priority: Schema.optionalKey(TaskPriority),
  /** `null` detaches the task from its project. */
  projectId: Schema.optionalKey(Schema.NullOr(Id)),
  /**
   * Labels are added and removed one at a time. The user and a triage agent
   * write the same task, and replacing the whole array would silently undo
   * the change of whichever of them read the task first.
   */
  addLabels: Schema.optionalKey(atMost(Label, MAX_TASK_LABELS)),
  removeLabels: Schema.optionalKey(atMost(Label, MAX_TASK_LABELS)),
  /** Entries to append. Provenance is never edited and never removed. */
  provenance: Schema.optionalKey(atMost(ProvenanceInput, MAX_PROVENANCE_APPEND)),
};

/**
 * Rejects a task update that sets no field. Such an update would still change
 * `updatedAt` and record a `task.updated` event with no changes, and that
 * event could start a workflow for nothing. The `task.update` operation and
 * the built-in action that calls it both use this check, so both reject the
 * same updates.
 */
export const refuseEmptyTaskUpdate = Schema.makeFilter(
  (update: { readonly [Field in keyof typeof TASK_UPDATE_FIELDS]?: unknown }) =>
    Object.keys(TASK_UPDATE_FIELDS).some(
      (field) => update[field as keyof typeof TASK_UPDATE_FIELDS] !== undefined,
    )
      ? undefined
      : "A task update must include at least one field to change. Add each field to change, such as title or status.",
);

/**
 * The input of a task update. Every field is optional and an absent field is
 * left unchanged, but at least one field must be set.
 */
export const TaskUpdateInput = Schema.Struct(TASK_UPDATE_FIELDS).check(refuseEmptyTaskUpdate);

export type TaskUpdateInput = Schema.Schema.Type<typeof TaskUpdateInput>;

/**
 * One call of `task.update` as a single object: the task's id, which an HTTP
 * request sends in its path, and the changes. A workflow step and a bound
 * answer have no path, so both send this shape. The check is the operation's
 * own, so all three reject an update that changes no field.
 */
export const TaskUpdateCall = Schema.Struct({ taskId: Id, ...TASK_UPDATE_FIELDS }).check(
  refuseEmptyTaskUpdate,
);

export type TaskUpdateCall = Schema.Schema.Type<typeof TaskUpdateCall>;

export const task = HttpApiGroup.make("task")
  .add(
    HttpApiEndpoint.get("query", "/tasks", {
      query: Schema.Struct({
        ...TaskFilter.fields,
        ...pageParams(TASK_SORT_FIELDS).fields,
      }),
      success: page(Task),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/tasks/:id", {
      params: { id: Id },
      success: Task,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/tasks", {
      payload: TaskCreateInput,
      success: Task,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.patch("update", "/tasks/:id", {
      params: { id: Id },
      payload: TaskUpdateInput,
      success: Task,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/tasks/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
