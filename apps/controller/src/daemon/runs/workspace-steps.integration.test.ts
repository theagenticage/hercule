/**
 * Integration tests for workspace steps over the real runner socket: a run
 * started through the API hands its `git.commit` step to a fake runner, and
 * the test plays that runner, sending results, reports and reconnects the
 * way a real runner does.
 */
import { describe, expect, it } from "vitest";
import type { Run } from "@hercule/contract";
import { MAX_WORKSPACE_STEPS } from "@hercule/protocol";
import { send } from "../../http/testing";
import {
  findStepRecords,
  readRun,
  requestCancel,
  requestStart,
  startSentWorkflow,
  waitForRun,
} from "../../runs/testing";
import {
  waitForRunnerGone,
  waitUntil,
  WAIT_DEADLINE_MS,
  type Arranged,
  type Wire,
} from "../../sessions/testing";
import {
  createGithubConnection,
  createRepo,
  githubPlugin,
  GITHUB_LOGIN,
  GITHUB_PAT,
  listFramesTagged,
  withFleet,
  type Frame,
} from "../../workspaces/testing";

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

/** The message for a run that no runner left can commit for. */
const NO_COMMITTING_RUNNER = "No runner can run git.commit; update a runner to this version.";

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

/** Checks whether a settle frame names the given step key. */
const namesStep =
  (key: ReturnType<typeof commitKey>) =>
  (frame: Frame): boolean =>
    (frame["steps"] as ReadonlyArray<unknown>).some(
      (step) => JSON.stringify(step) === JSON.stringify(key),
    );

/** Counts the settle frames that name a step key. */
const countSettles = (wire: Wire, key: ReturnType<typeof commitKey>): number =>
  listFramesTagged(wire, "workspaceStepSettle").filter(namesStep(key)).length;

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
 * Enlists a second runner whose hello lists no workspace action, like a
 * runner on an older build, then disconnects the fleet's first runner. Only
 * the older runner is online afterwards.
 */
const leaveOnlyAnOlderRunnerOnline = async (arranged: Arranged): Promise<Wire> => {
  const older = await arranged.enlist({ capabilities: [] });
  arranged.wire.close();
  await waitForRunnerGone(arranged);
  return older.wire;
};

