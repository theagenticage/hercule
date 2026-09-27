/**
 * Integration tests for re-running a run that has ended with `run.rerun`
 * (`POST /runs/{id}/rerun`), driven over HTTP against a real controller:
 *
 * - what the new run records in each mode: `re-stamp` runs the workflow as it
 *   is stored now, `replay` runs the original run's frozen plan, and both copy
 *   the original's resolved inputs and name it in `originalRunId`;
 * - whose origin the new run gets, which follows the caller as for
 *   `run.start`;
 * - every request the controller refuses, with its HTTP status and error code,
 *   and that a refused request creates no run;
 * - the list of a run's re-runs, read with `GET /runs?originalRunId=`.
 */
import { describe, expect, it, vi } from "vitest";
import { del, post, readErrorBody, type ServerHarness } from "../http/testing";
import { buildActionPlugin, NOTE_APPEND_ACTION, NOTE_APPEND_ACTION_ID } from "../plugins/testing";
import { spawnAgentWithGrants, WAIT_DEADLINE_MS } from "../sessions/testing";
import {
  createWorkflowOrFail,
  disablePlugin,
  updateWorkflow,
  withSetUpController,
} from "../workflows/testing";
import {
  buildCreateStep,
  buildHeldAction,
  buildHeldStep,
  countRuns,
  INPUTS_DEFINITION,
  insertPendingRun,
  queryRuns,
  readRun,
  startRun,
  startSentWorkflow,
  waitForHeldExecutions,
  waitForRunToFinish,
  withRunFleet,
} from "./testing";

/** Long enough for a runner fleet, a session, and a few runs that finish. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** The sentence every refused re-stamp ends with, pointing the caller to replay. */
const REPLAY_HINT = "Re-run with mode replay to run the original run's plan instead.";

/** A run id no run has. */
const UNKNOWN_RUN_ID = "0199f0b7-0000-7000-8000-00000000f001";

/** The id of the run `insertPendingRun` writes, which never leaves `pending`. */
const PENDING_RUN_ID = "0199f0b7-0000-7000-8000-00000000f002";

/** The resolved inputs of a run of `INPUTS_DEFINITION` started with only a title. */
const RESOLVED_INPUTS = { title: "Fix login", priority: "high" };

/**
 * `INPUTS_DEFINITION` as it is after an edit: renamed, its step renamed, and
 * the default of `priority` changed. A re-run that copies the original's
 * inputs keeps `priority: "high"`; one that resolved them again would get
 * `"low"`.
 */
const EDITED_DEFINITION = {
  ...INPUTS_DEFINITION,
  name: "File a task from inputs, edited",
  inputs: INPUTS_DEFINITION.inputs.map((input) =>
    input.name === "priority" ? { ...input, default: "low" } : input,
  ),
  steps: [{ ...INPUTS_DEFINITION.steps[0]!, id: "file" }],
};

/** Sends `run.rerun` for the run `id` with `body` as it is, and returns the response. */
const requestRerun = (base: string, token: string, id: string, body: unknown = {}) =>
  post(base, `/api/v1/runs/${id}/rerun`, body, token);

/**
 * Re-runs the run `id` and returns the new run's id. Fails the test if the
 * request is refused, or if the response holds anything but the run id.
 */
const rerunRun = async (
  base: string,
  token: string,
  id: string,
  body: unknown = {},
): Promise<string> => {
  const response = await requestRerun(base, token, id, body);
  expect(response.status, await response.clone().text()).toBe(200);
  const started = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(started)).toEqual(["runId"]);
  return started["runId"] as string;
};

/**
 * Checks that the response is the refusal with `status`, `code` and a
 * message containing `message`, and that the database holds `runCount` runs,
 * the count from before the request, so the refusal created no run.
 */
const expectRerunRefused = async (
  harness: ServerHarness,
  response: Response,
  refusal: { readonly status: number; readonly code: string; readonly message: string },
  runCount: number,
): Promise<void> => {
  const body = await readErrorBody(response);
  expect(response.status, body.text).toBe(refusal.status);
  expect(body.code).toBe(refusal.code);
  expect(body.message).toContain(refusal.message);
  expect(await countRuns(harness)).toBe(runCount);
};

/**
 * Creates a workflow of `INPUTS_DEFINITION`, runs it once with only a title
 * and waits for the run to finish. Returns the workflow's id and the run's id.
 */
const runInputsWorkflow = async (
  base: string,
  token: string,
): Promise<{ readonly workflowId: string; readonly runId: string }> => {
  const workflow = await createWorkflowOrFail(base, token, { definition: INPUTS_DEFINITION });
  const runId = await startRun(base, token, workflow.id, { inputs: { title: "Fix login" } });
  expect((await waitForRunToFinish(base, token, runId)).status).toBe("completed");
  return { workflowId: workflow.id, runId };
};

