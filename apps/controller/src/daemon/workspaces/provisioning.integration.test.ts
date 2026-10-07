/**
 * Integration tests for the workspace sweep on the workspaces of runs, and
 * for `workspace.dispose` on them. Runs are started through the API with a
 * `git.commit` step in an ephemeral workspace, and the test plays the runner:
 * it reports the workspace ready and sends the step's result.
 *
 * A run holds a lease on its workspace until it ends, and then releases it
 * with a retention that follows how it ended:
 *
 * - unfinished: the lease is active, so the sweep never touches the
 *   workspace and `workspace.dispose` refuses it
 * - completed, or cancelled without keeping it: `none`, so the next sweep
 *   deletes it
 * - failed, or cancelled with `keepWorkspace`: `inspection`, so it is kept
 *   for the inspection window, then deleted
 *
 * A thread that joins the workspace holds a lease of its own, and the
 * workspace becomes manual before the run can finish. Its files remain until explicit disposal.
 *
 * The sweep interval is shortened, as in the thread sweep's tests, and the
 * windows are crossed by moving the leases back rather than by waiting.
 */
import { describe, expect, it } from "vitest";
import { Duration } from "effect";
import type { WorkspaceDispose } from "@hercule/protocol";
import type { Run } from "@hercule/contract";
import { del, post } from "../../http/testing";
import { readRun, startSentWorkflow, waitForRunTo } from "../../runs/testing";
import { waitUntil, WAIT_DEADLINE_MS, type Arranged } from "../../sessions/testing";
import {
  ageLeases,
  createRepo,
  endResumable,
  listFramesTagged,
  listWorkspaceDeletions,
  readWorkspace,
  reportWorkspaceReady,
  spawnThread,
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

/** Waits until a run's status is `status`, and returns the run. */
const waitForRunStatus = (arranged: Arranged, runId: string, status: Run["status"]): Promise<Run> =>
  waitForRunTo(arranged, runId, status, (run) => run.status === status);

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

const waitForDeleted = async (arranged: Arranged, id: string): Promise<WorkspaceRecord> => {
  const frame = await waitUntil(
    "reserved removal before runner confirmation",
    () =>
      listFramesTagged(arranged.wire, "workspaceDispose").find(
        (item) => item["workspaceId"] === id,
      ) as WorkspaceDispose | undefined,
  );
  expect((await readWorkspace(arranged, id)).status).toBe("disposing");
  expect(frame.discardChanges ?? false).toBe(false);
  expect(frame.requestId).toEqual(expect.any(String));
  arranged.wire.send({
    _tag: "workspaceReport",
    workspaceId: id,
    requestId: frame.requestId!,
    status: "deleted",
  });
  return await waitUntil("recorded confirmed deletion", async () => {
    const one = await readWorkspace(arranged, id);
    return one.status === "deleted" ? one : undefined;
  });
};

/** Returns the reason and the holder of each `workspace.deleted` audit entry, by workspace id. */
const readDeletionReasons = async (arranged: Arranged): Promise<Record<string, unknown>> =>
  Object.fromEntries(
    (await listWorkspaceDeletions(arranged)).map((entry): [string, unknown] => [
      String(entry.payload["workspaceId"]),
      { reason: entry.payload["reason"], holder: entry.payload["holder"] },
    ]),
  );

/** Returns the time `days` after `from`, as the API writes a timestamp. */
const addDays = (from: string, days: number): string =>
  new Date(Date.parse(from) + days * DAY_MS).toISOString();

/** Reads the message of an error response. */
const readErrorMessage = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { message: string } }).error.message;

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

          const waiting = await startCommitRun(arranged, repoId);
          const waitingWorkspace = await readyWorkspaceOf(arranged, waiting);
          expect((await readWorkspace(arranged, waitingWorkspace)).keptUntil).toBeNull();

          const refused = await del(
            arranged.harness.base,
            `/api/v1/workspaces/${waitingWorkspace}`,
            arranged.token,
          );
          expect(refused.status).toBe(409);
          expect(await readErrorMessage(refused)).toMatch(`cancel run ${waiting} first`);

          const completing = await startCommitRun(arranged, repoId);
          const completedWorkspace = await readyWorkspaceOf(arranged, completing);
          finishCommit(arranged, completing, {
            status: "completed",
            output: { sha: "abc123", branch: `hercule/run-${completing}`, committed: true },
          });
          const completed = await waitForRunStatus(arranged, completing, "completed");
          expect(completed).not.toHaveProperty("workspaceKeptUntil");

          // Once a sweep has deleted the completed run's workspace, the
          // unfinished run's workspace is still ready: its lease is active.
          const gone = await waitForDeleted(arranged, completedWorkspace);
          expect(gone.keptUntil).toBeNull();
          expect((await readWorkspace(arranged, waitingWorkspace)).status).toBe("ready");

          await cancelRun(arranged, waiting, {});
          await waitForDeleted(arranged, waitingWorkspace);

          expect(await readDeletionReasons(arranged)).toEqual({
            [completedWorkspace]: { reason: "none", holder: `run:${completing}` },
            [waitingWorkspace]: { reason: "none", holder: `run:${waiting}` },
          });
        },
        { workspaceSweepInterval: SWEEP },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "names both the run and the thread in its refusal to dispose of a workspace they both use",
    async () => {
      await withFleet(async (arranged) => {
        const repoId = await createRepo(arranged, "https://github.com/o/shared.git");
        const running = await startCommitRun(arranged, repoId);
        const workspaceId = await readyWorkspaceOf(arranged, running);
        const thread = await spawnThread(arranged, { kind: "existing", workspaceId }, 1);

        const refused = await del(
          arranged.harness.base,
          `/api/v1/workspaces/${workspaceId}`,
          arranged.token,
        );
        expect(refused.status).toBe(409);
        const message = await readErrorMessage(refused);
        expect(message).toContain(`cancel run ${running} first`);
        expect(message).toContain(`stop sessions ${thread.id} first`);
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "keeps the workspace of a failed run, and of a run cancelled with its workspace kept, for the inspection window",
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
          const failed = await waitForRunStatus(arranged, failing, "failed");

          const keeping = await startCommitRun(arranged, repoId);
          const keptWorkspace = await readyWorkspaceOf(arranged, keeping);
          const kept = await cancelRun(arranged, keeping, { keepWorkspace: true });
          expect(await readRun(arranged.harness.base, arranged.token, keeping)).toEqual(kept);

          // The window runs from when each run finished: fourteen days by default.
          for (const [run, workspaceId] of [
            [failed, failedWorkspace],
            [kept, keptWorkspace],
          ] as const) {
            if (run.status !== "failed" && run.status !== "cancelled") throw new Error("unended");
            expect((await readWorkspace(arranged, workspaceId)).keptUntil).toBe(
              addDays(run.finishedAt, 14),
            );
          }

          await ageLeases(arranged, failedWorkspace, 13 * 24);
          await ageLeases(arranged, keptWorkspace, 13 * 24);
          await waitForSeveralSweeps();
          expect((await readWorkspace(arranged, failedWorkspace)).status).toBe("ready");
          expect((await readWorkspace(arranged, keptWorkspace)).status).toBe("ready");

          await ageLeases(arranged, failedWorkspace, 2 * 24);
          await ageLeases(arranged, keptWorkspace, 2 * 24);
          await waitForDeleted(arranged, failedWorkspace);
          await waitForDeleted(arranged, keptWorkspace);
          expect(await readDeletionReasons(arranged)).toEqual({
            [failedWorkspace]: { reason: "inspection", holder: `run:${failing}` },
            [keptWorkspace]: { reason: "inspection", holder: `run:${keeping}` },
          });
        },
        { workspaceSweepInterval: SWEEP },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "keeps a failed run workspace indefinitely after a human Thread joins it",
    async () => {
      await withFleet(
        async (arranged) => {
          const repoId = await createRepo(arranged, "https://github.com/o/joined.git");
          const failing = await startCommitRun(arranged, repoId);
          const workspaceId = await readyWorkspaceOf(arranged, failing);
          finishCommit(arranged, failing, {
            status: "failed",
            code: "action_failed",
            message: "nothing to commit",
          });
          await waitForRunStatus(arranged, failing, "failed");

          // A thread opened in the failed run's workspace, to look at what it left.
          const thread = await spawnThread(arranged, { kind: "existing", workspaceId }, 1);
          const joined = await readWorkspace(arranged, workspaceId);
          expect(joined.sessionIds).toEqual([thread.id]);
          expect(joined.keptUntil).toBeNull();

          const refused = await del(
            arranged.harness.base,
            `/api/v1/workspaces/${workspaceId}`,
            arranged.token,
          );
          expect(refused.status).toBe(409);
          expect(await readErrorMessage(refused)).toMatch(`stop sessions ${thread.id} first`);

          // The human Thread makes retention manual before releasing its active lease.
          await endResumable(arranged, thread);
          const released = await readWorkspace(arranged, workspaceId);
          expect(released.sessionIds).toEqual([]);
          expect(released.retentionPolicy).toBe("manual");
          expect(released.keptUntil).toBeNull();

          // Past the run's window, short of the thread's.
          await ageLeases(arranged, workspaceId, 15 * 24);
          await waitForSeveralSweeps();
          expect((await readWorkspace(arranged, workspaceId)).status).toBe("ready");

          await ageLeases(arranged, workspaceId, 16 * 24);
          const decoy = await startCommitRun(arranged, repoId);
          const decoyWorkspace = await readyWorkspaceOf(arranged, decoy);
          finishCommit(arranged, decoy, {
            status: "completed",
            output: { sha: "decoy", branch: "decoy", committed: true },
          });
          await waitForRunStatus(arranged, decoy, "completed");
          await waitForDeleted(arranged, decoyWorkspace);
          expect((await readWorkspace(arranged, workspaceId)).status).toBe("ready");
          expect(await readDeletionReasons(arranged)).toEqual({
            [decoyWorkspace]: { reason: "none", holder: `run:${decoy}` },
          });
        },
        { workspaceSweepInterval: SWEEP },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );
});
