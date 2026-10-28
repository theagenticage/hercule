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
import { TaskPriority } from "@hercule/plugin-host";
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Actor, ExternalRef, Id, Timestamp } from "../ids";
import { DEFAULT_PAGE_LIMIT, page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";
import { EventId } from "./event-record";
import { RunStatus } from "./run-status";

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

/** Re-exported from the package plugins are written against, so a signal's priority and a Task's agree. */
export { TASK_PRIORITIES, TaskPriority } from "@hercule/plugin-host";

/** A label: a bare string in one flat namespace. Nothing registers it. */
export const Label = bounded(1, MAX_LABEL_LENGTH);

const TaskTitle = bounded(1, MAX_TASK_TITLE_LENGTH);
const TaskDescription = bounded(0, MAX_TASK_DESCRIPTION_LENGTH);

/**
 * One entry in a task's record of what created or touched it: the external
 * thing, the event, the run, the signal, or any combination of the four.
 */
export const ProvenanceEntry = Schema.Struct({
  ref: Schema.optionalKey(ExternalRef),
  /** An event's id, which is its position in the log, and so an integer. */
  eventId: Schema.optionalKey(EventId),
  runId: Schema.optionalKey(Id),
  /**
   * The signal the user handed to an agent, when this entry records that
   * handoff. Only `signal.handOff` writes it, so a task with such an entry is
   * work the user handed off from Intake.
   */
  signalId: Schema.optionalKey(Id),
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
  signalId: Schema.optionalKey(CoreStampedField),
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
  /**
   * `true` lists only the tasks with a handoff entry in their provenance: an
   * entry that names a signal the user handed to an agent. `false` lists only
   * the tasks without one.
   */
  handedOff: Schema.optionalKey(Schema.Boolean),
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
 * answer have no path, so both send this shape. It uses the same check as
 * `TaskUpdateInput`, so an update that changes no field fails in all three.
 */
export const TaskUpdateCall = Schema.Struct({ taskId: Id, ...TASK_UPDATE_FIELDS }).check(
  refuseEmptyTaskUpdate,
);

export type TaskUpdateCall = Schema.Schema.Type<typeof TaskUpdateCall>;

/**
 * The most handoffs a Tracking row holds. A Task that was handed more than
 * this many signals returns its newest ones, so the reply does not grow with a
 * Task's history.
 */
export const MAX_TRACKING_HANDOFFS = 10;

/**
 * One handoff of a signal to the Task's workflow: the signal the user handed
 * off, the run that started, and when. It is a provenance entry that names a
 * signal.
 */
export const TrackingHandoff = Schema.Struct({ signalId: Id, runId: Id, at: Timestamp });

export type TrackingHandoff = Schema.Schema.Type<typeof TrackingHandoff>;

/**
 * The most characters of why a run failed (`TrackingRun.failureCause`). A
 * longer cause is cut to this many, "…" included. The cause is an error
 * message, which is as long as whatever produced it.
 */
export const MAX_TRACKING_FAILURE_CAUSE = 300;

/**
 * What a client needs to know about one run of a tracked Task to work out
 * where the work stands. It holds a run summary's fields plus `failureCause`,
 * so no row needs a `run.read`.
 */
export const TrackingRun = Schema.Struct({
  id: Id,
  /** `null` for a run of a workflow that was sent with the run and never stored. */
  workflowId: Schema.NullOr(Id),
  /** The workflow's name as it was when the run started. */
  workflowName: Schema.String,
  status: RunStatus,
  createdAt: Timestamp,
  startedAt: Schema.optionalKey(Timestamp),
  finishedAt: Schema.optionalKey(Timestamp),
  /**
   * The ids of the signal triggers a running run waits on, when it has no
   * step to run and waits for one of them. Empty for any other run.
   */
  awaitedSignalIds: Schema.Array(Schema.String),
  /**
   * Why the run failed, in a few words, such as "permission denied on
   * ops-db": the failure message, the message of the edge it failed at, or the
   * error of the step that failed, else the failure reason in plain words.
   * Present only for a failed run.
   */
  failureCause: Schema.optionalKey(bounded(0, MAX_TRACKING_FAILURE_CAUSE)),
});

export type TrackingRun = Schema.Schema.Type<typeof TrackingRun>;

/** One Task that Tracking follows, with the facts its state is worked out from. */
export const TrackingTask = Schema.Struct({
  taskId: Id,
  title: Schema.String,
  /**
   * The Task's newest handoffs, newest first, at most `MAX_TRACKING_HANDOFFS`.
   * A client that waits for its own handoff to show looks for the receipt
   * here; an older handoff has no bearing on where the work stands.
   */
  handoffs: atMost(TrackingHandoff, MAX_TRACKING_HANDOFFS),
  /** The Task's newest run, by creation time. */
  latestRun: TrackingRun,
  /** The Task's newest run that is pending or running, when one is. */
  latestLiveRun: Schema.optionalKey(TrackingRun),
  /**
   * The ids of every run of the Task that is pending or running, newest first,
   * so the first is `latestLiveRun`'s. Empty when no run is live. A Task can
   * have more than one live run: a second handoff on the same Task starts a
   * new run while the first still goes on. A client that asks whether any
   * live run of the Task is waiting on the user, for example through an open
   * Request of its session, looks for the run among these ids.
   */
  liveRunIds: Schema.Array(Id),
});

export type TrackingTask = Schema.Schema.Type<typeof TrackingTask>;

/** What `task.queryTracking` returns: every Task Tracking follows. */
export const TaskTracking = Schema.Struct({ rows: Schema.Array(TrackingTask) });

export type TaskTracking = Schema.Schema.Type<typeof TaskTracking>;

/** The most runs `task.readTracking` lists: the Task's newest ones. */
export const MAX_TRACKING_DETAIL_RUNS = 20;

/** The most characters of a text output. A longer text is cut to this many, "…" included. */
export const MAX_TRACKING_OUTPUT_TEXT = 1000;

/** The most fields of a fields output. The schema's later properties are left out. */
export const MAX_TRACKING_OUTPUT_FIELDS = 12;

/** The most characters of one string value of a fields output. A longer one is cut to this many, "…" included. */
export const MAX_TRACKING_OUTPUT_VALUE = 300;

/** The most characters of the label of a field. A longer label is cut to this many, "…" included. */
export const MAX_TRACKING_OUTPUT_LABEL = 80;

/**
 * The most characters of the name of a step, as the pane shows it: the step
 * that produced the output, and the action step the newest run ended on. A
 * longer name is cut to this many, "…" included. A workflow may give a step a
 * name of any length, and so a step's own id.
 */
export const MAX_TRACKING_STEP_NAME = 80;

/**
 * One run of a Task as the Tracking pane lists it: the facts of a Tracking
 * row's run, and the session of the run's last agent step, which holds the
 * run's thread.
 */
export const TrackingDetailRun = Schema.Struct({
  ...TrackingRun.fields,
  /** The session of the run's last agent step. Absent for a run that never started one. */
  sessionId: Schema.optionalKey(Id),
});

export type TrackingDetailRun = Schema.Schema.Type<typeof TrackingDetailRun>;

/**
 * The value of one field of a fields output. A string longer than
 * `MAX_TRACKING_OUTPUT_VALUE` is cut. An array and an object are not sent,
 * only how many items or fields they hold, so a reply never grows with the
 * output.
 */
export const TrackingOutputValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Struct({ items: Schema.Int }),
  Schema.Struct({ fields: Schema.Int }),
]);

export type TrackingOutputValue = Schema.Schema.Type<typeof TrackingOutputValue>;

/** One top-level field of a structured output, with the label a person reads. */
export const TrackingOutputField = Schema.Struct({
  /**
   * The `title` of the field's property in the step's output schema, else the
   * property's name, at most `MAX_TRACKING_OUTPUT_LABEL` characters.
   */
  label: bounded(0, MAX_TRACKING_OUTPUT_LABEL),
  value: TrackingOutputValue,
});

export type TrackingOutputField = Schema.Schema.Type<typeof TrackingOutputField>;

/**
 * What a run's last agent step produced, shaped to be drawn: free text for a
 * step with no output schema, fields for a step with one. The text and every
 * value are cut, so the reply does not grow with the output.
 */
export const TrackingOutput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    /** The step's `name`, else its id, at most `MAX_TRACKING_STEP_NAME` characters. */
    stepName: bounded(0, MAX_TRACKING_STEP_NAME),
    /** The session that ran the step: its thread. */
    sessionId: Schema.optionalKey(Id),
    /** The `text` of the step's output, at most `MAX_TRACKING_OUTPUT_TEXT` characters. */
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("fields"),
    stepName: bounded(0, MAX_TRACKING_STEP_NAME),
    sessionId: Schema.optionalKey(Id),
    /** The output's top-level fields in the output schema's property order, at most `MAX_TRACKING_OUTPUT_FIELDS`. */
    fields: atMost(TrackingOutputField, MAX_TRACKING_OUTPUT_FIELDS),
  }),
]);

