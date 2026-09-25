/**
 * Integration tests for workspace steps: steps whose action runs in the run's
 * workspace on a runner, such as `git.commit`. They drive the run service on
 * a `:memory:` database, with the real workspaces domain and Run Executor.
 *
 * No runner is connected. Workspace Steps is a fake that records what the
 * run engine hands to runners and asks them to stop, and the test plays the
 * runner by calling `completeStep` with a step's result, as the controller
 * daemon does when a result arrives.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Run, StepRecord, Validation } from "@hercule/contract";
import { CurrentActor } from "../actor";
import { AfterCommit, mintUuid, uuidToString } from "../db";
import { EventKindsLayer } from "../events";
import { buildWorkspaceActionCapability } from "@hercule/protocol";
import { SessionTokensLayer } from "../permissions";
import { EventKindCatalogLayer, PluginHost, WORKSPACE_ACTION_IDS } from "../plugins";
import { buildPluginStack, USER } from "../plugins/testing";
import { resourceRepository } from "../resources";
import { SettingsLayer } from "../settings";
import { TaskServiceLayer } from "../tasks";
import { WorkflowRuns, WorkflowServiceLayer } from "../workflows";
import { WorkspaceService, WorkspaceServiceLayer } from "../workspaces";
import { RunExecutorLayer } from "../daemon/runs";
import { RunService, RunServiceLayer } from "./service";
import {
  WorkspaceSteps,
  type WorkspaceStepToStart,
  type WorkspaceStepToStop,
} from "./workspace-steps";

const at = "2026-09-25T10:00:00.000Z";

/** What the fake Workspace Steps was asked to do, in order. */
interface Recorded {
  readonly starts: Array<WorkspaceStepToStart>;
  readonly stops: Array<WorkspaceStepToStop>;
}

type Deps = RunService | WorkspaceService | SqlClient.SqlClient;

/**
 * Runs `body` against a fresh controller: a `:memory:` database with the
 * built-in actions registered, and a fake Workspace Steps whose calls
 * `body` reads from `recorded`.
 */
const runTest = <A, E>(body: (recorded: Recorded) => Effect.Effect<A, E, Deps>): Promise<A> => {
  const recorded: Recorded = { starts: [], stops: [] };
  const workspaceSteps = Layer.succeed(WorkspaceSteps)({
    start: (step) => Effect.sync(() => void recorded.starts.push(step)),
    stop: (steps) => void recorded.stops.push(...steps),
  });
  const layer = RunServiceLayer.pipe(
    Layer.provideMerge(
      WorkflowServiceLayer.pipe(
        Layer.provide(EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer))),
        Layer.provide(
          Layer.succeed(WorkflowRuns)({ hasUnfinishedRun: () => Effect.succeed(false) }),
        ),
      ),
    ),
    Layer.provideMerge(TaskServiceLayer),
    Layer.provideMerge(WorkspaceServiceLayer.pipe(Layer.provide(SessionTokensLayer))),
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(RunExecutorLayer),
    Layer.provideMerge(workspaceSteps),
    Layer.provideMerge(Layer.succeed(AfterCommit)({ publish: () => Effect.void })),
    Layer.provideMerge(buildPluginStack()),
  );
  return Effect.runPromise(
    Effect.andThen(
      Effect.flatMap(PluginHost, (host) => host.boot([])),
      body(recorded),
    ).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer)) as Effect.Effect<A, E>,
  );
};

/**
 * The capabilities a runner of this build negotiates at hello: every
 * workspace action in the catalog.
 */
const CURRENT_CAPABILITIES = JSON.stringify(
  [...WORKSPACE_ACTION_IDS].map(buildWorkspaceActionCapability),
);

/**
 * Inserts an active runner of this build, online unless `connectivity` says
 * otherwise, and returns its id.
 */
const insertRunner = (connectivity: "online" | "offline" = "online") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintUuid();
    const name = uuidToString(id);
    yield* sql`
      INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                           negotiated_capabilities, credential_hash, created_at, updated_at)
      VALUES (${id}, ${name}, ${connectivity}, 'active', 0, '[]',
              ${CURRENT_CAPABILITIES}, ${name}, ${at}, ${at})
    `;
    return name;
  });

