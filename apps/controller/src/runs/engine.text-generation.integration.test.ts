/**
 * Integration tests for text generation steps: steps that make one model call
 * through the `TextGeneration` service. They drive the run service on a
 * temporary database file, with the real Run Executor.
 *
 * No runner is connected. `TextGeneration` is a fake that answers each call
 * with the next answer a test queued. A call that waits for a runner waits
 * inside the service, so a test plays one with an answer that does not come
 * until the test says so. The service's own tests cover the wait itself.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, FiberMap, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Run, StepRecord } from "@hercule/contract";
import { buildWorkspaceActionCapability, WORKSPACE_LIFECYCLE_CAPABILITY } from "@hercule/protocol";
import { CurrentActor } from "../actor";
import { AfterCommit, mintUuid, nowIso, uuidToString, withTransaction } from "../db";
import { RunExecutorLayer, RunFibers } from "../daemon/runs";
import { EventKindsLayer, PlatformEventsLayer } from "../events";
import { SessionTokensLayer } from "../permissions";
import { EventKindCatalogLayer, PluginHost, WORKSPACE_ACTION_IDS } from "../plugins";
import { buildPluginStack, USER } from "../plugins/testing";
import { ProviderAccountRunnersLayer } from "../provider-accounts";
import { resourceRepository } from "../resources";
import { SettingsLayer } from "../settings";
import { AccountUsageLayer } from "../usage";
import { TaskServiceLayer } from "../tasks";
import { TextGeneration, TextGenerationError, type TextGenerationCall } from "../text-generation";
import { WorkflowRuns, WorkflowService, WorkflowServiceLayer, WorkflowSignals } from "../workflows";
import { WorkspaceServiceLayer } from "../workspaces";
import { runRepository } from "./repository";
import { RunService, RunServiceLayer } from "./service";
import { RunWorkspaceStepActivityLayer } from "./workspace-step-activity";
import { WorkspaceSteps, type WorkspaceStepToStart } from "./workspace-steps";

const at = "2026-10-14T10:00:00.000Z";

/** The fakes' state, which a test reads and changes. */
interface Fakes {
  /** The answers to the next calls, in order. A call with none left dies. */
  readonly answers: Array<Effect.Effect<unknown, TextGenerationError>>;
  readonly calls: Array<TextGenerationCall>;
  /** The workspace steps the fake Workspace Steps was asked to start. */
  readonly starts: Array<WorkspaceStepToStart>;
}

type Deps = RunService | WorkflowService | SqlClient.SqlClient;

