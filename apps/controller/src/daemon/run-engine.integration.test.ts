/**
 * Integration tests for the run engine carrying out a run, driven over HTTP
 * against a real controller: a workflow is saved, `POST /workflows/{id}/run`
 * starts a run, and `GET /runs/{id}` reads it back while the engine carries
 * out its steps.
 *
 * The run request returns without waiting for the steps, so every test polls
 * the run until its status is final. `waitForRunToFinish` compares each read with
 * the one before it, so a status that moves backwards fails the test, and
 * checks the final read against the rules every finished run keeps.
 *
 * The tests for a restart write the rows of a half-finished run straight into
 * the database, because no request can stop the engine between two steps.
 * They then run the controller's boot again on the same database, as a
 * restart does.
 *
 * No runner is connected: action steps run on the controller.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Task } from "@hercule/contract";
import {
  collectMessages,
  expectHeld,
  fetchTicket,
  onSocket,
  post,
  waitWithin,
  type ServerHarness,
} from "../http/testing";
import { buildActionPlugin, NOTE_APPEND_ACTION, NOTE_APPEND_ACTION_ID } from "../plugins/testing";
import { WAIT_DEADLINE_MS } from "../sessions/testing";
import { ABSENT_ID, createWorkflowOrFail, withSetUpController } from "../workflows/testing";
import {
  buildCreateStep,
  FILE_AND_START_DEFINITION,
  findRecords,
  listTasks,
  readTask,
  runEffect,
  startRun,
  waitForRunToFinish,
} from "./testing";

/** Long enough for a run that waits its full deadline. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 10_000 });

/* ------------------------------------------------------------------------ */
/* Executing built-in actions.                                               */
/* ------------------------------------------------------------------------ */

describe("a run of built-in actions", () => {
  it("creates a task, then updates it, acting as the run", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: FILE_AND_START_DEFINITION,
      });

      const runId = await startRun(base, token, workflow.id, { inputs: { title: "Fix login" } });
      const run = await waitForRunToFinish(base, token, runId);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(run.startedAt).toBeDefined();
      expect(run.steps.map((record) => [record.stepId, record.iteration, record.status])).toEqual([
        ["create", 1, "completed"],
        ["update", 1, "completed"],
      ]);
      for (const record of run.steps) {
        expect(record.startedAt, record.stepId).toBeDefined();
        expect(record.finishedAt, record.stepId).toBeDefined();
      }

      // The first step's output is the task as it was created, before the
      // second step changed it.
      const created = run.steps[0]!.output as Task;
      expect(created).toMatchObject({
        title: "Fix login",
        description: "Filed by a run.",
        status: "open",
      });

      const task = await readTask(base, token, created.id);
      expect(task.title).toBe("Fix login");
      expect(task.status).toBe("in-progress");
      expect(task.provenance.map((entry) => [entry.ref, entry.actor])).toEqual([
        ["test:ticket:79", `run:${runId}`],
      ]);
      expect((await harness.audit("task.created")).map((entry) => entry.actor)).toEqual([
        `run:${runId}`,
      ]);
      expect((await harness.audit("task.updated")).map((entry) => entry.actor)).toEqual([
        `run:${runId}`,
      ]);
    });
  });
});

describe("a run subscription", () => {
  it("receives the run's id when the run is created and as its steps change", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: FILE_AND_START_DEFINITION,
      });
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const pushes = yield* collectMessages(client, { topic: "run" });
          yield* Effect.promise(() => expectHeld(harness.live, 1, "run"));

          const runId = yield* Effect.promise(() =>
            startRun(base, token, workflow.id, { inputs: { title: "Watched" } }),
          );
          yield* Effect.promise(() => waitForRunToFinish(base, token, runId));
          const seen = (kind: string): boolean =>
            pushes.received.some(
              (push) =>
                push._tag === "invalidate" && push.kind === kind && push.ids.includes(runId),
            );
          expect(yield* Effect.promise(() => waitWithin(1000, () => seen("updated")))).toBe(true);
          expect(seen("created")).toBe(true);
          for (const push of pushes.received) {
            expect(push).toMatchObject({ _tag: "invalidate", ids: [runId] });
          }
        }),
      );
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Failures.                                                                 */
/* ------------------------------------------------------------------------ */