/** Inserts a repo and returns its id. */
const insertRepo = Effect.gen(function* () {
  const resources = yield* resourceRepository;
  const remote = `https://github.com/o/${uuidToString(mintUuid())}.git`;
  const repo = yield* resources.insert({
    kind: "repo",
    remote,
    canonicalRemote: remote,
    label: null,
    connectionId: null,
    setupCommand: null,
    workspaceInclude: false,
    at,
  });
  return repo.id;
});

/**
 * A workflow whose run commits in a workspace of its own, with one checkout
 * of `repoId`, and then files a task titled with the commit's sha.
 */
const buildCommitDefinition = (repoId: string, commitParams: Record<string, unknown> = {}) => ({
  name: "Commit, then file a task",
  workspace: { kind: "ephemeral" as const, checkouts: [{ resourceId: repoId }] },
  steps: [
    {
      id: "commit",
      kind: "action" as const,
      action: "git.commit",
      params: { message: "Save the work", ...commitParams },
    },
    {
      id: "file",
      kind: "action" as const,
      action: "task.create",
      params: { title: "Committed {{ steps.commit.output.sha }}", description: "" },
    },
  ],
  edges: [{ from: "commit", to: "file" }],
});

const COMMITTED = { sha: "abc123", branch: "hercule/run-x", committed: true };

/** Reads a run through the run service. */
const readRun = (runId: string) => Effect.flatMap(RunService, (runs) => runs.read(runId));

/** Returns the record of `stepId`'s first iteration, or `undefined`. */
const findRecord = (run: Run, stepId: string): StepRecord | undefined =>
  run.steps.find((record) => record.stepId === stepId && record.iteration === 1);

/**
 * Checks `holds` every few milliseconds until it returns a value, and returns
 * that value. Dies after five seconds, naming `what` was waited for.
 */
const waitFor = <A, E, R>(
  what: string,
  holds: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const value = yield* holds;
      if (value !== undefined) return value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(`timed out waiting for ${what}`);
  });

/** Waits until the run's status is final, and returns it. */
const waitForRunToEnd = (runId: string) =>
  waitFor(
    `run ${runId} to end`,
    Effect.map(readRun(runId), (run) =>
      run.status === "pending" || run.status === "running" ? undefined : run,
    ),
  );

/** Waits until the fake Workspace Steps has been asked to start `count` steps. */
const waitForStarts = (recorded: Recorded, count: number) =>
  waitFor(
    `${String(count)} workspace step start(s)`,
    Effect.sync(() => (recorded.starts.length >= count ? recorded.starts : undefined)),
  );

/** Starts a run of the commit workflow on a fresh runner and repo, and waits until its step is handed on. */
const startCommitRun = (recorded: Recorded) =>
  Effect.gen(function* () {
    const runnerId = yield* insertRunner();
    const repoId = yield* insertRepo;
    const runs = yield* RunService;
    const { runId } = yield* runs.start({ definition: buildCommitDefinition(repoId) });
    const [start] = yield* waitForStarts(recorded, 1);
    return { runnerId, repoId, runId, start: start! };
  });

