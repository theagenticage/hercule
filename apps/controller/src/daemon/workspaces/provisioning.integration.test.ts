/**
 * Integration tests for the workspace sweep on the workspaces of runs, and
 * for `workspace.dispose` on them. Runs are started through the API with a
 * `git.commit` step in an ephemeral workspace, and the test plays the runner:
 * it reports the workspace ready and sends the step's result.
 *
 * What happens to a run's workspace follows how the run ended:
 *
 * - unfinished: never touched, and `workspace.dispose` refuses it
 * - completed: deleted by the next sweep
 * - cancelled without keeping it: deleted by the next sweep
 * - failed, or cancelled with `keepWorkspace`: kept for the failed-run
 *   window, then deleted
 *
 * The sweep interval is shortened, as in the thread sweep's tests, and the
 * failed-run window is crossed by moving the run's finish time back rather
 * than by waiting.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import type { Run } from "@hercule/contract";
import { del, get, post } from "../../http/testing";
import { readRun, startSentWorkflow, waitForRun } from "../../runs/testing";
import { waitUntil, WAIT_DEADLINE_MS, type Arranged } from "../../sessions/testing";
import {
  createRepo,
  listFramesTagged,
  readWorkspace,
  reportWorkspaceReady,
  withFleet,
  type WorkspaceRecord,
} from "../../workspaces/testing";

const SWEEP = Duration.millis(50);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Starts a run that commits in an ephemeral workspace of a repo, then files a task. */
const startCommitRun = (arranged: Arranged, repoId: string): Promise<string> =>
  startSentWorkflow(arranged.harness.base, arranged.token, {
    definition: {
      name: "Commit, then file a task",
      workspace: { kind: "ephemeral", checkouts: [{ resourceId: repoId }] },
      steps: [
        { id: "commit", kind: "action", action: "git.commit", params: { message: "Save" } },
        {
          id: "file",
          kind: "action",
          action: "task.create",
          params: { title: "Saved", description: "" },
        },
      ],
      edges: [{ from: "commit", to: "file" }],
    },
  });

/**
 * Waits until the runner has been sent the run's `commit` step, reports the
 * run's workspace ready, and returns the workspace id.
 */
const readyWorkspaceOf = async (arranged: Arranged, runId: string): Promise<string> => {
  const start = await waitUntil("sent the commit step", () =>
    listFramesTagged(arranged.wire, "workspaceStepStart").find((frame) => frame["runId"] === runId),
  );
  const workspaceId = String(start["workspaceId"]);
  await reportWorkspaceReady(arranged, workspaceId);
  return workspaceId;
};

/** Sends the result of a run's `commit` step, as its runner does. */
const finishCommit = (
  arranged: Arranged,
  runId: string,
  outcome:
    | { readonly status: "completed"; readonly output: unknown }
    | { readonly status: "failed"; readonly code: "action_failed"; readonly message: string },
): void => {
  arranged.wire.send({
    _tag: "workspaceStepResult",
    runId,
    stepId: "commit",
    iteration: 1,
    outcome: outcome as never,
  });
};

const waitForRunTo = (arranged: Arranged, runId: string, status: Run["status"]): Promise<Run> =>
  waitForRun(arranged.harness.base, arranged.token, runId, status, (run) => run.status === status);

const cancelRun = async (arranged: Arranged, runId: string, body: unknown): Promise<Run> => {
  const response = await post(
    arranged.harness.base,
    `/api/v1/runs/${runId}/cancel`,
    body,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Run;
};

const waitForDeleted = (arranged: Arranged, id: string): Promise<WorkspaceRecord> =>
  waitUntil("deleted the workspace", async () => {
    const one = await readWorkspace(arranged, id);
    return one.status === "deleted" ? one : undefined;
  });

/** Moves a workspace's timestamps back, so no thread window can be what keeps it. */
const ageWorkspace = (arranged: Arranged, id: string, days: number): Promise<unknown> =>
  Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql`
        UPDATE workspaces
        SET last_used_at = ${new Date(Date.now() - days * DAY_MS).toISOString()},
            created_at = ${new Date(Date.now() - days * DAY_MS).toISOString()}
        WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );

/** Moves a run's finish time back by `days`, which is how these tests cross the failed-run window. */
const ageRun = (arranged: Arranged, id: string, days: number): Promise<unknown> =>
  Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql`
        UPDATE runs SET finished_at = ${new Date(Date.now() - days * DAY_MS).toISOString()}
        WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );

