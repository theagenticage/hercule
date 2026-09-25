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
import { Effect, Schema } from "effect";
import { ActionError, type WorkflowActionContribution } from "@hercule/plugin-host";
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
  expectRefusedAt,
  FILE_AND_START_DEFINITION,
  findStepRecords,
  listTasks,
  readTask,
  requestRun,
  startRun,
  waitForRunToFinish,
  expectStatus,
} from "./testing";
import { runEffect } from "../daemon/testing";

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
      expect(expectStatus(run, "completed").startedAt).toBeDefined();
      expect(run.steps.map((record) => [record.stepId, record.iteration, record.status])).toEqual([
        ["create", 1, "completed"],
        ["update", 1, "completed"],
      ]);
      for (const record of run.steps) {
        const completed = expectStatus(record, "completed");
        expect(completed.startedAt, record.stepId).toBeDefined();
        expect(completed.finishedAt, record.stepId).toBeDefined();
      }

      // The first step's output is the task as it was created, before the
      // second step changed it.
      const created = expectStatus(run.steps[0], "completed").output as Task;
      expect(created).toMatchObject({
        title: "Fix login",
        description: "Filed by a run.",
        status: "open",
      });

      const task = await readTask(base, token, created.id);
      expect(task.title).toBe("Fix login");
      expect(task.status).toBe("in-progress");
      expect(task.provenance.map((entry) => [entry.ref, entry.runId, entry.actor])).toEqual([
        ["test:ticket:79", undefined, `run:${runId}`],
        [undefined, runId, `run:${runId}`],
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
/* Executing a plugin's action.                                              */
/* ------------------------------------------------------------------------ */

/** A workflow whose one step calls the notes plugin's action, then files a task. */
const NOTE_THEN_TASK_DEFINITION = {
  name: "Append a note, then file a task",
  steps: [
    { id: "note", kind: "action", action: NOTE_APPEND_ACTION_ID, params: { text: "hi" } },
    {
      id: "create",
      kind: "action",
      action: "task.create",
      params: { title: "Note {{ steps.note.output.noteId }}", description: "" },
    },
  ],
  edges: [{ from: "note", to: "create" }],
};

/** Runs `NOTE_THEN_TASK_DEFINITION` with the notes action executing as `execute`, and returns the finished run. */
const runNoteAction = async (
  execute: WorkflowActionContribution["execute"],
  check: (
    run: Awaited<ReturnType<typeof waitForRunToFinish>>,
    base: string,
    token: string,
  ) => Promise<void>,
): Promise<void> =>
  withSetUpController(
    async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: NOTE_THEN_TASK_DEFINITION,
      });
      await check(
        await waitForRunToFinish(base, token, await startRun(base, token, workflow.id)),
        base,
        token,
      );
    },
    [buildActionPlugin("notes", { ...NOTE_APPEND_ACTION, execute })],
  );

