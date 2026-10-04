/**
 * Integration tests for the built-in actions a run calls beyond `task.create`
 * and `task.update`, driven over HTTP against a real controller: `task.query`,
 * `run.start`, which starts a child run, `wait`, and `notification.create`. Also
 * checks that a run calls a built-in action
 * without the grant checks its starter would face.
 *
 * A child run is held at `running` by a plugin action that waits until the
 * test releases it, so the test can show that its parent finished without
 * waiting for it.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@hercule/contract";
import { get, post, send } from "../http/testing";
import { spawnThreadWithGrants, WAIT_DEADLINE_MS, waitUntil } from "../sessions/testing";
import {
  ABSENT_ID,
  createWorkflow,
  createWorkflowOrFail,
  readIssues,
  withSetUpController,
} from "../workflows/testing";
import {
  buildCreateStep,
  buildHeldAction,
  countRuns,
  findStepRecords,
  listTasks,
  queryRuns,
  readRun,
  startRun,
  waitForHeldExecutions,
  waitForRunToFinish,
  withRunFleet,
  expectStatus,
} from "./testing";
import { runEffect } from "../daemon/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Creates a task through the API and returns it. */
const createTask = async (base: string, token: string, title: string): Promise<Task> => {
  const response = await post(base, "/api/v1/tasks", { title, description: "" }, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

/**
 * A parent workflow with one step that starts a run of the workflow whose id
 * is the `child` input, passing `childInputs` as that run's inputs. The id is
 * a template, so saving the parent cannot check `childInputs` against the
 * child's inputs. Each value then counts as one that may choose a
 * Connection: it must be a literal or exactly one input, and choosing it
 * needs `connection.use`, which the user who saves these parents holds.
 */
const buildParentDefinition = (childInputs: Record<string, unknown>) => ({
  name: "Start a child run",
  inputs: [{ name: "child", schema: { type: "string" }, required: true }],
  steps: [
    {
      id: "start_child",
      kind: "action",
      action: "run.start",
      params: { workflowId: "{{ inputs.child }}", inputs: childInputs },
    },
  ],
});

/**
 * A workflow whose one step starts a run of the workflow whose id is the
 * `self` input, passing the same input on. Started with its own id, each run
 * starts the next, until the controller refuses one as nested too deep.
 */
const SELF_STARTING_DEFINITION = {
  name: "Start itself",
  inputs: [{ name: "self", schema: { type: "string" }, required: true }],
  steps: [
    {
      id: "start_self",
      kind: "action",
      action: "run.start",
      params: { workflowId: "{{ inputs.self }}", inputs: { self: "{{ inputs.self }}" } },
    },
  ],
};

describe("a built-in action in a run", () => {
  it("runs without the starter's grants: a session without task.create still gets its task", async () => {
    await withRunFleet(async (arranged) => {
      const base = arranged.harness.base;
      const workflow = await createWorkflowOrFail(base, arranged.token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const agent = await spawnThreadWithGrants(arranged, "starter", ["run.start", "run.read"]);

      const runId = await startRun(base, agent.token, workflow.id);
      const run = await waitForRunToFinish(base, arranged.token, runId);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect((await listTasks(base, arranged.token)).map((task) => task.title)).toEqual([
        "File the create task",
      ]);
    });
  });

  it("outputs the first page of tasks matching the filter from task.query", async () => {
    await withSetUpController(async ({ base, token }) => {
      const open = await createTask(base, token, "Still open");
      const done = await createTask(base, token, "Already done");
      const updated = await send("PATCH", base, `/api/v1/tasks/${done.id}`, {
        body: { status: "done" },
        token,
      });
      expect(updated.status, await updated.clone().text()).toBe(200);
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Find open tasks",
          steps: [
            { id: "find", kind: "action", action: "task.query", params: { status: ["open"] } },
          ],
        },
      });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      expect(run.status, JSON.stringify(run)).toBe("completed");
      const output = expectStatus(findStepRecords(run, "find")[0], "completed").output as {
        items: ReadonlyArray<Task>;
        nextCursor?: string;
      };
      expect(Object.keys(output)).toEqual(["items"]);
      expect(output.items.map((task) => task.id)).toEqual([open.id]);
    });
  });
});

