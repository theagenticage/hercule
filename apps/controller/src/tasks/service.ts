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
 *
 * The service also decides which Task a new or reopened Thread belongs to
 * (`joinSession`, `rejoinThread`) and keeps the Task made for a Thread in step
 * with the Thread's generated title (`adoptGeneratedTitle`). It takes plain
 * values: the sessions and the workspaces are known to it only by the ids its
 * caller passes. The one thing it reads from them is the kind of a workspace,
 * in the repository, as it reads `projects`. A Task is
 * joinable when it is neither deleted nor finished (`isFinishedStage`).
 */
import type * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Mutable } from "effect/Types";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  DEFAULT_PAGE_LIMIT,
  deriveTaskStatus,
  Id,
  isFinishedStage,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_LABELS,
  TASK_SORT_FIELDS,
  TaskCreateInput,
  TaskFilter,
  TaskMoveInput,
  TaskUpdateInput,
  refuseEmptyTaskUpdate,
  refuseStageWithStatus,
  NotFound,
  Validation,
  type Forbidden,
  type InvalidState,
  type ProvenanceEntry,
  type Task,
  type TaskPriority,
  type TaskStage,
  type TaskStatus,
  type TaskMergeInput,
  TaskSummary,
  type TaskUpdatedEventPayload,
  type TryAgainUndo,
  type Unauthenticated,
} from "@hercule/contract";
import { CurrentActor, currentStamp, requireGrant, requireUserActor, SYSTEM_ACTOR } from "../actor";
import {
  addSeconds,
  afterCommit,
  announce,
  announceTaskCardChange,
  nowIso,
  buildPageInputFields,
  refuseCursor,
  hasSortKeys,
  resolveSortKeys,
  withTransaction,
  type ResolvedSortKey,
} from "../db";
import { AuditLog, PlatformEvents } from "../events";
import { Notifier } from "../notifications";
import { chooseRankBetween } from "./board-rank";
import { TaskLinkOwners } from "./link-owners";
import { TaskSummaryWake } from "./summary-wake";
import { cutText } from "../text";
import {
  taskRepository,
  type BoardCell,
  type NewTask,
  type ProvenanceInput,
  type SummaryAttempt,
  type TaskEdit,
  type TaskFailureState,
  type TaskOrder,
  type TaskSortField,
} from "./repository";

