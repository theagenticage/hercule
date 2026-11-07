/**
 * Integration tests for the Task a run works on. They drive the run service
 * on a temporary database file, with the real Run Executor and no runner:
 *
 * - `startOnTask`, the controller's own way to link a run to a Task, which the
 *   public `start` does not offer;
 * - what carries the Task: the run record, its summary in the run list, the
 *   `taskId` on the summary, the event the run emits when it ends, and a re-run of
 *   the run in both modes.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Run } from "@hercule/contract";
import { CurrentActor } from "../actor";
import { AfterCommit, type Change } from "../db";
import { RunExecutorLayer } from "../daemon/runs";
import { EventKindsLayer, PlatformEventsLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { SessionTokensLayer } from "../permissions";
import { EventKindCatalogLayer, PluginHost } from "../plugins";
import { buildPluginStack, USER } from "../plugins/testing";
import { ProviderAccountRunnersLayer } from "../provider-accounts";
import { SettingsLayer } from "../settings";
import { AccountUsageLayer } from "../usage";
import { TaskService, TaskServiceLayer, taskRepository } from "../tasks";
import { TextGeneration } from "../text-generation";
import { WorkflowRuns, WorkflowService, WorkflowServiceLayer, WorkflowSignals } from "../workflows";
import { WorkspaceServiceLayer } from "../workspaces";
import { RunService, RunServiceLayer } from "./service";
import { RunWorkspaceStepActivityLayer } from "./workspace-step-activity";
import { WorkspaceSteps } from "./workspace-steps";

type Deps = RunService | WorkflowService | TaskService | SqlClient.SqlClient;

/**
 * Runs `body` against a fresh controller on a temporary database file. Every
 * change a committed transaction announces is added to `published`.
 */
