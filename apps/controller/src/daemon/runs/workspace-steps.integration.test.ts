/**
 * Integration tests for workspace steps over the real runner socket: a run
 * started through the API hands its `git.commit` step to a fake runner, and
 * the test plays that runner, sending results, reports and reconnects the
 * way a real runner does.
 */
import { describe, expect, it } from "vitest";
import type { Run } from "@hercule/contract";
import { get, send } from "../../http/testing";
import {
  findStepRecords,
  readRun,
  requestCancel,
  startSentWorkflow,
  waitForRun,
} from "../../runs/testing";
import { waitUntil, WAIT_DEADLINE_MS, type Arranged, type Wire } from "../../sessions/testing";
import { createRepo, listFramesTagged, withFleet, type Frame } from "../../workspaces/testing";

/** What `git.commit` returns, as a runner reports it. */
const COMMITTED = { sha: "abc123", branch: "hercule/run-x", committed: true };

/** A workflow that commits in the run's workspace, then files a task titled with the commit's sha. */
const buildCommitDefinition = (workspace: Record<string, unknown>) => ({
  name: "Commit, then file a task",
  workspace,
  steps: [
    { id: "commit", kind: "action", action: "git.commit", params: { message: "Save the work" } },
    {
      id: "file",
      kind: "action",
      action: "task.create",
      params: { title: "Committed {{ steps.commit.output.sha }}", description: "" },
    },
  ],
  edges: [{ from: "commit", to: "file" }],
});

/** Starts a run that commits in an ephemeral workspace with one checkout of a new repo. */
const startCommitRun = async (arranged: Arranged, repoId: string): Promise<string> =>
  startSentWorkflow(arranged.harness.base, arranged.token, {
    definition: buildCommitDefinition({ kind: "ephemeral", checkouts: [{ resourceId: repoId }] }),
  });

/** The step key of a run's `commit` step. */
const commitKey = (runId: string) => ({ runId, stepId: "commit", iteration: 1 });

/** Waits until a frame with this tag that matches `matches` has arrived, and returns it. */
const waitForFrame = (
  wire: Wire,
  tag: string,
  matches: (frame: Frame) => boolean = () => true,
): Promise<Frame> =>
  waitUntil(`sent a matching ${tag} frame`, () => listFramesTagged(wire, tag).find(matches));

/** Waits until the runner has been sent the start of a run's `commit` step, and returns that frame. */
const waitForStepStart = (wire: Wire, runId: string): Promise<Frame> =>
  waitForFrame(wire, "workspaceStepStart", (frame) => frame["runId"] === runId);

/** Checks whether a stop frame names the given step key. */
const namesStep =
  (key: ReturnType<typeof commitKey>) =>
  (frame: Frame): boolean =>
    (frame["steps"] as ReadonlyArray<unknown>).some(
      (step) => JSON.stringify(step) === JSON.stringify(key),
    );

/** Counts the stop frames that name a step key. */
const countStops = (wire: Wire, key: ReturnType<typeof commitKey>): number =>
  listFramesTagged(wire, "workspaceStepStop").filter(namesStep(key)).length;

/** Reads a run until `holds` is true for it. */
const waitForRunTo = (
  arranged: Arranged,
  runId: string,
  what: string,
  holds: (run: Run) => boolean,
) => waitForRun(arranged.harness.base, arranged.token, runId, what, holds);

/** Reads the status of a run's `commit` step record. */
const readCommitStatus = async (arranged: Arranged, runId: string): Promise<string | undefined> =>
  findStepRecords(await readRun(arranged.harness.base, arranged.token, runId), "commit")[0]?.status;

/**
 * Waits until the runner no longer reads `online`, which happens once the
 * controller has seen its socket close. A socket that closes without a
 * goodbye leaves the runner `unreachable`.
 */
