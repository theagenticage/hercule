/**
 * Integration tests for the platform event a run emits when it ends, driven
 * over HTTP against a real controller: `run.completed`, `run.failed` or
 * `run.cancelled`, exactly one per run, with a payload built from the run
 * record, and stamped with the actor whose request ended the run, or with
 * `system` when the run ended on its own.
 *
 * The events are read back from the event log with the harness's
 * `platformEvents`, and once through the reader the event router uses, to
 * show they are pipeline events and not audit entries.
 *
 * No runner is connected: action steps run on the controller.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { ActionError } from "@hercule/plugin-host";
import type { Notification } from "@hercule/contract";
import { runEffect } from "../daemon/testing";
import { get } from "../http/testing";
import { buildActionPlugin } from "../plugins/testing";
import { readPipelineEvent, readPipelineEventsAfter } from "../events";
import { WAIT_DEADLINE_MS, waitUntil } from "../sessions/testing";
import { ABSENT_ID, createWorkflowOrFail, withSetUpController } from "../workflows/testing";
import {
  buildCreateStep,
  buildHeldAction,
  buildHeldStep,
  expectEnded,
  expectStatus,
  insertPendingRun,
  queryRuns,
  readRun,
  requestCancel,
  startHeldRun,
  startRun,
  waitForHeldExecutions,
  waitForRunToFinish,
  type EndedRun,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 10_000 });

/**
 * Returns the fields every run event's payload has, as the ended run's
 * record holds them. A run that never started has no `startedAt`, and
 * neither has its event.
 */
