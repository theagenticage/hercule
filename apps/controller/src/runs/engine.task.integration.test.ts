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
import { NotFound, type Run, type TryAgainUndo } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { AfterCommit, uuidFromString, type Change } from "../db";
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
import {
  WorkflowRuns,
  WorkflowService,
  WorkflowServiceLayer,
  WorkflowSignals,
  WorkflowEntities,
} from "../workflows";
import { WorkspaceServiceLayer } from "../workspaces";
import { RunService, RunServiceLayer } from "./service";
import { buildHeldAction, waitForHeldExecutions, type HeldAction } from "./testing";
import { RunWorkspaceStepActivityLayer } from "./workspace-step-activity";
import { WorkspaceSteps } from "./workspace-steps";
import { TaskLinkOwnersLayer } from "../daemon/tasks";

type Deps = RunService | WorkflowService | TaskService | SqlClient.SqlClient;

/**
 * Runs `body` against a fresh controller on a temporary database file, with
 * the plugins `plugins`. Every change a committed transaction announces is
 * added to `published`.
 */
const runTest = <A, E>(
  body: Effect.Effect<A, E, Deps>,
  published: Array<Change> = [],
  plugins: ReadonlyArray<HeldAction["plugin"]> = [],
  actor: Actor = USER,
) => {
  const layer = RunServiceLayer.pipe(
    Layer.provideMerge(
      WorkflowServiceLayer.pipe(
        Layer.provide(EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer))),
        Layer.provide(
          Layer.succeed(WorkflowRuns)({ hasUnfinishedRun: () => Effect.succeed(false) }),
        ),
        Layer.provide(Layer.succeed(WorkflowSignals)({ readKind: () => Effect.succeedNone })),
        Layer.provide(Layer.succeed(WorkflowEntities)({ readKind: () => Effect.succeedNone })),
      ),
    ),
    Layer.provideMerge(TaskServiceLayer.pipe(Layer.provide(TaskLinkOwnersLayer))),
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
      Effect.flatMap(PluginHost, (host) => host.boot(plugins)),
      body,
    ).pipe(Effect.provideService(CurrentActor, actor), Effect.provide(layer)) as Effect.Effect<
      A,
      E
    >,
  );
};

const TASK_ID = "0199f0b7-0000-7000-8000-00000000a001";
const OTHER_TASK_ID = "0199f0b7-0000-7000-8000-00000000a002";
const ABSENT_RUN_ID = "0199f0b7-0000-7000-8000-00000000a0ff";

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

/** A workflow whose step names the run's Task in the title of the task it files. */
const NAMES_ITS_TASK_DEFINITION = {
  name: "File a task that names its Task",
  steps: [
    {
      id: "file",
      kind: "action" as const,
      action: "task.create",
      params: { title: "{{ run.taskId }}", description: "" },
    },
  ],
};