const waitForRunnerGone = (arranged: Arranged): Promise<true> =>
  waitUntil("took the runner off online", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/runners/${arranged.runnerId}`,
      arranged.token,
    );
    const runner = (await response.json()) as { readonly connectivity: string };
    return runner.connectivity === "online" ? undefined : true;
  });

describe("workspace steps over the runner socket", () => {
  it(
    "hands the step to its runner after its workspace, continues the run on its result, and says when the step is no longer owed",
    async () => {
      await withFleet(async (arranged) => {
        const { wire } = arranged;
        const repoId = await createRepo(arranged, "https://github.com/o/commit.git");
        const runId = await startCommitRun(arranged, repoId);
        const key = commitKey(runId);

        const start = await waitForStepStart(wire, runId);
        expect(start).toMatchObject({
          ...key,
          action: "git.commit",
          input: { message: "Save the work" },
        });
        // A run's workspace is new, so the runner is sent it before the step
        // that works in it.
        const provisionAt = wire.frames.findIndex(
          (frame) =>
            frame._tag === "workspaceProvision" && frame.workspaceId === start["workspaceId"],
        );
        expect(provisionAt).toBeGreaterThanOrEqual(0);
        expect(provisionAt).toBeLessThan(
          wire.frames.indexOf(start as (typeof wire.frames)[number]),
        );
        // The step record was committed as running before the frame was sent.
        expect(await readCommitStatus(arranged, runId)).toBe("running");

        // A runner the run is not pinned to cannot end its step, and is told
        // to drop it.
        const other = await arranged.enlist();
        const result = {
          _tag: "workspaceStepResult" as const,
          ...key,
          outcome: { status: "completed" as const, output: COMMITTED },
        };
        other.wire.send(result);
        await waitForFrame(other.wire, "workspaceStepStop", namesStep(key));
        expect(await readCommitStatus(arranged, runId)).toBe("running");

        wire.send(result);
        const ended = await waitForRunTo(
          arranged,
          runId,
          "completed",
          (run) => run.status === "completed",
        );
        expect(findStepRecords(ended, "commit")[0]).toMatchObject({
          status: "completed",
          output: COMMITTED,
        });
        expect(findStepRecords(ended, "file")[0]).toMatchObject({
          status: "completed",
          output: { title: "Committed abc123" },
        });
        // Once its end is recorded, the runner may delete the step's result.
        await waitUntil("stopped the recorded step", () =>
          countStops(wire, key) === 1 ? true : undefined,
        );

        // A late copy of the same result changes nothing, and is answered
        // with a stop too, so the runner still deletes the result.
        wire.send(result);
        await waitUntil("stopped the duplicate", () =>
          countStops(wire, key) === 2 ? true : undefined,
        );
        expect(await readRun(arranged.harness.base, arranged.token, runId)).toEqual(ended);
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "stops a step cancelled while its runner was away, and sends the runner that returns the steps it owes and the runs waiting for it",
    async () => {
      await withFleet(async (arranged) => {
        const repoId = await createRepo(arranged, "https://github.com/o/away.git");
        const cancelled = await startCommitRun(arranged, repoId);
        await waitForStepStart(arranged.wire, cancelled);

        arranged.wire.close();
        await waitForRunnerGone(arranged);
        // No write waits on a runner: the cancel returns while the runner
        // that holds the step is gone.
        const response = await requestCancel(arranged.harness.base, arranged.token, cancelled);
        expect(response.status, await response.clone().text()).toBe(200);
        // No runner can take this run now, so its step waits.
        const waiting = await startCommitRun(arranged, repoId);
        await waitForRunTo(arranged, waiting, "running", (run) => run.status === "running");
        expect(await readCommitStatus(arranged, waiting)).toBe("pending");

        const back = await arranged.reconnect();
        // The runner still holds the cancelled step, and reports it.
        back.send({ _tag: "workspaceStepsReport", steps: [commitKey(cancelled)] });
        await waitForFrame(back, "workspaceStepStop", namesStep(commitKey(cancelled)));
        // The runner's return wakes the waiting run, whose step starts there.
        await waitForStepStart(back, waiting);
        expect(listFramesTagged(back, "workspaceStepStart").map((frame) => frame["runId"])).toEqual(
          [waiting],
        );

        // A runner that connects again is sent the step it still owes a
        // result for, after its workspace, which is still provisioning.
        back.close();
        await waitForRunnerGone(arranged);
        const again = await arranged.reconnect();
        const resent = await waitForStepStart(again, waiting);
        expect(resent).toMatchObject(commitKey(waiting));
        const provision = listFramesTagged(again, "workspaceProvision").find(
          (frame) => frame["workspaceId"] === resent["workspaceId"],
        );
        expect(provision).toBeDefined();
        expect(again.frames.indexOf(provision as (typeof again.frames)[number])).toBeLessThan(
          again.frames.indexOf(resent as (typeof again.frames)[number]),
        );
      });
    },
    WAIT_DEADLINE_MS * 4,
  );

  it(
    "fails the run with workspace-failed when its workspace cannot be provisioned",
    async () => {
      await withFleet(async (arranged) => {
        const repoId = await createRepo(arranged, "https://github.com/o/missing.git");
        const runId = await startCommitRun(arranged, repoId);
        const start = await waitForStepStart(arranged.wire, runId);

        arranged.wire.send({
          _tag: "workspaceReport",
          workspaceId: start["workspaceId"] as string,
          status: "failed",
          message: "The clone failed: repository not found.",
        });
        const ended = await waitForRunTo(
          arranged,
          runId,
          "failed",
          (run) => run.status === "failed",
        );
        expect(ended).toMatchObject({ failureReason: "workspace-failed", failedStepId: "commit" });
        expect(findStepRecords(ended, "commit")[0]).toMatchObject({
          status: "failed",
          error: { code: "workspace_failed", message: "The clone failed: repository not found." },
        });
        await waitForFrame(arranged.wire, "workspaceStepStop", namesStep(commitKey(runId)));
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "switches a repo's main workspace to the workflow's branch, and fails the run when its runner is retired",
    async () => {
      await withFleet(async (arranged) => {
        const repoId = await createRepo(arranged, "https://github.com/o/main.git");
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildCommitDefinition({
            kind: "primary",
            resourceId: repoId,
            branch: "release",
          }),
        });
        const start = await waitForStepStart(arranged.wire, runId);
        expect(start).toMatchObject({ ...commitKey(runId), checkoutBranch: "release" });

        const retired = await send(
          "POST",
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}/retire`,
          {
            body: { force: true },
            token: arranged.token,
          },
        );
        expect(retired.status, await retired.clone().text()).toBe(200);
        const { name } = (await retired.json()) as { readonly name: string };
        const ended = await waitForRunTo(
          arranged,
          runId,
          "failed",
          (run) => run.status === "failed",
        );
        expect(ended).toMatchObject({ failureReason: "workspace-failed", failedStepId: "commit" });
        expect(findStepRecords(ended, "commit")[0]).toMatchObject({
          status: "failed",
          error: { code: "workspace_failed", message: `runner ${name} was retired` },
        });
      });
    },
    WAIT_DEADLINE_MS * 2,
  );
});