describe("a run whose step fails", () => {
  it("fails the step with not_found when task.update names a task that does not exist, and starts no later step", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Update a missing task",
          steps: [
            {
              id: "update",
              kind: "action",
              action: "task.update",
              params: { taskId: ABSENT_ID, status: "done" },
            },
            buildCreateStep("after"),
          ],
          edges: [{ from: "update", to: "after" }],
        },
      });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      expect(run.status, JSON.stringify(run)).toBe("failed");
      expect(run.failureReason).toBe("step-failed");
      expect(run.failedStepId).toBe("update");
      const [update] = findRecords(run, "update");
      expect(update?.status).toBe("failed");
      expect(update?.error?.code).toBe("not_found");
      expect(update?.error?.message).toMatch(/\S/);
      expect(findRecords(run, "after").filter((record) => record.startedAt !== undefined)).toEqual(
        [],
      );
      expect(await listTasks(base, token)).toEqual([]);
    });
  });

  it("fails the step with validation when the rendered params fail the action's input schema, and starts no later step", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Bad priority",
          inputs: [{ name: "priority", schema: { type: "string" }, required: true }],
          steps: [
            {
              id: "create",
              kind: "action",
              action: "task.create",
              params: { title: "A task", description: "", priority: "{{ inputs.priority }}" },
            },
            buildCreateStep("after"),
          ],
          edges: [{ from: "create", to: "after" }],
        },
      });

      // The input's schema accepts any string, but a task's priority must be
      // one of four words, so the rendered params fail task.create's schema.
      const runId = await startRun(base, token, workflow.id, { inputs: { priority: "someday" } });
      const run = await waitForRunToFinish(base, token, runId);

      expect(run.status, JSON.stringify(run)).toBe("failed");
      expect(run.failureReason).toBe("step-failed");
      expect(run.failedStepId).toBe("create");
      const [create] = findRecords(run, "create");
      expect(create?.status).toBe("failed");
      expect(create?.error?.code).toBe("validation");
      expect(create?.error?.message).toMatch(/\S/);
      expect(findRecords(run, "after").filter((record) => record.startedAt !== undefined)).toEqual(
        [],
      );
      expect(await listTasks(base, token)).toEqual([]);
    });
  });

  it("fails the run with expression-error when a template reads a step output that does not exist", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Missing output field",
          steps: [
            buildCreateStep("create"),
            {
              id: "update",
              kind: "action",
              action: "task.update",
              params: { taskId: "{{ steps.create.output.no_such_field }}", status: "done" },
            },
          ],
          edges: [{ from: "create", to: "update" }],
        },
      });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      expect(run.status, JSON.stringify(run)).toBe("failed");
      expect(run.failureReason).toBe("expression-error");
      expect(run.failedStepId).toBe("update");
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Resuming after a restart.                                                 */
/* ------------------------------------------------------------------------ */

/** The ids of the runs the restart tests insert. Each is a UUIDv7, like every id the controller mints. */
const RESUMED_RUN_ID = "0199f0b7-0000-7000-8000-00000000a001";
const INTERRUPTED_RUN_ID = "0199f0b7-0000-7000-8000-00000000a002";
const REPEATED_RUN_ID = "0199f0b7-0000-7000-8000-00000000a003";
const BROKEN_RUN_ID = "0199f0b7-0000-7000-8000-00000000a004";

/** Inserts a run row with the status `running`, as the engine leaves one between two steps. */
const insertRunningRun = (
  harness: ServerHarness,
  fields: {
    readonly id: string;
    readonly workflowId: string;
    readonly plan: unknown;
    readonly inputs: Record<string, unknown>;
    readonly at: string;
  },
) =>
  runEffect(
    harness.sql`
      INSERT INTO runs (id, workflow_id, plan, inputs, origin, status, created_at, started_at)
      VALUES
        (unhex(replace(${fields.id}, '-', '')),
         unhex(replace(${fields.workflowId}, '-', '')),
         ${JSON.stringify(fields.plan)}, ${JSON.stringify(fields.inputs)},
         ${JSON.stringify({ kind: "manual", actor: "user" })}, 'running', ${fields.at}, ${fields.at})`,
  );

