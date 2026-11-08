/**
 * Tests the Task side of handing work off from a card, on real rows:
 *
 * - the stage revision, which rises on every stage decision and on nothing
 *   else;
 * - `recordEntityHandoff`, which makes or continues the Task of a handoff;
 * - `reverseEntityHandoff`, which takes that back only while nothing has
 *   happened to the Task since;
 * - `readAttention`, the one read behind the sidebar's failure dot.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { ExternalRef, TaskStage } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotifierLayer } from "../notifications";
import { TaskLinkOwnersLayer } from "../daemon/tasks";
import { taskRepository } from "./repository";
import { TaskService, TaskServiceLayer, type EntityHandoffRecorded } from "./index";

const layer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(TaskLinkOwnersLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const buildSessionActor = (grants: ReadonlyArray<string>): Actor =>
  ({
    _tag: "session",
    sessionId: "0199e0e7-0002-7000-8000-000000000000",
    profileId: "0199e0e7-0003-7000-8000-000000000000",
    grants,
    profileGrants: grants,
    assistantId: null,
    agentId: null,
  }) as unknown as Actor;

const run = <A, E>(
  effect: Effect.Effect<A, E, TaskService | SqlClient.SqlClient>,
  actor: Actor = USER,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, actor),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

const REF: ExternalRef = "github:pull-request:northwind/api#12";
const OTHER_REF: ExternalRef = "github:issue:northwind/api#40";
const BEFORE_HANDOFF = "2026-11-01T09:00:00.000Z";
const HANDOFF_AT = "2026-11-01T10:00:00.000Z";
const AFTER_HANDOFF = "2026-11-01T10:05:00.000Z";
const FAILED_RUN = "0199e0e7-0a01-7000-8000-000000000001";
const NEWER_RUN = "0199e0e7-0a01-7000-8000-000000000002";

const newId = () => uuidToString(mintUuid());

const insertRun = (id: string, taskId: string, createdAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withTransaction(
      sql,
      sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at, task_id)
          VALUES (${uuidFromString(id)}, '{}', '{}', '{"kind":"manual","actor":"user"}', 'pending',
                  ${createdAt}, ${uuidFromString(taskId)})`,
    );
  });

/** Writes a Thread on the Task, of the run `runId` when one is given. */
const insertSession = (taskId: string, createdAt: string, runId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runnerId = mintUuid();
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
                   VALUES (${runnerId}, ${uuidToString(runnerId)}, 'online', 'active', 0, '[]', ${uuidToString(runnerId)}, ${createdAt}, ${createdAt})`;
        yield* sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at, task_id, run_id)
                   VALUES (${mintUuid()}, ${mintUuid()}, ${mintUuid()}, ${runnerId}, 'default', 'default',
                           '{}', 'thread', 'idle', ${createdAt}, ${createdAt},
                           ${uuidFromString(taskId)}, ${runId === undefined ? null : uuidFromString(runId)})`;
      }),
    );
  });

const readStageRevision = (taskId: string) =>
  Effect.gen(function* () {
    const repository = yield* taskRepository;
    return Option.getOrThrow(yield* repository.readStageRevision(taskId));
  });

const createTask = (stage: TaskStage, refs: ReadonlyArray<ExternalRef> = [REF]) =>
  Effect.flatMap(TaskService, (tasks) =>
    tasks.create({
      title: "Review the change",
      description: "",
      stage,
      provenance: refs.map((ref) => ({ ref })),
    }),
  );

describe("the stage revision", () => {
  it.each([
    ["an update that names the stage the Task has", "planned", { stage: "planned" }, 1],
    ["an update that moves the stage", "planned", { stage: "building" }, 1],
    ["a status that moves the stage", "planned", { status: "in-progress" }, 1],
    ["a move that names the stage the Task has", "planned", { move: { stage: "planned" } }, 1],
    ["a move to another stage", "planned", { move: { stage: "building" } }, 1],
    ["a title edit", "planned", { title: "Renamed" }, 0],
    ["a status the stage already reads as", "building", { status: "in-progress" }, 0],
    ["a move inside the cell", "planned", { move: { afterTaskId: null } }, 0],
  ] as const)("after %s rises by %i", async (_name, stage, change, rise) => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask(stage);
        yield* TestClock.adjust(60_000);
        if ("move" in change) yield* tasks.move({ id: task.id, ...change.move });
        else yield* tasks.update({ id: task.id, ...change });
        return {
          task,
          after: yield* tasks.read(task.id),
          revision: yield* readStageRevision(task.id),
          events: yield* readEventsOfKind("task.updated"),
        };
      }),
    );
    expect(result.revision).toBe(rise);
    // A decision that kept the stage leaves nothing else behind: no event, no new time.
    if ("stage" in change && change.stage === stage) {
      expect(result.events).toEqual([]);
      expect(result.after.updatedAt).toBe(result.task.updatedAt);
    }
  });
});