/* ------------------------------------------------------------------------ */
/* The two modes.                                                            */
/* ------------------------------------------------------------------------ */

describe("run.rerun in re-stamp mode", () => {
  it("runs the workflow as it is stored now, with the original's inputs, when the request leaves mode out", async () => {
    await withSetUpController(async ({ base, token }) => {
      const original = await runInputsWorkflow(base, token);
      const edited = await updateWorkflow(base, token, original.workflowId, {
        definition: EDITED_DEFINITION,
      });
      expect(edited.status, await edited.clone().text()).toBe(200);

      const rerunId = await rerunRun(base, token, original.runId);

      const rerun = await waitForRunToFinish(base, token, rerunId);
      expect(rerun.id).not.toBe(original.runId);
      expect(rerun.status).toBe("completed");
      expect(rerun.plan).toEqual(EDITED_DEFINITION);
      expect(rerun.workflowId).toBe(original.workflowId);
      expect(rerun.inputs).toEqual(RESOLVED_INPUTS);
      expect(rerun.originalRunId).toBe(original.runId);
      expect(rerun.origin).toEqual({ kind: "manual", actor: "user" });
      expect(rerun.steps.map((record) => record.stepId)).toEqual(["file"]);
    });
  });

  it("does the same when the request names re-stamp", async () => {
    await withSetUpController(async ({ base, token }) => {
      const original = await runInputsWorkflow(base, token);
      await updateWorkflow(base, token, original.workflowId, { definition: EDITED_DEFINITION });

      const rerunId = await rerunRun(base, token, original.runId, { mode: "re-stamp" });

      const rerun = await waitForRunToFinish(base, token, rerunId);
      expect(rerun.plan).toEqual(EDITED_DEFINITION);
      expect(rerun.inputs).toEqual(RESOLVED_INPUTS);
      expect(rerun.originalRunId).toBe(original.runId);
    });
  });
});