const buildExpectedFields = (run: EndedRun) => ({
  runId: run.id,
  workflowId: run.workflowId,
  origin: run.origin,
  inputs: run.inputs,
  ...("startedAt" in run && run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
  finishedAt: run.finishedAt,
});

/** A workflow with one input, whose one step creates a task and ends the run with it. */
const TERMINAL_DEFINITION = {
  name: "File a task and end",
  inputs: [{ name: "title", schema: { type: "string" }, required: true }],
  steps: [
    {
      id: "create",
      kind: "action",
      action: "task.create",
      params: { title: "{{ inputs.title }}", description: "" },
      terminal: true,
    },
  ],
};

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

/**
 * Builds a plugin whose one action, `refuse/on_abort`, waits until its run is
 * cancelled and then fails. A run engine that acted on that failure would
 * fail the run at the step after the cancel had already ended it.
 *
 * `started` and `failed` list the run id of each execution that has started,
 * and of each that has failed, so a test can wait for the action to be in
 * flight and check that it did fail after the cancel.
 */
const buildFailOnAbortAction = () => {
  const started: Array<string | undefined> = [];
  const failed: Array<string | undefined> = [];
  const plugin = buildActionPlugin("refuse", {
    id: "on_abort",
    displayName: "Fail on abort",
    description: "Waits until its run is cancelled, then fails.",
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    execute: (_input, context) =>
      Effect.callback<object, ActionError>((resume) => {
        started.push(context.run?.runId);
        context.signal.addEventListener("abort", () => {
          failed.push(context.run?.runId);
          resume(
            Effect.fail(new ActionError({ code: "aborted", message: "The run was cancelled." })),
          );
        });
      }),
  });
  return { plugin, started, failed };
};

/** The id of the pending run a test inserts. A UUIDv7, like every id the controller mints. */
const PENDING_RUN_ID = "0199f0b7-0000-7000-8000-00000000e101";

describe("the event a run emits when it ends on its own", () => {
  it("emits run.completed with the terminal step's output, stamped system and dated when the run ended", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: TERMINAL_DEFINITION,
      });

      const run = await waitForRunToFinish(
        base,
        token,
        await startRun(base, token, workflow.id, { inputs: { title: "Fix login" } }),
      );

      const completed = expectStatus(run, "completed");
      expect(completed.output).toMatchObject({ title: "Fix login" });
      const events = await harness.platformEvents("run.completed");
      expect(events).toEqual([
        {
          id: expect.any(Number) as unknown,
          kind: "run.completed",
          actor: "system",
          payload: { ...buildExpectedFields(completed), output: completed.output },
          receivedAt: completed.finishedAt,
        },
      ]);
      expect(events[0]!.payload).toMatchObject({
        workflowId: workflow.id,
        origin: { kind: "manual", actor: "user" },
        inputs: { title: "Fix login" },
      });
      expect(await harness.platformEvents("run.failed")).toEqual([]);
      expect(await harness.platformEvents("run.cancelled")).toEqual([]);
    });
  });

  it("leaves output out of run.completed when the run completed without a terminal step", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });

      const run = expectEnded(
        await waitForRunToFinish(base, token, await startRun(base, token, workflow.id)),
      );

      expect(run.status).toBe("completed");
      expect((await harness.platformEvents("run.completed")).map((event) => event.payload)).toEqual(
        [buildExpectedFields(run)],
      );
    });
  });

  it("emits run.failed naming the step the run failed at, with no failedEdge, stamped system", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, { definition: FAILING_DEFINITION });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      const failed = expectStatus(run, "failed");
      expect(await harness.platformEvents("run.failed")).toEqual([
        {
          id: expect.any(Number) as unknown,
          kind: "run.failed",
          actor: "system",
          payload: {
            ...buildExpectedFields(failed),
            failureReason: "step-failed",
            failedStepId: "update",
          },
          receivedAt: failed.finishedAt,
        },
      ]);
      expect(await harness.platformEvents("run.completed")).toEqual([]);
    });
  });

  it("raises a core.run-failed notification about the run and its workflow, linked to its run.failed event", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, { definition: FAILING_DEFINITION });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      expectStatus(run, "failed");
      const [event] = await harness.platformEvents("run.failed");
      const response = await get(base, "/api/v1/notifications", token);
      expect(response.status, await response.clone().text()).toBe(200);
      const { items } = (await response.json()) as { readonly items: ReadonlyArray<Notification> };
      expect(items).toEqual([
        {
          id: expect.any(String) as unknown,
          kind: "core.run-failed",
          title: "Run of Update a missing task failed",
          body: expect.stringMatching(/^Step `update` failed: /) as unknown,
          producer: { type: "core" },
          subject: [
            { kind: "run", id: run.id },
            { kind: "workflow", id: workflow.id },
          ],
          eventId: event!.id,
          actions: [],
          status: "resolved",
          createdAt: expect.any(String) as unknown,
        },
      ]);
    });
  });

  it("emits run.failed with the edge the run failed at, as the run record holds it", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "A broken edge condition",
          steps: [buildCreateStep("start"), buildCreateStep("next")],
          edges: [
            { from: "start", to: "next", condition: "steps.start.output.no_such_field == 1" },
          ],
        },
      });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      const failed = expectStatus(run, "failed");
      const failedEdge = "failedEdge" in failed ? failed.failedEdge : undefined;
      expect(failedEdge).toEqual({
        index: 0,
        message: expect.stringContaining("no_such_field") as unknown,
      });
      expect((await harness.platformEvents("run.failed")).map((event) => event.payload)).toEqual([
        {
          ...buildExpectedFields(failed),
          failureReason: "expression-error",
          failedStepId: "start",
          failedEdge,
        },
      ]);
    });
  });

  it("emits run.completed stamped system for a run a run's step started, and names the parent in its origin", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const child = await createWorkflowOrFail(base, token, {
        definition: { name: "Child", steps: [buildCreateStep("create")] },
      });
      const parent = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Parent",
          steps: [
            { id: "start", kind: "action", action: "run.start", params: { workflowId: child.id } },
          ],
        },
      });

      const parentId = await startRun(base, token, parent.id);
      await waitForRunToFinish(base, token, parentId);
      const [childSummary] = (await queryRuns(base, token, `actor=run:${parentId}`)).items;
      const childRun = expectEnded(await waitForRunToFinish(base, token, childSummary!.id));

      const events = await harness.platformEvents("run.completed");
      // Neither run was ended by a request: each ended when its last step did.
      expect(events.map((event) => event.actor)).toEqual(["system", "system"]);
      expect(events.find((event) => event.payload["runId"] === childRun.id)?.payload).toEqual({
        ...buildExpectedFields(childRun),
        origin: { kind: "action", parentRunId: parentId, stepId: "start" },
      });
    });
  });

  it("writes the event as a pipeline event, which the event router reads, and not as an audit entry", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: TERMINAL_DEFINITION,
      });
      const run = expectEnded(
        await waitForRunToFinish(
          base,
          token,
          await startRun(base, token, workflow.id, { inputs: { title: "Fix login" } }),
        ),
      );
      const [emitted] = await harness.platformEvents("run.completed");

      const routed = (await runEffect(readPipelineEventsAfter(harness.sql, 0, 1000))).filter(
        (event) => event.kind === "run.completed",
      );

      expect(routed).toEqual([
        expect.objectContaining({
          id: emitted!.id,
          source: "platform",
          connectionId: null,
          system: "platform",
          kind: "run.completed",
          occurredAt: run.finishedAt,
          receivedAt: run.finishedAt,
          refs: [],
          payload: emitted!.payload,
          actor: "system",
        }) as unknown,
      ]);
      const single = await runEffect(readPipelineEvent(harness.sql, emitted!.id));
      expect(single._tag).toBe("Some");
    });
  });
});