describe("run.start as a step", () => {
  it("starts a child run with an action origin and outputs its id without waiting for it", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          const child = await createWorkflowOrFail(base, token, {
            definition: {
              name: "Child",
              inputs: [{ name: "label", schema: { type: "string" }, required: true }],
              steps: [
                {
                  id: "wait",
                  kind: "action",
                  action: held.actionId,
                  params: { label: "{{ inputs.label }}" },
                },
              ],
            },
          });
          const parent = await createWorkflowOrFail(base, token, {
            definition: buildParentDefinition({ label: "from the parent" }),
          });

          const parentId = await startRun(base, token, parent.id, {
            inputs: { child: child.id },
          });
          const parentRun = await waitForRunToFinish(base, token, parentId);

          expect(parentRun.status, JSON.stringify(parentRun)).toBe("completed");
          const output = expectStatus(findStepRecords(parentRun, "start_child")[0], "completed")
            .output as Record<string, unknown>;
          expect(Object.keys(output)).toEqual(["runId"]);
          const childId = output["runId"] as string;

          // The parent finished while the child's step is still waiting.
          await waitForHeldExecutions(held, 1);
          const childRun = await readRun(base, token, childId);
          expect(["pending", "running"]).toContain(childRun.status);
          expect(childRun.workflowId).toBe(child.id);
          expect(childRun.inputs).toEqual({ label: "from the parent" });
          expect(childRun.origin).toEqual({
            kind: "action",
            parentRunId: parentId,
            stepId: "start_child",
          });
          expect(
            (await queryRuns(base, token, `actor=run:${parentId}`)).items.map((item) => item.id),
          ).toEqual([childId]);

          held.release();
          expect((await waitForRunToFinish(base, token, childId)).status).toBe("completed");
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("fails the step and creates no child run when the child workflow does not exist or its inputs are invalid", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const child = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Child with a required input",
          inputs: [{ name: "title", schema: { type: "string" }, required: true }],
          steps: [buildCreateStep("create")],
        },
      });
      // The parent passes no inputs, so the child's required `title` is missing.
      const parent = await createWorkflowOrFail(base, token, {
        definition: buildParentDefinition({}),
      });

      // A missing workflow fails the step with not_found, as task.update does
      // for a missing task.
      for (const [description, childId, code] of [
        ["a workflow that does not exist", ABSENT_ID, "not_found"],
        ["a missing required input", child.id, "validation"],
      ] as const) {
        const runsBefore = await countRuns(harness);
        const parentId = await startRun(base, token, parent.id, { inputs: { child: childId } });
        const run = await waitForRunToFinish(base, token, parentId);

        expect(run.status, `${description}: ${JSON.stringify(run)}`).toBe("failed");
        expect(expectStatus(run, "failed").failureReason, description).toBe("step-failed");
        expect(expectStatus(run, "failed"), description).toMatchObject({
          failedStepId: "start_child",
        });
        const [record] = findStepRecords(run, "start_child");
        expect(record?.status, description).toBe("failed");
        expect(expectStatus(record, "failed").error.code, description).toBe(code);
        expect(expectStatus(record, "failed").error.message, description).toMatch(/\S/);
        // Only the parent run was added.
        expect(await countRuns(harness), description).toBe(runsBefore + 1);
      }
      expect(await listTasks(base, token)).toEqual([]);
    });
  });

  it("refuses a run nested deeper than run.nestingLimit, 5 unless the setting says otherwise, and fails the step that started it", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: SELF_STARTING_DEFINITION,
      });

      for (const limit of [5, 2]) {
        if (limit !== 5) {
          const updated = await send("PATCH", base, "/api/v1/settings", {
            body: { controller: { "run.nestingLimit": limit } },
            token,
          });
          expect(updated.status, await updated.clone().text()).toBe(200);
        }
        const runsBefore = await countRuns(harness);
        const completedBefore = (await queryRuns(base, token, "status=completed")).items.length;
        await startRun(base, token, workflow.id, { inputs: { self: workflow.id } });

        // Each run starts the next, and the deepest run's step is refused.
        const failed = await waitUntil(`failed the run ${String(limit)} deep`, async () => {
          const [run] = (await queryRuns(base, token, "status=failed")).items;
          return run === undefined ? undefined : readRun(base, token, run.id);
        });
        const record = expectStatus(findStepRecords(failed, "start_self")[0], "failed");
        expect(record.error).toEqual({
          code: "cap_exceeded",
          message: `This run would be ${String(limit + 1)} runs deep, and the limit is ${String(limit)}. A workflow may be starting itself, directly or through another workflow. Raise the run.nestingLimit setting, or change the workflow.`,
        });
        expect(await countRuns(harness)).toBe(runsBefore + limit);
        await waitUntil("finished every run of the chain", async () => {
          const unfinished = [
            ...(await queryRuns(base, token, "status=pending")).items,
            ...(await queryRuns(base, token, "status=running")).items,
          ];
          return unfinished.length === 0 ? true : undefined;
        });
        expect((await queryRuns(base, token, "status=completed")).items).toHaveLength(
          completedBefore + limit - 1,
        );
        // Clears the failed run from the next round's search.
        await runEffect(harness.sql`DELETE FROM runs WHERE status = 'failed'`);
      }
    });
  });
});