describe("a run interrupted by a restart", () => {
  it("continues with its next step when the controller boots again, and completes", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: FILE_AND_START_DEFINITION,
      });
      // The task the first step created before the engine stopped.
      const created = await post(
        base,
        "/api/v1/tasks",
        { title: "Fix login", description: "Filed by a run." },
        token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const task = (await created.json()) as Task;

      // The rows a run has when the engine stopped right after the first
      // step committed: that step completed with its output, and the record
      // of the step after it waiting.
      const at = new Date().toISOString();
      await insertRunningRun(harness, {
        id: RESUMED_RUN_ID,
        workflowId: workflow.id,
        plan: FILE_AND_START_DEFINITION,
        inputs: { title: "Fix login" },
        at,
      });
      await runEffect(
        harness.sql`
          INSERT INTO run_steps
            (run_id, step_id, iteration, status, output, created_at, started_at, finished_at)
          VALUES
            (unhex(replace(${RESUMED_RUN_ID}, '-', '')), 'create', 1, 'completed',
             ${JSON.stringify(task)}, ${at}, ${at}, ${at})`,
      );
      await runEffect(
        harness.sql`
          INSERT INTO run_steps (run_id, step_id, iteration, status, created_at)
          VALUES (unhex(replace(${RESUMED_RUN_ID}, '-', '')), 'update', 1, 'pending', ${at})`,
      );

      await harness.reboot();
      const run = await waitForRunToFinish(base, token, RESUMED_RUN_ID);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(run.steps.map((record) => [record.stepId, record.status])).toEqual([
        ["create", "completed"],
        ["update", "completed"],
      ]);
      expect(run.steps[0]!.output).toEqual(task);
      expect((await readTask(base, token, task.id)).status).toBe("in-progress");
    });
  });

  it("executes a built-in action step that was running again, because its effect never committed", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: FILE_AND_START_DEFINITION,
      });

      // The rows a run has when the controller stopped after the first step
      // was marked running and before its action's transaction committed.
      const at = new Date().toISOString();
      await insertRunningRun(harness, {
        id: REPEATED_RUN_ID,
        workflowId: workflow.id,
        plan: FILE_AND_START_DEFINITION,
        inputs: { title: "Fix login" },
        at,
      });
      await runEffect(
        harness.sql`
          INSERT INTO run_steps (run_id, step_id, iteration, status, created_at, started_at)
          VALUES (unhex(replace(${REPEATED_RUN_ID}, '-', '')), 'create', 1, 'running', ${at}, ${at})`,
      );

      await harness.reboot();
      const run = await waitForRunToFinish(base, token, REPEATED_RUN_ID);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(run.steps.map((record) => [record.stepId, record.status])).toEqual([
        ["create", "completed"],
        ["update", "completed"],
      ]);
      expect((await listTasks(base, token)).map((task) => task.title)).toEqual(["Fix login"]);
    });
  });

  it("fails a run at its current step with unexpected when executing it fails for a reason of its own", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: FILE_AND_START_DEFINITION,
      });

      // A step record whose step is not in the plan: no request can make
      // one, so it stands in for a bug in executing the run.
      const at = new Date().toISOString();
      await insertRunningRun(harness, {
        id: BROKEN_RUN_ID,
        workflowId: workflow.id,
        plan: FILE_AND_START_DEFINITION,
        inputs: { title: "Fix login" },
        at,
      });
      await runEffect(
        harness.sql`
          INSERT INTO run_steps (run_id, step_id, iteration, status, created_at)
          VALUES (unhex(replace(${BROKEN_RUN_ID}, '-', '')), 'ghost', 1, 'pending', ${at})`,
      );

      await harness.reboot();
      const run = await waitForRunToFinish(base, token, BROKEN_RUN_ID);

      expect(run.status, JSON.stringify(run)).toBe("failed");
      expect(run.failureReason).toBe("step-failed");
      expect(run.failedStepId).toBe("ghost");
      expect(run.steps[0]?.error?.code).toBe("unexpected");
    });
  });

  it("fails a plugin action step that was running with interrupted, and does not run it again", async () => {
    let executions = 0;
    const countingNotesPlugin = buildActionPlugin("notes", {
      ...NOTE_APPEND_ACTION,
      execute: () =>
        Effect.sync(() => {
          executions += 1;
          return { noteId: "note-1" };
        }),
    });

    await withSetUpController(
      async ({ harness, base, token }) => {
        const definition = {
          name: "Append a note",
          steps: [
            { id: "note", kind: "action", action: NOTE_APPEND_ACTION_ID, params: { text: "hi" } },
          ],
        };
        const workflow = await createWorkflowOrFail(base, token, { definition });

        // The rows a run has when the controller stopped while the plugin's
        // action was running: its step record is `running`, and nothing
        // records whether the action took effect.
        const at = new Date().toISOString();
        await insertRunningRun(harness, {
          id: INTERRUPTED_RUN_ID,
          workflowId: workflow.id,
          plan: definition,
          inputs: {},
          at,
        });
        await runEffect(
          harness.sql`
            INSERT INTO run_steps (run_id, step_id, iteration, status, created_at, started_at)
            VALUES (unhex(replace(${INTERRUPTED_RUN_ID}, '-', '')), 'note', 1, 'running', ${at}, ${at})`,
        );

        await harness.reboot();
        const run = await waitForRunToFinish(base, token, INTERRUPTED_RUN_ID);

        expect(run.status, JSON.stringify(run)).toBe("failed");
        expect(run.failureReason).toBe("step-failed");
        expect(run.failedStepId).toBe("note");
        expect(run.steps).toHaveLength(1);
        expect(run.steps[0]!.status).toBe("failed");
        expect(run.steps[0]!.error?.code).toBe("interrupted");
        expect(run.steps[0]!.error?.message).toMatch(/\S/);
        expect(executions).toBe(0);
      },
      [countingNotesPlugin],
    );
  });
});
