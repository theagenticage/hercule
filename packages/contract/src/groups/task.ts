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
import { Fact } from "@hercule/protocol";
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import {
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Actor, ExternalRef, Id, Timestamp } from "../ids";
import { DEFAULT_PAGE_LIMIT, page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";
import {
  EntityEdge,
  EntityGrouping,
  EntityLifecycle,
  EntityMark,
  EntityPlace,
  MAX_BOARD_GROUPINGS,
  MAX_BOARD_PLACES,
  MAX_CARD_CONTEXTS,
  MAX_ENTITY_MARKS,
  MAX_GRAPH_EDGES,
} from "./entity-context";
import { EventId } from "./event-record";
import { RunStatus } from "./run-status";
import { Session, SessionRequest } from "./session";
import { MAX_TASK_TITLE_LENGTH, TaskTitle } from "./task-title";

export { MAX_TASK_TITLE_LENGTH };

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

/** The five stages Work draws, in the order it draws them. */
export const BOARD_STAGES = ["exploring", "planned", "building", "in-review", "landed"] as const;

/**
 * Where a Task stands. The five board stages are the ones Work draws; `done`
 * and `dropped` are the ends.
 */
export const TASK_STAGES = [...BOARD_STAGES, "done", "dropped"] as const;

export const TaskStage = Schema.Literals(TASK_STAGES);

export type TaskStage = Schema.Schema.Type<typeof TaskStage>;

/**
 * A stage that Work draws: any stage but `done` and `dropped`. The
 * board shows no Task at an end, and `task.move` refuses to put one there.
 */
export const BoardStage = Schema.Literals(BOARD_STAGES);

export type BoardStage = Schema.Schema.Type<typeof BoardStage>;

/**
 * The stages at which a Task is finished: `done` and `dropped`. A Task at one
 * of them takes no new Thread, and a workspace whose Task is at one starts a
 * new Task.
 */
export const FINISHED_STAGES: ReadonlyArray<TaskStage> = ["done", "dropped"];

/** Returns true if the stage is `done` or `dropped`, so a Task at it takes no new work. */
export const isFinishedStage = (stage: TaskStage): boolean => FINISHED_STAGES.includes(stage);

/**
 * Returns the coarse status that reads a stage: `exploring` and `planned` are
 * `open`; `building`, `in-review` and `landed` are `in-progress`; `done` is
 * `done`; `dropped` is `cancelled`.
 *
 * The stage is the truth and the status is only ever written from it, so the
 * two never disagree. The status stays because stored workflows, frozen run
 * plans and old events name its values.
 */
export const deriveTaskStatus = (stage: TaskStage): TaskStatus => {
  switch (stage) {
    case "exploring":
    case "planned":
      return "open";
    case "building":
    case "in-review":
    case "landed":
      return "in-progress";
    case "done":
      return "done";
    case "dropped":
      return "cancelled";
  }
};

/** Re-exported from the package plugins are written against, so a signal's priority and a Task's agree. */
export { TASK_PRIORITIES, TaskPriority } from "@hercule/plugin-host";

/** A label: a bare string in one flat namespace. Nothing registers it. */
export const Label = bounded(1, MAX_LABEL_LENGTH);

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
  /**
   * The Task that was merged into this one, when this entry records that
   * merge (`task.merge`). Only the core writes it, so a Task with such an
   * entry gained work from another Task. A merge moves the source's own
   * entries to the survivor unedited, so they keep their original `at` and
   * `actor`.
   */
  mergedTaskId: Schema.optionalKey(Id),
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
  mergedTaskId: Schema.optionalKey(CoreStampedField),
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
  /** A coarse reading of `stage`, worked out from it. */
  status: TaskStatus,
  stage: TaskStage,
  priority: TaskPriority,
  labels: atMost(Label, MAX_TASK_LABELS),
  /** At most one project, and it survives that project's deletion. */
  projectId: Schema.optionalKey(Id),
  /**
   * The Initiative the Task belongs to, when it does. At most one. A closed
   * Initiative keeps its Tasks, so this can name a closed one. Deleting the
   * Initiative clears it.
   */
  initiativeId: Schema.optionalKey(Id),
  provenance: Schema.Array(ProvenanceEntry),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Changes only when `status` changes. */
  statusChangedAt: Timestamp,
  /** Changes only when `stage` changes. */
  stageChangedAt: Timestamp,
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
 * - A field that holds one value reports `{ old, new }`. `boardRank` is one
 *   of them: the string that orders the cards of a cell.
 * - `labels` reports the labels `added` and `removed`.
 * - `blockedBy` reports the ids of the Tasks that were `added` and `removed`
 *   as this Task's blockers. A Task that is deleted or merged away reports
 *   its edges as `removed` (a merge reports them as `added` on the survivor).
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
    stage: Schema.optionalKey(buildValueChange(TaskStage)),
    priority: Schema.optionalKey(buildValueChange(TaskPriority)),
    /** `null` when the task had, or now has, no project. */
    projectId: Schema.optionalKey(buildValueChange(Schema.NullOr(Id))),
    /** `null` when the task had, or now has, no Initiative. */
    initiativeId: Schema.optionalKey(buildValueChange(Schema.NullOr(Id))),
    /**
     * The Task's place in its cell of the board. A move inside a cell reports
     * only this, so a trigger on `changes.stage` or `changes.status` does not
     * see it.
     */
    boardRank: Schema.optionalKey(buildValueChange(Schema.String)),
    labels: Schema.optionalKey(
      Schema.Struct({ added: Schema.Array(Label), removed: Schema.Array(Label) }),
    ),
    blockedBy: Schema.optionalKey(
      Schema.Struct({ added: Schema.Array(Id), removed: Schema.Array(Id) }),
    ),
    provenance: Schema.optionalKey(
      Schema.Struct({ added: Schema.Array(ProvenanceEntry), removed: Schema.Tuple([]) }),
    ),
  }),
});