describe("the event a cancelled run emits", () => {
  it("emits run.cancelled with the user as actor and no startedAt for a run cancelled while pending", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        try {
          const definition = { name: "Wait", steps: [buildHeldStep(held, "first")] };
          const workflow = await createWorkflowOrFail(base, token, { definition });
          await insertPendingRun(harness, {
            id: PENDING_RUN_ID,
            workflowId: workflow.id,
            plan: definition,
            stepId: "first",
          });

          const response = await requestCancel(base, token, PENDING_RUN_ID);
          expect(response.status, await response.clone().text()).toBe(200);

          const run = expectEnded(await readRun(base, token, PENDING_RUN_ID));
          expect(run.status).toBe("cancelled");
          expect(await harness.platformEvents("run.cancelled")).toEqual([
            {
              id: expect.any(Number) as unknown,
              kind: "run.cancelled",
              actor: "user",
              payload: {
                runId: PENDING_RUN_ID,
                workflowId: workflow.id,
                origin: { kind: "manual", actor: "user" },
                inputs: {},
                finishedAt: run.finishedAt,
              },
              receivedAt: run.finishedAt,
            },
          ]);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("emits one run.cancelled for the run and one for each unfinished run it started, all with the user as actor", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        try {
          // The parent starts the child and then waits. The child waits too.
          const child = await createWorkflowOrFail(base, token, {
            definition: { name: "Child", steps: [buildHeldStep(held, "hold")] },
          });
          const parent = await createWorkflowOrFail(base, token, {
            definition: {
              name: "Parent",
              steps: [
                {
                  id: "start",
                  kind: "action",
                  action: "run.start",
                  params: { workflowId: child.id },
                },
                buildHeldStep(held, "hold"),
              ],
              edges: [{ from: "start", to: "hold" }],
            },
          });
          const parentId = await startRun(base, token, parent.id);
          await waitForHeldExecutions(held, 2);
          const [childSummary] = (await queryRuns(base, token, `actor=run:${parentId}`)).items;

          const response = await requestCancel(base, token, parentId);
          expect(response.status, await response.clone().text()).toBe(200);

          const parentRun = expectEnded(await waitForRunToFinish(base, token, parentId));
          const childRun = expectEnded(await waitForRunToFinish(base, token, childSummary!.id));
          expect([parentRun.status, childRun.status]).toEqual(["cancelled", "cancelled"]);
          const events = await harness.platformEvents("run.cancelled");
          expect(events.map((event) => [event.actor, event.payload])).toEqual([
            ["user", buildExpectedFields(parentRun)],
            ["user", buildExpectedFields(childRun)],
          ]);
          // Both runs were running, so both events have a startedAt.
          expect(events.every((event) => typeof event.payload["startedAt"] === "string")).toBe(
            true,
          );
          expect(childRun.origin).toEqual({
            kind: "action",
            parentRunId: parentId,
            stepId: "start",
          });
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("emits no second event when the run's action returns after the cancel, or when the run is cancelled again", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        try {
          const runId = await startHeldRun(base, token, held);

          const cancelled = await requestCancel(base, token, runId);
          expect(cancelled.status, await cancelled.clone().text()).toBe(200);
          // The held action returns once its signal aborts, after the run
          // has already ended.
          await waitUntil("aborted the held action's signal", () =>
            held.contexts.every((context) => context.signal.aborted) ? true : undefined,
          );
          const again = await requestCancel(base, token, runId);
          expect(again.status, await again.clone().text()).toBe(409);
          await waitForRunToFinish(base, token, runId);

          expect(
            (await harness.platformEvents("run.cancelled")).map((event) => event.payload["runId"]),
          ).toEqual([runId]);
          expect(await harness.platformEvents("run.completed")).toEqual([]);
          expect(await harness.platformEvents("run.failed")).toEqual([]);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("emits no run.failed when the run's action fails after the cancel", async () => {
    const failOnAbort = buildFailOnAbortAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        const workflow = await createWorkflowOrFail(base, token, {
          definition: {
            name: "Fail once cancelled",
            steps: [{ id: "refuse", kind: "action", action: "refuse/on_abort", params: {} }],
          },
        });
        const runId = await startRun(base, token, workflow.id);
        await waitUntil("started the refusing action", () =>
          failOnAbort.started.includes(runId) ? true : undefined,
        );

        const cancelled = await requestCancel(base, token, runId);
        expect(cancelled.status, await cancelled.clone().text()).toBe(200);

        // The run's fiber ends only once its steps have stopped, so by then
        // the action has failed, and the engine has done all it ever will
        // with that failure.
        await waitUntil("stopped executing the run", () =>
          harness.isRunExecuting(runId) ? undefined : true,
        );
        expect(failOnAbort.failed).toEqual([runId]);
        expect((await readRun(base, token, runId)).status).toBe("cancelled");
        expect(
          (await harness.platformEvents("run.cancelled")).map((event) => event.payload["runId"]),
        ).toEqual([runId]);
        expect(await harness.platformEvents("run.failed")).toEqual([]);
      },
      [failOnAbort.plugin],
    );
  });
});