export type TrackingOutput = Schema.Schema.Type<typeof TrackingOutput>;

/**
 * One handoff of a Task together with the name of the workflow it handed the
 * signal to, which a client cannot read from other runs it holds when the
 * handoff's run is older than the newest ones. The Tracking pane draws the
 * Task's oldest handoff this way (`TrackingDetail.firstHandoff`), and a leg
 * names the handoff that follows it this way (`HandoffLeg.next`).
 */
export const TrackingHandoffWithWorkflow = Schema.Struct({
  ...TrackingHandoff.fields,
  /** The name of the workflow of the handoff's run, as it was when that run started. */
  workflowName: Schema.String,
});

export type TrackingHandoffWithWorkflow = Schema.Schema.Type<typeof TrackingHandoffWithWorkflow>;

/** What `task.readTracking` returns: what the Tracking pane of one Task draws. */
export const TrackingDetail = Schema.Struct({
  /** The Task's oldest handoff: the signal the user first handed to an agent. */
  firstHandoff: TrackingHandoffWithWorkflow,
  /** The Task's newest runs, at most `MAX_TRACKING_DETAIL_RUNS`, oldest first. */
  runs: atMost(TrackingDetailRun, MAX_TRACKING_DETAIL_RUNS),
  /**
   * What the newest run's last completed agent step (by `finishedAt`)
   * produced. Absent when the run has completed no agent step, or the step
   * left nothing to show.
   */
  output: Schema.optionalKey(TrackingOutput),
  /**
   * The name of the action step the newest run ended on: its `name`, else its
   * action's id. Present only when the newest run completed and its last
   * completed step is an action step, so it finished after the agent step
   * `output` comes from. A run that is live or failed has not ended on a
   * step, so it has none. At most `MAX_TRACKING_STEP_NAME` characters.
   */
  endingActionStepName: Schema.optionalKey(bounded(0, MAX_TRACKING_STEP_NAME)),
});