export type TaskUpdatedEventPayload = Schema.Schema.Type<typeof TaskUpdatedEventPayload>;

/**
 * The payload of `task.entityChanged`, which the controller emits when a fact
 * about a linked External Entity is recorded for a live Task: once per Task
 * that links the entity. The fact is a stored row, so the event carries its
 * id.
 *
 * A fact is recorded when the entity's lifecycle changed, when a link to it
 * was added, when a linked ref was observed for the first time, when the last
 * open link was removed, or when a change to what can be read made the Task's
 * link counts differ. Nothing else records one: a new title, status or owner
 * does not.
 *
 * `previousLifecycle` is `null` when the entity was only just linked or only
 * just observed, so there is no earlier lifecycle to report. The event's
 * `actor` is the system.
 */
export const TaskEntityChangedEventPayload = Schema.Struct({
  taskId: Id,
  /** The linked entity the fact is about. */
  ref: ExternalRef,
  /** The entity's qualified kind, such as `github/pull-request`. */
  entityKind: Schema.String,
  lifecycle: EntityLifecycle,
  /** The lifecycle before this fact, or `null` when the entity was only just linked or observed. */
  previousLifecycle: Schema.NullOr(EntityLifecycle),
  /** The fact's id. A stage write that comes from this fact passes it as `stageFactId`. */
  factId: Schema.Int,
  /**
   * How many of the Task's links were open, or could not be read, when this
   * fact was written. A link to something that cannot be read counts as
   * open, because what cannot be read cannot be called finished.
   */
  openLinks: Schema.Int,
  /** How many of the Task's links were completed when this fact was written. */
  completedLinks: Schema.Int,
  /** When the entity was observed in this state. For display: it is never compared. */
  observedAt: Timestamp,
});

export type TaskEntityChangedEventPayload = Schema.Schema.Type<
  typeof TaskEntityChangedEventPayload
>;

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
  stage: Schema.optionalKey(atMost(TaskStage, MAX_FILTER_VALUES)),
  projectId: Schema.optionalKey(Id),
  /** Lists only the Tasks that belong to this Initiative. */
  initiativeId: Schema.optionalKey(Id),
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
  /** Where the Task starts. Absent means `planned`: a Task someone files is planned, not explored. */
  stage: Schema.optionalKey(TaskStage),
  priority: Schema.optionalKey(TaskPriority),
  labels: Schema.optionalKey(atMost(Label, MAX_TASK_LABELS)),
  projectId: Schema.optionalKey(Id),
  /** An Initiative to start on. Fails `not_found` for an unknown or deleted one, and `invalid_state` for a closed one. */
  initiativeId: Schema.optionalKey(Id),
  provenance: Schema.optionalKey(atMost(ProvenanceInput, MAX_PROVENANCE_APPEND)),
});

export type TaskCreateInput = Schema.Schema.Type<typeof TaskCreateInput>;