describe("a run of a plugin's action", () => {
  it("calls the action with the rendered params and the run, and the next step reads its output", async () => {
    const calls: Array<{ input: unknown; run: unknown }> = [];
    await runNoteAction(
      (input, context) =>
        Effect.sync(() => {
          calls.push({ input, run: context.run });
          return { noteId: "n-7" };
        }),
      async (run, base, token) => {
        expect(run.status, JSON.stringify(run)).toBe("completed");
        expect(expectStatus(findStepRecords(run, "note")[0], "completed").output).toEqual({
          noteId: "n-7",
        });
        expect(calls).toEqual([{ input: { text: "hi" }, run: { runId: run.id, stepId: "note" } }]);
        expect((await listTasks(base, token)).map((task) => task.title)).toEqual(["Note n-7"]);
      },
    );
  });

  it("fails the step with the code and message of the action's ActionError", async () => {
    await runNoteAction(
      () => Effect.fail(new ActionError({ code: "rate_limited", message: "Too many notes." })),
      async (run, base, token) => {
        expect(run.status, JSON.stringify(run)).toBe("failed");
        expect(expectStatus(run, "failed").failureReason).toBe("step-failed");
        expect(expectStatus(run, "failed").failedStepId).toBe("note");
        expect(expectStatus(findStepRecords(run, "note")[0], "failed").error).toEqual({
          code: "rate_limited",
          message: "Too many notes.",
        });
        expect(findStepRecords(run, "create")).toEqual([]);
        expect(await listTasks(base, token)).toEqual([]);
      },
    );
  });

  it("fails the step with unexpected when the action throws, or returns a value its output schema refuses", async () => {
    for (const execute of [
      () =>
        Effect.sync((): unknown => {
          throw new Error("the plugin broke");
        }),
      () => Effect.succeed({ noteId: 7 }),
    ] as ReadonlyArray<WorkflowActionContribution["execute"]>) {
      await runNoteAction(execute, async (run, base, token) => {
        expect(run.status, JSON.stringify(run)).toBe("failed");
        expect(expectStatus(run, "failed").failedStepId).toBe("note");
        expect(expectStatus(findStepRecords(run, "note")[0], "failed").error.code).toBe(
          "unexpected",
        );
        expect(findStepRecords(run, "create")).toEqual([]);
        expect(await listTasks(base, token)).toEqual([]);
      });
    }
  });

  it("is refused at start when the action acts through a Connection", async () => {
    const connectionAction = buildActionPlugin("notes", {
      ...NOTE_APPEND_ACTION,
      connection: { type: "notes/notes" },
      input: Schema.Struct({ text: Schema.String }),
    });
    await withSetUpController(
      async ({ harness, base, token }) => {
        const workflow = await createWorkflowOrFail(base, token, {
          definition: {
            name: "Append a note",
            steps: [
              { id: "note", kind: "action", action: NOTE_APPEND_ACTION_ID, params: { text: "hi" } },
            ],
          },
        });

        await expectRefusedAt(harness, await requestRun(base, token, workflow.id), [
          ["steps", "0", "action"],
        ]);
      },
      [connectionAction],
    );
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
      expect(expectStatus(run, "failed").failureReason).toBe("step-failed");
      expect(expectStatus(run, "failed").failedStepId).toBe("update");
      const [update] = findStepRecords(run, "update");
      expect(update?.status).toBe("failed");
      expect(expectStatus(update, "failed").error.code).toBe("not_found");
      expect(expectStatus(update, "failed").error.message).toMatch(/\S/);
      expect(findStepRecords(run, "after").filter((record) => "startedAt" in record)).toEqual([]);
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
      expect(expectStatus(run, "failed").failureReason).toBe("step-failed");
      expect(expectStatus(run, "failed").failedStepId).toBe("create");
      const [create] = findStepRecords(run, "create");
      expect(create?.status).toBe("failed");
      expect(expectStatus(create, "failed").error.code).toBe("validation");
      expect(expectStatus(create, "failed").error.message).toMatch(/\S/);
      expect(findStepRecords(run, "after").filter((record) => "startedAt" in record)).toEqual([]);
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
      expect(expectStatus(run, "failed").failureReason).toBe("expression-error");
      expect(expectStatus(run, "failed").failedStepId).toBe("update");
    });
  });

  it("fails with controller-error, not as the step's own failure, when the database refuses the step's write", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      // Stands in for a database that cannot write, such as a full disk.
      await runEffect(
        harness.sql`
          CREATE TRIGGER refuse_task_insert BEFORE INSERT ON tasks
          BEGIN SELECT RAISE(ABORT, 'the disk is full'); END`,
      );

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      expect(run.status, JSON.stringify(run)).toBe("failed");
      expect(expectStatus(run, "failed").failureReason).toBe("controller-error");
      expect(expectStatus(run, "failed").failedStepId).toBe("create");
      expect(expectStatus(run.steps[0], "failed").error.code).toBe("unexpected");
      expect(await listTasks(base, token)).toEqual([]);
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
const WAITING_RUN_ID = "0199f0b7-0000-7000-8000-00000000a005";
const STRANDED_RUN_ID = "0199f0b7-0000-7000-8000-00000000a009";

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
      expect(expectStatus(run.steps[0], "completed").output).toEqual(task);
      expect((await readTask(base, token, task.id)).status).toBe("in-progress");
    });
  });

  it("waits only for the time a wait step had left when the controller stopped", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const definition = {
        name: "Wait a minute",
        steps: [{ id: "pause", kind: "action", action: "wait", params: { seconds: 60 } }],
      };
      const workflow = await createWorkflowOrFail(base, token, { definition });

      // The rows a run has when the controller stopped 59 seconds into the
      // minute its step waits.
      const startedAt = new Date(Date.now() - 59_000).toISOString();
      await insertRunningRun(harness, {
        id: WAITING_RUN_ID,
        workflowId: workflow.id,
        plan: definition,
        inputs: {},
        at: startedAt,
      });
      await runEffect(
        harness.sql`
          INSERT INTO run_steps (run_id, step_id, iteration, status, created_at, started_at)
          VALUES (unhex(replace(${WAITING_RUN_ID}, '-', '')), 'pause', 1, 'running', ${startedAt}, ${startedAt})`,
      );

      const rebootedAt = Date.now();
      await harness.reboot();
      const run = await waitForRunToFinish(base, token, WAITING_RUN_ID);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      const record = expectStatus(run.steps[0], "completed");
      expect(record.startedAt).toBe(startedAt);
      expect(Date.parse(record.finishedAt) - Date.parse(startedAt)).toBeGreaterThanOrEqual(60_000);
      // Far less than the full minute a fresh wait would take.
      expect(Date.now() - rebootedAt).toBeLessThan(30_000);
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

  it("fails a run with controller-error, at the step record it was executing, when executing it fails for a reason of the controller's own", async () => {
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
      expect(expectStatus(run, "failed").failureReason).toBe("controller-error");
      expect(expectStatus(run, "failed").failedStepId).toBe("ghost");
      expect(expectStatus(run.steps[0], "failed").error.code).toBe("unexpected");
    });
  });

  it("fails a running run with controller-error when it has no step record left to execute", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: FILE_AND_START_DEFINITION,
      });

      // The first step completed, but the record of the step after it is
      // missing. Routing creates that record in the same transaction, so
      // these rows stand in for a bug in the engine.
      const at = new Date().toISOString();
      await insertRunningRun(harness, {
        id: STRANDED_RUN_ID,
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
            (unhex(replace(${STRANDED_RUN_ID}, '-', '')), 'create', 1, 'completed', '{}',
             ${at}, ${at}, ${at})`,
      );

      await harness.reboot();
      const run = await waitForRunToFinish(base, token, STRANDED_RUN_ID);

      expect(run.status, JSON.stringify(run)).toBe("failed");
      expect(expectStatus(run, "failed").failureReason).toBe("controller-error");
      expect(run.steps.map((record) => [record.stepId, record.status])).toEqual([
        ["create", "completed"],
      ]);
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
        expect(expectStatus(run, "failed").failureReason).toBe("step-failed");
        expect(expectStatus(run, "failed").failedStepId).toBe("note");
        expect(run.steps).toHaveLength(1);
        expect(run.steps[0]!.status).toBe("failed");
        expect(expectStatus(run.steps[0], "failed").error.code).toBe("interrupted");
        expect(expectStatus(run.steps[0], "failed").error.message).toMatch(/\S/);
        expect(executions).toBe(0);
      },
      [countingNotesPlugin],
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Resuming a routed run after a restart.                                    */
/* ------------------------------------------------------------------------ */

const LOOPING_RUN_ID = "0199f0b7-0000-7000-8000-00000000a006";
const JOINING_RUN_ID = "0199f0b7-0000-7000-8000-00000000a007";
const PARALLEL_INTERRUPTED_RUN_ID = "0199f0b7-0000-7000-8000-00000000a008";

/**
 * Inserts one step record of a run. The records of a run are read in the
 * order they were inserted, so a test inserts them in the order the engine
 * would have created them.
 */
const insertStepRecord = (
  harness: ServerHarness,
  runId: string,
  record: {
    readonly stepId: string;
    readonly iteration: number;
    readonly status: "pending" | "running" | "completed";
    readonly output?: unknown;
    readonly at: string;
  },
) => {
  const startedAt = record.status === "pending" ? null : record.at;
  const finishedAt = record.status === "completed" ? record.at : null;
  const output = record.status === "completed" ? JSON.stringify(record.output ?? null) : null;
  return runEffect(
    harness.sql`
      INSERT INTO run_steps
        (run_id, step_id, iteration, status, output, created_at, started_at, finished_at)
      VALUES
        (unhex(replace(${runId}, '-', '')), ${record.stepId}, ${record.iteration},
         ${record.status}, ${output}, ${record.at}, ${startedAt}, ${finishedAt})`,
  );
};

/** Inserts how many times a run has followed the edge at `edgeIndex` of its plan. */
const insertEdgeTraversals = (
  harness: ServerHarness,
  runId: string,
  edgeIndex: number,
  count: number,
) =>
  runEffect(
    harness.sql`
      INSERT INTO run_edge_traversals (run_id, edge_index, count)
      VALUES (unhex(replace(${runId}, '-', '')), ${edgeIndex}, ${count})`,
  );

describe("a routed run interrupted by a restart", () => {
  it("continues a loop from its current iteration, with the traversal counts it had", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      // `file` creates a task labelled `loop` and `count` lists them. The
      // edge back to `file` (index 1) may fire twice, and fires while the
      // count is below the target of 4. So the loop stops at a count of 3,
      // with iteration-limit, only if the run keeps the firing it made before
      // the restart; a run that forgot it would reach 4 and complete.
      const definition = {
        name: "Count to the target",
        inputs: [{ name: "target", schema: { type: "integer", minimum: 1 }, required: true }],
        steps: [
          {
            id: "file",
            kind: "action",
            action: "task.create",
            entry: true,
            params: { title: "A loop task", description: "", labels: ["loop"] },
          },
          { id: "count", kind: "action", action: "task.query", params: { labels: ["loop"] } },
          buildCreateStep("done"),
        ],
        edges: [
          { from: "file", to: "count" },
          {
            from: "count",
            to: "file",
            condition: "size(steps.count.output.items) < inputs.target",
            maxTraversals: 2,
          },
          {
            from: "count",
            to: "done",
            condition: "size(steps.count.output.items) >= inputs.target",
          },
        ],
      };
      const workflow = await createWorkflowOrFail(base, token, { definition });
      // The task the first round of the loop created.
      const created = await post(
        base,
        "/api/v1/tasks",
        { title: "A loop task", description: "", labels: ["loop"] },
        token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const task = (await created.json()) as Task;

      // The rows a run has when the controller stopped after one round of
      // the loop: the edge back to `file` fired once, and `file`'s second
      // record waits.
      const at = new Date().toISOString();
      await insertRunningRun(harness, {
        id: LOOPING_RUN_ID,
        workflowId: workflow.id,
        plan: definition,
        inputs: { target: 4 },
        at,
      });
      await insertStepRecord(harness, LOOPING_RUN_ID, {
        stepId: "file",
        iteration: 1,
        status: "completed",
        output: task,
        at,
      });
      await insertStepRecord(harness, LOOPING_RUN_ID, {
        stepId: "count",
        iteration: 1,
        status: "completed",
        output: { items: [task] },
        at,
      });
      await insertStepRecord(harness, LOOPING_RUN_ID, {
        stepId: "file",
        iteration: 2,
        status: "pending",
        at,
      });
      await insertEdgeTraversals(harness, LOOPING_RUN_ID, 0, 1);
      await insertEdgeTraversals(harness, LOOPING_RUN_ID, 1, 1);

      await harness.reboot();
      const run = await waitForRunToFinish(base, token, LOOPING_RUN_ID);

      expect(expectStatus(run, "failed")).toMatchObject({
        failureReason: "iteration-limit",
        failedStepId: "count",
        failedEdge: { index: 1 },
      });
      for (const stepId of ["file", "count"]) {
        expect(
          findStepRecords(run, stepId).map((record) => [record.iteration, record.status]),
          stepId,
        ).toEqual([
          [1, "completed"],
          [2, "completed"],
          [3, "completed"],
        ]);
      }
      expect(findStepRecords(run, "done")).toEqual([]);
      expect(run.edgeTraversals).toEqual([3, 2, 0]);
    });
  });

  it("keeps a join: all edge that fired before the restart, and runs the join once", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      // `left`'s edge into `merge` fired before the restart, and `right`'s
      // never fires. So `merge` runs only if the run keeps that firing.
      const definition = {
        name: "Join across a restart",
        steps: [
          buildCreateStep("left"),
          buildCreateStep("right"),
          {
            id: "merge",
            kind: "action",
            action: "task.create",
            join: "all",
            params: { title: "Merged {{ steps.left.output.title }}", description: "" },
          },
        ],
        edges: [
          { from: "left", to: "merge" },
          { from: "right", to: "merge", condition: "false" },
        ],
      };
      const workflow = await createWorkflowOrFail(base, token, { definition });

      // The rows a run has when the controller stopped after `left`
      // completed and before `right` started.
      const at = new Date().toISOString();
      await insertRunningRun(harness, {
        id: JOINING_RUN_ID,
        workflowId: workflow.id,
        plan: definition,
        inputs: {},
        at,
      });
      await insertStepRecord(harness, JOINING_RUN_ID, {
        stepId: "left",
        iteration: 1,
        status: "completed",
        output: { title: "the left task" },
        at,
      });
      await insertStepRecord(harness, JOINING_RUN_ID, {
        stepId: "right",
        iteration: 1,
        status: "pending",
        at,
      });
      await insertEdgeTraversals(harness, JOINING_RUN_ID, 0, 1);

      await harness.reboot();
      const run = await waitForRunToFinish(base, token, JOINING_RUN_ID);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      const merges = findStepRecords(run, "merge");
      expect(merges.map((record) => [record.iteration, record.status])).toEqual([[1, "completed"]]);
      expect(
        (expectStatus(merges[0], "completed").output as { readonly title: string }).title,
      ).toBe("Merged the left task");
      expect(run.edgeTraversals).toEqual([1, 0]);
    });
  });

  it("fails the run with interrupted at the first of several plugin action records that were running, and cancels the others", async () => {
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
          name: "Append two notes side by side",
          steps: [
            { id: "first", kind: "action", action: NOTE_APPEND_ACTION_ID, params: { text: "a" } },
            { id: "second", kind: "action", action: NOTE_APPEND_ACTION_ID, params: { text: "b" } },
          ],
        };
        const workflow = await createWorkflowOrFail(base, token, { definition });

        // The rows a run has when the controller stopped while both plugin
        // actions were running.
        const at = new Date().toISOString();
        await insertRunningRun(harness, {
          id: PARALLEL_INTERRUPTED_RUN_ID,
          workflowId: workflow.id,
          plan: definition,
          inputs: {},
          at,
        });
        for (const stepId of ["first", "second"]) {
          await insertStepRecord(harness, PARALLEL_INTERRUPTED_RUN_ID, {
            stepId,
            iteration: 1,
            status: "running",
            at,
          });
        }

        await harness.reboot();
        const run = await waitForRunToFinish(base, token, PARALLEL_INTERRUPTED_RUN_ID);

        const failed = expectStatus(run, "failed");
        expect(failed.failureReason).toBe("step-failed");
        expect(failed.failedStepId).toBe("first");
        expect(expectStatus(findStepRecords(run, "first")[0], "failed").error.code).toBe(
          "interrupted",
        );
        const second = expectStatus(findStepRecords(run, "second")[0], "cancelled");
        expect(second.startedAt).toBe(at);
        expect(executions).toBe(0);
      },
      [countingNotesPlugin],
    );
  });
});