describe("wait", () => {
  it("completes after the seconds it is given, with an empty output", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Wait a second",
          steps: [{ id: "pause", kind: "action", action: "wait", params: { seconds: 1 } }],
        },
      });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      expect(run.status, JSON.stringify(run)).toBe("completed");
      const record = expectStatus(findStepRecords(run, "pause")[0], "completed");
      expect(record.output).toEqual({});
      expect(Date.parse(record.finishedAt) - Date.parse(record.startedAt)).toBeGreaterThanOrEqual(
        1000,
      );
    });
  });

  it("is refused at save for seconds outside 1 to 86400", async () => {
    await withSetUpController(async ({ base, token }) => {
      for (const seconds of [0, 86_401, 1.5]) {
        const issues = await readIssues(
          await createWorkflow(base, token, {
            definition: {
              name: "Wait too long",
              steps: [{ id: "pause", kind: "action", action: "wait", params: { seconds } }],
            },
          }),
        );
        expect(
          issues.map((issue) => issue.path),
          String(seconds),
        ).toEqual([["steps", "0", "params", "seconds"]]);
      }
    });
  });
});

describe("notification.create", () => {
  it("creates a notification produced by the run's step, muted with its workflow, and outputs its id", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Notify",
          steps: [
            {
              id: "notify",
              kind: "action",
              action: "notification.create",
              params: { kind: "deploy.done", title: "Deployed", body: "All green" },
            },
          ],
        },
      });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      expect(run.status, JSON.stringify(run)).toBe("completed");
      const { notificationId } = expectStatus(findStepRecords(run, "notify")[0], "completed")
        .output as { readonly notificationId: string };
      const response = await get(base, `/api/v1/notifications/${notificationId}`, token);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({
        id: notificationId,
        kind: "deploy.done",
        title: "Deployed",
        body: "All green",
        producer: { type: "run", runId: run.id, stepId: "notify" },
        muteKey: `workflow:${workflow.id}`,
        subject: [],
        actions: [],
        status: "resolved",
        createdAt: expect.any(String) as unknown,
      });
    });
  });

  it("is refused at save when its kind is one the core reserves", async () => {
    await withSetUpController(async ({ base, token }) => {
      const issues = await readIssues(
        await createWorkflow(base, token, {
          definition: {
            name: "Pretend to be the core",
            steps: [
              {
                id: "notify",
                kind: "action",
                action: "notification.create",
                params: { kind: "core.run-failed", title: "Fake" },
              },
            ],
          },
        }),
      );

      expect(issues.map((issue) => issue.path)).toEqual([["steps", "0", "params", "kind"]]);
    });
  });
});