describe("a workspace step", () => {
  it("pins the run and opens its workspace, hands the step on once, survives a resume, and routes on its result", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        const { runnerId, repoId, runId, start } = yield* startCommitRun(recorded);
        const runs = yield* RunService;
        const workspaces = yield* WorkspaceService;

        // The workspace id is checked against the run below.
        expect(start).toEqual({
          runId,
          stepId: "commit",
          iteration: 1,
          runnerId,
          workspaceId: start.workspaceId,
          action: "git.commit",
          input: { message: "Save the work" },
        });
        const running = yield* readRun(runId);
        expect(running).toMatchObject({
          status: "running",
          runnerId,
          workspaceId: start.workspaceId,
        });
        expect(findRecord(running, "commit")).toMatchObject({
          status: "running",
          input: { message: "Save the work" },
        });

        // The workspace is still provisioning, so its provision can be sent
        // again, with the run's branch on the checkout.
        const provision = yield* workspaces.rebuildProvision(start.workspaceId);
        expect(Option.getOrThrow(provision).checkouts).toMatchObject([
          { resourceId: repoId, branch: `hercule/run-${runId}`, baseBranch: null },
        ]);
        expect(yield* runs.owedWorkspaceSteps(runnerId)).toEqual([start]);

        // A resume leaves a running workspace step to its runner: it neither
        // fails it as cut off nor hands it on a second time.
        yield* runs.resumeUnfinished;
        yield* Effect.sleep("100 millis");
        expect(findRecord(yield* readRun(runId), "commit")?.status).toBe("running");
        expect(recorded.starts).toHaveLength(1);

        const result = {
          runId,
          stepId: "commit",
          iteration: 1,
          outcome: { status: "completed" as const, output: COMMITTED },
        };
        // A result from a runner the run is not pinned to is ignored.
        yield* runs.completeStep(yield* insertRunner(), result);
        expect(findRecord(yield* readRun(runId), "commit")?.status).toBe("running");

        yield* runs.completeStep(runnerId, result);
        const ended = yield* waitForRunToEnd(runId);
        expect(ended.status).toBe("completed");
        expect(findRecord(ended, "commit")).toMatchObject({
          status: "completed",
          output: COMMITTED,
        });
        expect(findRecord(ended, "file")).toMatchObject({
          status: "completed",
          output: { title: "Committed abc123" },
        });

        // The same result again finds the record ended, and changes nothing.
        yield* runs.completeStep(runnerId, result);
        expect(yield* readRun(runId)).toEqual(ended);
      }),
    );
  });

  it("fails the step with unexpected when the runner's output does not match the action's output schema", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        const { runnerId, runId } = yield* startCommitRun(recorded);
        const runs = yield* RunService;
        yield* runs.completeStep(runnerId, {
          runId,
          stepId: "commit",
          iteration: 1,
          outcome: { status: "completed", output: { sha: 1 } },
        });
        const ended = yield* waitForRunToEnd(runId);
        expect(ended).toMatchObject({
          status: "failed",
          failureReason: "step-failed",
          failedStepId: "commit",
        });
        expect(findRecord(ended, "commit")).toMatchObject({
          status: "failed",
          error: { code: "unexpected" },
        });
      }),
    );
  });

  it("asks the runner to stop the step when the run is cancelled, and lists it as ended from then on", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        const { runnerId, runId } = yield* startCommitRun(recorded);
        const runs = yield* RunService;
        const key = { runId, stepId: "commit", iteration: 1 };
        const notARun = { runId: "not-a-run", stepId: "commit", iteration: 1 };

        expect(yield* runs.listEndedWorkspaceSteps(runnerId, [key, notARun])).toEqual([
          { runnerId, ...notARun },
        ]);

        yield* runs.cancel(runId);
        expect(recorded.stops).toEqual([{ runnerId, ...key }]);
        expect(yield* runs.listEndedWorkspaceSteps(runnerId, [key])).toEqual([
          { runnerId, ...key },
        ]);
        expect(yield* runs.owedWorkspaceSteps(runnerId)).toEqual([]);
      }),
    );
  });

  it("asks the runner to stop a running step when another step fails the run", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        const runnerId = yield* insertRunner();
        const repoId = yield* insertRepo;
        const runs = yield* RunService;
        const commit = (id: string) => ({
          id,
          kind: "action" as const,
          action: "git.commit",
          params: { message: `Save ${id}` },
        });
        const { runId } = yield* runs.start({
          definition: {
            name: "Two commits at once",
            workspace: { kind: "ephemeral", checkouts: [{ resourceId: repoId }] },
            steps: [commit("first"), commit("second")],
          },
        });
        yield* waitForStarts(recorded, 2);

        yield* runs.completeStep(runnerId, {
          runId,
          stepId: "first",
          iteration: 1,
          outcome: { status: "failed", code: "action_failed", message: "nothing to commit" },
        });
        expect(yield* waitForRunToEnd(runId)).toMatchObject({
          status: "failed",
          failedStepId: "first",
        });
        // The runner reported how the first step ended, so only the second
        // is stopped here.
        expect(recorded.stops).toEqual([{ runnerId, runId, stepId: "second", iteration: 1 }]);
      }),
    );
  });

  it("switches a repo's main workspace to the workflow's branch before each step", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        const runnerId = yield* insertRunner();
        const repoId = yield* insertRepo;
        const runs = yield* RunService;
        yield* runs.start({
          definition: {
            ...buildCommitDefinition(repoId),
            workspace: { kind: "primary", resourceId: repoId, branch: "release" },
          },
        });
        const [start] = yield* waitForStarts(recorded, 1);
        expect(start).toMatchObject({ runnerId, checkoutBranch: "release" });
        // The step sent again when the runner reconnects carries the branch too.
        expect(yield* runs.owedWorkspaceSteps(runnerId)).toEqual([start]);
      }),
    );
  });

  it("fails the run at its running step when its workspace fails, and asks the runner to stop the step", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        const { runnerId, runId, start } = yield* startCommitRun(recorded);
        const runs = yield* RunService;
        yield* runs.failWorkspace(start.workspaceId, "The clone failed: repository not found.");
        const ended = yield* readRun(runId);
        expect(ended).toMatchObject({
          status: "failed",
          failureReason: "workspace-failed",
          failedStepId: "commit",
        });
        expect(findRecord(ended, "commit")).toMatchObject({
          status: "failed",
          error: { code: "workspace_failed", message: "The clone failed: repository not found." },
        });
        expect(recorded.stops).toEqual([{ runnerId, runId, stepId: "commit", iteration: 1 }]);
      }),
    );
  });

  it("fails every run pinned to a runner that is gone", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        const { runnerId, runId } = yield* startCommitRun(recorded);
        const runs = yield* RunService;
        yield* runs.failRunsPinnedTo(runnerId, `The runner ${runnerId} was retired.`);
        const ended = yield* readRun(runId);
        expect(ended).toMatchObject({ status: "failed", failureReason: "workspace-failed" });
        expect(findRecord(ended, "commit")?.status).toBe("failed");
        expect(yield* runs.owedWorkspaceSteps(runnerId)).toEqual([]);
      }),
    );
  });

  it("waits for a runner when none can take the run, and starts once one arrives and wakes it", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        // A runner that is offline can still take the run later, so the run
        // starts and waits rather than being refused.
        yield* insertRunner("offline");
        const repoId = yield* insertRepo;
        const runs = yield* RunService;
        const { runId } = yield* runs.start({ definition: buildCommitDefinition(repoId) });
        yield* waitFor(
          "the run to start",
          Effect.map(readRun(runId), (run) => (run.status === "running" ? run : undefined)),
        );
        yield* Effect.sleep("100 millis");
        const asleep = yield* readRun(runId);
        expect(asleep.runnerId).toBeUndefined();
        expect(findRecord(asleep, "commit")?.status).toBe("pending");
        expect(recorded.starts).toEqual([]);

        const runnerId = yield* insertRunner();
        yield* runs.wakeRunsWaitingForRunner();
        const [start] = yield* waitForStarts(recorded, 1);
        expect(start).toMatchObject({ runId, runnerId, stepId: "commit" });
      }),
    );
  });

  it("fails with validation when its resourceId names a repo the run's workspace has no checkout of", async () => {
    await runTest(() =>
      Effect.gen(function* () {
        yield* insertRunner();
        const repoId = yield* insertRepo;
        const otherRepoId = yield* insertRepo;
        const runs = yield* RunService;
        const { runId } = yield* runs.start({
          definition: buildCommitDefinition(repoId, { resourceId: otherRepoId }),
        });
        const ended = yield* waitForRunToEnd(runId);
        expect(ended).toMatchObject({ status: "failed", failedStepId: "commit" });
        expect(ended.runnerId).toBeUndefined();
        expect(findRecord(ended, "commit")).toMatchObject({
          status: "failed",
          error: { code: "validation" },
        });
      }),
    );
  });

  it("is refused at run.start when the sent workflow has no workspace", async () => {
    await runTest(() =>
      Effect.gen(function* () {
        const runs = yield* RunService;
        const { name, steps, edges } = buildCommitDefinition(
          "0199f0b7-0000-7000-8000-00000000a001",
        );
        const refused = yield* Effect.flip(runs.start({ definition: { name, steps, edges } }));
        expect((refused as Validation).error.details.issues).toMatchObject([
          { path: ["steps", "0", "action"] },
        ]);
      }),
    );
  });
});