/** The input of `task.query`: the filter, plus the page size, cursor and sort. */
const QueryInput = Schema.Struct({
  ...TaskFilter.fields,
  ...buildPageInputFields(TASK_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

/**
 * The input of `task.update`: the task's id and the fields to change. Decoding
 * fails when the edit sets no field, or sets both `stage` and `status`. The
 * checks are the same ones the request schema uses, so both reject the same
 * edits. Spreading the fields drops the checks of `TaskUpdateInput`, so they
 * are attached again here; a workflow step calls this service directly.
 */
const UpdateInput = Schema.Struct({ id: Id, ...TaskUpdateInput.fields }).check(
  refuseEmptyTaskUpdate,
  refuseStageWithStatus,
);

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

/** The input of `task.move`: the Task's id and where it goes. */
const MoveInput = Schema.Struct({ id: Id, ...TaskMoveInput.fields });

export type MoveInput = Schema.Schema.Type<typeof MoveInput>;

/**
 * How long after the first change since its last summary a Task waits before
 * its summary is written, in seconds. A burst of changes then makes one
 * summary. Later changes do not extend the wait: a busy Task is paced by
 * `SUMMARY_MIN_INTERVAL_SECONDS` instead.
 */
export const SUMMARY_QUIET_SECONDS = 30;

/**
 * The fewest seconds between two attempts to write one Task's summary,
 * failed attempts included. A failure waits longer each time it repeats.
 */
export const SUMMARY_MIN_INTERVAL_SECONDS = 300;

/** The most seconds a Task waits after repeated failures: one hour. */
const SUMMARY_MAX_BACKOFF_SECONDS = 3600;

/** The most characters of a failure reason that are stored. */
const MAX_SUMMARY_FAILURE_REASON = 500;

/** The text a summary write carries, checked against the contract's bounds. */
const SummaryText = Schema.Struct({
  line: TaskSummary.fields.line,
  standing: TaskSummary.fields.standing,
  left: TaskSummary.fields.left,
});

const decodeSummaryText = Schema.decodeUnknownEffect(SummaryText);

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(TaskCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeMove = Schema.decodeUnknownEffect(MoveInput);

/** The fields `updateTask` changes: an update after decoding. */
interface TaskPatch {
  readonly title?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly stage?: TaskStage;
  readonly priority?: TaskPriority;
  readonly projectId?: string | null;
  /**
   * The rank the Task takes in its cell, chosen by the caller (`task.move`).
   * When it is absent and the patch moves the Task to another cell, the Task
   * goes last in the new cell.
   */
  readonly boardRank?: string;
  readonly addLabels?: ReadonlyArray<string>;
  readonly removeLabels?: ReadonlyArray<string>;
  readonly provenance?: ReadonlyArray<ProvenanceInput>;
}

/** The provenance entry of a handoff: the signal handed off and the run it started. */
export interface HandoffEntry {
  readonly signalId: string;
  readonly runId: string;
  /** The signal's thread ref, when it has one. */
  readonly ref?: string;
  /** The signal's origin event, when it has one. */
  readonly eventId?: number;
}

/** Why `restoreRecoveredFailure` left the Task as it was. */
export type FailureRestoreRefusal =
  /** The run start ended no failure, so it left no row to restore from. */
  | "no-such-start"
  /** The failure was already restored once. */
  | "already-restored"
  | "task-deleted"
  /** The Task was merged into another, which now owns its failure. */
  | "task-merged"
  /** The Task is at `done` or `dropped`. */
  | "task-finished"
  /** Something changed who handles the failure since the start: a newer failure, run start, Done or Drop. */
  | "handled-since";

/** The result of `restoreRecoveredFailure`. */
export type FailureRestoration =
  | { readonly restored: true; readonly taskId: string }
  | { readonly restored: false; readonly reason: FailureRestoreRefusal };

/** The refusal of `merge` for a caller who is not the user. */
const ONLY_THE_USER_MERGES =
  "only the user may merge Tasks: merging is the user's correction of how work is grouped, so a session or a workflow step may not; ask the user instead";

/** The refusal of `recordHandoff` for a caller who is not the user. */
const ONLY_THE_USER_RECORDS_HANDOFF =
  "only the user may record a handoff: handing a signal off is the user's act, so a session or a workflow step may not; ask the user instead";

/** One page of tasks, in the contract's shape. */
export interface TaskPage {
  readonly items: ReadonlyArray<Task>;
  readonly nextCursor?: string;
}

/** Newest work first: a task list is read to see what is going on now. */
const DEFAULT_SORT: Arr.NonEmptyReadonlyArray<ResolvedSortKey<TaskSortField>> = [
  { field: "updatedAt", direction: "desc" },
];

const NO_SUCH_TASK = "no such task";
const NO_SUCH_PROJECT = "no such project";

/**
 * The title of the Task made for a Thread whose title is blank. A Task's title
 * has at least one character, and a stored empty title would make every read
 * of the Task fail.
 */
const UNTITLED_THREAD_TITLE = "Untitled thread";

/** The message for a spawn that names a finished Task. */
const buildFinishedTaskRefusal = (stage: TaskStage): string =>
  `the task is at the stage ${stage}, and new work cannot join a finished task; ` +
  "reopen the task by moving it to another stage, or start without a taskId";

/** Returns true if an edit gives a field a value other than the one it holds. */
const isNewValue = <Value>(next: Value | undefined, held: Value): next is Value =>
  next !== undefined && next !== held;

/**
 * Returns the stage a legacy `status` write moves a Task to. A Task whose
 * stage already reads as that status stays where it is, so `in-progress` never
 * moves an `in-review` Task back to `building`. Otherwise the status gives a
 * stage outright: `open` gives `planned`, `in-progress` gives `building`,
 * `done` gives `done` and `cancelled` gives `dropped`.
 */
const chooseStageForStatus = (current: TaskStage, status: TaskStatus): TaskStage => {
  if (deriveTaskStatus(current) === status) return current;
  switch (status) {
    case "open":
      return "planned";
    case "in-progress":
      return "building";
    case "done":
      return "done";
    case "cancelled":
      return "dropped";
  }
};

/**
 * Returns the description a Task has after another Task is merged into it:
 * its own, then the other's under a line naming the other's title. A merged
 * Task with an empty description adds nothing.
 */
const joinMergedDescriptions = (
  target: Pick<Task, "description">,
  source: Pick<Task, "title" | "description">,
): string => {
  if (source.description.trim() === "") return target.description;
  const appended = `Merged from "${source.title}":\n${source.description}`;
  return target.description === "" ? appended : `${target.description}\n\n${appended}`;
};

/** Returns the values with duplicates removed, keeping the first of each. */
const removeDuplicates = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

/**
 * Returns how a listing is ordered: by relevance for a full-text search,
 * otherwise by the requested sort keys, or by the default when there are
 * none. A key with no direction is `asc`. Fails with `Validation` if the
 * request has both a search and a sort key.
 *
 * Relevance is not a column, so a search cannot also be sorted. Supporting
 * both would need two paging strategies chosen per request, and ignoring the
 * sort would silently return an order nobody asked for. An empty sort list is
 * no sort at all (see `hasSortKeys`), so a search may come with one.
 */
const chooseOrder = (
  text: QueryInput["text"],
  sort: QueryInput["sort"],
): Effect.Effect<TaskOrder, Validation> => {
  if (text !== undefined && hasSortKeys(sort)) {
    return Effect.fail(
      createValidationError([
        { path: ["sort"], message: "a full-text search is ordered by relevance" },
        { path: ["text"], message: "a search cannot also be sorted; drop one of the two" },
      ]),
    );
  }
  if (text !== undefined) return Effect.succeed({ _tag: "relevance", text });
  return Effect.succeed({ _tag: "column", sort: resolveSortKeys(sort, DEFAULT_SORT) });
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* taskRepository;
  const audit = yield* AuditLog;
  const notifier = yield* Notifier;
  const platformEvents = yield* PlatformEvents;

  const linkOwners = yield* TaskLinkOwners;

  /**
   * Reads the live Task `id` stands for. When `id` was merged into another
   * Task (`resolveTaskId`), that is the survivor, whose `id` differs. Fails
   * with `NotFound` when the Task does not exist or is deleted.
   */
  const readLiveTaskOrFail = (id: string): Effect.Effect<Task, NotFound | SqlError> =>
    Effect.gen(function* () {
      const found = yield* tasks.readLiveOrSurvivor(id);
      if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError(NO_SUCH_TASK));
      return found.value;
    });

  /**
   * Checks that the Task `id`, taken as it is and never followed to a
   * survivor, can be merged, and returns its state. Fails with `NotFound` when
   * it does not exist or is deleted, with `Validation` when it was already
   * merged into another Task, and with `InvalidState` when it is at `done` or
   * `dropped`.
   */
  const requireMergeableTask = (
    id: string,
  ): Effect.Effect<TaskFailureState, NotFound | Validation | InvalidState | SqlError> =>
    Effect.gen(function* () {
      const state = yield* tasks.readFailureState(id);
      if (Option.isNone(state) || state.value.deleted) {
        return yield* Effect.fail(createNotFoundError(NO_SUCH_TASK));
      }
      if (state.value.merged) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["id"],
              message:
                `the task ${id} was already merged into another task; ` +
                "read it to find that task, and merge that one instead",
            },
          ]),
        );
      }
      if (isFinishedStage(state.value.stage)) {
        return yield* Effect.fail(
          createInvalidStateError(
            `the task ${id} is at the stage ${state.value.stage}, and a finished task cannot be merged; ` +
              "reopen it by moving it to another stage first, then merge",
          ),
        );
      }
      return state.value;
    });

  /**
   * Marks the summary of the Task `taskId` dirty in the caller's transaction,
   * and wakes the summary writer once that transaction commits. The first mark
   * of a dirty cycle on a Task with a written summary also announces the Task
   * as a derived change, so its card shows the summary as stale. A Task that is
   * deleted, merged or finished is left alone. It writes one row and waits for
   * nothing, so any change a summary reads can call it.
   */
  const markSummaryDirty = (taskId: string): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const wake = yield* TaskSummaryWake;
        const { marked, becameStale } = yield* tasks.markSummaryDirty(taskId, yield* nowIso);
        if (marked) yield* afterCommit(wake.wake);
        // The card shows a written summary as current until told otherwise.
        // Only the first mark of a dirty cycle says so; the rest change nothing
        // a client draws.
        if (becameStale) yield* announceTaskCardChange(taskId);
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

  /**
   * Applies `patch` to the task `id` (or to the Task it was merged into) in
   * the caller's transaction, and returns the task as stored. The `task.updated` event lists what changed. See
   * `update` for the rules; the patch is already decoded. The `actor` stamps
   * the event and the provenance entries the patch appends.
   *
   * The stage is the truth and the status is written only from it. A patch
   * that sets a `status` is turned into a stage first (`chooseStageForStatus`).
   * The event reports `changes.stage` whenever the stage changes, and
   * `changes.status` whenever the coarse status changes with it.
   */
  const updateTask = (
    requestedId: string,
    patch: TaskPatch,
    actor: string,
  ): Effect.Effect<Task, NotFound | Validation | SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
        const before = yield* readLiveTaskOrFail(requestedId);
        // A merged id lands on the survivor, and everything below is about it.
        const id = before.id;
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
        if (isNewValue(patch.priority, before.priority)) {
          changes.priority = { old: before.priority, new: patch.priority };
          edit.priority = patch.priority;
        }
        const stage =
          patch.stage ??
          (patch.status === undefined
            ? undefined
            : chooseStageForStatus(before.stage, patch.status));
        if (isNewValue(stage, before.stage)) {
          changes.stage = { old: before.stage, new: stage };
          edit.stage = stage;
          const status = deriveTaskStatus(stage);
          if (status !== before.status) {
            changes.status = { old: before.status, new: status };
            edit.status = status;
          }
        }
        const project = before.projectId ?? null;
        if (isNewValue(patch.projectId, project)) {
          changes.projectId = { old: project, new: patch.projectId };
          edit.projectId = patch.projectId;
        }
        if (patch.boardRank !== undefined) {
          // The caller chose the rank, so it is kept even when the Task also
          // changes cell. It is a change of its own only when it differs.
          edit.boardRank = patch.boardRank;
          const held = Option.getOrThrow(yield* tasks.readBoardRank(id));
          if (patch.boardRank !== held) {
            changes.boardRank = { old: held, new: patch.boardRank };
          }
        } else if (edit.stage !== undefined || edit.projectId !== undefined) {
          // A Task that changes cell by anything other than `task.move` goes
          // last in the new cell, so nothing the user is looking at moves. The
          // event reports the stage or the project, which is why the move to
          // the end is not listed as a change of its own.
          edit.boardRank = yield* tasks.chooseLastRankOfCell({
            projectId: (edit.projectId === undefined ? before.projectId : edit.projectId) ?? null,
            stage: edit.stage ?? before.stage,
          });
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
        // A finished Task waits for no summary. Taking it back to a live stage,
        // or changing the words a summary reads, makes the summary out of date.
        if (edit.stage !== undefined && isFinishedStage(edit.stage)) {
          yield* tasks.clearSummaryDirty(id);
        } else if (
          edit.title !== undefined ||
          edit.description !== undefined ||
          (edit.stage !== undefined && isFinishedStage(before.stage))
        ) {
          yield* markSummaryDirty(id);
        }
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

  /**
   * Returns the rank that puts the Task `movingId` right after the card
   * `afterTaskId` in `cell`: first when `afterTaskId` is null, last when it is
   * absent. The moving Task is not one of the cards it is placed among, so a
   * Task is never its own neighbour. When the Task already stands in that place,
   * it keeps its rank, so a drop that changes nothing writes nothing. Fails
   * with `Validation` when `afterTaskId` is not a card of `cell`.
   *
   * When no rank fits between the neighbours, because ranks have grown to the
   * length limit or the neighbours share a rank, the ranks of the cell are
   * spread again and the rank is chosen once more. A respread is rank
   * maintenance: it keeps the order of the cards and writes only their rank,
   * so it is not a placement event. Only the moved Task gets a
   * `task.updated`, and the other cards stay where they are.
   */
  const chooseRankAfter = (
    cell: BoardCell,
    movingId: string,
    afterTaskId: string | null | undefined,
  ): Effect.Effect<string, Validation | SqlError> => {
    const attempt = Effect.gen(function* () {
      const inCell = yield* tasks.listCellRanks(cell);
      const others = inCell.filter((card) => card.id !== movingId);
      let next = 0;
      if (afterTaskId === undefined) next = others.length;
      else if (afterTaskId !== null) {
        const position = others.findIndex((card) => card.id === afterTaskId);
        if (position < 0) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["afterTaskId"],
                message:
                  "afterTaskId is not a card of the cell the Task moves to; " +
                  "name a card at that stage and in that project, or null to put the Task first",
              },
            ]),
          );
        }
        next = position + 1;
      }
      const lower = others[next - 1]?.boardRank;
      const upper = others[next]?.boardRank;
      const held = inCell.find((card) => card.id === movingId)?.boardRank;
      if (
        held !== undefined &&
        (lower === undefined || lower < held) &&
        (upper === undefined || held < upper)
      ) {
        return held;
      }
      return chooseRankBetween(lower, upper);
    });
    return Effect.gen(function* () {
      const rank = yield* attempt;
      if (rank !== undefined) return rank;
      yield* tasks.respreadCell(cell);
      // A spread cell has room between every pair of cards and at both ends.
      return (yield* attempt)!;
    });
  };

  /**
   * Moves the Task `id` (or the Task it was merged into) as `task.move`
   * describes, in the caller's transaction. The write goes through `updateTask`, so one `task.updated`
   * reports what changed and the actor is stamped.
   */
  const moveTask = (
    requestedId: string,
    placement: Omit<MoveInput, "id">,
    actor: string,
  ): Effect.Effect<Task, NotFound | Validation | SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const before = yield* readLiveTaskOrFail(requestedId);
        // A merged id, for the Task or for the card it follows, stands for the
        // survivor, and the comparisons and the rank below are about it.
        const id = before.id;
        yield* ensureProjectExists(placement.projectId);
        const afterTaskId =
          placement.afterTaskId === undefined || placement.afterTaskId === null
            ? placement.afterTaskId
            : (yield* readLiveTaskOrFail(placement.afterTaskId)).id;
        if (afterTaskId === id) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["afterTaskId"],
                message:
                  "a task cannot be placed after itself; name another card, or leave afterTaskId out to put it last",
              },
            ]),
          );
        }
        const stage = placement.stage ?? before.stage;
        if (stage === "done" || stage === "dropped") {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["stage"],
                message:
                  `the task is at the stage ${stage}, which the board does not show; ` +
                  "name one of exploring, planned, building, in-review or landed to move it to",
              },
            ]),
          );
        }
        // A project that was deleted is the "No project" cell, as in every client.
        const cell: BoardCell = yield* tasks.resolveCell({
          projectId:
            placement.projectId === undefined ? (before.projectId ?? null) : placement.projectId,
          stage,
        });
        const stays = (yield* tasks.listCellRanks(cell)).find((card) => card.id === id);
        // Without `afterTaskId`, a Task goes last in the cell it arrives in and
        // keeps its place in the cell it is already in.
        const boardRank =
          afterTaskId === undefined && stays !== undefined
            ? stays.boardRank
            : yield* chooseRankAfter(cell, id, afterTaskId);
        return yield* updateTask(
          id,
          {
            ...(placement.stage === undefined ? {} : { stage: placement.stage }),
            ...(placement.projectId === undefined ? {} : { projectId: placement.projectId }),
            boardRank,
          },
          actor,
        );
      }),
    );

  /**
   * Writes a new task, with its first provenance entries and its
   * `task.created` event, in the caller's transaction, and returns it. The
   * task gets the `id` the caller chose, or a new one, and the status that
   * reads its `stage`. The `actor` stamps the row's provenance and the event.
   * The caller has checked that the project, if any, exists.
   */
  const insertTask = (
    fields: Pick<
      NewTask,
      "id" | "title" | "description" | "stage" | "priority" | "labels" | "projectId" | "provenance"
    >,
    actor: string,
  ): Effect.Effect<Task, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        // One clock read, inside the transaction: the row and the event
        // that records it carry the same instant.
        const at = yield* nowIso;
        const task = yield* tasks.insert({
          ...fields,
          status: deriveTaskStatus(fields.stage),
          at,
          actor,
        });
        yield* platformEvents.emit({ kind: "task.created", actor, payload: { task }, at });
        yield* announce({ _tag: "record", topic: "task", id: task.id, kind: "created" });
        return task;
      }),
    );

  /**
   * Returns the id of the Task, or `undefined` when there is no such Task or
   * it is deleted or finished (`isFinishedStage`).
   */
  const readJoinableTaskId = (
    id: string | undefined,
  ): Effect.Effect<string | undefined, SqlError> =>
    id === undefined
      ? Effect.succeed(undefined)
      : Effect.map(tasks.readStage(id), (stage) =>
          Option.isSome(stage) && !isFinishedStage(stage.value) ? id : undefined,
        );

  /**
   * Returns the id of the Task the caller named, for a join that may refuse
   * it. Fails with `NotFound` when there is no such Task or it is deleted, and
   * with `InvalidState` when the Task is finished.
   */
  const requireJoinableTask = (
    id: string,
  ): Effect.Effect<string, NotFound | InvalidState | SqlError> =>
    Effect.gen(function* () {
      const stage = yield* tasks.readStage(id);
      if (Option.isNone(stage)) return yield* Effect.fail(createNotFoundError(NO_SUCH_TASK));
      if (isFinishedStage(stage.value)) {
        return yield* Effect.fail(createInvalidStateError(buildFinishedTaskRefusal(stage.value)));
      }
      return id;
    });

  /**
   * Returns the Task a session joins when one exists, without making one, and
   * records the workspace's Task. The first of these that is a joinable Task
   * wins:
   *
   * 1. `joinableTaskId`, a Task the caller has already checked is joinable;
   * 2. the Task of the workspace, when the workspace is ephemeral. A main
   *    workspace has no row to read: sharing one says nothing about being the
   *    same work.
   *
   * Returns `undefined` when neither gives a Task. When a Task is returned and
   * the workspace had no joinable Task of its own, this records the Task as the
   * workspace's (`task_workspaces`), so the next Thread in the workspace joins
   * it too. That write does nothing for a main workspace.
   */
  const joinExistingTaskRecordingWorkspace = (input: {
    readonly joinableTaskId: string | undefined;
    readonly workspaceId: string | null;
  }): Effect.Effect<string | undefined, SqlError> =>
    Effect.gen(function* () {
      const workspaceTaskId =
        input.workspaceId === null
          ? undefined
          : Option.getOrUndefined(yield* tasks.readJoinableTaskIdOfWorkspace(input.workspaceId));
      const taskId = input.joinableTaskId ?? workspaceTaskId;
      if (taskId !== undefined && input.workspaceId !== null && workspaceTaskId === undefined) {
        yield* tasks.recordWorkspaceTask(input.workspaceId, taskId, yield* nowIso);
      }
      return taskId;
    });

  /**
   * Makes a new Task from a Thread and returns it, without recording any
   * workspace for it.
   *
   * The new Task is `exploring`, with priority `normal`, no description, no
   * labels and no provenance. It has the Thread's project only when that
   * project still exists: a fork can carry a deleted one, and a Task cannot
   * name it. The `task.created` event is stamped with `actor`.
   */
  const makeTaskFromThread = (
    session: { readonly title: string; readonly projectId: string | undefined },
    actor: string,
  ): Effect.Effect<Task, SqlError> =>
    Effect.gen(function* () {
      const projectId =
        session.projectId !== undefined && (yield* tasks.projectExists(session.projectId))
          ? session.projectId
          : undefined;
      return yield* insertTask(
        {
          title: session.title.trim() === "" ? UNTITLED_THREAD_TITLE : session.title,
          description: "",
          stage: "exploring",
          priority: "normal",
          labels: [],
          projectId,
          provenance: [],
        },
        actor,
      );
    });

  /**
   * Makes the Task of a Thread that found none to join, and returns it. It
   * also records the new Task as the workspace's Task, replacing a row that
   * names a Task that is deleted or finished. Nothing is recorded for a main
   * workspace or for a Thread with no workspace. See `makeTaskFromThread` for
   * the new Task.
   */
  const makeThreadTask = (
    session: { readonly title: string; readonly projectId: string | undefined },
    workspaceId: string | null,
    actor: string,
  ): Effect.Effect<Task, SqlError> =>
    Effect.gen(function* () {
      const task = yield* makeTaskFromThread(session, actor);
      if (workspaceId !== null) {
        yield* tasks.recordWorkspaceTask(workspaceId, task.id, yield* nowIso);
      }
      return task;
    });

  return {
    /**
     * Returns the Task an id stands for: the Task it was merged into, or the
     * id itself when the Task was not merged or does not exist. It follows one
     * hop, because a merge repoints everything merged into its source. It
     * checks no grant and reads one row.
     *
     * A writer that stores a Task id on a row of its own (a session, a run, a
     * workspace) calls this in the transaction that writes it, so a merge
     * cannot bring the old id back.
     */
    resolveTaskId: tasks.resolveTaskId,

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
     * if the task does not exist or has been deleted. The id of a Task that
     * was merged into another returns the survivor, whose `id` differs: the
     * caller should replace the id it holds.
     */
    read: (id: Id): Effect.Effect<Task, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.read");
        return yield* readLiveTaskOrFail(id);
      }),

    /**
     * Creates a task and returns it, at the stage the input names or at
     * `planned`. Fails with `NotFound` if the project does not exist.
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
        const actor = yield* currentStamp;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* ensureProjectExists(decoded.projectId);
            return yield* insertTask(
              {
                title: decoded.title,
                description: decoded.description,
                stage: decoded.stage ?? "planned",
                priority: decoded.priority ?? "normal",
                labels: removeDuplicates(decoded.labels ?? []),
                projectId: decoded.projectId,
                provenance,
              },
              actor,
            );
          }),
        );
      }),

    /**
     * Writes the Task of a handoff and the handoff's provenance entry in one
     * write, and returns the Task. This is the one way to record a handoff:
     * `create` and `update` refuse an entry that names a signal.
     *
     * - With `newTask`, it creates the Task at `building`, with the id the
     *   handoff chose, and the entry. One `task.created` event carries the
     *   entry, and no `task.updated` follows.
     * - Without it, it appends the entry to the Task `taskId` and sets the
     *   status `in-progress`, as any legacy status write does: a Task that is
     *   `open` moves to `building`, and one that is already `in-progress`
     *   keeps its stage. One `task.updated` event.
     *
     * It runs in the caller's transaction. Only the user hands work off, so it
     * fails with `Forbidden` for any other caller, whatever grants they hold.
     * It fails with `NotFound` if the Task to continue does not exist.
     */
    recordHandoff: (handoff: {
      readonly taskId: string;
      readonly entry: HandoffEntry;
      readonly newTask?: { readonly title: string; readonly priority: TaskPriority };
    }): Effect.Effect<Task, Unauthenticated | Forbidden | NotFound | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor(
          handoff.newTask === undefined ? "task.update" : "task.create",
          ONLY_THE_USER_RECORDS_HANDOFF,
        );
        if (handoff.newTask !== undefined) {
          return yield* insertTask(
            {
              id: handoff.taskId,
              title: handoff.newTask.title,
              description: "",
              stage: "building",
              priority: handoff.newTask.priority,
              labels: [],
              projectId: undefined,
              provenance: [handoff.entry],
            },
            yield* currentStamp,
          );
        }
        return yield* updateTask(
          handoff.taskId,
          { status: "in-progress", provenance: [handoff.entry] },
          yield* currentStamp,
        );
      }),

    /**
     * Updates a task and returns it as stored. The `task.updated` event lists
     * what changed.
     *
     * A patch that sets no field, or sets both `stage` and `status`, fails to
     * decode with a `Validation` error. A patch that asks for the values the
     * task already has writes nothing.
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
        return yield* updateTask(id, patch, yield* currentStamp);
      }),

    /**
     * Moves a Task on the Work board and returns it as stored: to another
     * stage, to another project (`null` is "No project"), or to another place
     * in its cell. A cell is the Tasks of one project at one stage.
     *
     * - `afterTaskId` is the card the Task now follows in its cell, in stored
     *   rank order. `null` puts it first. Absent puts it last in a cell it
     *   arrives in, and leaves it where it is in the cell it is already in.
     * - It fails with `NotFound` for a Task, a project or an `afterTaskId` that
     *   does not exist, and with `Validation` when `afterTaskId` is the Task
     *   itself or is not a card of the cell the Task goes to. A move to
     *   `done` or `dropped` fails to decode: the board has no such stage.
     * - A Task whose project was deleted is in the "No project" cell, as every
     *   client shows it.
     * - A move that changes nothing writes nothing, like `update`.
     *
     * One transaction reads the neighbours, chooses the rank and writes it. It
     * writes one `task.updated`, which lists `boardRank` beside whatever else
     * changed. Filters on `changes.stage` or `changes.status` do not see a
     * move inside a cell.
     */
    move: (
      input: MoveInput,
    ): Effect.Effect<Task, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.update");
        const { id, ...placement } = yield* Effect.mapError(
          decodeMove(input),
          createDecodeValidationError,
        );
        return yield* moveTask(id, placement, yield* currentStamp);
      }),

    /**
     * Merges the Task `id` (the source) into the Task `input.intoTaskId` (the
     * survivor), as the user, and returns the survivor. Only the user merges:
     * a session or a workflow step is refused with `Forbidden`.
     *
     * The survivor keeps its title, stage, project, priority and board rank.
     * Labels are united, and a non-empty source description is appended under
     * a line naming the source's title. In one transaction the source's
     * sessions, runs, workspace links and provenance move to the survivor, the
     * survivor gains a provenance entry naming the source, and a failure the
     * source shows moves too. A read of the source's id then returns the
     * survivor (`resolveTaskId`).
     *
     * Fails with `NotFound` when either Task does not exist or is deleted, with
     * `InvalidState` when either is at `done` or `dropped`, and with
     * `Validation` when the Tasks are the same, one is already merged, or the
     * result would hold more labels or a longer description than a Task may.
     */
    merge: (
      id: Id,
      input: TaskMergeInput,
    ): Effect.Effect<
      Task,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireUserActor("task.merge", ONLY_THE_USER_MERGES);
        const stamp = yield* currentStamp;
        if (id === input.intoTaskId) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["intoTaskId"],
                message: "a task cannot be merged into itself; name another task to merge it into",
              },
            ]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Both ids are taken as they are, never followed to a survivor:
            // merging into or from a merged Task would hide the redirect.
            const sourceId = id;
            const targetId = input.intoTaskId;
            const sourceState = yield* requireMergeableTask(sourceId);
            const targetState = yield* requireMergeableTask(targetId);
            const source = Option.getOrThrow(yield* tasks.live(sourceId));
            const target = Option.getOrThrow(yield* tasks.live(targetId));

            const addedLabels = source.labels.filter((label) => !target.labels.includes(label));
            if (target.labels.length + addedLabels.length > MAX_TASK_LABELS) {
              return yield* Effect.fail(
                createValidationError([
                  {
                    path: ["intoTaskId"],
                    message:
                      `merging would give the task ${String(target.labels.length + addedLabels.length)} labels, ` +
                      `and a task carries at most ${String(MAX_TASK_LABELS)}; ` +
                      "remove some labels from either task, then merge again",
                  },
                ]),
              );
            }
            const description = joinMergedDescriptions(target, source);
            if (description.length > MAX_TASK_DESCRIPTION_LENGTH) {
              return yield* Effect.fail(
                createValidationError([
                  {
                    path: ["intoTaskId"],
                    message:
                      `merging would make the description ${String(description.length)} characters long, ` +
                      `and a task holds at most ${String(MAX_TASK_DESCRIPTION_LENGTH)}; ` +
                      "shorten the description of either task, then merge again",
                  },
                ]),
              );
            }

            yield* tasks.markMerged(sourceId, targetId);
            yield* linkOwners.moveTaskLinks(sourceId, targetId);
            yield* tasks.moveWorkspaces(sourceId, targetId);
            // The entries move before the survivor gains its own, and unedited:
            // Tracking joins them to the runs, which moved just above.
            yield* tasks.moveProvenance(sourceId, targetId);

            // The failure the survivor shows is the newer of the two, and a
            // merge always raises the revision, so a recovery from before it
            // cannot overwrite the result.
            const failedRunId =
              sourceState.failedRunId === undefined || targetState.failedRunId === undefined
                ? (sourceState.failedRunId ?? targetState.failedRunId)
                : yield* tasks.chooseNewerRun(sourceState.failedRunId, targetState.failedRunId);
            yield* tasks.recordMergedFailure(targetId, failedRunId);

            // Through `updateTask`, so the survivor gets its `task.updated`
            // event, with the merge entry and what the labels and the
            // description gained.
            const survivor = yield* updateTask(
              targetId,
              {
                ...(description === target.description ? {} : { description }),
                ...(addedLabels.length === 0 ? {} : { addLabels: addedLabels }),
                provenance: [{ mergedTaskId: sourceId }],
              },
              stamp,
            );
            yield* tasks.deleteSummary(sourceId);
            // The survivor gained Threads and runs. `updateTask` has marked its summary when the
            // description changed, and marking twice would raise the revision twice.
            if (description === target.description) yield* markSummaryDirty(targetId);
            // The entry names both Tasks, so clients read both again.
            yield* audit.append({
              kind: "task.merged",
              actor: stamp,
              record: { topic: "task", ids: [targetId, sourceId] },
              payload: { taskId: sourceId, intoTaskId: targetId, snapshot: source },
              at: survivor.updatedAt,
            });
            return survivor;
          }),
        );
      }),

    /**
     * Returns the Task a session being written joins, or `undefined` when it
     * joins none. `created` is true when the join made the Task for this
     * session, and false when the session joined an existing one. The first
     * source that gives a Task wins:
     *
     * 1. `requestedTaskId`, the Task the spawn named. It is the one source
     *    that can be refused: it fails with `NotFound` when there is no such
     *    Task or it is deleted, and with `InvalidState` when it is at `done`
     *    or `dropped`, because new work on a finished Task is a contradiction
     *    the caller should hear about. A `thread` that the user starts this
     *    way also ends the Task's failure and raises its `failure_revision`,
     *    because the user has taken the Task up. A Thread started this way by
     *    a session leaves the failure as it is, and no other source ends it.
     * 2. `callerTaskId`, the Task of the session that spawned this one, or of
     *    the parent of a fork. Only a joinable Task counts.
     * 3. The Task of the workspace, when the workspace is ephemeral and the
     *    Task is joinable. A main workspace is shared by whatever runs in it,
     *    so it has no Task of its own, and this source is skipped for it and
     *    for a session with no workspace.
     * 4. A new Task, only for a `thread`. An `agent` session never makes one.
     *
     * Sources 2 and 3 never refuse: a Task that is deleted, missing or
     * finished gives nothing, and the next source decides. When a session
     * joins a Task in an ephemeral workspace that has no joinable Task, the
     * workspace's row is written, so the next Thread in the workspace joins
     * the same Task.
     *
     * It checks no grant. Starting a Thread was already allowed by
     * `session.spawn`, and the Task follows from it. It joins the caller's
     * transaction, so the choice is atomic with the write of the session and
     * with the check that stops a retried call from placing a second session.
     * The `title` and `projectId` are the new session's; they are used only
     * when a new Task is made. A new Task is stamped with the current actor,
     * which dies when there is none.
     */
    joinSession: (input: {
      readonly requestedTaskId: string | undefined;
      readonly callerTaskId: string | undefined;
      readonly workspaceId: string | null;
      readonly sessionKind: "thread" | "agent";
      readonly title: string;
      readonly projectId: string | undefined;
    }): Effect.Effect<
      { readonly taskId: string; readonly created: boolean } | undefined,
      NotFound | InvalidState | SqlError
    > =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          // A Task merged into another is joined as the survivor. This reads
          // inside the transaction that writes the join, so a merge cannot come
          // between the read and the write.
          const requestedTaskId =
            input.requestedTaskId === undefined
              ? undefined
              : yield* tasks.resolveTaskId(input.requestedTaskId);
          const callerTaskId =
            input.callerTaskId === undefined
              ? undefined
              : yield* tasks.resolveTaskId(input.callerTaskId);
          const joinableTaskId =
            requestedTaskId === undefined
              ? yield* readJoinableTaskId(callerTaskId)
              : yield* requireJoinableTask(requestedTaskId);
          // The user took the Task up by naming it, so its failure is handled. An agent that
          // starts a Thread on the Task has handled nothing yet.
          const actor = yield* CurrentActor;
          if (
            requestedTaskId !== undefined &&
            input.sessionKind === "thread" &&
            actor._tag === "user"
          ) {
            if (yield* tasks.endFailure(requestedTaskId)) {
              yield* announceTaskCardChange(requestedTaskId);
            }
          }
          const taskId = yield* joinExistingTaskRecordingWorkspace({
            joinableTaskId,
            workspaceId: input.workspaceId,
          });
          if (taskId !== undefined) {
            if (input.sessionKind === "thread") yield* markSummaryDirty(taskId);
            return { taskId, created: false };
          }
          if (input.sessionKind === "agent") return undefined;
          const task = yield* makeThreadTask(input, input.workspaceId, yield* currentStamp);
          yield* markSummaryDirty(task.id);
          return { taskId: task.id, created: true };
        }),
      ),

    /**
     * Returns the Task a Thread has when it is taken off Done. The Thread
     * keeps its own Task (`currentTaskId`) while that is joinable, and nothing
     * else is read or written. Otherwise it joins the joinable Task of its
     * ephemeral workspace, or gets a new Task (sources 3 and 4 of
     * `joinSession`). A Thread always ends up with a Task, so it always
     * returns one.
     *
     * It is a method of its own, not a call of `joinSession`, because a
     * reopen names no Task: it cannot fail with `NotFound` or
     * `InvalidState`. It checks no grant and joins the caller's transaction,
     * for the reasons given at `joinSession`. A new Task is stamped with
     * `actor`, the actor of the reopen.
     */
    rejoinThread: (input: {
      readonly currentTaskId: string | undefined;
      readonly workspaceId: string | null;
      readonly title: string;
      readonly projectId: string | undefined;
      readonly actor: string;
    }): Effect.Effect<string, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          // A Thread whose Task was merged away keeps the survivor.
          const keptTaskId = yield* readJoinableTaskId(
            input.currentTaskId === undefined
              ? undefined
              : yield* tasks.resolveTaskId(input.currentTaskId),
          );
          const taskId =
            keptTaskId ??
            (yield* joinExistingTaskRecordingWorkspace({
              joinableTaskId: undefined,
              workspaceId: input.workspaceId,
            })) ??
            (yield* makeThreadTask(input, input.workspaceId, input.actor)).id;
          // The Task has a live Thread again, in each of the three cases.
          yield* markSummaryDirty(taskId);
          return taskId;
        }),
      ),

    /**
     * Returns the id of the Task a Thread is moved to (`session.moveToTask`).
     * With `requestedTaskId` it is that Task, or its survivor when it was
     * merged (`resolveTaskId`), and it must be joinable: it fails with
     * `NotFound` when there is no such Task or it is deleted, and with
     * `InvalidState` when it is at `done` or `dropped`. Without it, it makes a
     * new Task from the Thread (`title` and `projectId`), stamped with
     * `actor`, and returns that.
     *
     * Unlike a join, it records no workspace for a new Task: the workspace
     * keeps its Task, so the next Thread started there still joins that one.
     * It checks no grant and joins the caller's transaction. It does not move
     * the Thread, and marks no summary: the caller does both.
     */
    chooseTaskForMovedThread: (input: {
      readonly requestedTaskId: string | undefined;
      readonly title: string;
      readonly projectId: string | undefined;
      readonly actor: string;
    }): Effect.Effect<string, NotFound | InvalidState | SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if (input.requestedTaskId !== undefined) {
            return yield* requireJoinableTask(yield* tasks.resolveTaskId(input.requestedTaskId));
          }
          return (yield* makeTaskFromThread(input, input.actor)).id;
        }),
      ),

    /**
     * Records that the run `runId` started on the Task `taskId`, in the
     * caller's transaction, which is the transaction that inserts the run. So
     * a start that is refused, and rolls back, ends no failure.
     *
     * - It raises the Task's `failure_revision`, whether or not the Task shows
     *   a failure, because it changes who is handling the Task's failure.
     * - When the Task shows a failure, it clears it, and keeps a row so that
     *   `restoreRecoveredFailure` can bring it back. A second start finds no
     *   failure and writes no row.
     * - A Task with no row yet has nothing to clear, as in a handoff that
     *   starts its run before it creates the Task. It does nothing.
     *
     * It checks no grant: whoever may start the run may start it on the Task.
     */
    recordRunStart: (input: {
      readonly taskId: string;
      readonly runId: string;
    }): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const clearedFailure = yield* tasks.recordRunStart(input.taskId, input.runId);
          if (clearedFailure) {
            yield* announceTaskCardChange(input.taskId);
          }
        }),
      ),

    /**
     * Makes the run `runId` the failure the Task `taskId` shows, in the
     * caller's transaction, which is the one that writes the run's ending. It
     * raises the Task's `failure_revision`. Does nothing for a Task that is
     * deleted or missing. A failure stays until a run starts on the Task, so a
     * Task at any stage keeps it, and so does one that has a newer completed
     * run.
     *
     * It writes no `task.updated` event: the failure is not a field of the
     * Task that a trigger can watch. It announces the change so that clients
     * read the Task again.
     */
    recordRunFailure: (input: {
      readonly taskId: string;
      readonly runId: string;
    }): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if (yield* tasks.setFailedRun(input.taskId, input.runId)) {
            yield* announceTaskCardChange(input.taskId);
          }
        }),
      ),

    /**
     * Puts back the failure that the start of the run `runId` ended: the
     * Undo of Try again. A Thread started by name ends a failure too, but it
     * writes no row to restore from, so it has no Undo. Runs in the
     * caller's transaction, and checks everything in one statement. It
     * restores only when the start left a row not used before, the Task is
     * not deleted or finished, and the Task's `failure_revision` is still the
     * one right after that start. A newer failure, a newer run start, Done and
     * Drop all raise the revision, so none of them is ever overwritten.
     *
     * Returns `{ restored: true }`, or `{ restored: false, reason }` having
     * changed nothing. A restore writes a `task.failureRestored` audit entry
     * stamped with the current actor, which dies when there is none.
     */
    restoreRecoveredFailure: (input: {
      readonly runId: string;
    }): Effect.Effect<FailureRestoration, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const taskId = yield* tasks.restoreFailure(input.runId, at);
          if (Option.isSome(taskId)) {
            yield* audit.append({
              kind: "task.failureRestored",
              actor: yield* currentStamp,
              payload: { taskId: taskId.value, runId: input.runId },
              at,
            });
            yield* announceTaskCardChange(taskId.value);
            return { restored: true, taskId: taskId.value } as const;
          }
          const recovery = yield* tasks.readFailureRecovery(input.runId);
          if (Option.isNone(recovery)) return { restored: false, reason: "no-such-start" } as const;
          if (recovery.value.restoredAt !== undefined) {
            return { restored: false, reason: "already-restored" } as const;
          }
          const state = yield* tasks.readFailureState(recovery.value.taskId);
          if (Option.isNone(state) || state.value.deleted) {
            return { restored: false, reason: "task-deleted" } as const;
          }
          if (state.value.merged) return { restored: false, reason: "task-merged" } as const;
          if (isFinishedStage(state.value.stage)) {
            return { restored: false, reason: "task-finished" } as const;
          }
          return { restored: false, reason: "handled-since" } as const;
        }),
      ),

    /**
     * Returns the row that the start of the run `runId` left when it ended a
     * failure (the Task, the failure it ended, and the first answer to its
     * Undo), or none when the start ended no failure. Checks no grant: the
     * caller of `task.undoTryAgain` has done that.
     */
    readFailureRecovery: (runId: string) => tasks.readFailureRecovery(runId),

    /**
     * Stores the first answer to the Undo of the run start `runId`, in the
     * caller's transaction, so that a repeat of the Undo returns it. Does
     * nothing when an answer is stored already.
     */
    storeTryAgainUndo: (runId: string, answer: TryAgainUndo): Effect.Effect<void, SqlError> =>
      tasks.storeTryAgainUndo(runId, answer),

    /**
     * Marks the summary of the Task `taskId` as out of date, in the caller's
     * transaction, and wakes the summary writer once that transaction
     * commits (`TaskSummaryWake`). Call it from the transaction of the change
     * the summary reads, so a crash cannot lose the change.
     *
     * When the mark starts a dirty cycle on a Task that has a written summary,
     * it announces the Task as a derived change (as `storeSummary` does), so
     * clients draw the summary as stale. Later marks of the same cycle announce
     * nothing.
     *
     * It raises the row's `dirty_revision`. It sets `dirty_at` to now only
     * when the row is clean, so `dirty_at` is the first change since the last
     * summary and the writer waits `SUMMARY_QUIET_SECONDS` after that one;
     * later changes do not push it back. It keeps
     * `next_attempt_at`, so changes never lift the pacing of the model calls.
     * A Task that is deleted, merged or finished is left alone. It checks no
     * grant and waits for nothing.
     */
    markSummaryDirty,

    /**
     * Picks the Tasks whose summary is due, oldest change first, at most
     * `limit` of them, and records an attempt on each, in one short
     * transaction. A Task is due when it is live (not deleted, merged or
     * finished), first changed at least `SUMMARY_QUIET_SECONDS` ago, and is past
     * its `next_attempt_at`. Each pick sets `next_attempt_at` to
     * `SUMMARY_MIN_INTERVAL_SECONDS` from now, so a Task is called for at most
     * once in that time, failures included.
     *
     * Returns the Task ids with the `dirtyRevision` to hand back to
     * `storeSummary` or `failSummary`. Checks no grant.
     */
    claimSummaryAttempts: (input: {
      readonly limit: number;
    }): Effect.Effect<ReadonlyArray<SummaryAttempt>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          return yield* tasks.claimSummaryAttempts({
            limit: input.limit,
            at,
            quietBefore: addSeconds(at, -SUMMARY_QUIET_SECONDS),
            nextAttemptAt: addSeconds(at, SUMMARY_MIN_INTERVAL_SECONDS),
          });
        }),
      ),

    /**
     * Stores the summary the writer made for the revision it was given by
     * `claimSummaryAttempts`, in one short transaction, and returns whether it
     * stored it. It stores nothing when the Task is no longer live (deleted,
     * merged or finished), and never makes a row.
     *
     * - When the Task has not changed since the claim, the summary is current:
     *   the row is clean.
     * - When it changed meanwhile, the summary is stored all the same and the
     *   row stays dirty, so the card shows it as stale and the next attempt,
     *   paced by `next_attempt_at`, brings it up to date. A Task that changes
     *   during every call would otherwise never get a summary.
     *
     * A stored summary clears the failure and resets the failure count. It
     * writes a `task.summarized` audit entry stamped with the system actor and
     * announces the Task as a derived change, which clients read at the slower
     * pace. It does not touch the Task's `updatedAt`, writes no `task.updated`
     * event, and marks nothing dirty, because none of those would be a
     * decision of a model.
     *
     * The text must fit the contract's bounds (`MAX_SUMMARY_LINE` and the
     * other two): the writer cuts it at a word first, and an overlong text is
     * a defect here, because a stored text over its bound would fail every
     * read of the board. Checks no grant.
     */
    storeSummary: (input: {
      readonly taskId: string;
      readonly dirtyRevision: number;
      readonly summary: Pick<TaskSummary, "line" | "standing" | "left">;
    }): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const summary = yield* Effect.orDie(decodeSummaryText(input.summary));
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const written = yield* tasks.writeSummary({
              taskId: input.taskId,
              dirtyRevision: input.dirtyRevision,
              summary,
              at,
            });
            if (!written) return false;
            // Only ids go in the entry: the text of a summary is not kept in
            // the log.
            yield* audit.append({
              kind: "task.summarized",
              actor: SYSTEM_ACTOR,
              payload: { taskId: input.taskId, dirtyRevision: input.dirtyRevision },
              at,
            });
            yield* announceTaskCardChange(input.taskId);
            return true;
          }),
        );
      }),

    /**
     * Returns the time the first dirty Task becomes due for a summary, or none
     * when no live Task is dirty. It is the earliest time at which
     * `claimSummaryAttempts` would pick a Task: `SUMMARY_QUIET_SECONDS` after
     * the first change, or the Task's `next_attempt_at` when that is later.
     * The summary writer sleeps until then. Runs outside a transaction, so it
     * reads on the read connection and never waits for the writer. Checks no
     * grant.
     */
    readNextSummaryDueAt: (): Effect.Effect<Option.Option<string>, SqlError> =>
      tasks.readNextSummaryDueAt(SUMMARY_QUIET_SECONDS),

    /**
     * Records that the attempt for the revision `claimSummaryAttempts` gave
     * failed, in one short transaction, and returns whether it recorded it.
     * It keeps the last summary, stores the (cut) `reason` with the time,
     * raises the failure count, and sets `next_attempt_at` to now plus
     * `SUMMARY_MIN_INTERVAL_SECONDS` doubled for each failure in a row, at
     * most one hour. The row stays dirty, so the card shows the summary as
     * stale. Unlike `storeSummary`, it records nothing when the Task changed
     * since: a failure of an older attempt says nothing about the Task now.
     * It also records nothing when the Task is no longer live, so a late
     * failure cannot touch a Task that was merged away. Checks no grant.
     */
    failSummary: (input: {
      readonly taskId: string;
      readonly dirtyRevision: number;
      readonly reason: string;
    }): Effect.Effect<boolean, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          return yield* tasks.writeSummaryFailure({
            taskId: input.taskId,
            dirtyRevision: input.dirtyRevision,
            reason: cutText(input.reason, MAX_SUMMARY_FAILURE_REASON),
            at,
            chooseNextAttempt: (attemptCount) =>
              addSeconds(
                at,
                Math.min(
                  SUMMARY_MIN_INTERVAL_SECONDS * 2 ** attemptCount,
                  SUMMARY_MAX_BACKOFF_SECONDS,
                ),
              ),
          });
        }),
      ),

    /**
     * Gives the Task made for a Thread the Thread's generated title. It
     * renames the Task only when the Task is not deleted, merged or finished,
     * its title is still `from` (the title it was made with), and `to` is a
     * different title. A Task someone renamed since is left alone. Does
     * nothing otherwise. `taskId` is taken as it is, never followed to a
     * survivor: a Task merged away must not rename the Task it joined.
     *
     * It runs after a commit with no request behind it, so the rename is
     * stamped with the system actor and never reads the current one
     * (`currentStamp` dies without an actor). It is an ordinary Task update
     * and writes a `task.updated` event.
     */
    adoptGeneratedTitle: (input: {
      readonly taskId: string;
      readonly from: string;
      readonly to: string;
    }): Effect.Effect<void, NotFound | Validation | SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if (input.to === input.from) return;
          const found = yield* tasks.live(input.taskId);
          if (
            Option.isNone(found) ||
            isFinishedStage(found.value.stage) ||
            found.value.title !== input.from
          ) {
            return;
          }
          yield* updateTask(input.taskId, { title: input.to }, SYSTEM_ACTOR);
        }),
      ),

    /**
     * Soft-deletes a task, and withdraws the open decisions about it. The row
     * stays, so the log and the runs that reference the task still point at
     * something. Fails with `NotFound` if the task does not exist or is
     * already deleted. It also fails with
     * `NotFound` for a task that was merged into another, naming the survivor,
     * because an old id must never delete the task that took over.
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
            // The id is taken as it is, never followed to a survivor: a stale id
            // (an old link, a CLI call) must not delete the Task that took over.
            const survivorId = yield* tasks.resolveTaskId(id);
            if (survivorId !== id) {
              const survivor = yield* tasks.live(survivorId);
              return yield* Effect.fail(
                createNotFoundError(
                  Option.isSome(survivor)
                    ? `this task was merged into ${survivor.value.title} (${survivorId}); delete that task if you mean it`
                    : `this task was merged into another task (${survivorId}), which no longer exists`,
                ),
              );
            }
            const task = yield* readLiveTaskOrFail(id);
            yield* tasks.softDelete(task.id, at);
            yield* tasks.clearSummaryDirty(task.id);
            // The event holds a final snapshot, because nothing can read the
            // row afterwards.
            yield* audit.append({
              kind: "task.deleted",
              actor,
              record: { topic: "task", id: task.id },
              payload: { taskId: task.id, snapshot: { ...task, deletedAt: at } },
              at,
            });
            yield* notifier.withdrawDecisionsAbout([{ kind: "task", id: task.id }], "task deleted");
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
  SqlClient.SqlClient | AuditLog | PlatformEvents | Notifier | TaskLinkOwners
> = Layer.effect(TaskService)(make);