describe("recordEntityHandoff", () => {
  it("makes a Task at building for a new handoff, linked to the ref, with no signal in its entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const taskId = newId();
        const runId = newId();
        const projectId = newId();
        yield* withTransaction(
          sql,
          sql`INSERT INTO projects (id, name, created_at, updated_at)
                   VALUES (${uuidFromString(projectId)}, 'Northwind', ${HANDOFF_AT}, ${HANDOFF_AT})`,
        );
        const recorded = yield* tasks.recordEntityHandoff({
          taskId,
          entry: { ref: REF, runId },
          newTask: { title: "Review PR 12", projectId },
        });
        const links = yield* sql<{ readonly ref: string }>`
          SELECT ref FROM task_entity_links WHERE task_id = ${uuidFromString(taskId)}`;
        return {
          recorded,
          taskId,
          runId,
          projectId,
          links,
          created: yield* readEventsOfKind("task.created"),
        };
      }),
    );
    expect(result.recorded).toMatchObject({
      created: true,
      stageBefore: undefined,
      stageRevision: 0,
      task: {
        id: result.taskId,
        title: "Review PR 12",
        stage: "building",
        priority: "normal",
        projectId: result.projectId,
        provenance: [{ ref: REF, runId: result.runId, actor: "user" }],
      },
    });
    expect(result.recorded.task.provenance[0]).not.toHaveProperty("signalId");
    expect(result.links).toEqual([{ ref: REF }]);
    expect(result.created).toHaveLength(1);
  });

  it("moves a Task at exploring or planned to building, and raises the revision", async () => {
    const results = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const out: Array<unknown> = [];
        for (const stage of ["exploring", "planned"] as const) {
          const task = yield* createTask(stage);
          const before = yield* readStageRevision(task.id);
          const recorded = yield* tasks.recordEntityHandoff({
            taskId: task.id,
            entry: { ref: REF, runId: newId() },
          });
          out.push({
            stageBefore: recorded.stageBefore,
            stage: recorded.task.stage,
            created: recorded.created,
            rose: recorded.stageRevision - before,
          });
        }
        return out;
      }),
    );
    expect(results).toEqual([
      { stageBefore: "exploring", stage: "building", created: false, rose: 1 },
      { stageBefore: "planned", stage: "building", created: false, rose: 1 },
    ]);
  });

  it("keeps a Task at any other stage where it is, and still raises the revision", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("in-review");
        const before = yield* readStageRevision(task.id);
        const recorded = yield* tasks.recordEntityHandoff({
          taskId: task.id,
          entry: { ref: REF, runId: newId() },
        });
        const events = yield* readEventsOfKind("task.updated");
        return { recorded, rose: recorded.stageRevision - before, events };
      }),
    );
    expect(result.recorded).toMatchObject({
      stageBefore: "in-review",
      task: { stage: "in-review" },
    });
    expect(result.rose).toBe(1);
    // The entry is a change of the Task; the stage is not listed in it.
    expect(
      result.events.map((event) => Object.keys((event.payload as { changes: object }).changes)),
    ).toEqual([["provenance"]]);
  });

  it("writes to the survivor when the id was merged", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const survivor = yield* createTask("planned", [OTHER_REF]);
        const source = yield* createTask("planned", [REF]);
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        const recorded = yield* tasks.recordEntityHandoff({
          taskId: source.id,
          entry: { ref: REF, runId: newId() },
        });
        return { recorded, survivorId: survivor.id };
      }),
    );
    expect(result.recorded.task.id).toBe(result.survivorId);
    expect(result.recorded.task.stage).toBe("building");
  });

  it("refuses a caller who is not the user, even one who holds the grants", async () => {
    const error = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        return yield* Effect.flip(
          tasks.recordEntityHandoff({
            taskId: newId(),
            entry: { ref: REF, runId: newId() },
            newTask: { title: "forged" },
          }),
        );
      }),
      buildSessionActor(["task.create", "task.update", "task.read"]),
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("reverseEntityHandoff", () => {
  /** Hands a new Task off: the run exists, as the run service writes it first. */
  const handOffNewTask = Effect.gen(function* () {
    const tasks = yield* TaskService;
    const taskId = newId();
    const runId = newId();
    yield* insertRun(runId, taskId, HANDOFF_AT);
    const recorded = yield* tasks.recordEntityHandoff({
      taskId,
      entry: { ref: REF, runId },
      newTask: { title: "Review PR 12" },
    });
    return { taskId, runId, recorded };
  });

  /** Hands off a Task that exists already, at `stage`. */
  const handOffContinuedTask = (stage: TaskStage) =>
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      const task = yield* createTask(stage);
      const runId = newId();
      yield* insertRun(runId, task.id, HANDOFF_AT);
      const recorded = yield* tasks.recordEntityHandoff({
        taskId: task.id,
        entry: { ref: REF, runId },
      });
      return { taskId: task.id, runId, recorded };
    });

  const reverse = (handoff: {
    readonly taskId: string;
    readonly runId: string;
    readonly recorded: Pick<
      EntityHandoffRecorded,
      "stageBefore" | "stageRevision" | "runsOnTask" | "sessionsOnTask"
    >;
  }) =>
    Effect.flatMap(TaskService, (tasks) =>
      tasks.reverseEntityHandoff({
        taskId: handoff.taskId,
        runId: handoff.runId,
        ref: REF,
        stageBefore: handoff.recorded.stageBefore,
        stageRevision: handoff.recorded.stageRevision,
        runsOnTask: handoff.recorded.runsOnTask,
        sessionsOnTask: handoff.recorded.sessionsOnTask,
      }),
    );

  const isGone = (taskId: string) =>
    Effect.flatMap(TaskService, (tasks) =>
      Effect.match(tasks.read(taskId), { onFailure: () => true, onSuccess: () => false }),
    );

  it("deletes a Task the handoff made when nothing has happened to it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const handoff = yield* handOffNewTask;
        // The run's own row was counted when the handoff wrote the Task.
        expect(handoff.recorded).toMatchObject({ runsOnTask: 1, sessionsOnTask: 0 });
        return { reversal: yield* reverse(handoff), gone: yield* isGone(handoff.taskId) };
      }),
    );
    expect(result.reversal).toEqual({
      reversed: true,
      taskRemoved: true,
      stageRestored: false,
      failureRestored: false,
    });
    expect(result.gone).toBe(true);
  });

  it.each([
    ["a Thread joined it", (taskId: string) => insertSession(taskId, AFTER_HANDOFF), "thread"],
    [
      "a second run joined it",
      (taskId: string) => insertRun(newId(), taskId, AFTER_HANDOFF),
      "run",
    ],
    [
      "it was edited",
      (taskId: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id: taskId, title: "Renamed" })),
      "edited",
    ],
    [
      "it was dragged to another stage",
      (taskId: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.move({ id: taskId, stage: "in-review" })),
      "moved",
    ],
    [
      "its stage was set to the one it has",
      (taskId: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id: taskId, stage: "building" })),
      "moved",
    ],
    [
      "it links another ref",
      (taskId: string) => insertLink(taskId, OTHER_REF),
      "links something else",
    ],
  ])("keeps a Task the handoff made when %s", async (_name, change, reason) => {
    const result = await run(
      Effect.gen(function* () {
        const handoff = yield* handOffNewTask;
        yield* change(handoff.taskId);
        return { reversal: yield* reverse(handoff), gone: yield* isGone(handoff.taskId) };
      }),
    );
    expect(result.reversal).toMatchObject({
      reversed: false,
      reason: expect.stringContaining(reason),
    });
    expect(result.gone).toBe(false);
  });

  it("keeps a Task that was merged into another, and never touches the survivor", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const handoff = yield* handOffNewTask;
        const survivor = yield* createTask("planned", [OTHER_REF]);
        yield* tasks.merge(handoff.taskId, { intoTaskId: survivor.id });
        return {
          reversal: yield* reverse(handoff),
          survivor: yield* tasks.read(survivor.id),
          survivorId: survivor.id,
        };
      }),
    );
    expect(result.reversal).toMatchObject({
      reversed: false,
      reason: expect.stringContaining("merged"),
    });
    expect(result.survivor.id).toBe(result.survivorId);
  });

  it("keeps a Task that was deleted, finished, or never existed", async () => {
    const reasons = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const deleted = yield* handOffNewTask;
        yield* tasks.delete(deleted.taskId);
        const finished = yield* handOffContinuedTask("planned");
        yield* tasks.update({ id: finished.taskId, stage: "done" });
        return [yield* reverse(deleted), yield* reverse(finished)];
      }),
    );
    expect(reasons).toMatchObject([
      { reversed: false, reason: expect.stringContaining("deleted") },
      { reversed: false, reason: expect.stringContaining("finished") },
    ]);
  });

  it.each([["exploring"], ["planned"], ["in-review"]] as const)(
    "puts a continued Task at %s back at that stage",
    async (stage) => {
      const result = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const handoff = yield* handOffContinuedTask(stage);
          const reversal = yield* reverse(handoff);
          return { reversal, task: yield* tasks.read(handoff.taskId) };
        }),
      );
      expect(result.reversal).toEqual({
        reversed: true,
        taskRemoved: false,
        stageRestored: true,
        failureRestored: false,
      });
      expect(result.task.stage).toBe(stage);
    },
  );

  it("lets a continued Task keep its earlier Threads and runs, and refuses one that came after", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const earlier = yield* Effect.gen(function* () {
          const task = yield* createTask("planned");
          yield* insertSession(task.id, BEFORE_HANDOFF);
          yield* insertRun(newId(), task.id, BEFORE_HANDOFF);
          const runId = newId();
          yield* insertRun(runId, task.id, HANDOFF_AT);
          const recorded = yield* tasks.recordEntityHandoff({
            taskId: task.id,
            entry: { ref: REF, runId },
          });
          return { taskId: task.id, runId, recorded };
        });
        const later = yield* handOffContinuedTask("planned");
        yield* insertSession(later.taskId, AFTER_HANDOFF);
        return { kept: yield* reverse(earlier), refused: yield* reverse(later) };
      }),
    );
    expect(result.kept).toMatchObject({ reversed: true, stageRestored: true });
    expect(result.refused).toMatchObject({
      reversed: false,
      reason: expect.stringContaining("thread"),
    });
  });

  it("keeps a continued Task that a Thread was moved onto since, or another Task was merged into", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const moved = yield* handOffContinuedTask("planned");
        const merged = yield* handOffContinuedTask("planned");
        // Work that already existed on other Tasks, with times from before the handoff.
        const threadElsewhere = yield* createTask("planned", [OTHER_REF]);
        yield* insertSession(threadElsewhere.id, BEFORE_HANDOFF);
        const source = yield* createTask("planned", [OTHER_REF]);
        yield* insertSession(source.id, BEFORE_HANDOFF);
        yield* insertRun(newId(), source.id, BEFORE_HANDOFF);
        // What `session.moveToTask` does to the Thread: it points it at another Task.
        yield* withTransaction(
          sql,
          sql`UPDATE sessions SET task_id = ${uuidFromString(moved.taskId)}
              WHERE task_id = ${uuidFromString(threadElsewhere.id)}`,
        );
        yield* tasks.merge(source.id, { intoTaskId: merged.taskId });
        return { moved: yield* reverse(moved), merged: yield* reverse(merged) };
      }),
    );
    expect(result.moved).toMatchObject({
      reversed: false,
      reason: expect.stringContaining("thread"),
    });
    expect(result.merged).toMatchObject({
      reversed: false,
      reason: expect.stringContaining("run joined"),
    });
  });

  it("keeps a continued Task that was dragged since", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const handoff = yield* handOffContinuedTask("planned");
        yield* tasks.move({ id: handoff.taskId, stage: "in-review" });
        return { reversal: yield* reverse(handoff), task: yield* tasks.read(handoff.taskId) };
      }),
    );
    expect(result.reversal).toMatchObject({ reversed: false });
    expect(result.task.stage).toBe("in-review");
  });

  it("brings back the failure the run's start ended", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const repository = yield* taskRepository;
        const task = yield* createTask("exploring");
        yield* tasks.recordRunFailure({ taskId: task.id, runId: FAILED_RUN });
        const runId = newId();
        yield* insertRun(runId, task.id, HANDOFF_AT);
        yield* tasks.recordRunStart({ taskId: task.id, runId });
        const recorded = yield* tasks.recordEntityHandoff({
          taskId: task.id,
          entry: { ref: REF, runId },
        });
        const during = yield* repository.readFailureState(task.id);
        const reversal = yield* reverse({ taskId: task.id, runId, recorded });
        return { during, reversal, after: yield* repository.readFailureState(task.id) };
      }),
    );
    expect(result.during).toMatchObject({ _tag: "Some", value: { failedRunId: undefined } });
    expect(result.reversal).toEqual({
      reversed: true,
      taskRemoved: false,
      stageRestored: true,
      failureRestored: true,
    });
    expect(result.after).toMatchObject({ _tag: "Some", value: { failedRunId: FAILED_RUN } });
  });

  it("does not overwrite a failure when newer handling came in between", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const repository = yield* taskRepository;
        const task = yield* createTask("exploring");
        yield* tasks.recordRunFailure({ taskId: task.id, runId: FAILED_RUN });
        const runId = newId();
        yield* insertRun(runId, task.id, HANDOFF_AT);
        yield* tasks.recordRunStart({ taskId: task.id, runId });
        const recorded = yield* tasks.recordEntityHandoff({
          taskId: task.id,
          entry: { ref: REF, runId },
        });
        // Handling that leaves no run or Thread row behind, so only the failure fence sees it.
        yield* tasks.recordRunFailure({ taskId: task.id, runId: NEWER_RUN });
        const reversal = yield* reverse({ taskId: task.id, runId, recorded });
        return { reversal, after: yield* repository.readFailureState(task.id) };
      }),
    );
    expect(result.reversal).toMatchObject({
      reversed: true,
      stageRestored: true,
      failureRestored: false,
    });
    expect(result.after).toMatchObject({ _tag: "Some", value: { failedRunId: NEWER_RUN } });
  });

  it("refuses a caller who is not the user", async () => {
    const error = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        return yield* Effect.flip(
          Effect.provideService(
            tasks.reverseEntityHandoff({
              taskId: newId(),
              runId: newId(),
              ref: REF,
              stageBefore: undefined,
              stageRevision: 0,
              runsOnTask: 1,
              sessionsOnTask: 0,
            }),
            CurrentActor,
            buildSessionActor(["task.update", "task.delete", "task.read"]),
          ),
        );
      }),
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });
});

