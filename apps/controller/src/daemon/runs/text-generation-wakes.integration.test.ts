/**
 * Tests that a run whose text-generation step waits for a runner is woken by
 * the two changes `TextGenerationWakes` listens to: a write of the
 * `textGeneration.model` setting, and a provider snapshot a probe stores.
 * They run a real controller with a fake runner on the real runner socket.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { ModelDescriptor, RunnerFacts, TextGenerationRequest } from "@hercule/protocol";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { uuidFromString } from "../../db";
import { post, send } from "../../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../../plugins/testing";
import { findStepRecords, listTasks, readRun, startRun, waitForRunTo } from "../../runs/testing";
import {
  findInstanceId,
  WAIT_DEADLINE_MS,
  waitUntil,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../../sessions/testing";
import { createWorkflowOrFail } from "../../workflows/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const withSuggestion = (id: string, model: string): ProviderDefinition => ({
  ...buildProviderDefinition(id, { token: "t" }),
  suggestedTextGenerationModel: model,
});

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["codex", "pi"],
  identityPort: 4939,
};

const MODELS: ReadonlyArray<ModelDescriptor> = ["codex-mini", "pi-small"].map((slug, index) => ({
  slug,
  name: slug,
  imageInput: { maxBytes: null },
  isDefault: index === 0,
  options: [],
}));

/** Runs `body` against a controller with one runner that offers both suggested models. */
const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, {
    plugins: [
      createPluginFixture({
        id: "titles",
        definitions: [withSuggestion("codex", "codex-mini"), withSuggestion("pi", "pi-small")],
      }).plugin,
    ],
    facts: FACTS,
    models: MODELS,
  });

const TITLE = "Fix the login bug";

/** A workflow that titles a text with a model, then files a task with that title. */
const SUMMARIZE_DEFINITION = {
  name: "Title, then file",
  steps: [
    {
      id: "summarize",
      kind: "text-generation",
      instructions: "Write a short title for the text.",
      input: "The login page rejects every password.",
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    },
    {
      id: "file",
      kind: "action",
      action: "task.create",
      params: { title: "{{ steps.summarize.output.title }}", description: "" },
    },
  ],
  edges: [{ from: "summarize", to: "file" }],
};

const setModel = async (arranged: Arranged, model: unknown): Promise<void> => {
  const response = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
    body: { controller: { "textGeneration.model": model } },
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

/**
 * Starts a run of the summarize workflow and returns its id once the run is
 * asleep with its text-generation step pending and no call sent.
 */
const startWaitingRun = async (arranged: Arranged): Promise<string> => {
  const { base } = arranged.harness;
  const workflow = await createWorkflowOrFail(base, arranged.token, {
    definition: SUMMARIZE_DEFINITION,
  });
  const runId = await startRun(base, arranged.token, workflow.id);
  // The record is pending from the run's start, before the run's first pass
  // checks for a runner. Waiting for that pass to end makes sure the call the
  // test then sees is made by the wake and not by the first pass.
  await waitUntil("the run's first pass ended", () =>
    arranged.harness.isRunExecuting(runId) ? undefined : true,
  );
  const run = await readRun(arranged.harness.base, arranged.token, runId);
  expect(run.status).toBe("running");
  expect(findStepRecords(run, "summarize").map((record) => record.status)).toEqual(["pending"]);
  expect(arranged.wire.frames.some((frame) => frame._tag === "textGenerationRequest")).toBe(false);
  return runId;
};

/** Waits until the run completed, and checks it filed the task with the model's title. */
const expectCompletedWithTitle = async (arranged: Arranged, runId: string): Promise<void> => {
  const run = await waitForRunTo(arranged, runId, "completed", (read) => read.status !== "running");
  expect(run.status, JSON.stringify(run)).toBe("completed");
  const tasks = await listTasks(arranged.harness.base, arranged.token);
  expect(tasks.map((task) => task.title)).toEqual([TITLE]);
  const requests = arranged.wire.frames.filter(
    (frame): frame is TextGenerationRequest => frame._tag === "textGenerationRequest",
  );
  expect(requests).toHaveLength(1);
};

const answerWithTitle = (arranged: Arranged): void =>
  arranged.wire.setTextGenerationAnswer(() => ({
    outcome: "ok",
    value: { title: TITLE },
    usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.002 },
  }));

describe("a run waiting for text generation", () => {
  it("wakes when the textGeneration.model setting is written", async () => {
    await withFleet(async (arranged) => {
      answerWithTitle(arranged);
      await setModel(arranged, {
        instanceId: findInstanceId(arranged, "pi"),
        model: "not-in-any-list",
      });
      const runId = await startWaitingRun(arranged);

      await setModel(arranged, "automatic");

      await expectCompletedWithTitle(arranged, runId);
    });
  });

  it("wakes when a probe stores a provider snapshot", async () => {
    await withFleet(async (arranged) => {
      answerWithTitle(arranged);
      // Expires every login in the stored snapshots, as a probe would, so no
      // runner can take the call.
      await Effect.runPromise(
        arranged.harness.sql`UPDATE capability_snapshots SET auth_status = 'unauthenticated'
               WHERE runner_id = ${uuidFromString(arranged.runnerId)}`.pipe(Effect.orDie),
      );
      const runId = await startWaitingRun(arranged);

      const probed = await post(
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/probe`,
        { instanceId: findInstanceId(arranged, "codex") },
        arranged.token,
      );
      expect(probed.status, await probed.clone().text()).toBe(200);

      await expectCompletedWithTitle(arranged, runId);
    });
  });
});
