/**
 * Tasks: units of human intent.
 *
 * The row is thin on purpose. There is one fixed status axis with no state
 * machine, bare-string labels with no registry, and no assignee, subtask or
 * comment; everything a richer task engine would hard-code is a workflow's to
 * say. What the core does own is the shape below, the append-only provenance
 * that lets a repeated signal find its existing task, and the full-text query.
 *
 * Delete is soft. A deleted task answers `not_found` on read, is excluded from
 * `query` and from search, and there is no include-deleted option.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Actor, ExternalRef, Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { bounded } from "../strings";
import { EventId } from "./event";

/** The longest title. A title is a line, not a paragraph. */
export const MAX_TASK_TITLE_LENGTH = 512;

/** The longest description. It is markdown a person or an agent writes. */
export const MAX_TASK_DESCRIPTION_LENGTH = 64 * 1024;

/** The longest label. */
export const MAX_LABEL_LENGTH = 64;

/** The longest search text. Longer than a sentence is not a search. */
export const MAX_SEARCH_TEXT_LENGTH = 512;

/** The fixed status axis. Every transition between these is legal. */
export const TaskStatus = Schema.Literals(["open", "in-progress", "done", "cancelled"]);

export type TaskStatus = Schema.Schema.Type<typeof TaskStatus>;

/** How much this matters. Rendered as bars and weight, never as colour. */
export const TaskPriority = Schema.Literals(["urgent", "high", "normal", "low"]);

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
 * A provenance entry as a caller writes it. `at` and `actor` are declared and
 * uninhabited rather than left out: an excess property is dropped in silence,
 * and a caller who thinks they stamped an entry with someone else's actor
 * deserves to be told they did not.
 */
const ProvenanceInput = Schema.Struct({
  ref: Schema.optionalKey(ExternalRef),
  eventId: Schema.optionalKey(EventId),
  runId: Schema.optionalKey(Id),
  at: Schema.optionalKey(Schema.Never.annotate({ description: "stamped by the core" })),
  actor: Schema.optionalKey(Schema.Never.annotate({ description: "stamped by the core" })),
}).check(
  Schema.makeFilter((entry) =>
    entry.ref === undefined && entry.eventId === undefined && entry.runId === undefined
      ? "A provenance entry names at least one of ref, eventId and runId."
      : undefined,
  ),
);

export const Task = Schema.Struct({
  id: Id,
  title: TaskTitle,
  description: TaskDescription,
  status: TaskStatus,
  priority: TaskPriority,
  labels: Schema.Array(Label),
  /** At most one project, and it survives that project's deletion. */
  projectId: Schema.optionalKey(Id),
  provenance: Schema.Array(ProvenanceEntry),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Moves only when `status` does. */
  statusChangedAt: Timestamp,
  /** Set by a delete, and so absent from everything a caller can still read. */
  deletedAt: Schema.optionalKey(Timestamp),
});

export type Task = Schema.Schema.Type<typeof Task>;

/**
 * What narrows a task listing. Within one field the values are any-of; across
 * fields the filter is and. There is no `or` across fields and no negation.
 * `text` is full text over the title and the description; a label and a ref are
 * never reached through it.
 */
export const TaskFilter = Schema.Struct({
  refs: Schema.optionalKey(Schema.Array(ExternalRef)),
  labels: Schema.optionalKey(Schema.Array(Label)),
  status: Schema.optionalKey(Schema.Array(TaskStatus)),
  projectId: Schema.optionalKey(Id),
  text: Schema.optionalKey(bounded(1, MAX_SEARCH_TEXT_LENGTH)),
});

export type TaskFilter = Schema.Schema.Type<typeof TaskFilter>;

/** What a task listing may be sorted by, when it is not sorted by relevance. */
export const TASK_SORT_FIELDS = ["updatedAt", "createdAt", "priority", "status"] as const;

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
      payload: Schema.Struct({
        title: TaskTitle,
        description: TaskDescription,
        priority: Schema.optionalKey(TaskPriority),
        labels: Schema.optionalKey(Schema.Array(Label)),
        projectId: Schema.optionalKey(Id),
        provenance: Schema.optionalKey(Schema.Array(ProvenanceInput)),
      }),
      success: Task,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.patch("update", "/tasks/:id", {
      params: { id: Id },
      payload: Schema.Struct({
        title: Schema.optionalKey(TaskTitle),
        description: Schema.optionalKey(TaskDescription),
        status: Schema.optionalKey(TaskStatus),
        priority: Schema.optionalKey(TaskPriority),
        /** `null` detaches the task from its project. */
        projectId: Schema.optionalKey(Schema.NullOr(Id)),
        /**
         * Labels move one at a time. The user and a triage agent write the same
         * task, and a whole-array replace would silently undo whichever of them
         * read the task first.
         */
        addLabels: Schema.optionalKey(Schema.Array(Label)),
        removeLabels: Schema.optionalKey(Schema.Array(Label)),
        /** Appends. Provenance is never edited and never removed. */
        provenance: Schema.optionalKey(Schema.Array(ProvenanceInput)),
      }),
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
