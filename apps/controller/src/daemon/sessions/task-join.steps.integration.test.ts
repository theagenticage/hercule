/**
 * Tests the Task of a workflow run's step sessions, and of a fork of one
 * (spec 09, "Which Task a session gets"). The run is started by handing a
 * signal off, so it has a Task, in a workflow with two agent steps in one ephemeral
 * workspace.
 *
 * - A step session takes its run's Task as it is, even a finished one, and
 *   writes no `task_workspaces` row.
 * - A fork of a step session is an Agent's session: it takes its parent's Task
 *   when that is live, falls through when it is finished, and never makes a
 *   Task.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Session } from "@hercule/contract";
import { mintUuid, uuidToString, withTransaction } from "../../db";
import { post, send, type ServerHarness } from "../../http/testing";
import { findStepRecords, readRun } from "../../runs/testing";
import { signalRepository } from "../../signals";
import {
  at,
  readSession,
  reportEvent,
  waitForSession,
  waitUntil,
  WAIT_DEADLINE_MS,
  type Arranged,
} from "../../sessions/testing";
import { createAgent, createWorkflowOrFail, updateWorkflow } from "../../workflows/testing";
import { createRepo, reportWorkspaceReady, withFleet } from "../../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 });

const SIGNAL_KIND = "forge/assigned";

/**
 * Writes an open signal of a plugin's kind that offers a handoff to the
 * workflow, and returns its id. No operation raises one without a running
 * plugin.
 */
const insertSignal = async ({ sql }: ServerHarness, workflowId: string): Promise<string> => {
  const id = uuidToString(mintUuid());
  await Effect.runPromise(
    Effect.orDie(
      withTransaction(
        sql,
        Effect.gen(function* () {
          const signals = yield* signalRepository;
          yield* signals.insert(
            {
              id,
              kind: SIGNAL_KIND,
              origin: {
                type: "event",
                eventId: 1,
                connectionId: "0199e0e7-0000-7000-8000-00000000c001",
                threadRef: "forge:issue:acme/api#7",
              },
              title: "Retry failed webhooks",
              place: "acme/api#7",
              priority: "normal",
              blocks: [],
              actions: [
                {
                  id: `hand-to-${workflowId}`,
                  label: "Hand to the workflow",
                  operation: { op: "signal.handOff", input: { signalId: id, workflowId } },
                },
              ],
              match: {},
              status: "open",
              createdAt: "2026-10-20T10:00:00.000Z",
            },
            [],
          );
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
    ),
  );
  return id;
};

/** Counts the rows of `task_workspaces`. */
const countWorkspaceTasks = async (arranged: Arranged): Promise<number> => {
  const [row] = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM task_workspaces`,
    ),
  );
  return row!.n;
};

/** Counts every Task row and every `task.created` event. */
const countTasks = async (arranged: Arranged): Promise<readonly [number, number]> => {
  const [row] = await Effect.runPromise(
    Effect.orDie(arranged.harness.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks`),
  );
  return [row!.n, (await arranged.harness.platformEvents("task.created")).length];
};

/** Reports an event of a session; the runner numbers a session's events from 1. */
const report = (arranged: Arranged, sessionId: string, seq: number, event: object): void =>
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    ...event,
  } as Parameters<typeof reportEvent>[2]);

/** Waits until the run's step has a session, and returns the session's id. */
const waitForStepSession = (arranged: Arranged, runId: string, stepId: string): Promise<string> =>
  waitUntil(`gave the step ${stepId} a session`, async () => {
    const run = await readRun(arranged.harness.base, arranged.token, runId);
    return findStepRecords(run, stepId)[0]?.sessionId ?? undefined;
  });

/**
 * Plays the runner for one step: the session starts, its turn runs, the step's
 * result is sent, and the turn ends. Reports events 1 to 3 of the session.
 */
const runStep = async (arranged: Arranged, runId: string, stepId: string): Promise<string> => {
  const sessionId = await waitForStepSession(arranged, runId, stepId);
  await waitForSession(arranged, sessionId, (one) => one.status !== "queued");
  const turnId = `${stepId}-1`;
  report(arranged, sessionId, 1, {
    _tag: "session.started",
    harnessRefs: { nativeSessionId: `native-${stepId}` },
  });
  report(arranged, sessionId, 2, { _tag: "turn.started", turnId });
  arranged.wire.send({
    _tag: "workspaceStepResult",
    runId,
    stepId,
    iteration: 1,
    outcome: { status: "completed", output: { text: "done", exitStatus: "completed" } },
  });
  report(arranged, sessionId, 3, { _tag: "turn.completed", turnId, state: "completed" });
  return sessionId;
};

