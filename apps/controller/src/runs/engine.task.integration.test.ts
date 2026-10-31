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
import { AfterCommit } from "../db";
import { RunExecutorLayer } from "../daemon/runs";
import { EventKindsLayer, PlatformEventsLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { SessionTokensLayer } from "../permissions";
import { EventKindCatalogLayer, PluginHost } from "../plugins";
import { buildPluginStack, USER } from "../plugins/testing";
import { ProviderAccountRunnersLayer } from "../provider-accounts";
import { SettingsLayer } from "../settings";
import { AccountUsageLayer } from "../usage";
import { TaskServiceLayer } from "../tasks";
import { TextGeneration } from "../text-generation";
import { WorkflowRuns, WorkflowService, WorkflowServiceLayer, WorkflowSignals } from "../workflows";
import { WorkspaceServiceLayer } from "../workspaces";
import { RunService, RunServiceLayer } from "./service";
import { RunWorkspaceStepActivityLayer } from "./workspace-step-activity";
import { WorkspaceSteps } from "./workspace-steps";

type Deps = RunService | WorkflowService | SqlClient.SqlClient;

/** Runs `body` against a fresh controller on a temporary database file. */
const runTest = <A, E>(body: Effect.Effect<A, E, Deps>) => {
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
    Layer.provideMerge(Layer.succeed(AfterCommit)({ publish: () => Effect.void })),
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