/** The fields a task update can change. */
const TASK_UPDATE_FIELDS = {
  title: Schema.optionalKey(TaskTitle),
  description: Schema.optionalKey(TaskDescription),
  /**
   * Sets a coarse status. The Task moves to a stage: `open` gives `planned`,
   * `in-progress` gives `building`, `done` gives `done` and `cancelled` gives
   * `dropped`. A Task whose stage already reads as that status stays where it
   * is: `in-progress` leaves an `in-review` Task there. `stage` is the exact
   * word; send it to choose the stage. A call that sends both is refused.
   */
  status: Schema.optionalKey(TaskStatus),
  /** Moves the Task to this stage. The status follows from it. */
  stage: Schema.optionalKey(TaskStage),
  priority: Schema.optionalKey(TaskPriority),
  /** `null` detaches the task from its project. */
  projectId: Schema.optionalKey(Schema.NullOr(Id)),
  /**
   * Puts the Task on this Initiative; `null` takes it off its Initiative.
   * Fails `not_found` for an unknown or deleted Initiative, and
   * `invalid_state` when the write changes the Task to a closed one. An
   * update that leaves a Task on its closed Initiative never fails for it.
   */
  initiativeId: Schema.optionalKey(Schema.NullOr(Id)),
  /**
   * Labels are added and removed one at a time. The user and a triage agent
   * write the same task, and replacing the whole array would silently undo
   * the change of whichever of them read the task first.
   */
  addLabels: Schema.optionalKey(atMost(Label, MAX_TASK_LABELS)),
  removeLabels: Schema.optionalKey(atMost(Label, MAX_TASK_LABELS)),
  /** Entries to append. Provenance is never edited and never removed. */
  provenance: Schema.optionalKey(atMost(ProvenanceInput, MAX_PROVENANCE_APPEND)),
  /**
   * For a workflow that moves a Task because of a fact: the id of the
   * `task.entityChanged` fact it acts on, from `event.payload.factId`. It
   * needs `stage`. The write is a fence, so that a late or repeated run never
   * undoes a move the user made after the fact. It does nothing, and returns
   * the Task as it is, when:
   *
   * - the Task is Done or Dropped;
   * - the fact was voided because the user unlinked the thing;
   * - the Task already accounts for this fact or a newer one, because someone
   *   set a stage by hand or an earlier run used it.
   *
   * Otherwise the Task moves to `stage`, and a newer fact is needed to move it
   * again. The fact must exist and belong to this Task, or the call is refused.
   */
  stageFactId: Schema.optionalKey(Schema.Int),
  /**
   * With `stageFactId`: moves the Task only if nothing linked to it is still
   * open and at least one linked thing completed. The links are counted again
   * when the write happens, because a link can arrive or leave between a fact
   * and its run. A workflow that lands a card when work finishes sets it.
   */
  onlyWhenLinkedWorkFinished: Schema.optionalKey(Schema.Boolean),
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
 * Rejects a task update that sets both `stage` and `status`. The stage is the
 * truth and the status is worked out from it, so a call that sets both could
 * contradict itself. The task update operation, a workflow step and a bound
 * answer all use this check, so they refuse the same updates.
 */
export const refuseStageWithStatus = Schema.makeFilter(
  (update: { readonly [Field in keyof typeof TASK_UPDATE_FIELDS]?: unknown }) =>
    update.stage !== undefined && update.status !== undefined
      ? {
          path: ["status"],
          issue:
            "A task update cannot set both stage and status, because the status follows from the stage. Send stage alone.",
        }
      : undefined,
);

/**
 * Rejects a task update that sends `stageFactId` without `stage`. The fact
 * only says why a stage is being written, so with no stage there is nothing
 * for it to guard. The task update operation, a workflow step and a bound
 * answer all use this check.
 */
export const refuseStageFactWithoutStage = Schema.makeFilter(
  (update: { readonly [Field in keyof typeof TASK_UPDATE_FIELDS]?: unknown }) =>
    update.stageFactId !== undefined && update.stage === undefined
      ? {
          path: ["stageFactId"],
          issue:
            "A task update cannot send stageFactId without stage, because the fact only guards a stage write. Send the stage the fact should move the Task to, or remove stageFactId.",
        }
      : undefined,
);

/**
 * Rejects a task update that sends `onlyWhenLinkedWorkFinished` without
 * `stageFactId`. The count is only meaningful for a move that comes from a
 * fact, and a stage written by hand must not be held back by it. The task
 * update operation, a workflow step and a bound answer all use this check.
 */
export const refuseFinishedCheckWithoutStageFact = Schema.makeFilter(
  (update: { readonly [Field in keyof typeof TASK_UPDATE_FIELDS]?: unknown }) =>
    update.onlyWhenLinkedWorkFinished !== undefined && update.stageFactId === undefined
      ? {
          path: ["onlyWhenLinkedWorkFinished"],
          issue:
            "A task update cannot send onlyWhenLinkedWorkFinished without stageFactId, because it only limits a move that comes from a fact. Send stageFactId as well, or remove onlyWhenLinkedWorkFinished.",
        }
      : undefined,
);

/**
 * The input of a task update. Every field is optional and an absent field is
 * left unchanged, but at least one field must be set.
 */
export const TaskUpdateInput = Schema.Struct(TASK_UPDATE_FIELDS).check(
  refuseEmptyTaskUpdate,
  refuseStageWithStatus,
  refuseStageFactWithoutStage,
  refuseFinishedCheckWithoutStageFact,
);

export type TaskUpdateInput = Schema.Schema.Type<typeof TaskUpdateInput>;

/**
 * The input of `task.move`: where the user drops a card. A field that is
 * absent keeps its value. `stage` is a board stage, so a move to `done` or
 * `dropped` fails as invalid input; Done and Drop go through `task.update`.
 */
export const TaskMoveInput = Schema.Struct({
  stage: Schema.optionalKey(BoardStage),
  /** `null` moves the Task to the "No project" lane. */
  projectId: Schema.optionalKey(Schema.NullOr(Id)),
  /**
   * `null` takes the Task off its Initiative. Another id puts it on that
   * Initiative, with the same refusals as `task.update`. It is here so that
   * one drop between Initiative lanes is one write and one Undo.
   */
  initiativeId: Schema.optionalKey(Schema.NullOr(Id)),
  /** The card this one now follows in its cell. `null` puts it first. Absent keeps it last in the new cell. */
  afterTaskId: Schema.optionalKey(Schema.NullOr(Id)),
  /**
   * Fails with `NotFound` when the Task in the path was merged into another,
   * instead of moving the survivor that the merged id stands for. An Undo sets
   * it, because it puts back the Task the gesture moved and no other.
   */
  refuseIfMerged: Schema.optionalKey(Schema.Literal(true)),
});

export type TaskMoveInput = Schema.Schema.Type<typeof TaskMoveInput>;

/**
 * One call of `task.update` as a single object: the task's id, which an HTTP
 * request sends in its path, and the changes. A workflow step and a bound
 * answer have no path, so both send this shape. It uses the same check as
 * `TaskUpdateInput`, so an update that changes no field fails in all three.
 */
export const TaskUpdateCall = Schema.Struct({ taskId: Id, ...TASK_UPDATE_FIELDS }).check(
  refuseEmptyTaskUpdate,
  refuseStageWithStatus,
  refuseStageFactWithoutStage,
  refuseFinishedCheckWithoutStageFact,
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

/** The most cards one board read returns. The reply says when there were more. */
export const MAX_BOARD_CARDS = 1000;

/**
 * The most characters of a question on a card. A longer question is cut to this
 * many, "…" included.
 */
export const MAX_CARD_QUESTION = 300;

/** The most characters of `TaskSummary.line`: about six words. A longer line is cut at a word. */
export const MAX_SUMMARY_LINE = 60;

/** The most characters of `TaskSummary.standing`. A longer text is cut at a word. */
export const MAX_SUMMARY_STANDING = 400;

/** The most characters of `TaskSummary.left`. A longer text is cut at a word. */
export const MAX_SUMMARY_LEFT = 200;

/**
 * What a cheap model wrote to describe a Task. It is description only: it
 * holds no question, no answer and no judgement of what comes next. An open
 * question and a failure come from real rows (`WorkCard.openQuestion` and
 * `WorkCard.failure`), never from a summary, and a summary never moves a card
 * or changes the Task.
 */
export const TaskSummary = Schema.Struct({
  /** What the card shows: about six words, such as "Three designs, depots worried." */
  line: bounded(0, MAX_SUMMARY_LINE),
  /** Where the Task stands, for the details pane. */
  standing: bounded(0, MAX_SUMMARY_STANDING),
  /** What is left to do, for the details pane. */
  left: bounded(0, MAX_SUMMARY_LEFT),
  /** When the summary was written. */
  generatedAt: Timestamp,
  /** True when something changed since this was written, or the last attempt failed. */
  stale: Schema.Boolean,
});

export type TaskSummary = Schema.Schema.Type<typeof TaskSummary>;

/**
 * The most characters of `WorkCard.stageCause.text`. It is built from the
 * thing's noun (at most 40), its identifier (at most 64) and a short verb, so
 * 160 is never tighter than what it is built from.
 */
export const MAX_STAGE_CAUSE_TEXT = 160;

/** The most blockers a card lists. `WorkCard.blockedByCount` says how many there are. */
export const MAX_CARD_BLOCKERS = 8;

/** The most blockers, or blocked Tasks, a `TaskDetail` lists. The count fields say how many there are. */
export const MAX_DETAIL_BLOCKERS = 50;

/**
 * A Task that another Task waits on, or a Task that waits on another, with
 * what a row needs to draw it: the title and the stage, so a client can tell
 * whether it still blocks without reading the Task.
 */
export const WorkCardBlocker = Schema.Struct({
  id: Id,
  title: TaskTitle,
  stage: TaskStage,
});

export type WorkCardBlocker = Schema.Schema.Type<typeof WorkCardBlocker>;

/**
 * One Task as a card on Work: the Task's place and the three facts a card
 * shows, each worked out on the controller from real rows. The facts are
 * independent: a card can have all three, and none hides another.
 */
export const WorkCard = Schema.Struct({
  id: Id,
  title: TaskTitle,
  /** One of the five board stages: never `done` or `dropped`. */
  stage: BoardStage,
  priority: TaskPriority,
  projectId: Schema.optionalKey(Id),
  /** The Initiative the Task belongs to. Absent when it belongs to none. */
  initiativeId: Schema.optionalKey(Id),
  /** Orders the cards of one cell. Compare as a string. Never shown. */
  boardRank: Schema.String,
  /**
   * A question a Thread of this Task has open, asked by the Thread's agent or
   * by a subagent inside it, parked or async. This is the only thing that
   * means "wants you": an approval, a Permission Request, a signal and a
   * question in a session that is not a Thread leave it unset.
   */
  openQuestion: Schema.optionalKey(
    Schema.Struct({
      sessionId: Id,
      requestId: Fact,
      /**
       * The first question of the Request, cut to `MAX_CARD_QUESTION`
       * characters. It may be empty: the protocol lets an agent ask an empty
       * question, and one such Thread must not make the board unreadable for
       * everyone. A client words a blank question itself.
       */
      text: bounded(0, MAX_CARD_QUESTION),
    }),
  ),
  /**
   * The failure this Task shows, read from the Task's stored failed run.
   * Present until the failure ends, beside anything else: an open question or
   * a busy Thread can sit beside a failed run, and neither hides it.
   */
  failure: Schema.optionalKey(
    Schema.Struct({
      runId: Id,
      workflowName: Schema.String,
      cause: bounded(0, MAX_TRACKING_FAILURE_CAUSE),
    }),
  ),
  /**
   * The session a click opens: the Thread with the open question, else the
   * newest Thread, else the newest session of any kind. Absent only when the
   * Task has no session. For navigation only: never a destination for an
   * answer.
   */
  openSessionId: Schema.optionalKey(Id),
  threadCount: Schema.Int,
  /** A live session of this Task, for the head behind the top edge. Absent when no session is live. */
  workingSessionId: Schema.optionalKey(Id),
  createdAt: Timestamp,
  stageChangedAt: Timestamp,
  /** The last time a session of the Task ended a turn, or a run of it ended. For the age a card shows. */
  lastActivityAt: Timestamp,
  /** Absent until a summary has been written for the Task. */
  summary: Schema.optionalKey(TaskSummary),
  /**
   * One mark per kind of outside thing the Task links, at most
   * `MAX_ENTITY_MARKS`.
   */
  entityMarks: atMost(EntityMark, MAX_ENTITY_MARKS),
  /**
   * Why the card is in its stage, set only when the current stage came from a
   * fact about a linked thing. Any other write of the stage clears it: a
   * drag, an edit, an agent. `text` says what happened in the thing's words,
   * such as "PR #6221 merged".
   */
  stageCause: Schema.optionalKey(
    Schema.Struct({
      /**
       * The id of the fact that placed the stage. A client uses it to tell one
       * move by a fact from the next: `stageChangedAt` can repeat, when two
       * writes share a millisecond or the clock steps back.
       */
      factId: Schema.Int,
      ref: ExternalRef,
      text: bounded(1, MAX_STAGE_CAUSE_TEXT),
    }),
  ),
  /**
   * The Tasks this card waits on and that still block it, at most
   * `MAX_CARD_BLOCKERS`, in the order they were added. A blocker stops
   * blocking when it reaches `landed`, `done` or `dropped`, or is deleted or
   * merged away: the stored edge stays as history but is not listed here. A
   * blocker may be on another project, or not on the board at all.
   */
  blockedBy: atMost(WorkCardBlocker, MAX_CARD_BLOCKERS),
  /** How many Tasks still block this card, which may be more than `blockedBy` lists. */
  blockedByCount: Schema.Int,
  /**
   * The refs the Task links and everything above them by `part of`, for
   * Group by and Filter. A peer's ancestors are never included: a `linked`
   * claim adds nothing here. The records are in the board's `places`.
   */
  contextRefs: atMost(ExternalRef, MAX_CARD_CONTEXTS),
});

export type WorkCard = Schema.Schema.Type<typeof WorkCard>;

/** The most stack candidates one Work board carries. A read that hits it sets `stackCandidatesTruncated`. */
export const MAX_BOARD_STACK_CANDIDATES = 2000;

/**
 * One pair that may be drawn as a stack on Work: the Task `leadTaskId` links a
 * rich thing, or a compact thing that a rich one it links reports. The Task
 * `memberTaskId` links the other end. `noun` names what the member is
 * ("pull request"), for the stack's reason ("2 pull requests"). A Task can be
 * in several candidates, so the client chooses per cell which become stacks.
 */
export const WorkStackCandidate = Schema.Struct({
  leadTaskId: Id,
  memberTaskId: Id,
  noun: bounded(1, 40),
});

export type WorkStackCandidate = Schema.Schema.Type<typeof WorkStackCandidate>;

/**
 * What `task.queryBoard` returns: the cards of every unfinished Task. They
 * come ordered by project, then stage, then `boardRank`. Nothing sorts by
 * recent activity, so a card stays where the user left it.
 */
export const WorkBoard = Schema.Struct({
  cards: atMost(WorkCard, MAX_BOARD_CARDS),
  /** True when more Tasks exist than `MAX_BOARD_CARDS`. The screen says so; it never hides it. */
  truncated: Schema.Boolean,
  /** Each record above a card's links, once. */
  places: atMost(EntityPlace, MAX_BOARD_PLACES),
  /** The current `part of` steps between the places and the linked refs, so a client rebuilds every path. */
  edges: atMost(EntityEdge, MAX_GRAPH_EDGES),
  /** The groupable kinds that have at least one place on this board. */
  groupings: atMost(EntityGrouping, MAX_BOARD_GROUPINGS),
  /**
   * False when a depth, edge or fanout limit cut the walk up `part of`, or an
   * ancestor has no record. Work then says that what is above the cards may
   * be incomplete.
   */
  contextComplete: Schema.Boolean,
  /**
   * The pairs of Tasks that may be drawn as one stack: a lead and a member
   * that it brings along. The client chooses the stacks of each cell from
   * these, because the cell's cards and their order are the client's.
   */
  stackCandidates: atMost(WorkStackCandidate, MAX_BOARD_STACK_CANDIDATES),
  /** True when more candidates exist than `MAX_BOARD_STACK_CANDIDATES`. What was left out draws as cards. */
  stackCandidatesTruncated: Schema.Boolean,
  /**
   * For each open Initiative that has Tasks at `done`, how many of its live
   * Tasks are Done. Done Tasks have no card, so a client adds these to the
   * cards of the Initiative to count its progress. An Initiative with none,
   * and a closed Initiative, is absent.
   */
  initiativeDoneCounts: Schema.Record(Id, Schema.Int),
});

export type WorkBoard = Schema.Schema.Type<typeof WorkBoard>;

/** The most sessions a `TaskDetail` lists. `sessionCount` says how many the Task has. */
export const MAX_DETAIL_SESSIONS = 10;

/**
 * One session of a Task as the details pane lists it: what a row needs to
 * show the session and to answer its open question, without reading the
 * session itself. The types are the session contract's own.
 */
export const TaskDetailSession = Schema.Struct({
  id: Id,
  title: Session.fields.title,
  role: Session.fields.role,
  kind: Session.fields.kind,
  status: Session.fields.status,
  /** The Requests the session has open, oldest first. */
  openRequests: Schema.Array(SessionRequest),
  /** True while the Thread is marked Done (`session.markDone`). Only a Thread can be. */
  done: Schema.Boolean,
});

export type TaskDetailSession = Schema.Schema.Type<typeof TaskDetailSession>;

/**
 * What `task.readDetail` returns: everything the details pane of one Task
 * draws, in one reply, so the pane never joins reads itself.
 */
export const TaskDetail = Schema.Struct({
  /** The Task in full: description, labels and provenance. */
  task: Task,
  /** The same facts the board shows for the Task, its summary included. */
  card: WorkCard,
  /** At most `MAX_DETAIL_SESSIONS`, the unfinished first, then newest. */
  sessions: atMost(TaskDetailSession, MAX_DETAIL_SESSIONS),
  /**
   * How many sessions the Task has. The pane says "and 12 more", and links to
   * the session list filtered by `taskId`.
   */
  sessionCount: Schema.Int,
  /** At most `MAX_TRACKING_DETAIL_RUNS` runs of the Task, as Tracking lists them. */
  runs: atMost(TrackingDetailRun, MAX_TRACKING_DETAIL_RUNS),
  /** How many runs the Task has, with a link to `run.query` by `taskIds`, the same way. */
  runCount: Schema.Int,
  /**
   * The Tasks this Task waits on, at most `MAX_DETAIL_BLOCKERS`, in the order
   * they were added. Unlike the card, it lists every stored edge whatever the
   * blocker's stage, so the pane can show a finished blocker and remove it.
   */
  blockers: atMost(WorkCardBlocker, MAX_DETAIL_BLOCKERS),
  /** How many Tasks this Task waits on. The pane says "and 12 more" past `blockers`. */
  blockerCount: Schema.Int,
  /** The Tasks that wait on this Task, at most `MAX_DETAIL_BLOCKERS`, listed like `blockers`. */
  blocks: atMost(WorkCardBlocker, MAX_DETAIL_BLOCKERS),
  /** How many Tasks wait on this Task. */
  blockCount: Schema.Int,
  /**
   * The outside things the Task links, in the order they were linked, each as
   * the place it is: the pane draws them as rows. A linked thing no
   * Connection can read is `restricted`. At most `MAX_CARD_CONTEXTS`, the
   * same bound as the card's `contextRefs`.
   */
  entities: atMost(EntityPlace, MAX_CARD_CONTEXTS),
  /** Each record above the linked things, and the linked things themselves, once, at most `MAX_CARD_CONTEXTS`. */
  places: atMost(EntityPlace, MAX_CARD_CONTEXTS),
  /** The current `part of` steps between them, so the pane rebuilds every path. */
  edges: atMost(EntityEdge, MAX_GRAPH_EDGES),
});

export type TaskDetail = Schema.Schema.Type<typeof TaskDetail>;

/** The input of `task.merge`, beside the source Task's id in the path. */
export const TaskMergeInput = Schema.Struct({
  /** The survivor: the Task the source is merged into. It keeps its title, stage, project, priority and place. */
  intoTaskId: Id,
});

export type TaskMergeInput = Schema.Schema.Type<typeof TaskMergeInput>;

/**
 * The input of `task.linkEntity` and `task.unlinkEntity`, beside the Task's id
 * in the path. The ref travels in the body because it holds `:`, `/` and `#`.
 */
export const TaskEntityLinkInput = Schema.Struct({
  /** The outside thing to link to the Task, or to take away from it. */
  ref: ExternalRef,
});

export type TaskEntityLinkInput = Schema.Schema.Type<typeof TaskEntityLinkInput>;

/**
 * The query of `task.checkMerge`, beside the source Task's id in the path.
 * It names the survivor the same way `TaskMergeInput` does.
 */
export const TaskMergeCheckQuery = Schema.Struct({
  /** The Task the source would be merged into. */
  intoTaskId: Id,
});

export type TaskMergeCheckQuery = Schema.Schema.Type<typeof TaskMergeCheckQuery>;

/**
 * What `task.checkMerge` returns. `refusal` is present when `task.merge` would
 * refuse the same merge, and holds the message that merge would fail with:
 * the Tasks are the same, one is unknown, deleted, merged or finished, the
 * result would hold too many labels or too long a description, or the blockers
 * would close a loop (the message then names the path). Absent when the merge
 * would go ahead. It runs every check the merge runs before it writes, and
 * writes nothing, so a client can show the refusal before a drop: the merge
 * itself still decides.
 */
export const TaskMergeCheck = Schema.Struct({
  refusal: Schema.optionalKey(Schema.String),
});

export type TaskMergeCheck = Schema.Schema.Type<typeof TaskMergeCheck>;

/**
 * The input of `task.addBlocker` and `task.removeBlocker`. The Task that waits
 * is in the path.
 */
export const TaskBlockerInput = Schema.Struct({
  /** The Task that must land first. */
  blockedByTaskId: Id,
});

export type TaskBlockerInput = Schema.Schema.Type<typeof TaskBlockerInput>;

/**
 * What `task.linkEntity`, `task.unlinkEntity`, `task.addBlocker` and
 * `task.removeBlocker` return: the Task as stored, and whether the call
 * changed anything. `changed` is false when there was nothing to do (the Task
 * linked the thing already, or did not link it; the blocker was there already,
 * or was not there), so a client can tell a call that did something from one
 * that did not, and offer an Undo only for the first.
 */
export const TaskChangeResult = Schema.Struct({
  task: Task,
  changed: Schema.Boolean,
});

export type TaskChangeResult = Schema.Schema.Type<typeof TaskChangeResult>;

/** The input of `task.undoTryAgain`, beside the Task's id in the path. */
export const TaskUndoTryAgainInput = Schema.Struct({
  /** The run that Try again started, whose start ended the Task's failure. */
  runId: Id,
});

export type TaskUndoTryAgainInput = Schema.Schema.Type<typeof TaskUndoTryAgainInput>;

/**
 * What `task.undoTryAgain` answers. A repeat of the call returns the first
 * answer again.
 *
 * - `restored`: the failure is back on the Task.
 * - `stopped`: the run was asked to stop, and the failure was not restored,
 *   because something newer holds the Task: another failure, a second retry,
 *   a named Thread, a merge, Done or Drop. The current state stays.
 * - `too-late`: the run had already ended. Nothing changed.
 */
export const TryAgainUndo = Schema.Struct({
  outcome: Schema.Literals(["restored", "stopped", "too-late"]),
  /** True when the run was asked to stop. The run may not have stopped yet. */
  stopRequested: Schema.Boolean,
  /** Why the failure stayed as it is, in words for the undo line. */
  reason: Schema.optionalKey(Schema.String),
});

export type TryAgainUndo = Schema.Schema.Type<typeof TryAgainUndo>;

/**
 * What `task.readAttention` answers: whether any live Task needs a look from
 * outside the board. It is a boolean on purpose, so the sidebar draws a dot
 * and no number.
 */
export const TaskAttention = Schema.Struct({
  /** True when a live Task has a failed run, the same rule as the board's `failure`. */
  anyFailure: Schema.Boolean,
});

export type TaskAttention = Schema.Schema.Type<typeof TaskAttention>;

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
     * Returns every unfinished Task as a card, at the five board stages, with
     * what each card shows: an open question, a failure, a live session. A
     * dedicated read, because `task.query` loads each Task's whole description
     * and provenance and sorts by recent update, which would reshuffle a board.
     * The reply is capped at `MAX_BOARD_CARDS`, and `truncated` says when
     * Tasks were left out.
     */
    // A static path beside `/tasks/:id`, for the same reason as `/tasks/tracking`:
    // the router prefers it, and "board" is not an id.
    HttpApiEndpoint.get("queryBoard", "/tasks/board", {
      success: WorkBoard,
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
    /**
     * Returns whether any live Task has a failed run, for the sidebar's dot on
     * every screen. Needs `task.read` and `run.query`.
     */
    // A static path beside `/tasks/:id`, for the same reason as `/tasks/tracking`:
    // the router prefers it, and "attention" is not an id.
    HttpApiEndpoint.get("readAttention", "/tasks/attention", {
      success: TaskAttention,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    // `/tasks/:id/tracking` has one more segment than `/tasks/:id`, so the
    // router never takes it for that route.
    HttpApiEndpoint.get("readTracking", "/tasks/:id/tracking", {
      params: { id: Id },
      success: TrackingDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    // `/tasks/:id/detail` has one more segment than `/tasks/:id`, so the router
    // never takes it for that route.
    HttpApiEndpoint.get("readDetail", "/tasks/:id/detail", {
      params: { id: Id },
      success: TaskDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.get("read", "/tasks/:id", {
      params: { id: Id },
      success: Task,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/tasks", {
      payload: TaskCreateInput,
      success: Task,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.patch("update", "/tasks/:id", {
      params: { id: Id },
      payload: TaskUpdateInput,
      success: Task,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    /**
     * Moves a Task to a place on the board: another stage, another project, or
     * another position in its cell. Returns the Task. A move that changes
     * nothing writes nothing.
     */
    // `/tasks/:id/move` has one more segment than `/tasks/:id`, so the router
    // never takes it for that route.
    HttpApiEndpoint.post("move", "/tasks/:id/move", {
      params: { id: Id },
      payload: TaskMoveInput,
      success: Task,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    /**
     * Merges a Task into another: the Task in the path is the source, and
     * `intoTaskId` is the survivor. Returns the survivor. Only the user merges.
     * Fails `InvalidState` when either Task is `done` or `dropped`, and with
     * reason `blocker-cycle` when the merged blockers would wait on each other
     * in a loop.
     */
    HttpApiEndpoint.post("merge", "/tasks/:id/merge", {
      params: { id: Id },
      payload: TaskMergeInput,
      success: Task,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    /**
     * Says whether `task.merge` would refuse a merge, and why, without
     * writing anything. See `TaskMergeCheck`.
     */
    // `/tasks/:id/merge-check` has one more segment than `/tasks/:id`, so the
    // router never takes it for that route.
    HttpApiEndpoint.get("checkMerge", "/tasks/:id/merge-check", {
      params: { id: Id },
      query: TaskMergeCheckQuery,
      success: TaskMergeCheck,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    /**
     * Makes a Task wait on another: `blockedByTaskId` must land first. Returns
     * the Task and whether anything changed (an edge that exists already
     * changes nothing). Either id may be a merged Task's old id. Fails
     * `InvalidState` with reason `blocker-cycle` when the other Task already
     * waits on this one, directly or through others, and the message names the
     * path. A blocker gates no operation: a blocked card can still be moved.
     */
    // `/tasks/:id/blockers` has one more segment than `/tasks/:id`, so the
    // router never takes it for that route.
    HttpApiEndpoint.post("addBlocker", "/tasks/:id/blockers", {
      params: { id: Id },
      payload: TaskBlockerInput,
      success: TaskChangeResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    /**
     * Takes a blocker away from a Task, whatever stage the blocker is at.
     * Returns the Task and whether anything changed (an edge that does not
     * exist changes nothing).
     */
    HttpApiEndpoint.delete("removeBlocker", "/tasks/:id/blockers/:blockedByTaskId", {
      params: { id: Id, blockedByTaskId: Id },
      success: TaskChangeResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * Links an outside thing to a Task by hand. Returns the Task and whether
     * anything changed. A thing the Task links already changes nothing
     * (`changed` is false). Linking clears an earlier unlink of the same
     * thing, so scans may link it again.
     */
    // `/tasks/:id/entities/link` has more segments than `/tasks/:id`, so the
    // router never takes it for that route.
    HttpApiEndpoint.post("linkEntity", "/tasks/:id/entities/link", {
      params: { id: Id },
      payload: TaskEntityLinkInput,
      success: TaskChangeResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * Takes the link to an outside thing away from a Task, and keeps it away:
     * no scan links it again until someone links it by hand. Returns the Task
     * and whether anything changed. A thing the Task does not link changes
     * nothing (`changed` is false).
     */
    HttpApiEndpoint.post("unlinkEntity", "/tasks/:id/entities/unlink", {
      params: { id: Id },
      payload: TaskEntityLinkInput,
      success: TaskChangeResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * Undoes a Try again: asks the run it started to stop, and puts the
     * Task's failure back when nothing newer holds the Task. Only the user
     * undoes. Fails `NotFound` when the run did not end a failure of this
     * Task.
     */
    HttpApiEndpoint.post("undoTryAgain", "/tasks/:id/try-again/undo", {
      params: { id: Id },
      payload: TaskUndoTryAgainInput,
      success: TryAgainUndo,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/tasks/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
