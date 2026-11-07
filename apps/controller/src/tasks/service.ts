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
 * values and reads no other domain: the sessions and the workspaces are known
 * to it only by the ids and the workspace kind its caller passes. A Task is
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
  MAX_TASK_LABELS,
  TASK_SORT_FIELDS,
  TaskCreateInput,
  TaskFilter,
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
  type TaskUpdatedEventPayload,
  type Unauthenticated,
  type Workspace,
} from "@hercule/contract";
import { currentStamp, requireGrant, requireUserActor, SYSTEM_ACTOR } from "../actor";
import {
  announce,
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
import {
  taskRepository,
  type NewTask,
  type ProvenanceInput,
  type TaskEdit,
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

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(TaskCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);

/** The fields `updateTask` changes: an update after decoding. */
interface TaskPatch {
  readonly title?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly stage?: TaskStage;
  readonly priority?: TaskPriority;
  readonly projectId?: string | null;
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

/** The Task a session joined, and the title stored on it when the join made it. */
export interface JoinedTask {
  readonly taskId: string;
  /** The Task's title when the join made the Task, or undefined when it joined an existing one. */
  readonly madeTitle: string | undefined;
}

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

  /**
   * Applies `patch` to the task `id` in the caller's transaction, and returns
   * the task as stored. The `task.updated` event lists what changed. See
   * `update` for the rules; the patch is already decoded. The `actor` stamps
   * the event and the provenance entries the patch appends.
   *
   * The stage is the truth and the status is written only from it. A patch
   * that sets a `status` is turned into a stage first (`chooseStageForStatus`).
   * The event reports `changes.stage` whenever the stage changes, and
   * `changes.status` whenever the coarse status changes with it.
   */
  const updateTask = (
    id: string,
    patch: TaskPatch,
    actor: string,
  ): Effect.Effect<Task, NotFound | Validation | SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
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

  /**
   * Writes a new task, with its first provenance entries and its
   * `task.created` event, in the caller's transaction, and returns it. The
   * task gets the `id` the caller chose, or a new one, and the status that
   * reads its `stage`. The `actor` stamps the row's provenance and the event.
   * The caller has checked that the project, if any, exists.
   */
  const writeTask = (
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
   * Checks that the project exists and writes a new task (`writeTask`), in the
   * caller's transaction. Fails with `NotFound` if the project does not exist.
   */
  const insertTask = (
    fields: Parameters<typeof writeTask>[0],
    actor: string,
  ): Effect.Effect<Task, NotFound | SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        yield* ensureProjectExists(fields.projectId);
        return yield* writeTask(fields, actor);
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
   *    workspace is never read: sharing one says nothing about being the same
   *    work.
   *
   * Returns `undefined` when neither gives a Task. When a Task is returned and
   * the workspace is ephemeral with no joinable Task of its own, this writes
   * the workspace's row (`task_workspaces`) to name the returned Task, so the
   * next Thread in the workspace joins it too.
   */
  const joinExistingTaskRecordingWorkspace = (input: {
    readonly joinableTaskId: string | undefined;
    readonly workspace: Pick<Workspace, "id" | "kind"> | undefined;
  }): Effect.Effect<string | undefined, SqlError> =>
    Effect.gen(function* () {
      const ephemeral = input.workspace?.kind === "ephemeral" ? input.workspace : undefined;
      const workspaceTaskId =
        ephemeral === undefined
          ? undefined
          : Option.getOrUndefined(yield* tasks.readJoinableTaskIdOfWorkspace(ephemeral.id));
      const taskId = input.joinableTaskId ?? workspaceTaskId;
      if (taskId !== undefined && ephemeral !== undefined && workspaceTaskId === undefined) {
        yield* tasks.recordWorkspaceTask(ephemeral.id, taskId, yield* nowIso);
      }
      return taskId;
    });

  /**
   * Makes the Task of a Thread that found none to join, and returns it. When
   * the workspace is ephemeral, it also records the new Task as the
   * workspace's Task, replacing a row that names a Task that is deleted or
   * finished.
   *
   * The new Task is `exploring`, with priority `normal`, no description, no
   * labels and no provenance. It has the Thread's project only when that
   * project still exists: a fork can carry a deleted one, and a Task cannot
   * name it. The `task.created` event is stamped with `actor`.
   */
  const makeThreadTask = (
    session: { readonly title: string; readonly projectId: string | undefined },
    workspace: Pick<Workspace, "id" | "kind"> | undefined,
    actor: string,
  ): Effect.Effect<Task, SqlError> =>
    Effect.gen(function* () {
      const projectId =
        session.projectId !== undefined && (yield* tasks.projectExists(session.projectId))
          ? session.projectId
          : undefined;
      const task = yield* writeTask(
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
      if (workspace?.kind === "ephemeral") {
        yield* tasks.recordWorkspaceTask(workspace.id, task.id, yield* nowIso);
      }
      return task;
    });

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
          yield* currentStamp,
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
     * Returns the Task a session being written joins, or `undefined` when it
     * joins none. `madeTitle` is the title stored on the Task when the join
     * made the Task, and `undefined` when the session joined an existing one.
     * The first source that gives a Task wins:
     *
     * 1. `requestedTaskId`, the Task the spawn named. It is the one source
     *    that can be refused: it fails with `NotFound` when there is no such
     *    Task or it is deleted, and with `InvalidState` when it is at `done`
     *    or `dropped`, because new work on a finished Task is a contradiction
     *    the caller should hear about.
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
      readonly workspace: Pick<Workspace, "id" | "kind"> | undefined;
      readonly sessionKind: "thread" | "agent";
      readonly title: string;
      readonly projectId: string | undefined;
    }): Effect.Effect<JoinedTask | undefined, NotFound | InvalidState | SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const joinableTaskId =
            input.requestedTaskId === undefined
              ? yield* readJoinableTaskId(input.callerTaskId)
              : yield* requireJoinableTask(input.requestedTaskId);
          const taskId = yield* joinExistingTaskRecordingWorkspace({
            joinableTaskId,
            workspace: input.workspace,
          });
          if (taskId !== undefined) return { taskId, madeTitle: undefined };
          if (input.sessionKind === "agent") return undefined;
          const task = yield* makeThreadTask(input, input.workspace, yield* currentStamp);
          return { taskId: task.id, madeTitle: task.title };
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
      readonly workspace: Pick<Workspace, "id" | "kind"> | undefined;
      readonly title: string;
      readonly projectId: string | undefined;
      readonly actor: string;
    }): Effect.Effect<string, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const keptTaskId = yield* readJoinableTaskId(input.currentTaskId);
          if (keptTaskId !== undefined) return keptTaskId;
          const taskId = yield* joinExistingTaskRecordingWorkspace({
            joinableTaskId: undefined,
            workspace: input.workspace,
          });
          if (taskId !== undefined) return taskId;
          return (yield* makeThreadTask(input, input.workspace, input.actor)).id;
        }),
      ),

    /**
     * Gives the Task made for a Thread the Thread's generated title. It
     * renames the Task only when the Task is not deleted or finished, its
     * title is still `from` (the title it was made with), and `to` is a
     * different title. A Task someone renamed since is left alone. Does
     * nothing otherwise.
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
