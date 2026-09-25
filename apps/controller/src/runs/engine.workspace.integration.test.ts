/**
 * Integration tests for workspace steps: steps whose action runs in the run's
 * workspace on a runner, such as `git.commit`. They drive the run service on
 * a `:memory:` database, with the real workspaces domain and Run Executor.
 *
 * No runner is connected. Workspace Steps is a fake that records what the
 * run engine hands to runners and asks them to stop, and the test plays the
 * runner by calling `recordStepResult` with a step's result, as the controller
 * daemon does when a result arrives. The fake also notes every call made
 * inside a database transaction, and each test fails if there is one: a
 * transaction must never wait on a runner.
 */
import { describe, expect, it } from "vitest";
import { Context, Effect, Fiber, Layer, Option } from "effect";
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
import { WorkflowRuns, WorkflowService, WorkflowServiceLayer } from "../workflows";
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
  /** The calls, `start` or `stop`, that were made inside a database transaction. */
  readonly callsInTransaction: Array<string>;
}

type Deps = RunService | WorkspaceService | WorkflowService | SqlClient.SqlClient;

/**
 * Runs `body` against a fresh controller: a `:memory:` database with the
 * built-in actions registered, and a fake Workspace Steps whose calls
 * `body` reads from `recorded`.
 */
const runTest = <A, E>(body: (recorded: Recorded) => Effect.Effect<A, E, Deps>): Promise<A> => {
  const recorded: Recorded = { starts: [], stops: [], callsInTransaction: [] };
  const workspaceSteps = Layer.effect(WorkspaceSteps)(
    Effect.map(SqlClient.SqlClient, (sql) => {
      // `stop` is synchronous, so the transaction is looked up in the
      // services of the fiber that calls it.
      const noteIfInTransaction = (call: string) => {
        const fiber = Fiber.getCurrent();
        if (
          fiber !== undefined &&
          Context.getOption(fiber.context, sql.transactionService)._tag === "Some"
        ) {
          recorded.callsInTransaction.push(call);
        }
      };
      return {
        start: (step) =>
          Effect.sync(() => {
            noteIfInTransaction("start");
            recorded.starts.push(step);
          }),
        stop: (steps) => {
          noteIfInTransaction("stop");
          recorded.stops.push(...steps);
        },
      };
    }),
  );
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
      Effect.tap(body(recorded), () =>
        Effect.sync(() => expect(recorded.callsInTransaction).toEqual([])),
      ),
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
 * that value. Dies after about two seconds, naming `what` was waited for, so
 * a test that waits in vain fails with that name well before vitest's own
 * five-second timeout.
 */
const waitFor = <A, E, R>(
  what: string,
  holds: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
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
        const provision = yield* workspaces.rebuildOwedProvision(start.workspaceId);
        expect(Option.getOrThrow(provision).checkouts).toMatchObject([
          { resourceId: repoId, branch: `hercule/run-${runId}`, baseBranch: null },
        ]);
        expect(yield* runs.listOwedWorkspaceSteps(runnerId)).toEqual([start]);

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
        yield* runs.recordStepResult(yield* insertRunner(), result);
        expect(findRecord(yield* readRun(runId), "commit")?.status).toBe("running");

        yield* runs.recordStepResult(runnerId, result);
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
        yield* runs.recordStepResult(runnerId, result);
        expect(yield* readRun(runId)).toEqual(ended);
      }),
    );
  });

  it("fails the step with unexpected when the runner's output does not match the action's output schema", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        const { runnerId, runId } = yield* startCommitRun(recorded);
        const runs = yield* RunService;
        yield* runs.recordStepResult(runnerId, {
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

        yield* runs.cancel(runId, {});
        expect(recorded.stops).toEqual([{ runnerId, ...key }]);
        expect(yield* runs.listEndedWorkspaceSteps(runnerId, [key])).toEqual([
          { runnerId, ...key },
        ]);
        expect(yield* runs.listOwedWorkspaceSteps(runnerId)).toEqual([]);
      }),
    );
  });

  it("keeps the workspace of every run cancelled with the run when the cancel keeps its workspace", async () => {
    await runTest((recorded) =>
      Effect.gen(function* () {
        const runnerId = yield* insertRunner();
        const repoId = yield* insertRepo;
        const runs = yield* RunService;
        const workflows = yield* WorkflowService;
        const { workflow: child } = yield* workflows.create({
          definition: { ...buildCommitDefinition(repoId), name: "Child" },
        });
        // The parent starts the child and commits at the same time. Both
        // commits wait for the runner, so both runs stay unfinished.
        const { runId } = yield* runs.start({
          definition: {
            name: "Parent",
            workspace: { kind: "ephemeral", checkouts: [{ resourceId: repoId }] },
            steps: [
              {
                id: "start",
                kind: "action",
                action: "run.start",
                params: { workflowId: child.id },
              },
              { id: "commit", kind: "action", action: "git.commit", params: { message: "Save" } },
            ],
          },
        });
        const starts = yield* waitForStarts(recorded, 2);
        const childRunId = starts.find((start) => start.runId !== runId)!.runId;

        yield* runs.cancel(runId, { keepWorkspace: true });
        for (const id of [runId, childRunId]) {
          const cancelled = yield* readRun(id);
          expect(cancelled).toMatchObject({ status: "cancelled", runnerId });
          expect(cancelled.workspaceKeptUntil).toBeDefined();
        }
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

        yield* runs.recordStepResult(runnerId, {
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
        expect(yield* runs.listOwedWorkspaceSteps(runnerId)).toEqual([start]);
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
        expect(yield* runs.listOwedWorkspaceSteps(runnerId)).toEqual([]);
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

  it("fails with validation when the run's workspace has no checkout, or none of the repo its resourceId names", async () => {
    await runTest(() =>
      Effect.gen(function* () {
        yield* insertRunner();
        const repoId = yield* insertRepo;
        const otherRepoId = yield* insertRepo;
        const runs = yield* RunService;
        const noCheckout = {
          ...buildCommitDefinition(repoId),
          workspace: { kind: "ephemeral" as const, checkouts: [] },
        };
        const otherRepo = buildCommitDefinition(repoId, { resourceId: otherRepoId });
        for (const definition of [noCheckout, otherRepo]) {
          const { runId } = yield* runs.start({ definition });
          const ended = yield* waitForRunToEnd(runId);
          expect(ended).toMatchObject({ status: "failed", failedStepId: "commit" });
          expect(ended.runnerId).toBeUndefined();
          expect(findRecord(ended, "commit")).toMatchObject({
            status: "failed",
            error: { code: "validation" },
          });
        }
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
