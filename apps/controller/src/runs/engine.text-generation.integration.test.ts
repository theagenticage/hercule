/**
 * Integration tests for text-generation steps: steps that make one model call
 * through the `TextGeneration` service. They drive the run service on a
 * `:memory:` database, with the real Run Executor.
 *
 * No runner is connected. `TextGeneration` is a fake that answers each call
 * with the next answer a test queued, and `TextGenerationModels` is a fake
 * whose answer the test sets: off, ready, or not ready. A test plays a runner
 * that becomes able to take a call by setting it ready and waking the runs
 * waiting for a runner, as the controller daemon does.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, FiberMap, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Run, StepRecord } from "@hercule/contract";
import { buildWorkspaceActionCapability, WORKSPACE_LIFECYCLE_CAPABILITY } from "@hercule/protocol";
import { CurrentActor } from "../actor";
import { AfterCommit, mintUuid, uuidToString } from "../db";
import { RunExecutorLayer, RunFibers } from "../daemon/runs";
import { EventKindsLayer, PlatformEventsLayer } from "../events";
import { SessionTokensLayer } from "../permissions";
import { EventKindCatalogLayer, PluginHost, WORKSPACE_ACTION_IDS } from "../plugins";
import { buildPluginStack, USER } from "../plugins/testing";
import type { StoredInstance } from "../providers";
import { resourceRepository } from "../resources";
import { SettingsLayer } from "../settings";
import { TaskServiceLayer } from "../tasks";
import {
  TextGeneration,
  TextGenerationError,
  TextGenerationModels,
  type TextGenerationCall,
  type TextGenerationTarget,
} from "../text-generation";
import { WorkflowRuns, WorkflowService, WorkflowServiceLayer, WorkflowSignals } from "../workflows";
import { WorkspaceServiceLayer } from "../workspaces";
import { RunService, RunServiceLayer } from "./service";
import { RunWorkspaceStepActivityLayer } from "./workspace-step-activity";
import { WorkspaceSteps, type WorkspaceStepToStart } from "./workspace-steps";

const at = "2026-10-14T10:00:00.000Z";

/** What the fake `TextGenerationModels` resolves to. */
type Readiness = "off" | "ready" | "notReady";

/** The fakes' state, which a test reads and changes. */
interface Fakes {
  readiness: Readiness;
  /** The answers to the next calls, in order. A call with none left dies. */
  readonly answers: Array<Effect.Effect<unknown, TextGenerationError>>;
  readonly calls: Array<TextGenerationCall>;
  /** The workspace steps the fake Workspace Steps was asked to start. */
  readonly starts: Array<WorkspaceStepToStart>;
}

/** Builds the target the fake `TextGenerationModels` resolves to for `readiness`. */
const buildTarget = (readiness: Readiness): TextGenerationTarget => {
  switch (readiness) {
    case "off":
      return { _tag: "off", failureKey: "off" };
    case "notReady":
      return { _tag: "unresolved", message: "no runner", failureKey: "unresolved" };
    case "ready":
      return {
        _tag: "resolved",
        // The engine never reads the instance, only whether runners offer it.
        instance: {} as StoredInstance,
        model: "small",
        runnerIds: ["runner"],
        failureKey: "resolved",
      };
  }
};

type Deps = RunService | WorkflowService | SqlClient.SqlClient;

/** Runs `body` against a fresh controller on a `:memory:` database, with the fakes `body` reads and sets. */
const runTest = <A, E>(body: (fakes: Fakes) => Effect.Effect<A, E, Deps | RunFibers>) => {
  const fakes: Fakes = { readiness: "ready", answers: [], calls: [], starts: [] };
  const textGeneration = Layer.succeed(TextGeneration)({
    generate: (call) =>
      Effect.suspend(() => {
        fakes.calls.push(call);
        const answer = fakes.answers.shift();
        return answer ?? Effect.die(`no answer queued for call ${String(fakes.calls.length)}`);
      }),
  });
  const models = Layer.succeed(TextGenerationModels)({
    resolve: () => Effect.sync(() => buildTarget(fakes.readiness)),
  });
  const workspaceSteps = Layer.succeed(WorkspaceSteps)({
    start: (step) =>
      Effect.sync(() => {
        fakes.starts.push(step);
      }),
    settle: () => undefined,
    openSession: () => Effect.die("these tests run no agent step"),
    stopSessions: () => Effect.void,
  });
  const layer = RunServiceLayer.pipe(
    Layer.provideMerge(
      WorkflowServiceLayer.pipe(
        Layer.provide(EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer))),
        Layer.provide(
          Layer.succeed(WorkflowRuns)({ hasUnfinishedRun: () => Effect.succeed(false) }),
        ),
        Layer.provide(Layer.succeed(WorkflowSignals)({ readKind: () => Effect.succeedNone })),
      ),
    ),
    Layer.provideMerge(TaskServiceLayer),
    Layer.provideMerge(
      WorkspaceServiceLayer.pipe(
        Layer.provide(SessionTokensLayer),
        Layer.provide(RunWorkspaceStepActivityLayer),
      ),
    ),
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(RunExecutorLayer),
    Layer.provideMerge(PlatformEventsLayer),
    Layer.provideMerge(workspaceSteps),
    Layer.provideMerge(Layer.succeed(AfterCommit)({ publish: () => Effect.void })),
    Layer.provideMerge(textGeneration),
    Layer.provideMerge(models),
    Layer.provideMerge(buildPluginStack()),
  );
  return Effect.runPromise(
    Effect.andThen(
      Effect.flatMap(PluginHost, (host) => host.boot([])),
      body(fakes),
    ).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer)) as Effect.Effect<A, E>,
  );
};