describe("workspace steps over the runner socket", () => {
  it(
    "hands the step to its runner after its workspace, continues the run on its result, and says when the step is no longer owed",
    async () => {
      await withFleet(
        async (arranged) => {
          const { wire } = arranged;
          const connectionId = await createGithubConnection(arranged, { pat: GITHUB_PAT });
          const repoId = await createRepo(
            arranged,
            "https://github.com/o/commit.git",
            connectionId,
          );
          const runId = await startCommitRun(arranged, repoId);
          const key = commitKey(runId);

          const start = await waitForStepStart(wire, runId);
          // The commit is made as the account of the workspace's designated
          // Connection, as a session in that workspace would commit.
          expect(start).toMatchObject({
            ...key,
            action: "git.commit",
            input: { message: "Save the work" },
            gitIdentity: { name: GITHUB_LOGIN, email: `${GITHUB_LOGIN}@users.noreply.github.com` },
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
          // the controller does not owe it the step.
          const other = await arranged.enlist();
          const result = {
            _tag: "workspaceStepResult" as const,
            ...key,
            outcome: { status: "completed" as const, output: COMMITTED },
          };
          other.wire.send(result);
          await waitForFrame(other.wire, "workspaceStepSettle", namesStep(key));
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
          await waitUntil("settled the recorded step", () =>
            countSettles(wire, key) >= 1 ? true : undefined,
          );
          expect(countSettles(wire, key)).toBe(1);

          // A late copy of the same result changes nothing, and is answered
          // with a settle too, so the runner still deletes the result.
          wire.send(result);
          await waitUntil("settled the duplicate", () =>
            countSettles(wire, key) >= 2 ? true : undefined,
          );
          expect(countSettles(wire, key)).toBe(2);
          expect(await readRun(arranged.harness.base, arranged.token, runId)).toEqual(ended);
        },
        { plugins: [githubPlugin] },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "hands on a workspace step made ready by a result while another branch of the run still waits",
    async () => {
      await withFleet(async (arranged) => {
        const { wire } = arranged;
        const repoId = await createRepo(arranged, "https://github.com/o/branches.git");
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: {
            name: "Wait on one branch, commit and push on the other",
            workspace: { kind: "ephemeral", checkouts: [{ resourceId: repoId }] },
            steps: [
              { id: "pause", kind: "action", action: "wait", params: { seconds: 3600 } },
              { id: "commit", kind: "action", action: "git.commit", params: { message: "Save" } },
              { id: "push", kind: "action", action: "git.push", params: {} },
            ],
            edges: [{ from: "commit", to: "push" }],
          },
        });
        await waitForStepStart(wire, runId);
        wire.send({
          _tag: "workspaceStepResult",
          ...commitKey(runId),
          outcome: { status: "completed", output: COMMITTED },
        });

        // The push is handed to the runner while the wait on the other branch
        // is still running, not an hour later when the wait ends.
        await waitForFrame(
          wire,
          "workspaceStepStart",
          (frame) => frame["runId"] === runId && frame["stepId"] === "push",
        );
        const run = await readRun(arranged.harness.base, arranged.token, runId);
        expect(findStepRecords(run, "pause")[0]?.status).toBe("running");
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "completes a run whose controller restarted while its step ran, once the runner reconnects",
    async () => {
      await withFleet(async (arranged) => {
        const repoId = await createRepo(arranged, "https://github.com/o/restart.git");
        const runId = await startCommitRun(arranged, repoId);
        const key = commitKey(runId);
        await waitForStepStart(arranged.wire, runId);

        // A stopping controller drops every runner's socket.
        arranged.wire.close();
        await waitForRunnerGone(arranged);
        await arranged.harness.reboot();
        expect(await readCommitStatus(arranged, runId)).toBe("running");

        // The runner comes back still running the step. It is sent the step
        // again, and its result ends the step and continues the run.
        const back = await arranged.reconnect();
        back.send({ _tag: "workspaceStepsReport", steps: [key] });
        await waitForStepStart(back, runId);
        back.send({
          _tag: "workspaceStepResult",
          ...key,
          outcome: { status: "completed", output: COMMITTED },
        });
        const ended = await waitForRunTo(
          arranged,
          runId,
          "completed",
          (run) => run.status === "completed",
        );
        expect(findStepRecords(ended, "file")[0]).toMatchObject({
          status: "completed",
          output: { title: "Committed abc123" },
        });
      });
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "settles the steps of a cancelled run in frames the protocol accepts, however many were running",
    async () => {
      await withFleet(async (arranged) => {
        const repoId = await createRepo(arranged, "https://github.com/o/many.git");
        // More parallel steps than one frame may list, all started at once.
        const stepIds = Array.from({ length: MAX_WORKSPACE_STEPS + 1 }, (_, at) => `c${at}`);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: {
            name: "Many commits at once",
            workspace: { kind: "ephemeral", checkouts: [{ resourceId: repoId }] },
            steps: stepIds.map((id) => ({
              id,
              kind: "action",
              action: "git.commit",
              params: { message: `Save ${id}` },
            })),
          },
        });
        await waitUntil("sent every step", () =>
          listFramesTagged(arranged.wire, "workspaceStepStart").length === stepIds.length
            ? true
            : undefined,
        );

        const response = await requestCancel(arranged.harness.base, arranged.token, runId);
        expect(response.status, await response.clone().text()).toBe(200);

        // Every received frame is decoded against the protocol, so a frame
        // that listed too many steps would not have arrived.
        const listSettled = () =>
          listFramesTagged(arranged.wire, "workspaceStepSettle").flatMap(
            (frame) => frame["steps"] as ReadonlyArray<{ readonly stepId: string }>,
          );
        await waitUntil("settled every step", () =>
          listSettled().length === stepIds.length ? true : undefined,
        );
        expect(
          listSettled()
            .map((step) => step.stepId)
            .sort(),
        ).toEqual([...stepIds].sort());
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "settles a step cancelled while its runner was away, and sends the runner that returns the steps it owes and the runs waiting for it",
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
        await waitForFrame(back, "workspaceStepSettle", namesStep(commitKey(cancelled)));
        // The runner's return wakes the waiting run, whose step starts there.
        await waitForStepStart(back, waiting);
        expect(listFramesTagged(back, "workspaceStepStart").map((frame) => frame["runId"])).toEqual(
          [waiting],
        );

        // A runner that connects again is sent the step it still owes a
        // result for, after its workspace, which is still provisioning. The
        // workspace is owed both on its own and as the step's workspace, and
        // is sent once. Every provision on arrival is sent before any step,
        // so no second copy can still arrive after the step's frame.
        back.close();
        await waitForRunnerGone(arranged);
        const again = await arranged.reconnect();
        const resent = await waitForStepStart(again, waiting);
        expect(resent).toMatchObject(commitKey(waiting));
        const provisions = listFramesTagged(again, "workspaceProvision").filter(
          (frame) => frame["workspaceId"] === resent["workspaceId"],
        );
        expect(provisions).toHaveLength(1);
        expect(again.frames.indexOf(provisions[0] as (typeof again.frames)[number])).toBeLessThan(
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
        await waitForFrame(arranged.wire, "workspaceStepSettle", namesStep(commitKey(runId)));
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

  it(
    "pins a run only to a runner that lists every workspace action in its plan",
    async () => {
      await withFleet(async (arranged) => {
        const repoId = await createRepo(arranged, "https://github.com/o/older.git");
        const older = await leaveOnlyAnOlderRunnerOnline(arranged);
        // The online runner cannot commit, and the one that can is away, so
        // the run waits for it.
        const runId = await startCommitRun(arranged, repoId);
        await waitForRunTo(arranged, runId, "running", (run) => run.status === "running");
        expect(await readCommitStatus(arranged, runId)).toBe("pending");

        const back = await arranged.reconnect();
        await waitForStepStart(back, runId);
        expect((await readRun(arranged.harness.base, arranged.token, runId)).runnerId).toBe(
          arranged.runnerId,
        );
        expect(listFramesTagged(older, "workspaceStepStart")).toEqual([]);
      });
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "starts a run waiting for its drained runner once it is undrained, and counts no reserved runner",
    async () => {
      await withFleet(async (arranged) => {
        const repoId = await createRepo(arranged, "https://github.com/o/drained.git");
        const runnerPath = `/api/v1/runners/${arranged.runnerId}`;
        const change = async (method: "POST" | "PATCH", path: string, body?: unknown) => {
          const response = await send(method, arranged.harness.base, path, {
            ...(body === undefined ? {} : { body }),
            token: arranged.token,
          });
          expect(response.status, await response.clone().text()).toBe(200);
        };

        // A draining runner may take work again, so the run starts and waits.
        await change("POST", `${runnerPath}/drain`);
        const runId = await startCommitRun(arranged, repoId);
        await waitForRunTo(arranged, runId, "running", (run) => run.status === "running");
        expect(await readCommitStatus(arranged, runId)).toBe("pending");
        // Undrained, the connected runner takes the run without reconnecting.
        await change("POST", `${runnerPath}/undrain`);
        await waitForStepStart(arranged.wire, runId);

        // A run never goes to a reserved runner, so a plan only a reserved
        // runner can run is refused rather than left waiting forever.
        const reserved = await arranged.enlist();
        await change("PATCH", `/api/v1/runners/${reserved.runnerId}`, { reserved: true });
        await change("POST", `${runnerPath}/retire`, { force: true });
        const refused = await requestStart(arranged.harness.base, arranged.token, {
          definition: buildCommitDefinition({
            kind: "ephemeral",
            checkouts: [{ resourceId: repoId }],
          }),
        });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({
          error: {
            code: "validation",
            details: { issues: [{ path: [], message: NO_COMMITTING_RUNNER }] },
          },
        });
      });
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "fails a waiting run once its only capable runner is retired, and refuses to start another",
    async () => {
      await withFleet(async (arranged) => {
        const repoId = await createRepo(arranged, "https://github.com/o/retired.git");
        await leaveOnlyAnOlderRunnerOnline(arranged);
        const runId = await startCommitRun(arranged, repoId);
        await waitForRunTo(arranged, runId, "running", (run) => run.status === "running");

        const retired = await send(
          "POST",
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}/retire`,
          { body: { force: true }, token: arranged.token },
        );
        expect(retired.status, await retired.clone().text()).toBe(200);
        const ended = await waitForRunTo(
          arranged,
          runId,
          "failed",
          (run) => run.status === "failed",
        );
        expect(ended).toMatchObject({ failureReason: "workspace-failed", failedStepId: "commit" });
        expect(findStepRecords(ended, "commit")[0]).toMatchObject({
          status: "failed",
          error: { code: "workspace_failed", message: NO_COMMITTING_RUNNER },
        });

        const refused = await requestStart(arranged.harness.base, arranged.token, {
          definition: buildCommitDefinition({
            kind: "ephemeral",
            checkouts: [{ resourceId: repoId }],
          }),
        });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({
          error: {
            code: "validation",
            details: { issues: [{ path: [], message: NO_COMMITTING_RUNNER }] },
          },
        });
      });
    },
    WAIT_DEADLINE_MS * 3,
  );
});