describe("run.rerun in replay mode", () => {
  it("runs the original run's plan, not the edit made since, with the original's inputs", async () => {
    await withSetUpController(async ({ base, token }) => {
      const original = await runInputsWorkflow(base, token);
      await updateWorkflow(base, token, original.workflowId, { definition: EDITED_DEFINITION });

      const rerunId = await rerunRun(base, token, original.runId, { mode: "replay" });

      const rerun = await waitForRunToFinish(base, token, rerunId);
      expect(rerun.status).toBe("completed");
      expect(rerun.plan).toEqual(INPUTS_DEFINITION);
      expect(rerun.workflowId).toBe(original.workflowId);
      expect(rerun.inputs).toEqual(RESOLVED_INPUTS);
      expect(rerun.originalRunId).toBe(original.runId);
      expect(rerun.origin).toEqual({ kind: "manual", actor: "user" });
      expect(rerun.steps.map((record) => record.stepId)).toEqual(["create"]);
    });
  });

  it("re-runs a run of a workflow sent with run.start, which has no stored workflow", async () => {
    await withSetUpController(async ({ base, token }) => {
      const originalId = await startSentWorkflow(base, token, {
        definition: INPUTS_DEFINITION,
        inputs: { title: "Fix login" },
      });
      await waitForRunToFinish(base, token, originalId);

      const rerunId = await rerunRun(base, token, originalId, { mode: "replay" });

      const rerun = await waitForRunToFinish(base, token, rerunId);
      expect(rerun.status).toBe("completed");
      expect(rerun.plan).toEqual(INPUTS_DEFINITION);
      expect(rerun.workflowId).toBeNull();
      expect(rerun.inputs).toEqual(RESOLVED_INPUTS);
      expect(rerun.originalRunId).toBe(originalId);
    });
  });

  it("re-runs a run whose workflow has been deleted, and keeps the workflow id", async () => {
    await withSetUpController(async ({ base, token }) => {
      const original = await runInputsWorkflow(base, token);
      const deleted = await del(base, `/api/v1/workflows/${original.workflowId}`, token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      const rerunId = await rerunRun(base, token, original.runId, { mode: "replay" });

      const rerun = await waitForRunToFinish(base, token, rerunId);
      expect(rerun.status).toBe("completed");
      expect(rerun.plan).toEqual(INPUTS_DEFINITION);
      expect(rerun.workflowId).toBe(original.workflowId);
      expect(rerun.originalRunId).toBe(original.runId);
    });
  });

  it("re-runs a run that failed", async () => {
    await withSetUpController(async ({ base, token }) => {
      // task.update of a task that does not exist fails the step, and the run.
      const definition = {
        name: "Update a missing task",
        steps: [
          {
            id: "update",
            kind: "action",
            action: "task.update",
            params: { taskId: UNKNOWN_RUN_ID, status: "done" },
          },
        ],
      };
      const originalId = await startSentWorkflow(base, token, { definition });
      expect((await waitForRunToFinish(base, token, originalId)).status).toBe("failed");

      const rerunId = await rerunRun(base, token, originalId, { mode: "replay" });

      const rerun = await waitForRunToFinish(base, token, rerunId);
      expect(rerun.status).toBe("failed");
      expect(rerun.originalRunId).toBe(originalId);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Who re-runs.                                                              */
/* ------------------------------------------------------------------------ */

describe("the origin of a re-run", () => {
  it("names the session that re-ran, and a session without the run.start grant is refused with forbidden", async () => {
    await withRunFleet(async (arranged) => {
      const base = arranged.harness.base;
      const originalId = await startSentWorkflow(base, arranged.token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      await waitForRunToFinish(base, arranged.token, originalId);
      const allowed = await spawnAgentWithGrants(arranged, "submitter", ["run.start", "run.read"]);
      const refused = await spawnAgentWithGrants(arranged, "reader", ["run.read"]);

      const response = await requestRerun(base, refused.token, originalId, { mode: "replay" });
      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(403);
      expect(refusal.code).toBe("forbidden");
      expect(refusal.grant).toBe("run.start");
      expect(await countRuns(arranged.harness)).toBe(1);

      const rerunId = await rerunRun(base, allowed.token, originalId, { mode: "replay" });
      const rerun = await waitForRunToFinish(base, arranged.token, rerunId);
      expect(rerun.origin).toEqual({ kind: "api", actor: `session:${allowed.session.id}` });
      expect(rerun.originalRunId).toBe(originalId);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* What run.rerun refuses.                                                   */
/* ------------------------------------------------------------------------ */

describe("run.rerun refuses", () => {
  it("a run id no run has, with not_found", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      for (const mode of ["re-stamp", "replay"]) {
        await expectRerunRefused(
          harness,
          await requestRerun(base, token, UNKNOWN_RUN_ID, { mode }),
          { status: 404, code: "not_found", message: "no such run" },
          0,
        );
      }
    });
  });

  it("a mode that is neither re-stamp nor replay, and a field it does not know, with validation", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const original = await runInputsWorkflow(base, token);

      for (const body of [{ mode: "again" }, { mode: "replay", inputs: { title: "Other" } }]) {
        const response = await requestRerun(base, token, original.runId, body);
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.code).toBe("validation");
      }
      expect(await countRuns(harness)).toBe(1);
    });
  });

  it("a run that is still running, with invalid_state, in both modes", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        try {
          const workflow = await createWorkflowOrFail(base, token, {
            definition: { name: "Wait", steps: [buildHeldStep(held, "wait")] },
          });
          const runId = await startRun(base, token, workflow.id);
          await waitForHeldExecutions(held, 1);

          for (const mode of ["re-stamp", "replay"]) {
            await expectRerunRefused(
              harness,
              await requestRerun(base, token, runId, { mode }),
              {
                status: 409,
                code: "invalid_state",
                message: "This run is still running, and only a run that has ended can be re-run.",
              },
              1,
            );
          }
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("a run that is still pending, with invalid_state, in both modes", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const definition = { name: "One task", steps: [buildCreateStep("create")] };
      const workflow = await createWorkflowOrFail(base, token, { definition });
      await insertPendingRun(harness, {
        id: PENDING_RUN_ID,
        workflowId: workflow.id,
        plan: definition,
        stepId: "create",
      });

      for (const mode of ["re-stamp", "replay"]) {
        await expectRerunRefused(
          harness,
          await requestRerun(base, token, PENDING_RUN_ID, { mode }),
          {
            status: 409,
            code: "invalid_state",
            message: "This run is still pending, and only a run that has ended can be re-run.",
          },
          1,
        );
      }
    });
  });

  it("a re-stamp of a run of a workflow sent with run.start, with invalid_state that points to replay", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const originalId = await startSentWorkflow(base, token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      await waitForRunToFinish(base, token, originalId);

      // Leaving mode out is a re-stamp too: the controller never falls back
      // to replay on its own.
      for (const body of [{}, { mode: "re-stamp" }]) {
        await expectRerunRefused(
          harness,
          await requestRerun(base, token, originalId, body),
          {
            status: 409,
            code: "invalid_state",
            message: `This run's workflow was sent with run.start and never stored, so there is no stored workflow to re-stamp from. ${REPLAY_HINT}`,
          },
          1,
        );
      }
    });
  });

  it("a re-stamp of a run whose workflow has been deleted, with invalid_state that points to replay", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const original = await runInputsWorkflow(base, token);
      const deleted = await del(base, `/api/v1/workflows/${original.workflowId}`, token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      await expectRerunRefused(
        harness,
        await requestRerun(base, token, original.runId),
        {
          status: 409,
          code: "invalid_state",
          message: `This run's workflow has been deleted, so there is no stored workflow to re-stamp from. ${REPLAY_HINT}`,
        },
        1,
      );
    });
  });

  it("a re-stamp whose stored workflow no longer accepts the original's inputs, with validation that points to replay", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const original = await runInputsWorkflow(base, token);
      // The edit removes the `priority` input the original resolved, and
      // adds a required `owner` input the original never had.
      const edited = await updateWorkflow(base, token, original.workflowId, {
        definition: {
          name: "File a task for an owner",
          inputs: [
            { name: "title", schema: { type: "string", minLength: 1 }, required: true },
            { name: "owner", schema: { type: "string" }, required: true },
          ],
          steps: [buildCreateStep("create")],
        },
      });
      expect(edited.status, await edited.clone().text()).toBe(200);

      const response = await requestRerun(base, token, original.runId);
      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.message).toBe(`the inputs are not valid. ${REPLAY_HINT}`);
      expect(refusal.issues.toSorted()).toEqual([
        ["inputs", "owner"],
        ["inputs", "priority"],
      ]);
      expect(await countRuns(harness)).toBe(1);

      // Replay runs the original's plan, which still accepts its inputs.
      const rerunId = await rerunRun(base, token, original.runId, { mode: "replay" });
      const rerun = await waitForRunToFinish(base, token, rerunId);
      expect(rerun.status).toBe("completed");
      expect(rerun.inputs).toEqual(RESOLVED_INPUTS);
    });
  });

  it("a re-stamp whose stored workflow names an action that no longer exists, and a replay of the same plan, with validation", async () => {
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
        const originalId = await startRun(base, token, workflow.id);
        await waitForRunToFinish(base, token, originalId);
        // The step's action disappears with its plugin, so neither the
        // stored workflow nor the original's plan can run any more.
        await disablePlugin(base, token, "notes");

        const restamp = await requestRerun(base, token, originalId);
        const restampRefusal = await readErrorBody(restamp);
        expect(restamp.status, restampRefusal.text).toBe(400);
        expect(restampRefusal.code).toBe("validation");
        expect(restampRefusal.message).toBe(
          `this workflow cannot run as it is saved now. ${REPLAY_HINT}`,
        );
        expect(restampRefusal.issues).toEqual([["steps", "0", "action"]]);

        const replay = await requestRerun(base, token, originalId, { mode: "replay" });
        const replayRefusal = await readErrorBody(replay);
        expect(replay.status, replayRefusal.text).toBe(400);
        expect(replayRefusal.code).toBe("validation");
        expect(replayRefusal.message).toBe("the original run's plan cannot run any more");
        expect(replayRefusal.issues).toEqual([["steps", "0", "action"]]);

        expect(await countRuns(harness)).toBe(1);
      },
      [buildActionPlugin("notes", NOTE_APPEND_ACTION)],
    );
  });
});