/** Returns the reason of each `workspace.deleted` audit entry, by workspace id. */
const readDeletionReasons = async (arranged: Arranged): Promise<Record<string, unknown>> => {
  const response = await get(arranged.harness.base, "/api/v1/events", arranged.token);
  const log = (await response.json()) as {
    readonly items: ReadonlyArray<{
      readonly kind: string;
      readonly payload: Record<string, unknown>;
    }>;
  };
  return Object.fromEntries(
    log.items
      .filter((entry) => entry.kind === "workspace.deleted")
      .map((entry): [string, unknown] => [
        String(entry.payload["workspaceId"]),
        entry.payload["reason"],
      ]),
  );
};

/** Waits for six sweep intervals, so a workspace that still exists is one the sweep kept. */
const waitForSeveralSweeps = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Duration.toMillis(SWEEP) * 6));

describe("the sweep on the workspaces of runs", () => {
  it(
    "leaves an unfinished run's workspace alone and refuses to dispose of it, and deletes it once the run completes or is cancelled",
    async () => {
      await withFleet(
        async (arranged) => {
          const repoId = await createRepo(arranged, "https://github.com/o/sweep.git");

          // An unfinished run, whose workspace is older than any thread window.
          const waiting = await startCommitRun(arranged, repoId);
          const waitingWorkspace = await readyWorkspaceOf(arranged, waiting);
          await ageWorkspace(arranged, waitingWorkspace, 90);

          const refused = await del(
            arranged.harness.base,
            `/api/v1/workspaces/${waitingWorkspace}`,
            arranged.token,
          );
          expect(refused.status).toBe(409);
          expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(
            /cancel the run first/,
          );

          const completing = await startCommitRun(arranged, repoId);
          const completedWorkspace = await readyWorkspaceOf(arranged, completing);
          finishCommit(arranged, completing, {
            status: "completed",
            output: { sha: "abc123", branch: `hercule/run-${completing}`, committed: true },
          });
          const completed = await waitForRunTo(arranged, completing, "completed");
          expect(completed.workspaceKeptUntil).toBeUndefined();

          // Once a sweep has deleted the completed run's workspace, the
          // unfinished run's workspace, which is older, is still ready: the
          // sweep leaves out the workspace of an unfinished run.
          await waitForDeleted(arranged, completedWorkspace);
          expect((await readWorkspace(arranged, waitingWorkspace)).status).toBe("ready");

          const cancelled = await cancelRun(arranged, waiting, {});
          expect(cancelled.workspaceKeptUntil).toBeUndefined();
          await waitForDeleted(arranged, waitingWorkspace);

          expect(await readDeletionReasons(arranged)).toEqual({
            [completedWorkspace]: "run-completed",
            [waitingWorkspace]: "run-cancelled",
          });
        },
        { workspaceSweepInterval: SWEEP },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "keeps the workspace of a failed run, and of a run cancelled with its workspace kept, for the failed-run window",
    async () => {
      await withFleet(
        async (arranged) => {
          const repoId = await createRepo(arranged, "https://github.com/o/kept.git");

          const failing = await startCommitRun(arranged, repoId);
          const failedWorkspace = await readyWorkspaceOf(arranged, failing);
          finishCommit(arranged, failing, {
            status: "failed",
            code: "action_failed",
            message: "nothing to commit",
          });
          const failed = await waitForRunTo(arranged, failing, "failed");

          const keeping = await startCommitRun(arranged, repoId);
          const keptWorkspace = await readyWorkspaceOf(arranged, keeping);
          const kept = await cancelRun(arranged, keeping, { keepWorkspace: true });

          // The window runs from when each run finished: fourteen days by default.
          for (const run of [failed, kept]) {
            if (run.status !== "failed" && run.status !== "cancelled") throw new Error("unended");
            expect(run.workspaceKeptUntil).toBe(
              new Date(Date.parse(run.finishedAt) + 14 * DAY_MS).toISOString(),
            );
          }
          expect(await readRun(arranged.harness.base, arranged.token, keeping)).toEqual(kept);

          await ageWorkspace(arranged, failedWorkspace, 90);
          await ageWorkspace(arranged, keptWorkspace, 90);
          await waitForSeveralSweeps();
          expect((await readWorkspace(arranged, failedWorkspace)).status).toBe("ready");
          expect((await readWorkspace(arranged, keptWorkspace)).status).toBe("ready");

          await ageRun(arranged, failing, 15);
          await ageRun(arranged, keeping, 15);
          await waitForDeleted(arranged, failedWorkspace);
          await waitForDeleted(arranged, keptWorkspace);
          expect(await readDeletionReasons(arranged)).toEqual({
            [failedWorkspace]: "run-failed",
            [keptWorkspace]: "run-kept",
          });
        },
        { workspaceSweepInterval: SWEEP },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );
});