/** The output schema of the summarize step: an object with one string. */
const TITLE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

/** A text-generation step with this id that titles the run's `text` input. */
const buildSummarizeStep = (id = "summarize", input = "{{ inputs.text }}") => ({
  id,
  kind: "text-generation" as const,
  instructions: "Write a short title for the text.",
  input,
  outputSchema: TITLE_SCHEMA,
});

/** A step that files a task titled with the summarize step's output. */
const FILE_STEP = {
  id: "file",
  kind: "action" as const,
  action: "task.create",
  params: { title: "{{ steps.summarize.output.title }}", description: "" },
};

/** A workflow that titles a text, then files a task with that title. */
const SUMMARIZE_DEFINITION = {
  name: "Title, then file",
  inputs: [{ name: "text", schema: { type: "string" }, required: true }],
  steps: [buildSummarizeStep(), FILE_STEP],
  edges: [{ from: "summarize", to: "file" }],
};

/** Reads a run through the run service. */
const readRun = (runId: string) => Effect.flatMap(RunService, (runs) => runs.read(runId));

/** Returns the record of `stepId`'s first iteration, or `undefined`. */
const findRecord = (run: Run, stepId: string): StepRecord | undefined =>
  run.steps.find((record) => record.stepId === stepId && record.iteration === 1);

/**
 * Checks `holds` every few milliseconds until it returns a value, and returns
 * that value. Dies after about two seconds, naming `what` was waited for.
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

/** Waits until the run's status is final, and returns the run. */
const waitForRunToEnd = (runId: string) =>
  waitFor(
    `run ${runId} to end`,
    Effect.map(readRun(runId), (run) =>
      run.status === "pending" || run.status === "running" ? undefined : run,
    ),
  );

/** Waits until the fake `TextGeneration` has been called `count` times. */
const waitForCalls = (fakes: Fakes, count: number) =>
  waitFor(
    `${String(count)} text generation call(s)`,
    Effect.sync(() => (fakes.calls.length >= count ? fakes.calls : undefined)),
  );

/** Starts a run of `definition` with `text` as its input, and returns its id. */
const startRun = (definition: unknown, text = "The login page fails on Safari.") =>
  Effect.flatMap(RunService, (runs) =>
    Effect.map(
      runs.start({ definition: definition as never, inputs: { text } }),
      (started) => started.runId,
    ),
  );

/** Sets the fake ready and wakes the runs waiting for a runner, as a runner arriving would. */
const becomeReady = (fakes: Fakes) =>
  Effect.gen(function* () {
    fakes.readiness = "ready";
    yield* Effect.flatMap(RunService, (runs) => runs.wakeRunsWaitingForRunner());
  });

/** Builds the failure the fake `TextGeneration` answers a call with. */
const failCall = (reason: TextGenerationError["reason"], message = `the call ended: ${reason}`) =>
  Effect.fail(new TextGenerationError({ reason, message }));

const TITLED = { title: "Login fails on Safari" };