/* ------------------------------------------------------------------------ */
/* The re-runs of a run.                                                     */
/* ------------------------------------------------------------------------ */

describe("GET /runs?originalRunId=", () => {
  it("lists only the direct re-runs of the run, newest first, and each re-run names the original when read", async () => {
    await withSetUpController(async ({ base, token }) => {
      const original = await runInputsWorkflow(base, token);
      const other = await runInputsWorkflow(base, token);
      const rerunIds: Array<string> = [];
      for (const mode of ["re-stamp", "replay"]) {
        const rerunId = await rerunRun(base, token, original.runId, { mode });
        await waitForRunToFinish(base, token, rerunId);
        rerunIds.push(rerunId);
      }
      // A re-run of another run, and a re-run of a re-run, are not re-runs
      // of the original.
      await waitForRunToFinish(base, token, await rerunRun(base, token, other.runId));
      await waitForRunToFinish(base, token, await rerunRun(base, token, rerunIds[0]!));

      const page = await queryRuns(base, token, `originalRunId=${original.runId}`);

      expect(page.items.map((summary) => summary.id)).toEqual(rerunIds.toReversed());
      expect(page.nextCursor).toBeUndefined();
      // The summary leaves the original out; reading the run shows it.
      expect(page.items[0]).not.toHaveProperty("originalRunId");
      expect((await readRun(base, token, rerunIds[1]!)).originalRunId).toBe(original.runId);
      expect(await readRun(base, token, original.runId)).not.toHaveProperty("originalRunId");
    });
  });
});