export type TrackingDetail = Schema.Schema.Type<typeof TrackingDetail>;

/**
 * The most run ids one `task.queryLegs` call takes. It is the size of a page of
 * Done signals, so a client asks for the legs of one page in one call.
 */
export const MAX_LEG_QUERY_RUNS = DEFAULT_PAGE_LIMIT;

/**
 * The most ids `HandoffLeg.liveRunIds` lists. The ids are a sample of the
 * leg's live runs, newest first: a leg is not expected to have more runs
 * going at once, and the cap keeps the reply from growing with them.
 */
export const MAX_LEG_LIVE_RUNS = 20;

/**
 * One handoff of a signal to a Task's workflow, with where the work it
 * started stands: the handoff's run and every run that re-runs it (a "leg").
 * A client draws the line "handed to X, tried again twice, finished" from it
 * without reading the Task's whole history.
 */
export const HandoffLeg = Schema.Struct({
  /** The run the handoff started: the handoff entry's `runId`. */
  runId: Id,
  /** The signal the user handed off. */
  signalId: Id,
  /** The Task the handoff belongs to. */
  taskId: Id,
  /** The Task's status now. */
  taskStatus: TaskStatus,
  /** The workflow of the handoff's run. `null` for a run of a workflow that was sent with the run and never stored. */
  workflowId: Schema.NullOr(Id),
  /** The name of the workflow of the handoff's run, as it was when that run started. */
  workflowName: Schema.String,
  /**
   * How many runs re-run the handoff's run. A re-run of a re-run counts, and
   * each run counts once. The runs are those the leg holds, as `latestRun`
   * describes.
   */
  rerunCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * The newest run of the leg, by creation time and then id. It is the
   * handoff's run when nothing re-ran it. A leg holds the handoff's run and
   * every run that can be reached from it through the run it re-runs, however
   * many re-runs deep, and that belongs to the same Task. It never holds a run
   * only because it started around the same time.
   *
   * Only its id and status: they are all a client reads, to name how the leg
   * stands and to open the run. A client that wants more of the run reads the
   * run itself.
   */
  latestRun: Schema.Struct({ id: Id, status: RunStatus }),
  /**
   * The ids of the leg's runs that are pending or running, newest first, at
   * most `MAX_LEG_LIVE_RUNS`. Empty when no run of the leg is live.
   */
  liveRunIds: atMost(Id, MAX_LEG_LIVE_RUNS),
  /**
   * The Task's next handoff: the handoff entry that follows this one by time,
   * then by the order it was appended, whichever signal it handed off. Absent
   * when this is the Task's newest handoff. It marks the end of this leg's
   * story: the user handed the Task on.
   */
  next: Schema.optionalKey(TrackingHandoffWithWorkflow),
});