const insertLink = (taskId: string, ref: ExternalRef) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withTransaction(
      sql,
      sql`INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by)
          VALUES (${uuidFromString(taskId)}, ${ref}, ${AFTER_HANDOFF}, 'user')`,
    );
  });

describe("readAttention", () => {
  const failTask = (stage: TaskStage = "building") =>
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      const task = yield* createTask(stage);
      yield* tasks.recordRunFailure({ taskId: task.id, runId: FAILED_RUN });
      return task;
    });

  const readAnyFailure = Effect.flatMap(TaskService, (tasks) =>
    Effect.map(tasks.readAttention(), (attention) => attention.anyFailure),
  );

  it("is false with no failure, and true while a live Task shows one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const empty = yield* readAnyFailure;
        yield* createTask("building");
        const plain = yield* readAnyFailure;
        yield* failTask();
        return { empty, plain, failed: yield* readAnyFailure };
      }),
    );
    expect(result).toEqual({ empty: false, plain: false, failed: true });
  });

  it("stays true after a drag, and ends with Try again, Done, Drop or delete", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const steps: Array<boolean> = [];
        const task = yield* failTask();
        yield* tasks.move({ id: task.id, stage: "in-review" });
        steps.push(yield* readAnyFailure);
        yield* tasks.recordRunStart({ taskId: task.id, runId: newId() });
        steps.push(yield* readAnyFailure);
        for (const end of ["done", "dropped", "deleted"] as const) {
          const failed = yield* failTask();
          if (end === "deleted") yield* tasks.delete(failed.id);
          else yield* tasks.update({ id: failed.id, stage: end });
          steps.push(yield* readAnyFailure);
        }
        return steps;
      }),
    );
    expect(result).toEqual([true, false, false, false, false]);
  });

  it("does not count a merged Task", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const failed = yield* failTask();
        const survivor = yield* createTask("planned");
        yield* withTransaction(
          sql,
          sql`UPDATE tasks SET merged_into_id = ${uuidFromString(survivor.id)}
              WHERE id = ${uuidFromString(failed.id)}`,
        );
        return yield* readAnyFailure;
      }),
    );
    expect(result).toBe(false);
  });

  it.each([
    ["task.read alone", ["task.read"], "run.read"],
    ["run.read alone", ["run.read"], "task.read"],
  ])(
    "refuses a session that holds %s, and names the grant it lacks",
    async (_name, grants, missing) => {
      const exit = await run(
        Effect.gen(function* () {
          yield* failTask();
          const tasks = yield* TaskService;
          return yield* Effect.exit(
            Effect.provideService(tasks.readAttention(), CurrentActor, buildSessionActor(grants)),
          );
        }),
      );
      expect(JSON.stringify(exit)).toContain(`"grant":"${missing}"`);
    },
  );

  it("lets a session that holds both grants read it", async () => {
    const attention = await run(
      Effect.gen(function* () {
        yield* failTask();
        const tasks = yield* TaskService;
        return yield* Effect.provideService(
          tasks.readAttention(),
          CurrentActor,
          buildSessionActor(["task.read", "run.read"]),
        );
      }),
    );
    expect(attention).toEqual({ anyFailure: true });
  });
});
