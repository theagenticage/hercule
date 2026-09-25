/**
 * Integration tests for starting a run of a workflow sent with the request,
 * without storing it, and for listing and reading runs, driven over HTTP
 * against a real controller: `POST /runs/start`, `GET /runs` and
 * `GET /runs/{id}`, and who may call them and `POST /runs/{id}/cancel`.
 *
 * The tests about grants spawn sessions on profiles with exactly the grants
 * the test needs, so they run against a controller with a connected runner.
 * The others need no runner: action steps run on the controller.
 */
import { describe, expect, it, vi } from "vitest";
import type { Run, RunSummary } from "@hercule/contract";
import { get, readErrorBody } from "../http/testing";
import {
  readProfileNamed,
  spawnAgentUnder,
  spawnAgentWithGrants,
  WAIT_DEADLINE_MS,
} from "../sessions/testing";
import {
  ABSENT_ID,
  buildFileTaskSource,
  createWorkflowOrFail,
  queryWorkflows,
  withSetUpController,
} from "../workflows/testing";
import {
  buildCreateStep,
  buildHeldAction,
  buildHeldStep,
  countRuns,
  expectRefusedAt,
  INPUTS_DEFINITION,
  queryRuns,
  readRun,
  requestCancel,
  requestStart,
  startRun,
  startSentWorkflow,
  waitForHeldExecutions,
  waitForRunToFinish,
  withRunFleet,
  expectStatus,
} from "./testing";

/** Long enough for an agent fleet, a session, and runs that wait their full deadline. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Waits long enough that the next run gets a later `createdAt` than the one before. */
const waitForNextMillisecond = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

/** A workflow whose one step fails, because it updates a task that does not exist. */
const FAILING_DEFINITION = {
  name: "Update a missing task",
  steps: [
    {
      id: "update",
      kind: "action",
      action: "task.update",
      params: { taskId: ABSENT_ID, status: "done" },
    },
  ],
};

/** Returns the ids of a page's runs, in the order the page lists them. */
const listIds = (items: ReadonlyArray<RunSummary>): ReadonlyArray<string> =>
  items.map((item) => item.id);

/* ------------------------------------------------------------------------ */
/* Starting a run of a sent workflow.                                        */
/* ------------------------------------------------------------------------ */