export type HandoffLeg = Schema.Schema.Type<typeof HandoffLeg>;

/** What `task.queryLegs` returns: the leg of each handoff that was asked for, in the order asked. */
export const HandoffLegs = Schema.Struct({ legs: Schema.Array(HandoffLeg) });

export type HandoffLegs = Schema.Schema.Type<typeof HandoffLegs>;

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
    // A static path beside `/tasks/:id`: the router prefers it, and "tracking"
    // is not an id.
    HttpApiEndpoint.get("queryTracking", "/tasks/tracking", {
      success: TaskTracking,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    /**
     * Returns the leg of each given run that is the run of a handoff of a
     * Task: the handoff, the runs that re-ran it, and where they stand. Each
     * id is looked up on its own. An id that is not the run of a handoff of a
     * Task that exists is left out of the reply, so the reply may hold fewer
     * legs than ids: an unknown run, a run of no Task, a run of a deleted Task,
     * and a run that only re-runs a handoff's run. The legs come in the order
     * of the ids. Each leg is a fixed size, so the reply does not grow with a
     * Task's history.
     */
    // A static path beside `/tasks/:id`, for the same reason as `/tasks/tracking`:
    // the router prefers it, and "legs" is not an id.
    HttpApiEndpoint.get("queryLegs", "/tasks/legs", {
      query: Schema.Struct({
        runIds: atMost(Id, MAX_LEG_QUERY_RUNS).check(Schema.isMinLength(1)),
      }),
      success: HandoffLegs,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    // `/tasks/:id/tracking` has one more segment than `/tasks/:id`, so the
    // router never takes it for that route.
    HttpApiEndpoint.get("readTracking", "/tasks/:id/tracking", {
      params: { id: Id },
      success: TrackingDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
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