/** Runs `body` against a fresh controller on a temporary database file, with the fakes `body` reads and sets. */
const runTest = <A, E>(body: (fakes: Fakes) => Effect.Effect<A, E, Deps | RunFibers>) => {
  const fakes: Fakes = { answers: [], calls: [], starts: [] };
  const textGeneration = Layer.succeed(TextGeneration)({
    generate: (call) =>
      Effect.suspend(() => {
        fakes.calls.push(call);
        const answer = fakes.answers.shift();
        return answer ?? Effect.die(`no answer queued for call ${String(fakes.calls.length)}`);
      }),
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
    Layer.provideMerge(ProviderAccountRunnersLayer),
    Layer.provideMerge(AccountUsageLayer),
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

/** A text generation step with this id that titles the run's `text` input. */
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

/** Builds the failure the fake `TextGeneration` answers a call with. */
const failCall = (reason: TextGenerationError["reason"], message = `the call ended: ${reason}`) =>
  Effect.fail(new TextGenerationError({ reason, message }));

const TITLED = { title: "Login fails on Safari" };

describe("a text generation step", () => {
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
            whenNoRunner: "wait",
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
        // A text generation step never pins its run.
        expect(ended.runnerId).toBeUndefined();
      }),
    );
  });

  it("fails with text_generation_off when the call finds text generation off", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        fakes.answers.push(failCall("off", "text generation is off in Settings"));
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
      }),
    );
  });

  it("stays running while its call waits for a runner, and completes once the call answers", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        const answered = yield* Deferred.make<unknown>();
        fakes.answers.push(Deferred.await(answered));
        const runId = yield* startRun(SUMMARIZE_DEFINITION);
        yield* waitForCalls(fakes, 1);
        yield* Effect.sleep("100 millis");
        const waiting = yield* readRun(runId);
        expect(waiting.status).toBe("running");
        expect(findRecord(waiting, "summarize")?.status).toBe("running");

        yield* Deferred.succeed(answered, TITLED);
        const ended = yield* waitForRunToEnd(runId);
        expect(ended.status, JSON.stringify(ended)).toBe("completed");
        expect(fakes.calls).toHaveLength(1);
      }),
    );
  });

  it("fails with expression_error, before any call, when the input cannot be rendered", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        const runId = yield* startRun({
          ...SUMMARIZE_DEFINITION,
          steps: [buildSummarizeStep("summarize", "{{ inputs.text.no_such_field }}"), FILE_STEP],
        });
        const ended = yield* waitForRunToEnd(runId);

        expect(ended).toMatchObject({
          status: "failed",
          failureReason: "expression-error",
          failedStepId: "summarize",
        });
        expect(findRecord(ended, "summarize")).toMatchObject({
          status: "failed",
          error: { code: "expression_error" },
        });
        expect(fakes.calls).toEqual([]);
      }),
    );
  });

  it("drops a value that returns after a cancel already ended the record", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* runRepository;
        let runId = "";
        // The cancel commits while the call is in flight, and the value
        // returns before the cancel stops the run's execution.
        fakes.answers.push(
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* withTransaction(
              sql,
              Effect.andThen(
                runs.cancelUnfinishedSteps(runId, at),
                runs.finish(runId, { status: "cancelled", keepWorkspace: false }, at),
              ),
            );
            return TITLED;
          }).pipe(Effect.orDie),
        );
        runId = yield* startRun(SUMMARIZE_DEFINITION);
        const ended = yield* waitForRunToEnd(runId);
        yield* Effect.sleep("100 millis");

        const read = yield* readRun(runId);
        expect(ended.status).toBe("cancelled");
        expect(read.status).toBe("cancelled");
        expect(findRecord(read, "summarize")?.status).toBe("cancelled");
        expect(findRecord(read, "file")).toBeUndefined();
      }),
    );
  });

  it.each([
    [
      "invalid-output",
      "schema_failure",
      "schema-failure",
      "The model's answer did not match the step's output schema.",
    ],
    ["timeout", "timeout", "step-failed", "The runner said no"],
    [
      "failed",
      "text_generation_failed",
      "step-failed",
      "The text generation failed: the runner said no",
    ],
  ] as const)(
    "fails a call that ends with %s with %s, and the run with %s",
    async (reason, code, failureReason, message) => {
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
          expect(record).toMatchObject({ status: "failed", error: { code, message } });
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

  it("makes the call of a run pinned to a runner without needing that runner", async () => {
    await runTest((fakes) =>
      Effect.gen(function* () {
        fakes.answers.push(Effect.succeed(TITLED));
        const runnerId = yield* insertRunner;
        const repoId = yield* insertRepo;
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
        const ended = yield* waitForRunToEnd(runId);
        expect(ended.status, JSON.stringify(ended)).toBe("completed");
        expect(ended.runnerId).toBe(runnerId);
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
  yield* withTransaction(
    sql,
    sql`
      INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                           negotiated_capabilities, credential_hash, created_at, updated_at)
      VALUES (${id}, ${name}, 'online', 'active', 0, '[]',
              ${CURRENT_CAPABILITIES}, ${name}, ${at}, ${at})
    `,
  );
  return name;
});

/** Inserts a repo and returns its id. */
const insertRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const resources = yield* resourceRepository;
  const remote = `https://github.com/o/${uuidToString(mintUuid())}.git`;
  const repo = yield* withTransaction(
    sql,
    resources.insert({
      kind: "repo",
      remote,
      canonicalRemote: remote,
      label: null,
      connectionId: null,
      setupCommand: null,
      workspaceInclude: false,
      at,
    }),
  );
  return repo.id;
});
