/**
 * Integration tests for the built-in actions a run calls beyond `task.create`
 * and `task.update`, driven over HTTP against a real controller: `task.query`,
 * `workflow.run`, which starts a child run, and the action that stays unknown,
 * `notification.create`. Also checks that a run calls a built-in action
 * without the grant checks its starter would face.
 *
 * A child run is held at `running` by a plugin action that waits until the
 * test releases it, so the test can show that its parent finished without
 * waiting for it.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@hercule/contract";
import { post, send } from "../http/testing";
import { spawnAgentWithGrants, WAIT_DEADLINE_MS } from "../sessions/testing";
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
  findRecords,
  listTasks,
  queryRuns,
  readRun,
  startRun,
  waitForHeldExecutions,
  waitForRunToFinish,
  withRunFleet,
} from "./testing";

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
 * a template, so saving the parent checks nothing about the child.
 */
const buildParentDefinition = (childInputs: Record<string, unknown>) => ({
  name: "Start a child run",
  inputs: [{ name: "child", schema: { type: "string" }, required: true }],
  steps: [
    {
      id: "start_child",
      kind: "action",
      action: "workflow.run",
      params: { workflowId: "{{ inputs.child }}", inputs: childInputs },
    },
  ],
});

describe("a built-in action in a run", () => {
  it("runs without the starter's grants: a session without task.create still gets its task", async () => {
    await withRunFleet(async (arranged) => {
      const base = arranged.harness.base;
      const workflow = await createWorkflowOrFail(base, arranged.token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const agent = await spawnAgentWithGrants(arranged, "starter", ["workflow.run", "run.read"]);

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
      const output = findRecords(run, "find")[0]!.output as {
        items: ReadonlyArray<Task>;
        nextCursor?: string;
      };
      expect(Object.keys(output)).toEqual(["items"]);
      expect(output.items.map((task) => task.id)).toEqual([open.id]);
    });
  });
});

describe("workflow.run as a step", () => {
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
          const output = findRecords(parentRun, "start_child")[0]!.output as Record<
            string,
            unknown
          >;
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
        expect(run.failureReason, description).toBe("step-failed");
        expect(run.failedStepId, description).toBe("start_child");
        const [record] = findRecords(run, "start_child");
        expect(record?.status, description).toBe("failed");
        expect(record?.error?.code, description).toBe(code);
        expect(record?.error?.message, description).toMatch(/\S/);
        // Only the parent run was added.
        expect(await countRuns(harness), description).toBe(runsBefore + 1);
      }
      expect(await listTasks(base, token)).toEqual([]);
    });
  });
});

describe("notification.create", () => {
  it("is refused at save as an unknown action", async () => {
    await withSetUpController(async ({ base, token }) => {
      const issues = await readIssues(
        await createWorkflow(base, token, {
          definition: {
            name: "Notify",
            steps: [
              {
                id: "notify",
                kind: "action",
                action: "notification.create",
                params: { title: "Done" },
              },
            ],
          },
        }),
      );

      expect(issues.map((issue) => issue.path)).toEqual([["steps", "0", "action"]]);
      expect(issues[0]!.message).toMatch(/not a known action/);
    });
  });
});