const runTest = <A, E>(body: Effect.Effect<A, E, Deps>, published: Array<Change> = []) => {
  const layer = RunServiceLayer.pipe(
    Layer.provideMerge(
      WorkflowServiceLayer.pipe(
        Layer.provide(EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer))),
        Layer.provide(
          Layer.succeed(WorkflowRuns)({ hasUnfinishedRun: () => Effect.succeed(false) }),
        ),
        Layer.provide(Layer.succeed(WorkflowSignals)({ readKind: () => Effect.succeedNone })),
      ),
    ),
    Layer.provideMerge(TaskServiceLayer),
    Layer.provideMerge(
      WorkspaceServiceLayer.pipe(
        Layer.provide(SessionTokensLayer),
        Layer.provide(RunWorkspaceStepActivityLayer),
      ),
    ),
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(RunExecutorLayer),
    Layer.provideMerge(PlatformEventsLayer),
    Layer.provideMerge(
      Layer.succeed(WorkspaceSteps)({
        start: () => Effect.void,
        settle: () => undefined,
        openSession: () => Effect.die("these tests run no agent step"),
        stopSessions: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(AfterCommit)({
        publish: (changes) =>
          Effect.sync(() => {
            published.push(...changes);
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TextGeneration)({
        generate: () => Effect.die("these tests make no model call"),
      }),
    ),
    Layer.provideMerge(ProviderAccountRunnersLayer),
    Layer.provideMerge(AccountUsageLayer),
    Layer.provideMerge(buildPluginStack()),
  );
  return Effect.runPromise(
    Effect.andThen(
      Effect.flatMap(PluginHost, (host) => host.boot([])),
      body,
    ).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer)) as Effect.Effect<A, E>,
  );
};

const TASK_ID = "0199f0b7-0000-7000-8000-00000000a001";
const OTHER_TASK_ID = "0199f0b7-0000-7000-8000-00000000a002";

/** A workflow of one step that files a task, so a run of it ends on its own. */
const FILE_DEFINITION = {
  name: "File a task",
  steps: [
    {
      id: "file",
      kind: "action" as const,
      action: "task.create",
      params: { title: "t", description: "" },
    },
  ],
};

/** A workflow whose only step fails: it updates a Task that does not exist. */
const FAIL_DEFINITION = {
  name: "Update a Task that is not there",
  steps: [
    {
      id: "update",
      kind: "action" as const,
      action: "task.update",
      params: { taskId: "0199f0b7-0000-7000-8000-00000000ffff", status: "done" },
    },
  ],
};

/** A workflow that cannot start without its required input. */
const NEEDS_INPUT_DEFINITION = {
  name: "Needs an input",
  inputs: [{ name: "title", schema: { type: "string", minLength: 1 }, required: true }],
  steps: FILE_DEFINITION.steps,
};

/** Waits until the run has ended, and returns it. */
const waitForRunToEnd = (runId: string) =>
  Effect.gen(function* () {
    const runs = yield* RunService;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const run = yield* runs.read(runId);
      if (run.status !== "pending" && run.status !== "running") return run;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(`timed out waiting for run ${runId} to end`);
  });

/** Returns the ids of the runs the run list shows with `taskId` as their Task. */
const listRunIdsOfTask = (taskId: string) =>
  Effect.flatMap(RunService, (runs) =>
    Effect.map(runs.query({}), (page) =>
      page.items.filter((summary) => summary.taskId === taskId).map((summary) => summary.id),
    ),
  );

describe("a run that works on a Task", () => {
  it("is linked by startOnTask, and the run record, the run list and the event it emits when it ends carry the Task", async () => {
    await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const { runId } = yield* runs.startOnTask({ definition: FILE_DEFINITION }, TASK_ID);
        const { runId: untrackedId } = yield* runs.start({ definition: FILE_DEFINITION });
        const ended = yield* waitForRunToEnd(runId);
        const untracked = yield* waitForRunToEnd(untrackedId);

        expect(ended.status).toBe("completed");
        expect(ended.taskId).toBe(TASK_ID);
        expect(untracked).not.toHaveProperty("taskId");
        expect(yield* listRunIdsOfTask(TASK_ID)).toEqual([runId]);
        expect(yield* listRunIdsOfTask(OTHER_TASK_ID)).toEqual([]);
        const payloads = (yield* readEventsOfKind("run.completed")).map((event) => event.payload);
        expect(payloads.find((payload) => payload["runId"] === runId)?.["taskId"]).toBe(TASK_ID);
        expect(payloads.find((payload) => payload["runId"] === untrackedId)).not.toHaveProperty(
          "taskId",
        );
      }),
    );
  });

  it("is kept by a re-run, in both modes", async () => {
    await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const workflows = yield* WorkflowService;
        const { workflow } = yield* workflows.create({ definition: FILE_DEFINITION });
        const { runId } = yield* runs.startOnTask({ workflowId: workflow.id }, TASK_ID);
        yield* waitForRunToEnd(runId);

        const restamped = yield* runs.rerun(runId, { mode: "re-stamp" });
        const replayed = yield* runs.rerun(runId, { mode: "replay" });

        const reruns: Array<Run> = [];
        for (const rerun of [restamped, replayed]) reruns.push(yield* waitForRunToEnd(rerun.runId));
        expect(reruns.map((rerun) => rerun.taskId)).toEqual([TASK_ID, TASK_ID]);
        expect(yield* listRunIdsOfTask(TASK_ID)).toHaveLength(3);
      }),
    );
  });
});

