/**
 * Tests `GET /tasks/tracking`, `GET /tasks/:id/tracking` and `GET /tasks/legs` over a real
 * socket, against the real `TaskTrackingRuns` port: what a row holds for
 * Tasks whose runs are in each state, how a Task with a long history reads,
 * which Tasks are left out, and what the pane of one Task draws: its runs,
 * what the newest run's agent step produced, and the action step the run
 * ended on. The Tasks and runs are written through their repositories, as a
 * handoff leaves them.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  HandoffLegs,
  MAX_LEG_QUERY_RUNS,
  MAX_TRACKING_DETAIL_RUNS,
  MAX_TRACKING_FAILURE_CAUSE,
  MAX_TRACKING_OUTPUT_TEXT,
  MAX_TRACKING_STEP_NAME,
  TaskTracking,
  TrackingDetail,
  type TaskPriority,
  type TrackingRun,
  type WorkflowDefinition,
} from "@hercule/contract";
import { uuidFromString } from "../db";
import { inTransaction } from "../db/testing";
import { completeSetup, get, readErrorBody, withServer, type ServerHarness } from "../http/testing";
import { spawnThreadWithGrants, withAgentFleet } from "../sessions/testing";
import { runRepository, type NewRun, type RunOutcome } from "../runs/repository";
import { taskRepository } from "./repository";

const SIGNAL = "0199e0e7-0005-7000-8000-000000000001";

/**
 * The run a Task's handoff entry names until the Task's first run is written.
 * A real handoff starts the run in the same transaction, which these helpers
 * cannot, because they write the Task first.
 */
const HANDOFF_PLACEHOLDER_RUN = "0199e0e7-0006-7000-8000-000000000001";
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
        provenance: [{ signalId: SIGNAL, runId: HANDOFF_PLACEHOLDER_RUN }],
        at: AT,
        actor: "user",
      });
      return task.id;
    }).pipe(inTransaction, Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
  );

/**
 * Makes `runId` the run of the Task's handoff entry when the entry still names
 * the placeholder, so the first run a test writes for a Task is the run its
 * handoff started.
 */
