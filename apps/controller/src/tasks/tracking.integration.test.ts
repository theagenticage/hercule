/**
 * Tests `GET /tasks/tracking` over a real socket, against the real
 * `TaskTrackingRuns` port: what a row holds for Tasks whose runs are in each
 * state, how a Task with a long history reads, and which Tasks are left out.
 * The Tasks and runs are written through their repositories, as a handoff
 * leaves them.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  TaskTracking,
  type TaskPriority,
  type TrackingRun,
  type WorkflowDefinition,
} from "@hercule/contract";
import { inTransaction } from "../db/testing";
import { completeSetup, get, withServer, type ServerHarness } from "../http/testing";
import { runRepository, type NewRun, type RunOutcome } from "../runs/repository";
import { taskRepository } from "./repository";

const SIGNAL = "0199e0e7-0005-7000-8000-000000000001";
const AT = "2026-10-20T10:00:00.000Z";
const minute = (n: number) => `2026-10-20T11:${String(n).padStart(2, "0")}:00.000Z`;

const PLAN = { name: "Implement", steps: [] } as unknown as WorkflowDefinition;
const SIGNALLED_PLAN = {
  name: "Review PR",
  steps: [],
  triggers: [
    {
      id: "pr_checks",
      kind: "signal",
      on: { kind: "github.checks.completed" },
      correlation: { event: "event.payload.pr", run: "inputs.pr" },
    },
  ],
} as unknown as WorkflowDefinition;

/** Writes a Task in progress with one handoff entry, and returns its id. */
const insertTrackedTask = async (
  { sql }: ServerHarness,
  title: string,
  fields: {
    readonly status?: "in-progress" | "done" | "open";
    readonly priority?: TaskPriority;
  } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tasks = yield* taskRepository;
      const task = yield* tasks.insert({
        title,
        description: "",
        status: fields.status ?? "in-progress",
        priority: fields.priority ?? "normal",
        labels: [],
        projectId: undefined,
        provenance: [{ signalId: SIGNAL, runId: "0199e0e7-0006-7000-8000-000000000001" }],
        at: AT,
        actor: "user",
      });
      return task.id;
    }).pipe(inTransaction, Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
  );

interface RunToWrite {
  readonly plan?: WorkflowDefinition;
  readonly at: string;
  readonly ending?: RunOutcome;
  /** Moves the run to running, with its step finished, so it waits on its signal triggers. */
  readonly waiting?: boolean;
  /** The error of the step a run failed at. */
  readonly stepError?: string;
}

/** Writes a run of the Task and ends it as `ending` says. Returns the run's id. */
const insertRun = async ({ sql }: ServerHarness, taskId: string, run: RunToWrite) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runs = yield* runRepository;
      const newRun: NewRun = {
        workflowId: null,
        plan: run.plan ?? PLAN,
        inputs: {},
        origin: { kind: "manual", actor: "user" },
        entryStepIds: ["work"],
        taskId,
      };
      const id = yield* runs.insert(newRun, run.at);
      const step = { stepId: "work", iteration: 1 };
      // Every run but one that was cancelled, or failed to validate, had started.
      const neverStarted =
        run.ending === undefined ||
        run.ending.status === "cancelled" ||
        (run.ending.status === "failed" && run.ending.failureReason === "validation-error");
      if (run.waiting === true || run.stepError !== undefined || !neverStarted) {
        yield* runs.start(id, run.at);
      }
      if (run.waiting === true) {
        yield* runs.startStep(id, step, undefined, run.at);
        yield* runs.finishStep(
          id,
          step,
          { status: "completed", output: {} },
          { startedAt: run.at, finishedAt: run.at },
        );
      }
      if (run.stepError !== undefined) {
        yield* runs.startStep(id, step, undefined, run.at);
        yield* runs.finishStep(
          id,
          step,
          { status: "failed", error: { code: "denied", message: run.stepError } },
          { startedAt: run.at, finishedAt: run.at },
        );
      }
      if (run.ending !== undefined) yield* runs.finish(id, run.ending, run.at);
      return id;
    }).pipe(inTransaction, Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
  );

const COMPLETED: RunOutcome = { status: "completed" };