describe("run.start of a sent workflow", () => {
  it("starts a run of a definition with no workflow id and a manual origin, resolves its inputs, and stores no workflow", async () => {
    await withSetUpController(async ({ base, token }) => {
      const runId = await startSentWorkflow(base, token, {
        definition: INPUTS_DEFINITION,
        inputs: { title: "Fix login" },
      });

      const run = await readRun(base, token, runId);
      expect(run.workflowId).toBeNull();
      expect(run.plan).toEqual(INPUTS_DEFINITION);
      // The default fills `priority`; `note` and `repo` have no value and no
      // default, so they are left out.
      expect(run.inputs).toEqual({ title: "Fix login", priority: "high" });
      expect(run.origin).toEqual({ kind: "manual", actor: "user" });

      const finished = await waitForRunToFinish(base, token, runId);
      expect(finished.status, JSON.stringify(finished)).toBe("completed");
      expect((await queryWorkflows(base, token)).items).toEqual([]);
    });
  });

  it("starts a run of a YAML source, with the parsed definition as its plan", async () => {
    await withSetUpController(async ({ base, token }) => {
      const runId = await startSentWorkflow(base, token, {
        source: buildFileTaskSource("Submitted"),
      });

      const run = await waitForRunToFinish(base, token, runId);
      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(run.workflowId).toBeNull();
      expect(run.plan).toEqual({
        name: "Submitted",
        steps: [
          {
            id: "file_task",
            kind: "action",
            action: "task.create",
            params: { title: "File the file_task task", description: "Filed by a workflow." },
          },
        ],
      });
      expect((await queryWorkflows(base, token)).items).toEqual([]);
    });
  });

  it("refuses a definition that does not validate and invalid inputs with validation at their paths, and creates no run", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      await expectRefusedAt(
        harness,
        await requestStart(base, token, {
          definition: {
            name: "Unknown action",
            steps: [{ id: "first", kind: "action", action: "task.creat", params: {} }],
          },
        }),
        [["steps", "0", "action"]],
        "a definition naming an unknown action",
      );
      await expectRefusedAt(
        harness,
        await requestStart(base, token, {
          definition: INPUTS_DEFINITION,
          inputs: { ghost: 1, priority: "someday" },
        }),
        [
          ["inputs", "ghost"],
          ["inputs", "title"],
          ["inputs", "priority"],
        ],
        "unknown, missing and invalid inputs",
      );
      expect((await queryWorkflows(base, token)).items).toEqual([]);
    });
  });

  it("records the session as actor, and refuses a session without the run.start grant with forbidden", async () => {
    await withRunFleet(async (arranged) => {
      const base = arranged.harness.base;
      const definition = { name: "One task", steps: [buildCreateStep("create")] };
      const allowed = await spawnAgentWithGrants(arranged, "submitter", ["run.start", "run.read"]);
      const refused = await spawnAgentWithGrants(arranged, "reader", ["run.read"]);

      const response = await requestStart(base, refused.token, { definition });
      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(403);
      expect(refusal.code).toBe("forbidden");
      expect(refusal.grant).toBe("run.start");
      expect(await countRuns(arranged.harness)).toBe(0);

      const runId = await startSentWorkflow(base, allowed.token, { definition });
      const run = await waitForRunToFinish(base, arranged.token, runId);
      expect(run.origin).toEqual({ kind: "api", actor: `session:${allowed.session.id}` });
      expect(run.workflowId).toBeNull();
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Listing and reading runs.                                                 */
/* ------------------------------------------------------------------------ */

describe("GET /runs", () => {
  it("lists runs newest first, each as the summary of what GET /runs/{id} returns", async () => {
    await withSetUpController(async ({ base, token }) => {
      const oneTask = await createWorkflowOrFail(base, token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const failing = await createWorkflowOrFail(base, token, { definition: FAILING_DEFINITION });
      const ids: Array<string> = [];
      for (const workflowId of [oneTask.id, failing.id, oneTask.id]) {
        ids.push(await startRun(base, token, workflowId));
        await waitForNextMillisecond();
      }
      const runs: Array<Run> = [];
      for (const id of ids) runs.push(await waitForRunToFinish(base, token, id));

      const page = await queryRuns(base, token);

      expect(listIds(page.items)).toEqual([...ids].reverse());
      expect(page.nextCursor).toBeUndefined();
      for (const summary of page.items) {
        const run = runs.find((one) => one.id === summary.id)!;
        // A summary is the run without its plan, inputs, step records and
        // edge traversal counts, plus the workflow's name from the plan.
        const fields: Record<string, unknown> = { ...run, workflowName: run.plan.name };
        for (const key of ["plan", "inputs", "steps", "edgeTraversals"]) delete fields[key];
        expect(summary).toEqual(fields);
      }

      // The failed run's read holds everything the run page needs to explain it.
      const failed = runs[1]!;
      expect(failed).toMatchObject({
        id: ids[1],
        workflowId: failing.id,
        plan: FAILING_DEFINITION,
        inputs: {},
        origin: { kind: "manual", actor: "user" },
        status: "failed",
        failureReason: "step-failed",
        failedStepId: "update",
      });
      expect(failed.createdAt).toBeDefined();
      expect(expectStatus(failed, "failed").startedAt).toBeDefined();
      expect(failed.steps.map((record) => [record.stepId, record.status])).toEqual([
        ["update", "failed"],
      ]);
    });
  });

  it("filters by workflow, status, and creation time, with since and until both inclusive", async () => {
    await withSetUpController(async ({ base, token }) => {
      const oneTask = await createWorkflowOrFail(base, token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const failing = await createWorkflowOrFail(base, token, { definition: FAILING_DEFINITION });
      const ids: Array<string> = [];
      for (const workflowId of [oneTask.id, failing.id, oneTask.id]) {
        ids.push(await startRun(base, token, workflowId));
        await waitForNextMillisecond();
      }
      const runs: Array<Run> = [];
      for (const id of ids) runs.push(await waitForRunToFinish(base, token, id));
      const [first, second, third] = ids as [string, string, string];
      const middle = encodeURIComponent(runs[1]!.createdAt);

      const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
        [`workflowId=${oneTask.id}`, [third, first]],
        [`workflowId=${failing.id}`, [second]],
        [`workflowId=${ABSENT_ID}`, []],
        ["status=completed", [third, first]],
        ["status=failed", [second]],
        ["status=running", []],
        [`since=${middle}`, [third, second]],
        [`until=${middle}`, [second, first]],
        [`since=${middle}&until=${middle}`, [second]],
        [`workflowId=${oneTask.id}&status=failed`, []],
      ];
      for (const [query, expected] of cases) {
        expect(listIds((await queryRuns(base, token, query)).items), query).toEqual(expected);
      }
    });
  });

  it("pages with a cursor, newest first, until the last page has no cursor", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const ids: Array<string> = [];
      for (let count = 0; count < 3; count += 1) {
        ids.push(await startRun(base, token, workflow.id));
        await waitForNextMillisecond();
      }
      for (const id of ids) await waitForRunToFinish(base, token, id);

      const seen: Array<string> = [];
      let page = await queryRuns(base, token, "limit=2");
      expect(page.items).toHaveLength(2);
      seen.push(...listIds(page.items));
      expect(page.nextCursor).toBeDefined();
      page = await queryRuns(base, token, `limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`);
      seen.push(...listIds(page.items));
      expect(page.nextCursor).toBeUndefined();

      expect(seen).toEqual([...ids].reverse());
    });
  });

  it("filters by the actor that started the run", async () => {
    await withRunFleet(async (arranged) => {
      const base = arranged.harness.base;
      const workflow = await createWorkflowOrFail(base, arranged.token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const agent = await spawnAgentWithGrants(arranged, "starter", ["run.start", "run.read"]);
      const byUser = await startRun(base, arranged.token, workflow.id);
      const bySession = await startRun(base, agent.token, workflow.id);
      await waitForRunToFinish(base, arranged.token, byUser);
      await waitForRunToFinish(base, arranged.token, bySession);

      expect(listIds((await queryRuns(base, arranged.token, "actor=user")).items)).toEqual([
        byUser,
      ]);
      expect(
        listIds((await queryRuns(base, arranged.token, `actor=session:${agent.session.id}`)).items),
      ).toEqual([bySession]);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Grants.                                                                   */
/* ------------------------------------------------------------------------ */

describe("the grants for runs", () => {
  it("lets a worker list and read runs, and refuses it cancelling one, because that needs run.write", async () => {
    const held = buildHeldAction();
    await withRunFleet(
      async (arranged) => {
        try {
          const base = arranged.harness.base;
          const workflow = await createWorkflowOrFail(base, arranged.token, {
            definition: { name: "Wait", steps: [buildHeldStep(held, "first")] },
          });
          const runId = await startRun(base, arranged.token, workflow.id);
          await waitForHeldExecutions(held, 1);
          // The shipped worker profile has run.read and not run.write.
          const worker = await spawnAgentUnder(
            arranged,
            await readProfileNamed(arranged, "worker"),
          );

          expect(listIds((await queryRuns(base, worker.token)).items)).toEqual([runId]);
          expect((await readRun(base, worker.token, runId)).id).toBe(runId);

          const response = await requestCancel(base, worker.token, runId);
          const refusal = await readErrorBody(response);
          expect(response.status, refusal.text).toBe(403);
          expect(refusal.code).toBe("forbidden");
          expect(refusal.grant).toBe("run.write");
          expect((await readRun(base, arranged.token, runId)).status).toBe("running");

          // A session with run.write may cancel the same run.
          const canceller = await spawnAgentWithGrants(arranged, "canceller", [
            "run.read",
            "run.write",
          ]);
          const cancelled = await requestCancel(base, canceller.token, runId);
          expect(cancelled.status, await cancelled.clone().text()).toBe(200);
          const run = await waitForRunToFinish(base, arranged.token, runId);
          expect(run.status).toBe("cancelled");
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("refuses listing and reading runs to a session without run.read", async () => {
    await withRunFleet(async (arranged) => {
      const base = arranged.harness.base;
      const workflow = await createWorkflowOrFail(base, arranged.token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const runId = await startRun(base, arranged.token, workflow.id);
      await waitForRunToFinish(base, arranged.token, runId);
      const agent = await spawnAgentWithGrants(arranged, "reader-of-tasks", ["task.read"]);

      for (const path of ["/api/v1/runs", `/api/v1/runs/${runId}`]) {
        const response = await get(base, path, agent.token);
        const refusal = await readErrorBody(response);
        expect(response.status, `${path}: ${refusal.text}`).toBe(403);
        expect(refusal.code).toBe("forbidden");
        expect(refusal.grant).toBe("run.read");
      }
    });
  });
});