const adoptHandoffRun = (taskId: string, runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE task_provenance SET run_id = ${uuidFromString(runId)}
      WHERE task_id = ${uuidFromString(taskId)}
        AND run_id = ${uuidFromString(HANDOFF_PLACEHOLDER_RUN)}`;
  });

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
      yield* adoptHandoffRun(taskId, id);
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
      const first = await insertRun(harness, taskId, { at: minute(1), ending: COMPLETED });
      for (let n = 2; n <= 30; n++) {
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
        handoffs: [{ signalId: SIGNAL, runId: first, at: AT }],
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

const SESSION_A = "0199e0e7-0007-7000-8000-00000000000a";
const SESSION_B = "0199e0e7-0007-7000-8000-00000000000b";
const ABSENT_ID = "0199e0e7-0004-7000-8000-0000000000ff";

/** A step of a run `insertRunWithSteps` writes, with the plan's definition of it and how it ended. */
interface StepToWrite {
  readonly id: string;
  readonly kind: "agent" | "action" | "text-generation";
  readonly name?: string;
  readonly action?: string;
  readonly outputSchema?: Record<string, unknown>;
  /** The session an agent step ran in. */
  readonly sessionId?: string;
  readonly output: Schema.Json;
  readonly finishedAt: string;
}

/**
 * Writes a run of the Task whose plan holds `steps`, completes each step in
 * the order given, and ends the run as `ending` says. Returns the run's id.
 */
const insertRunWithSteps = async (
  { sql }: ServerHarness,
  taskId: string,
  run: {
    readonly at: string;
    readonly steps: ReadonlyArray<StepToWrite>;
    readonly ending?: RunOutcome;
  },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runs = yield* runRepository;
      const plan = {
        name: "Implement",
        steps: run.steps.map((step) => ({
          id: step.id,
          kind: step.kind,
          ...(step.name === undefined ? {} : { name: step.name }),
          ...(step.action === undefined ? {} : { action: step.action }),
          ...(step.outputSchema === undefined ? {} : { outputSchema: step.outputSchema }),
        })),
      } as unknown as WorkflowDefinition;
      const id = yield* runs.insert(
        {
          workflowId: null,
          plan,
          inputs: {},
          origin: { kind: "manual", actor: "user" },
          entryStepIds: [run.steps[0]!.id],
          taskId,
        },
        run.at,
      );
      yield* adoptHandoffRun(taskId, id);
      yield* runs.start(id, run.at);
      for (const [index, step] of run.steps.entries()) {
        if (index > 0) yield* runs.insertSteps(id, [step.id], run.at);
        const record = { stepId: step.id, iteration: 1 };
        yield* runs.startStep(
          id,
          record,
          step.sessionId !== undefined
            ? { sessionId: step.sessionId }
            : step.kind === "action"
              ? { input: {}, checkoutBranch: undefined }
              : undefined,
          run.at,
        );
        yield* runs.finishStep(
          id,
          record,
          { status: "completed", output: step.output },
          { startedAt: run.at, finishedAt: step.finishedAt },
        );
      }
      if (run.ending !== undefined) yield* runs.finish(id, run.ending, run.at);
      return id;
    }).pipe(inTransaction, Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
  );

const readDetail = async (base: string, token: string, taskId: string) => {
  const response = await get(base, `/api/v1/tasks/${taskId}/tracking`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return Schema.decodeUnknownSync(TrackingDetail)(await response.json());
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", title: "Verdict" },
    blocking: { type: "boolean" },
    notes: { type: "array" },
  },
};

describe("task.readTracking", () => {
  it("lists a re-run Task's runs oldest first, each with its last agent session, and shapes the newest run's structured output", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const taskId = await insertTrackedTask(harness, "Review the PR");
      const first = await insertRunWithSteps(harness, taskId, {
        at: minute(1),
        steps: [
          {
            id: "review",
            kind: "agent",
            sessionId: SESSION_A,
            output: { text: "Needs work", exitStatus: "completed" },
            finishedAt: minute(2),
          },
        ],
        ending: COMPLETED,
      });
      const second = await insertRunWithSteps(harness, taskId, {
        at: minute(10),
        steps: [
          {
            id: "review",
            kind: "agent",
            name: "Review",
            sessionId: SESSION_B,
            outputSchema: REVIEW_SCHEMA,
            output: { notes: ["a", "b"], blocking: true, verdict: "Request changes" },
            finishedAt: minute(12),
          },
        ],
        ending: COMPLETED,
      });

      const detail = await readDetail(harness.base, token, taskId);

      expect(detail.firstHandoff).toEqual({
        signalId: SIGNAL,
        runId: first,
        at: AT,
        workflowName: "Implement",
      });
      expect(detail.runs.map((run) => [run.id, run.sessionId])).toEqual([
        [first, SESSION_A],
        [second, SESSION_B],
      ]);
      expect(detail.runs[1]).toMatchObject({ status: "completed", workflowName: "Implement" });
      expect(detail.output).toEqual({
        kind: "fields",
        stepName: "Review",
        sessionId: SESSION_B,
        fields: [
          { label: "Verdict", value: "Request changes" },
          { label: "blocking", value: true },
          { label: "notes", value: { items: 2 } },
        ],
      });
      expect(detail).not.toHaveProperty("endingActionStepName");
    });
  });

  it("gives a step with no output schema as text, cut when it is long, named by its id when it has no name", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const taskId = await insertTrackedTask(harness, "Write the notes");
      await insertRunWithSteps(harness, taskId, {
        at: minute(1),
        steps: [
          {
            id: "write-notes",
            kind: "agent",
            sessionId: SESSION_A,
            output: { text: "A sentence that goes on. ".repeat(500), exitStatus: "completed" },
            finishedAt: minute(2),
          },
        ],
        ending: COMPLETED,
      });

      const detail = await readDetail(harness.base, token, taskId);

      expect(detail.output).toMatchObject({
        kind: "text",
        stepName: "write-notes",
        sessionId: SESSION_A,
      });
      const text = (detail.output as { text: string }).text;
      expect(text.length).toBeLessThanOrEqual(MAX_TRACKING_OUTPUT_TEXT + 1);
      expect(text.endsWith("goes on.…")).toBe(true);
    });
  });

  it("names the action step a run ended on, by its name or else its action, beside the agent step's output", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const named = await insertTrackedTask(harness, "named");
      await insertRunWithSteps(harness, named, {
        at: minute(1),
        steps: [
          {
            id: "work",
            kind: "agent",
            sessionId: SESSION_A,
            output: { text: "Done" },
            finishedAt: minute(2),
          },
          {
            id: "open",
            kind: "action",
            name: "Open the pull request",
            action: "github/open-pr",
            output: {},
            finishedAt: minute(3),
          },
        ],
        ending: COMPLETED,
      });
      const unnamed = await insertTrackedTask(harness, "unnamed");
      await insertRunWithSteps(harness, unnamed, {
        at: minute(1),
        steps: [
          {
            id: "work",
            kind: "agent",
            sessionId: SESSION_A,
            output: { text: "Done" },
            finishedAt: minute(2),
          },
          {
            id: "open",
            kind: "action",
            action: "github/open-pr",
            output: {},
            finishedAt: minute(3),
          },
        ],
        ending: COMPLETED,
      });
      const agentLast = await insertTrackedTask(harness, "agent last");
      await insertRunWithSteps(harness, agentLast, {
        at: minute(1),
        steps: [
          {
            id: "open",
            kind: "action",
            action: "github/open-pr",
            output: {},
            finishedAt: minute(2),
          },
          {
            id: "work",
            kind: "agent",
            sessionId: SESSION_A,
            output: { text: "Done" },
            finishedAt: minute(3),
          },
        ],
        ending: COMPLETED,
      });

      expect(await readDetail(harness.base, token, named)).toMatchObject({
        output: { kind: "text", text: "Done" },
        endingActionStepName: "Open the pull request",
      });
      expect(await readDetail(harness.base, token, unnamed)).toMatchObject({
        endingActionStepName: "github/open-pr",
      });
      expect(await readDetail(harness.base, token, agentLast)).not.toHaveProperty(
        "endingActionStepName",
      );
    });
  });

  it("names no ending action step for a run that is live or failed, whatever step it completed last", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const steps = [
        {
          id: "work",
          kind: "agent" as const,
          sessionId: SESSION_A,
          output: { text: "Done" },
          finishedAt: minute(2),
        },
        {
          id: "open",
          kind: "action" as const,
          name: "Open the pull request",
          action: "github/open-pr",
          output: {},
          finishedAt: minute(3),
        },
      ];
      const running = await insertTrackedTask(harness, "running");
      await insertRunWithSteps(harness, running, { at: minute(1), steps });
      const failed = await insertTrackedTask(harness, "failed");
      await insertRunWithSteps(harness, failed, {
        at: minute(1),
        steps,
        ending: { status: "failed", failureReason: "step-failed", failedStepId: "next" },
      });

      for (const taskId of [running, failed]) {
        const detail = await readDetail(harness.base, token, taskId);
        expect(detail.output).toMatchObject({ kind: "text", text: "Done" });
        expect(detail).not.toHaveProperty("endingActionStepName");
      }
    });
  });

  it("does not take a text generation step for an agent step", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const taskId = await insertTrackedTask(harness, "screened");
      await insertRunWithSteps(harness, taskId, {
        at: minute(1),
        steps: [
          {
            id: "screen",
            kind: "text-generation",
            output: { text: "Not an agent" },
            finishedAt: minute(2),
          },
        ],
        ending: COMPLETED,
      });

      const detail = await readDetail(harness.base, token, taskId);

      expect(detail).not.toHaveProperty("output");
      expect(detail).not.toHaveProperty("endingActionStepName");
    });
  });

  it("gives a failed run's cause, and keeps the output of the agent step that completed before the failure", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const failedFirst = await insertTrackedTask(harness, "fails at once");
      await insertRun(harness, failedFirst, {
        at: minute(1),
        stepError: "permission denied on ops-db",
        ending: { status: "failed", failureReason: "step-failed", failedStepId: "work" },
      });
      const failedLater = await insertTrackedTask(harness, "fails later");
      const run = await insertRunWithSteps(harness, failedLater, {
        at: minute(1),
        steps: [
          {
            id: "work",
            kind: "agent",
            sessionId: SESSION_A,
            output: { text: "Half done" },
            finishedAt: minute(2),
          },
        ],
        ending: { status: "failed", failureReason: "controller-error" },
      });

      const first = await readDetail(harness.base, token, failedFirst);
      const later = await readDetail(harness.base, token, failedLater);

      expect(first.runs).toHaveLength(1);
      expect(first.runs[0]).toMatchObject({
        status: "failed",
        failureCause: "permission denied on ops-db",
      });
      expect(first.runs[0]).not.toHaveProperty("sessionId");
      expect(first).not.toHaveProperty("output");
      expect(later.runs[0]).toMatchObject({ id: run, status: "failed", sessionId: SESSION_A });
      expect(later.output).toMatchObject({ kind: "text", text: "Half done" });
    });
  });

  it("cuts the names of the agent step and the ending action step, and the cause of a failed run, to their limits", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const completed = await insertTrackedTask(harness, "long names");
      await insertRunWithSteps(harness, completed, {
        at: minute(1),
        steps: [
          {
            id: "work",
            kind: "agent",
            name: "Review the change ".repeat(5000),
            sessionId: SESSION_A,
            output: { text: "Done" },
            finishedAt: minute(2),
          },
          {
            id: "open",
            kind: "action",
            name: "Open the pull request ".repeat(5000),
            action: "github/open-pr",
            output: {},
            finishedAt: minute(3),
          },
        ],
        ending: COMPLETED,
      });
      const failed = await insertTrackedTask(harness, "long cause");
      await insertRun(harness, failed, {
        at: minute(1),
        stepError: "permission denied on ops-db ".repeat(5000),
        ending: { status: "failed", failureReason: "step-failed", failedStepId: "work" },
      });

      const detail = await readDetail(harness.base, token, completed);
      const failedDetail = await readDetail(harness.base, token, failed);
      const { rows } = await readTracking(harness.base, token);

      const stepName = (detail.output as { stepName: string }).stepName;
      expect(stepName.length).toBeLessThanOrEqual(MAX_TRACKING_STEP_NAME);
      expect(stepName.startsWith("Review the change")).toBe(true);
      expect(stepName.endsWith("…")).toBe(true);
      const ending = detail.endingActionStepName!;
      expect(ending.length).toBeLessThanOrEqual(MAX_TRACKING_STEP_NAME);
      expect(ending.startsWith("Open the pull request")).toBe(true);
      expect(ending.endsWith("…")).toBe(true);
      const cause = failedDetail.runs[0]!.failureCause!;
      expect(cause.length).toBeLessThanOrEqual(MAX_TRACKING_FAILURE_CAUSE);
      expect(cause.endsWith("…")).toBe(true);
      const rowCause = rows.find((row) => row.title === "long cause")!.latestRun.failureCause!;
      expect(rowCause).toBe(cause);
    });
  });

  it("lists only the newest runs of a Task with a long history, oldest first", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const taskId = await insertTrackedTask(harness, "Retry failed webhooks");
      const ids: Array<string> = [];
      for (let n = 1; n <= MAX_TRACKING_DETAIL_RUNS + 5; n++) {
        ids.push(await insertRun(harness, taskId, { at: minute(n), ending: COMPLETED }));
      }

      const detail = await readDetail(harness.base, token, taskId);

      expect(detail.runs.map((run) => run.id)).toEqual(ids.slice(-MAX_TRACKING_DETAIL_RUNS));
    });
  });

  it("fails with not_found for a Task that does not exist, one that was never handed off, and one that was deleted", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
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
      const deleted = await insertTrackedTask(harness, "deleted");
      await Effect.runPromise(
        Effect.flatMap(taskRepository, (tasks) => tasks.softDelete(deleted, AT)).pipe(
          inTransaction,
          Effect.provideService(SqlClient.SqlClient, harness.sql),
          Effect.orDie,
        ),
      );

      for (const id of [ABSENT_ID, plain.id, deleted]) {
        const response = await get(harness.base, `/api/v1/tasks/${id}/tracking`, token);
        const refused = await readErrorBody(response);
        expect(response.status, refused.text).toBe(404);
        expect(refused.code).toBe("not_found");
      }
    });
  });

  it("refuses a caller with no token", async () => {
    await withServer(async (harness) => {
      await completeSetup(harness.base);
      const response = await get(harness.base, `/api/v1/tasks/${ABSENT_ID}/tracking`);

      expect(response.status).toBe(401);
    });
  });

  it("refuses a session that holds the task read grant but not the run read grant, and names the grant", async () => {
    await withAgentFleet(async (arranged) => {
      const taskId = await insertTrackedTask(arranged.harness, "Review the PR");
      const agent = await spawnThreadWithGrants(arranged, "task-readers", ["task.read"]);

      const response = await get(
        arranged.harness.base,
        `/api/v1/tasks/${taskId}/tracking`,
        agent.token,
      );

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(403);
      expect(refused.code).toBe("forbidden");
      expect(refused.grant).toBe("run.read");
    });
  });

  it("refuses a session with no task read grant, and names the grant", async () => {
    await withAgentFleet(async (arranged) => {
      const taskId = await insertTrackedTask(arranged.harness, "Review the PR");
      const agent = await spawnThreadWithGrants(arranged, "run-readers", ["run.read"]);

      const response = await get(
        arranged.harness.base,
        `/api/v1/tasks/${taskId}/tracking`,
        agent.token,
      );

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(403);
      expect(refused.grant).toBe("task.read");
    });
  });
});

describe("task.queryLegs", () => {
  /** Writes a run that re-runs `original` on the Task, and returns its id. */
  const insertRerun = async (
    { sql }: ServerHarness,
    taskId: string,
    original: string,
    at: string,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        return yield* runs.insert(
          {
            workflowId: null,
            plan: PLAN,
            inputs: {},
            origin: { kind: "manual", actor: "user" },
            entryStepIds: ["work"],
            originalRunId: original,
            taskId,
          },
          at,
        );
      }).pipe(inTransaction, Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
    );

  const readLegs = async (base: string, token: string, query: string) => {
    const response = await get(base, `/api/v1/tasks/legs${query}`, token);
    expect(response.status, await response.clone().text()).toBe(200);
    return Schema.decodeUnknownSync(HandoffLegs)(await response.json());
  };

  it("reads one run id as one id and repeated run ids as several, in the order given, and leaves out an id that is no handoff's run", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const firstTask = await insertTrackedTask(harness, "Retry failed webhooks");
      const first = await insertRun(harness, firstTask, { at: minute(1), ending: COMPLETED });
      const rerun = await insertRerun(harness, firstTask, first, minute(2));
      const secondTask = await insertTrackedTask(harness, "Review the PR");
      const second = await insertRun(harness, secondTask, { at: minute(3), ending: COMPLETED });

      const one = await readLegs(harness.base, token, `?runIds=${first}`);
      const several = await readLegs(
        harness.base,
        token,
        `?runIds=${second}&runIds=${rerun}&runIds=${first}`,
      );

      expect(one.legs).toHaveLength(1);
      expect(one.legs[0]).toMatchObject({
        runId: first,
        signalId: SIGNAL,
        taskId: firstTask,
        taskStatus: "in-progress",
        workflowName: "Implement",
        rerunCount: 1,
        latestRun: { id: rerun, status: "pending" },
        liveRunIds: [rerun],
      });
      // The re-run is no handoff's run, so only the two handoffs' runs are left.
      expect(several.legs.map((leg) => leg.runId)).toEqual([second, first]);
    });
  });

  it("refuses no run ids, and more run ids than a page holds, as validation errors", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const ids = Array.from(
        { length: MAX_LEG_QUERY_RUNS + 1 },
        (_, n) => `0199e0e7-0006-7000-8000-${String(n).padStart(12, "0")}`,
      );

      const none = await get(harness.base, "/api/v1/tasks/legs", token);
      const tooMany = await get(
        harness.base,
        `/api/v1/tasks/legs?${ids.map((id) => `runIds=${id}`).join("&")}`,
        token,
      );

      expect(none.status, await none.clone().text()).toBe(400);
      expect(tooMany.status, await tooMany.clone().text()).toBe(400);
    });
  });

  it("refuses a session that holds the task read grant but not the run read grant, and names the grant", async () => {
    await withAgentFleet(async (arranged) => {
      const agent = await spawnThreadWithGrants(arranged, "task-readers", ["task.read"]);

      const response = await get(
        arranged.harness.base,
        `/api/v1/tasks/legs?runIds=${ABSENT_ID}`,
        agent.token,
      );

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(403);
      expect(refused.grant).toBe("run.read");
    });
  });
});