const readTracking = async (base: string, token: string) => {
  const response = await get(base, "/api/v1/tasks/tracking", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return Schema.decodeUnknownSync(TaskTracking)(await response.json());
};

describe("task.queryTracking", () => {
  it("gives a Task with a long history one newest run and one newest live run, with why the newest failed", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const taskId = await insertTrackedTask(harness, "Retry failed webhooks");
      for (let n = 1; n <= 30; n++) {
        await insertRun(harness, taskId, { at: minute(n), ending: COMPLETED });
      }
      const live = await insertRun(harness, taskId, { at: minute(40) });
      const failed = await insertRun(harness, taskId, {
        at: minute(45),
        stepError: "permission denied on ops-db",
        ending: { status: "failed", failureReason: "step-failed", failedStepId: "work" },
      });

      const { rows } = await readTracking(harness.base, token);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        taskId,
        title: "Retry failed webhooks",
        handoffs: [{ signalId: SIGNAL, runId: "0199e0e7-0006-7000-8000-000000000001", at: AT }],
        latestRun: {
          id: failed,
          workflowName: "Implement",
          status: "failed",
          failureCause: "permission denied on ops-db",
          awaitedSignalIds: [],
        },
        latestLiveRun: { id: live, status: "pending" },
        liveRunIds: [live],
      });
    });
  });

  it("gives the ids of all a Task's live runs, newest first, when a second handoff started a run while the first still goes on", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const taskId = await insertTrackedTask(harness, "Two handoffs");
      const first = await insertRun(harness, taskId, { at: minute(1), waiting: true });
      await insertRun(harness, taskId, { at: minute(2), ending: COMPLETED });
      const second = await insertRun(harness, taskId, { at: minute(3) });
      const other = await insertTrackedTask(harness, "No live run");
      await insertRun(harness, other, { at: minute(1), ending: COMPLETED });

      const { rows } = await readTracking(harness.base, token);

      const byTitle = new Map(rows.map((row) => [row.title, row]));
      expect(byTitle.get("Two handoffs")).toMatchObject({
        latestLiveRun: { id: second },
        liveRunIds: [second, first],
      });
      expect(byTitle.get("No live run")?.liveRunIds).toEqual([]);
    });
  });

  it("says why a run failed in the words of the run page: a validation message, else the failure reason in plain words", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const validation = await insertTrackedTask(harness, "validation");
      await insertRun(harness, validation, {
        at: minute(1),
        ending: {
          status: "failed",
          failureReason: "validation-error",
          failureMessage: "the inputs do not fit",
        },
      });
      const workspace = await insertTrackedTask(harness, "workspace");
      await insertRun(harness, workspace, {
        at: minute(1),
        ending: { status: "failed", failureReason: "workspace-failed" },
      });

      const { rows } = await readTracking(harness.base, token);

      const causes = Object.fromEntries(rows.map((row) => [row.title, row.latestRun.failureCause]));
      expect(causes).toEqual({
        validation: "the inputs do not fit",
        workspace: "workspace failed",
      });
    });
  });

  it("gives the state inputs of finished, stopped and waiting runs, and no failure cause for a run that did not fail", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const finished = await insertTrackedTask(harness, "finished");
      await insertRun(harness, finished, { at: minute(1), ending: COMPLETED });
      const stopped = await insertTrackedTask(harness, "stopped");
      await insertRun(harness, stopped, {
        at: minute(1),
        ending: { status: "cancelled", keepWorkspace: false },
      });
      const waiting = await insertTrackedTask(harness, "waiting");
      await insertRun(harness, waiting, { at: minute(1), plan: SIGNALLED_PLAN, waiting: true });

      const { rows } = await readTracking(harness.base, token);

      const byTitle = new Map<string, TrackingRun>(rows.map((row) => [row.title, row.latestRun]));
      expect(byTitle.get("finished")).toMatchObject({
        status: "completed",
        startedAt: minute(1),
        finishedAt: minute(1),
      });
      expect(byTitle.get("stopped")).toMatchObject({ status: "cancelled", finishedAt: minute(1) });
      expect(byTitle.get("waiting")).toMatchObject({
        status: "running",
        awaitedSignalIds: ["pr_checks"],
      });
      for (const run of byTitle.values()) expect(run).not.toHaveProperty("failureCause");
      expect(rows.find((row) => row.title === "waiting")).toMatchObject({
        latestLiveRun: { status: "running" },
      });
    });
  });

  it("leaves out a Task that is done or deleted, one without a handoff, and one without a run", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const kept = await insertTrackedTask(harness, "kept");
      await insertRun(harness, kept, { at: minute(1), ending: COMPLETED });
      const done = await insertTrackedTask(harness, "done", { status: "done" });
      await insertRun(harness, done, { at: minute(1), ending: COMPLETED });
      const deleted = await insertTrackedTask(harness, "deleted");
      await insertRun(harness, deleted, { at: minute(1), ending: COMPLETED });
      await Effect.runPromise(
        Effect.flatMap(taskRepository, (tasks) => tasks.softDelete(deleted, AT)).pipe(
          inTransaction,
          Effect.provideService(SqlClient.SqlClient, harness.sql),
          Effect.orDie,
        ),
      );
      await insertTrackedTask(harness, "no run");
      const plain = await Effect.runPromise(
        Effect.flatMap(taskRepository, (tasks) =>
          tasks.insert({
            title: "no handoff",
            description: "",
            status: "in-progress",
            priority: "normal",
            labels: [],
            projectId: undefined,
            provenance: [],
            at: AT,
            actor: "user",
          }),
        ).pipe(
          inTransaction,
          Effect.provideService(SqlClient.SqlClient, harness.sql),
          Effect.orDie,
        ),
      );
      await insertRun(harness, plain.id, { at: minute(1), ending: COMPLETED });

      const { rows } = await readTracking(harness.base, token);

      expect(rows.map((row) => row.title)).toEqual(["kept"]);
    });
  });
});