describe("run.taskId in a step", () => {
  it("renders the Task the run works on", async () => {
    await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const { runId } = yield* runs.startOnTask(
          { definition: NAMES_ITS_TASK_DEFINITION },
          TASK_ID,
        );

        const ended = yield* waitForRunToEnd(runId);

        expect(ended.status).toBe("completed");
        expect(ended.steps[0]).toMatchObject({ status: "completed", output: { title: TASK_ID } });
      }),
    );
  });

  it("fails the run with a message that says it works on no Task, when it has none", async () => {
    await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const { runId } = yield* runs.start({ definition: NAMES_ITS_TASK_DEFINITION });

        const ended = yield* waitForRunToEnd(runId);

        expect(ended).toMatchObject({ status: "failed" });
        expect(JSON.stringify(ended)).toContain("run.taskId is not set: this run works on no Task");
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

  it("is announced as a plain change when a failure starts and when it ends, and as a derived one when the retry's run ends", async () => {
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
        // The failure starting (plain), the first run ending (derived), the
        // retry starting and ending the failure (plain), and the retry ending (derived).
        yield* waitForAnnouncements(published, task.id, 4);
        return task.id;
      }),
      published,
    );

    // The sidebar's failure dot follows plain pushes only, so a failure
    // starting or ending must send one. The rest of the card stays derived.
    const changes = cardChanges(published, taskId);
    expect(changes.map((change) => "derived" in change)).toEqual([false, true, false, true]);
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

describe("the summary of a Task, when a run of it ends", () => {
  it.each([
    ["completes", FILE_DEFINITION],
    ["fails", FAIL_DEFINITION],
  ])("is out of date once a run that %s has ended, and not before", async (_name, definition) => {
    const result = await runTest(
      Effect.gen(function* () {
        const runs = yield* RunService;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const task = yield* tasks.create({ title: "Add a refund button", description: "" });
        const readRevision = Effect.map(
          sql<{ readonly dirty_revision: number }>`
            SELECT dirty_revision FROM task_summaries WHERE task_id = ${uuidFromString(task.id)}`,
          (rows) => rows[0]?.dirty_revision ?? 0,
        );
        const beforeRun = yield* readRevision;
        const { runId } = yield* runs.startOnTask({ definition }, task.id);
        yield* waitForRunToEnd(runId);
        return { beforeRun, afterRun: yield* readRevision };
      }),
    );

    expect(result).toEqual({ beforeRun: 0, afterRun: 1 });
  });
});

/** What the Undo of a Try again does to the Task and to the run it asks to stop. */
describe("task.undoTryAgain", () => {
  /** Waits for `held` to carry out `count` steps, which says the run holding them is running. */
  const waitForHeld = (held: HeldAction, count: number) =>
    Effect.promise(() => waitForHeldExecutions(held, count));

  /** Builds the step `stepId`, which calls the held action. */
  const buildHeldStep = (held: HeldAction, stepId: string) => ({
    id: stepId,
    kind: "action" as const,
    action: held.actionId,
    params: { label: stepId },
  });

  /** A run of one step that waits until the test releases it, which `stepId` names. */
  const buildWaiting = (held: HeldAction, stepId: string) => ({
    definition: { name: `Wait at ${stepId}`, steps: [buildHeldStep(held, stepId)] },
  });

  /**
   * A run that waits at the step `live`, and fails once the test releases that
   * step: the update after it names a Task that does not exist.
   */
  const buildWaitingThenFailing = (held: HeldAction) => ({
    definition: {
      name: "Wait, then fail",
      steps: [buildHeldStep(held, "live"), ...FAIL_DEFINITION.steps],
      edges: [{ from: "live", to: "update" }],
    },
  });

  /**
   * Arranges a Task whose run failed and whose Try again (the run `retryId`)
   * has started. With `liveBeforeFailure`, another run of the Task was already
   * running before the failure, and fails once the test releases it. With
   * `retryEnds`, the Try again is a run that ends at once, so the Undo comes
   * too late.
   */
  const arrangeTryAgain = (
    held: HeldAction,
    options: { readonly liveBeforeFailure?: boolean; readonly retryEnds?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const runs = yield* RunService;
      const tasks = yield* TaskService;
      const repository = yield* taskRepository;
      const task = yield* tasks.create({ title: "Add a refund button", description: "" });
      const live =
        options.liveBeforeFailure === true
          ? yield* runs.startOnTask(buildWaitingThenFailing(held), task.id)
          : undefined;
      if (live !== undefined) yield* waitForHeld(held, 1);
      const failing = yield* runs.startOnTask({ definition: FAIL_DEFINITION }, task.id);
      yield* waitForRunToEnd(failing.runId);
      const retry = yield* runs.startOnTask(
        options.retryEnds === true ? { definition: FILE_DEFINITION } : buildWaiting(held, "retry"),
        task.id,
      );
      if (options.retryEnds === true) yield* waitForRunToEnd(retry.runId);
      else yield* waitForHeld(held, live === undefined ? 1 : 2);
      return {
        taskId: task.id,
        failedRunId: failing.runId,
        retryId: retry.runId,
        liveRunId: live?.runId,
        /** The run whose failure the Task shows, or `undefined`. */
        readShownFailure: Effect.map(repository.readFailureState(task.id), (state) =>
          state._tag === "Some" ? state.value.failedRunId : undefined,
        ),
        readRetryStatus: Effect.map(runs.read(retry.runId), (run) => run.status),
      };
    });

  type Arranged = Effect.Success<ReturnType<typeof arrangeTryAgain>>;

  /** A change to the Task after the Try again started, and the answer the Undo must then give. */
  interface Row {
    readonly name: string;
    readonly options?: Parameters<typeof arrangeTryAgain>[1];
    readonly disturb?: (
      arranged: Arranged,
      held: HeldAction,
    ) => Effect.Effect<unknown, unknown, Deps>;
    readonly answer: TryAgainUndo;
    /** Words the reason of a `stopped` answer must contain. */
    readonly reasonIncludes?: string;
    /** The run whose failure the Task shows afterwards: the first failure, or the newer one. */
    readonly shownFailure: "first" | "newer" | "none";
    readonly retryStatus: Run["status"];
  }

  const NEWER = "newer";
  const FINISHED = "done or dropped";
  const MERGED = "merged";

  const ROWS: ReadonlyArray<Row> = [
    {
      name: "puts the failure back when nothing changed, and asks the run to stop",
      answer: { outcome: "restored", stopRequested: true },
      shownFailure: "first",
      retryStatus: "cancelled",
    },
    {
      name: "keeps a newer failure, from a run that was live before the retry started",
      options: { liveBeforeFailure: true },
      disturb: (arranged, held) =>
        Effect.gen(function* () {
          held.releaseStep("live");
          yield* waitForRunToEnd(arranged.liveRunId!);
        }),
      answer: { outcome: "stopped", stopRequested: true },
      reasonIncludes: NEWER,
      shownFailure: "newer",
      retryStatus: "cancelled",
    },
    {
      name: "keeps a Thread started on the Task by name",
      disturb: (arranged) =>
        Effect.flatMap(TaskService, (tasks) =>
          tasks.joinSession({
            requestedTaskId: arranged.taskId,
            callerTaskId: undefined,
            workspaceId: null,
            sessionKind: "thread",
            title: "Look into the refund button",
            projectId: undefined,
          }),
        ),
      answer: { outcome: "stopped", stopRequested: true },
      reasonIncludes: NEWER,
      shownFailure: "none",
      retryStatus: "cancelled",
    },
    {
      name: "keeps a Task that was marked Done",
      disturb: (arranged) =>
        Effect.flatMap(TaskService, (tasks) =>
          tasks.update({ id: arranged.taskId, stage: "done" }),
        ),
      answer: { outcome: "stopped", stopRequested: true },
      reasonIncludes: FINISHED,
      shownFailure: "none",
      retryStatus: "cancelled",
    },
    {
      name: "keeps a Task that was dropped",
      disturb: (arranged) =>
        Effect.flatMap(TaskService, (tasks) =>
          tasks.update({ id: arranged.taskId, stage: "dropped" }),
        ),
      answer: { outcome: "stopped", stopRequested: true },
      reasonIncludes: FINISHED,
      shownFailure: "none",
      retryStatus: "cancelled",
    },
    {
      name: "keeps a second Try again, which keeps running",
      disturb: (arranged, held) =>
        Effect.gen(function* () {
          const runs = yield* RunService;
          const second = yield* runs.startOnTask(buildWaiting(held, "second"), arranged.taskId);
          yield* waitForHeld(held, 2);
          expect((yield* runs.read(second.runId)).status).toBe("running");
        }),
      answer: { outcome: "stopped", stopRequested: true },
      reasonIncludes: NEWER,
      shownFailure: "none",
      retryStatus: "cancelled",
    },
    {
      name: "leaves a Task that was merged into another with its failure gone",
      disturb: (arranged) =>
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const survivor = yield* tasks.create({ title: "Refund work", description: "" });
          yield* tasks.merge(arranged.taskId, { intoTaskId: survivor.id });
        }),
      answer: { outcome: "stopped", stopRequested: true },
      reasonIncludes: MERGED,
      shownFailure: "none",
      retryStatus: "cancelled",
    },
    {
      name: "is too late once the Try again has ended, and changes nothing",
      options: { retryEnds: true },
      answer: { outcome: "too-late", stopRequested: false },
      shownFailure: "none",
      retryStatus: "completed",
    },
  ];

  it.each(ROWS)("$name", async (row) => {
    const held = buildHeldAction();
    try {
      await runTest(
        Effect.gen(function* () {
          const runs = yield* RunService;
          const arranged = yield* arrangeTryAgain(held, row.options);
          if (row.disturb !== undefined) yield* row.disturb(arranged, held);

          const answered = yield* runs.undoTryAgain(arranged.taskId, { runId: arranged.retryId });

          expect(answered).toMatchObject(row.answer);
          if (row.reasonIncludes !== undefined) {
            expect(answered.reason).toContain(row.reasonIncludes);
          }
          // The line only says the run was asked to stop, never that it has.
          expect(answered.reason ?? "").not.toMatch(/has stopped|is stopped/);
          expect(yield* arranged.readRetryStatus).toBe(row.retryStatus);
          const shown = yield* arranged.readShownFailure;
          const expected = {
            first: arranged.failedRunId,
            newer: arranged.liveRunId,
            none: undefined,
          }[row.shownFailure];
          expect(shown).toBe(expected);
          // A repeat returns the first answer and changes nothing.
          expect(yield* runs.undoTryAgain(arranged.taskId, { runId: arranged.retryId })).toEqual(
            answered,
          );
          expect(yield* arranged.readShownFailure).toBe(expected);
        }),
        [],
        [held.plugin],
      );
    } finally {
      held.release();
    }
  });

  it("refuses before it cancels anything: an unrelated Task, an unknown run, and a re-run of a successful run on a Task with no failure", async () => {
    const held = buildHeldAction();
    try {
      await runTest(
        Effect.gen(function* () {
          const runs = yield* RunService;
          const tasks = yield* TaskService;
          const arranged = yield* arrangeTryAgain(held);
          const unrelated = yield* tasks.create({ title: "Update the footer", description: "" });

          // A Task that never failed: its original run succeeded, and the
          // re-run of that run is live, but it ended no failure.
          const clean = yield* tasks.create({ title: "Add a gift card", description: "" });
          const original = yield* runs.startOnTask(buildWaiting(held, "original"), clean.id);
          yield* waitForHeld(held, 2);
          held.releaseStep("original");
          yield* waitForRunToEnd(original.runId);
          const rerun = yield* runs.rerun(original.runId, { mode: "replay" });
          yield* waitForHeld(held, 3);

          const refusals = yield* Effect.all([
            Effect.flip(runs.undoTryAgain(unrelated.id, { runId: arranged.retryId })),
            Effect.flip(runs.undoTryAgain(clean.id, { runId: rerun.runId })),
            Effect.flip(runs.undoTryAgain(arranged.taskId, { runId: rerun.runId })),
            Effect.flip(runs.undoTryAgain(arranged.taskId, { runId: ABSENT_RUN_ID })),
          ]);

          expect(refusals.map((refusal) => refusal instanceof NotFound)).toEqual([
            true,
            true,
            true,
            true,
          ]);
          expect(yield* arranged.readRetryStatus).toBe("running");
          expect((yield* runs.read(rerun.runId)).status).toBe("running");
        }),
        [],
        [held.plugin],
      );
    } finally {
      held.release();
    }
  });

  it("refuses a session, whatever grants it holds, and cancels nothing", async () => {
    const held = buildHeldAction();
    const session: Actor = {
      _tag: "session",
      sessionId: "0199f0b7-0000-7000-8000-00000000b001",
      profileId: "0199f0b7-0000-7000-8000-00000000b002",
      grants: ["task.update", "run.write"],
      profileGrants: ["task.update", "run.write"],
      assistantId: null,
      agentId: null,
    };
    try {
      const retryStatus = await runTest(
        Effect.gen(function* () {
          const runs = yield* RunService;
          const arranged = yield* arrangeTryAgain(held);

          const refusal = yield* Effect.flip(
            runs
              .undoTryAgain(arranged.taskId, { runId: arranged.retryId })
              .pipe(Effect.provideService(CurrentActor, session)),
          );

          expect(refusal).toMatchObject({ error: { code: "forbidden" } });
          return yield* arranged.readRetryStatus;
        }),
        [],
        [held.plugin],
      );
      expect(retryStatus).toBe("running");
    } finally {
      held.release();
    }
  });
});