describe("the Task of a workflow run's step sessions", () => {
  it("is the run's Task, even a finished one, with no workspace row; a fork of a step session never makes a Task", async () => {
    await withFleet(async (arranged) => {
      const { base } = arranged.harness;
      const repo = await createRepo(arranged, "https://github.com/acme/web");
      const agentId = await createAgent(base, arranged.token);
      const workflow = await createWorkflowOrFail(base, arranged.token, {
        definition: {
          name: "Implement, then review",
          inputs: [{ name: "signal", signal: { kinds: [SIGNAL_KIND] }, required: true }],
          workspace: { kind: "ephemeral", checkouts: [{ resourceId: repo }] },
          steps: [
            { id: "implement", kind: "agent", agent: agentId, prompt: "Implement the change." },
            { id: "review", kind: "agent", agent: agentId, prompt: "Review the change." },
          ],
          edges: [{ from: "implement", to: "review" }],
        },
      });
      const enabled = await updateWorkflow(base, arranged.token, workflow.id, { enabled: true });
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const signalId = await insertSignal(arranged.harness, workflow.id);

      const handedOff = await post(
        base,
        `/api/v1/signals/${signalId}/hand-off`,
        { workflowId: workflow.id },
        arranged.token,
      );
      expect(handedOff.status, await handedOff.clone().text()).toBe(200);
      const runId = ((await handedOff.json()) as { resolution: { runId: string } }).resolution
        .runId;
      const run = await readRun(base, arranged.token, runId);
      const taskId = run.taskId!;
      expect(taskId).toBeDefined();
      await waitUntil("provisioned the run's workspace", () => {
        const frame = arranged.wire.frames.find((one) => one._tag === "workspaceProvision");
        return frame === undefined
          ? undefined
          : (frame as unknown as { workspaceId: string }).workspaceId;
      }).then((workspaceId) => reportWorkspaceReady(arranged, workspaceId));

      // The first step's session takes the run's live Task.
      const implement = await runStep(arranged, runId, "implement");
      expect((await readSession(arranged, implement)).taskId).toBe(taskId);

      // The Task is finished before the second step opens its session.
      const finished = await send("PATCH", base, `/api/v1/tasks/${taskId}`, {
        body: { stage: "done" },
        token: arranged.token,
      });
      expect(finished.status, await finished.clone().text()).toBe(200);
      const review = await runStep(arranged, runId, "review");
      const reviewSession = await readSession(arranged, review);
      expect(reviewSession.taskId).toBe(taskId);
      expect(reviewSession.workspaceId).not.toBeNull();
      expect(await countWorkspaceTasks(arranged)).toBe(0);

      // A fork of the second step's session: its parent's Task is finished, the
      // workspace has no Task, so it has none and makes none.
      await waitUntil("ended the run", async () => {
        const ended = await readRun(base, arranged.token, runId);
        return ended.status === "completed" ? ended : undefined;
      });
      report(arranged, review, 4, { _tag: "session.exited", reason: "stopped" });
      await waitForSession(arranged, review, (one) => one.status === "exited");
      const fork = async (): Promise<Session> => {
        const response = await post(
          base,
          `/api/v1/sessions/${review}/continue`,
          { mode: "fork", prompt: "carry on" },
          arranged.token,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        return (await response.json()) as Session;
      };
      const before = await countTasks(arranged);
      const orphan = await fork();
      expect((await readSession(arranged, orphan.id)).taskId).toBeUndefined();
      expect(await countTasks(arranged)).toEqual(before);

      // Once the Task is live again, a fork takes it, and still makes no Task.
      const reopened = await send("PATCH", base, `/api/v1/tasks/${taskId}`, {
        body: { stage: "building" },
        token: arranged.token,
      });
      expect(reopened.status, await reopened.clone().text()).toBe(200);
      const adopted = await fork();
      expect((await readSession(arranged, adopted.id)).taskId).toBe(taskId);
      expect(await countTasks(arranged)).toEqual(before);
    });
  });
});