describe("the failure a Task shows", () => {
  /** Creates a Task and returns its id and a reader of its failure state. */
  const createTask = Effect.gen(function* () {
    const tasks = yield* TaskService;
    const repository = yield* taskRepository;
    const task = yield* tasks.create({ title: "Add a refund button", description: "" });
    const readState = Effect.map(repository.readFailureState(task.id), (state) =>
      state._tag === "Some" ? state.value : undefined,
    );
    return { taskId: task.id, readState, repository };
  });

  it("is set when a run of the Task fails, and ended by the next run that starts on it", async () => {
    await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const { taskId, readState, repository } = yield* createTask;

        const failing = yield* runs.startOnTask({ definition: FAIL_DEFINITION }, taskId);
        expect((yield* waitForRunToEnd(failing.runId)).status).toBe("failed");
        expect((yield* readState)?.failedRunId).toBe(failing.runId);

        const retry = yield* runs.startOnTask({ definition: FILE_DEFINITION }, taskId);
        expect((yield* readState)?.failedRunId).toBeUndefined();
        const recovery = yield* repository.readFailureRecovery(retry.runId);
        expect(recovery).toMatchObject({ value: { taskId, failedRunId: failing.runId } });
        yield* waitForRunToEnd(retry.runId);
        expect((yield* readState)?.failedRunId).toBeUndefined();
      }),
    );
  });

  it("is kept when a run that cannot start is refused, and that refusal leaves no row to restore from", async () => {
    await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const workflows = yield* WorkflowService;
        const { taskId, readState } = yield* createTask;
        const failing = yield* runs.startOnTask({ definition: FAIL_DEFINITION }, taskId);
        yield* waitForRunToEnd(failing.runId);
        const before = yield* readState;
        const { workflow } = yield* workflows.create({ definition: NEEDS_INPUT_DEFINITION });

        const refusal = yield* Effect.flip(runs.startOnTask({ workflowId: workflow.id }, taskId));

        expect(refusal).toMatchObject({ error: { code: "validation" } });
        expect(yield* readState).toEqual(before);
        expect(before?.failedRunId).toBe(failing.runId);
      }),
    );
  });
});

describe("the card of a Task, when a run of it starts or ends", () => {
  /** The Task's `updated` announcements so far. */
  const cardChanges = (published: ReadonlyArray<Change>, taskId: string) =>
    published.filter(
      (change) =>
        change._tag === "record" &&
        change.topic === "task" &&
        change.id === taskId &&
        change.kind === "updated",
    );

  /** Waits until `count` announcements are out, which follows the commit of what caused them. */
  const waitForAnnouncements = (published: ReadonlyArray<Change>, taskId: string, count: number) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (cardChanges(published, taskId).length >= count) return;
        yield* Effect.sleep("10 millis");
      }
      return yield* Effect.die("timed out waiting for the card change");
    });

  it("is announced as a derived change when a run of the Task ends", async () => {
    const published: Array<Change> = [];
    const taskId = await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const tasks = yield* TaskService;
        const task = yield* tasks.create({ title: "Add a refund button", description: "" });
        const run = yield* runs.startOnTask({ definition: FILE_DEFINITION }, task.id);
        yield* waitForRunToEnd(run.runId);
        yield* waitForAnnouncements(published, task.id, 1);
        return task.id;
      }),
      published,
    );

    expect(cardChanges(published, taskId)).toEqual([
      { _tag: "record", topic: "task", id: taskId, kind: "updated", derived: true },
    ]);
  });

  it("is announced only as derived changes when a run fails and the next run ends the failure", async () => {
    const published: Array<Change> = [];
    const taskId = await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const tasks = yield* TaskService;
        const task = yield* tasks.create({ title: "Add a refund button", description: "" });
        const failing = yield* runs.startOnTask({ definition: FAIL_DEFINITION }, task.id);
        yield* waitForRunToEnd(failing.runId);
        const retry = yield* runs.startOnTask({ definition: FILE_DEFINITION }, task.id);
        yield* waitForRunToEnd(retry.runId);
        // The failure and the start that ended it.
        yield* waitForAnnouncements(published, task.id, 2);
        return task.id;
      }),
      published,
    );

    const changes = cardChanges(published, taskId);
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(
      changes.every(
        (change) => change._tag === "record" && change.topic === "task" && change.derived === true,
      ),
    ).toBe(true);
  });

  it("is not announced when a run that cannot start is refused", async () => {
    const published: Array<Change> = [];
    await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const workflows = yield* WorkflowService;
        const tasks = yield* TaskService;
        const task = yield* tasks.create({ title: "Add a refund button", description: "" });
        const { workflow } = yield* workflows.create({ definition: NEEDS_INPUT_DEFINITION });
        yield* Effect.flip(runs.startOnTask({ workflowId: workflow.id }, task.id));
        return task.id;
      }),
      published,
    );

    expect(
      published.filter(
        (change) =>
          change._tag === "record" && change.topic === "task" && change.kind === "updated",
      ),
    ).toEqual([]);
  });
});