describe("a text-generation step", () => {
  it("calls the model with the rendered step, and routes its value to the next step", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        fakes.answers.push(Effect.succeed(TITLED));
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        const ended = yield* waitForRunToEnd(runId);

        expect(ended.status, JSON.stringify(ended)).toBe("completed");
        expect(fakes.calls).toEqual([
          {
            caller: `run:${runId}`,
            purpose: "summarize",
            instructions: "Write a short title for the text.",
            input: "The login page fails on Safari.",
            outputSchema: TITLE_SCHEMA,
          },
        ]);
        expect(findRecord(ended, "summarize")).toMatchObject({
          status: "completed",
          output: TITLED,
        });
        expect(findRecord(ended, "file")).toMatchObject({
          status: "completed",
          output: { title: "Login fails on Safari" },
        });
        // A text-generation step never pins its run.
        expect(ended.runnerId).toBeUndefined();
      }),
    );
  });

  it("fails with text_generation_off when text generation is off, without a call", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        fakes.readiness = "off";
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        const ended = yield* waitForRunToEnd(runId);

        expect(ended).toMatchObject({
          status: "failed",
          failureReason: "step-failed",
          failedStepId: "summarize",
        });
        expect(findRecord(ended, "summarize")).toMatchObject({
          status: "failed",
          error: { code: "text_generation_off" },
        });
        expect(fakes.calls).toEqual([]);
      }),
    );
  });

  it("stays pending while no runner can take the call, and completes once a wake finds one", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        fakes.readiness = "notReady";
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        yield* Effect.sleep("100 millis");
        const waiting = yield* readRun(runId);
        expect(waiting.status).toBe("running");
        expect(findRecord(waiting, "summarize")?.status).toBe("pending");
        expect(fakes.calls).toEqual([]);

        fakes.answers.push(Effect.succeed(TITLED));
        yield* becomeReady(fakes);
        const ended = yield* waitForRunToEnd(runId);
        expect(ended.status, JSON.stringify(ended)).toBe("completed");
        expect(fakes.calls).toHaveLength(1);
      }),
    );
  });

  it("calls once more at once when a call finds no runner but the check still finds one", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        fakes.answers.push(failCall("unavailable"), Effect.succeed(TITLED));
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        const ended = yield* waitForRunToEnd(runId);

        expect(ended.status, JSON.stringify(ended)).toBe("completed");
        expect(fakes.calls).toHaveLength(2);
      }),
    );
  });

  it("sleeps after a second call finds no runner, stays running, and completes once a wake finds one", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        fakes.answers.push(failCall("unavailable"), failCall("unavailable"));
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        yield* waitForCalls(fakes, 2);
        // No hot loop: nothing calls again until a wake.
        yield* Effect.sleep("100 millis");
        expect(fakes.calls).toHaveLength(2);
        const waiting = yield* readRun(runId);
        expect(waiting.status).toBe("running");
        expect(findRecord(waiting, "summarize")?.status).toBe("running");

        fakes.answers.push(Effect.succeed(TITLED));
        yield* becomeReady(fakes);
        const ended = yield* waitForRunToEnd(runId);
        expect(ended.status, JSON.stringify(ended)).toBe("completed");
        expect(fakes.calls).toHaveLength(3);
      }),
    );
  });

  it("sleeps without a second call when a call finds no runner and the check finds none either", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        fakes.answers.push(
          Effect.suspend(() => {
            fakes.readiness = "notReady";
            return failCall("unavailable");
          }),
        );
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        yield* waitForCalls(fakes, 1);
        yield* Effect.sleep("100 millis");
        expect(fakes.calls).toHaveLength(1);
        expect(findRecord(yield* readRun(runId), "summarize")?.status).toBe("running");

        fakes.answers.push(Effect.succeed(TITLED));
        yield* becomeReady(fakes);
        expect((yield* waitForRunToEnd(runId)).status).toBe("completed");
      }),
    );
  });

  it.each([
    ["invalid-output", "schema_failure", "schema-failure"],
    ["timeout", "timeout", "step-failed"],
    ["failed", "text_generation_failed", "step-failed"],
  ] as const)(
    "fails a call that ends with %s with %s, and the run with %s",
    async (reason, code, failureReason) => {
      await runTest((fakes) =>
        Effect.gen(function* () {
          fakes.answers.push(failCall(reason, "the runner said no"));
          const runId = yield* startRun(SUMMARIZE_DEFINITION);
          const ended = yield* waitForRunToEnd(runId);

          expect(ended).toMatchObject({
            status: "failed",
            failureReason,
            failedStepId: "summarize",
          });
          const record = findRecord(ended, "summarize");
          expect(record).toMatchObject({ status: "failed", error: { code } });
          expect(JSON.stringify(record)).toContain("the runner said no");
          expect(fakes.calls).toHaveLength(1);
        }),
      );
    },
  );

  it("fails with input_too_large, naming the size, before any call", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        const runId = yield* startRun(SUMMARIZE_DEFINITION, "x".repeat(64 * 1024 + 1));
        const ended = yield* waitForRunToEnd(runId);

        expect(ended).toMatchObject({ status: "failed", failureReason: "step-failed" });
        expect(findRecord(ended, "summarize")).toMatchObject({
          status: "failed",
          error: { code: "input_too_large" },
        });
        expect(JSON.stringify(findRecord(ended, "summarize"))).toContain("65537 characters");
        expect(fakes.calls).toEqual([]);
      }),
    );
  });

  it("fails the run as a controller error when the call dies, without calling again", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        fakes.answers.push(Effect.die("a bug in the text generation service"));
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        const ended = yield* waitForRunToEnd(runId);

        expect(ended).toMatchObject({ status: "failed", failureReason: "controller-error" });
        expect(fakes.calls).toHaveLength(1);
      }),
    );
  });

  it("calls a running record again after a restart rather than failing it as interrupted", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        const held = yield* Deferred.make<unknown>();
        fakes.answers.push(Deferred.await(held));
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        yield* waitForCalls(fakes, 1);

        // A restart: every execution stops, and the boot resumes the run.
        yield* FiberMap.clear(yield* RunFibers);
        expect(findRecord(yield* readRun(runId), "summarize")?.status).toBe("running");
        fakes.answers.push(Effect.succeed(TITLED));
        yield* Effect.flatMap(RunService, (runs) => runs.resumeUnfinished);

        const ended = yield* waitForRunToEnd(runId);
        expect(ended.status, JSON.stringify(ended)).toBe("completed");
        expect(fakes.calls).toHaveLength(2);
      }),
    );
  });

  it("interrupts the call in flight when the run is cancelled", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        const interrupted = yield* Deferred.make<void>();
        fakes.answers.push(
          Effect.onInterrupt(Effect.never, () => Deferred.succeed(interrupted, undefined)),
        );
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        yield* waitForCalls(fakes, 1);

        yield* Effect.flatMap(RunService, (runs) => runs.cancel(runId, {}));
        yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"));
        const ended = yield* readRun(runId);
        expect(ended.status).toBe("cancelled");
        expect(findRecord(ended, "summarize")?.status).toBe("cancelled");
      }),
    );
  });

  it("wakes a run already pinned to a runner when its text-generation step waits", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        const runnerId = yield* insertRunner;
        const repoId = yield* insertRepo;
        fakes.readiness = "notReady";
        const runId = yield* startRun({
          name: "Commit, then title",
          inputs: [{ name: "text", schema: { type: "string" }, required: true }],
          workspace: { kind: "ephemeral" as const, checkouts: [{ resourceId: repoId }] },
          steps: [
            {
              id: "commit",
              kind: "action" as const,
              action: "git.commit",
              params: { message: "Save the work" },
            },
            buildSummarizeStep("summarize", "{{ steps.commit.output.sha }}"),
          ],
          edges: [{ from: "commit", to: "summarize" }],
        });
        yield* waitFor(
          "the commit step to be handed on",
          Effect.sync(() => fakes.starts[0]),
        );
        const runs = yield* RunService;
        yield* runs.completeStep(runnerId, {
          runId,
          stepId: "commit",
          iteration: 1,
          outcome: {
            status: "completed",
            output: { sha: "abc123", branch: `hercule/run-${runId}`, committed: true },
          },
        });
        yield* waitFor(
          "the summarize step to wait",
          Effect.map(readRun(runId), (run) =>
            findRecord(run, "summarize")?.status === "pending" ? run : undefined,
          ),
        );
        expect((yield* readRun(runId)).runnerId).toBe(runnerId);

        fakes.answers.push(Effect.succeed(TITLED));
        yield* becomeReady(fakes);
        const ended = yield* waitForRunToEnd(runId);
        expect(ended.status, JSON.stringify(ended)).toBe("completed");
        expect(fakes.calls[0]?.input).toBe("abc123");
      }),
    );
  });
});

/** The capabilities a runner of this build negotiates at hello. */
const CURRENT_CAPABILITIES = JSON.stringify([
  WORKSPACE_LIFECYCLE_CAPABILITY,
  ...[...WORKSPACE_ACTION_IDS].map(buildWorkspaceActionCapability),
]);

/** Inserts an online, active runner of this build, and returns its id. */
const insertRunner = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const id = mintUuid();
  const name = uuidToString(id);
  yield* sql`
    INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                         negotiated_capabilities, credential_hash, created_at, updated_at)
    VALUES (${id}, ${name}, 'online', 'active', 0, '[]',
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
