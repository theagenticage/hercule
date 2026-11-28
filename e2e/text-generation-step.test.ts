/**
 * Tests the text generation step through the shipped program: a workflow run
 * whose one step makes a text generation, under each value of the controller
 * setting `textGeneration.model` that decides what such a step does.
 *
 * - `off`: the step fails at once with `text_generation_off`, because the
 *   user chose Off and waiting would hide that choice.
 * - `automatic` with no logged-in Provider Account, which is what a
 *   throwaway Hercule Home has: the step waits, the run stays running, and
 *   `controller read` says why no text generation can run. Cancelling the
 *   run ends the wait.
 * - `automatic` with a logged-in account: the step makes a real model call
 *   and completes with an output that matches its schema. This case spends
 *   real tokens, so it is opt-in like `session.test.ts`: set
 *   `HERCULE_LIVE_SESSION_TEST=1`, and provide a login by either of the two
 *   routes `e2e/harness.ts` documents.
 *
 * The suite is in vitest's `binary` project, so `pnpm test:binary` runs it and
 * `pnpm test` does not. It runs the release binary if one has been built, and
 * the dispatcher's source otherwise.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  runCli,
  completeSetup,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  LOGIN_DEADLINE_MS,
  createTemporaryHome,
  findReleaseBinary,
  isLiveSessionTestEnabled,
  isLoginAvailable,
  parseJsonOutputOrFail,
  prepareLoggedInAccount,
  readApiKey,
  type TemporaryHome,
} from "./harness";

/** How long a run may take to reach the state a case waits for, when no model is called. */
const RUN_DEADLINE_MS = 30_000;

/** How long a live text generation may take: the service's own deadline is 60 s. */
const LIVE_RUN_DEADLINE_MS = 120_000;

/**
 * How long a waiting run is watched to show that it keeps waiting. A step
 * that wrongly failed or completed would do so well within this time.
 */
const WAIT_OBSERVATION_MS = 3_000;

/**
 * A workflow with one text generation step. Its output schema requires one
 * string, so the live case can check the output against it.
 */
const WORKFLOW_FILE = [
  "name: Classify a note",
  "steps:",
  "  - id: classify",
  "    kind: text-generation",
  '    instructions: "Reply with one word that describes the mood of the note."',
  '    input: "The release went out on time and every check is green."',
  "    outputSchema:",
  "      type: object",
  "      additionalProperties: false",
  "      required: [mood]",
  "      properties:",
  "        mood: { type: string }",
  "",
].join("\n");

interface StepRecord {
  readonly stepId: string;
  readonly status: string;
  readonly output?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

interface Run {
  readonly id: string;
  readonly status: string;
  readonly failureReason?: string;
  readonly failedStepId?: string;
  readonly steps: ReadonlyArray<StepRecord>;
}

interface ControllerInfo {
  readonly textGeneration: {
    readonly unavailableReason: string | null;
  };
}

/** A controller in its own throwaway home, with a logged-in CLI. */
interface Instance {
  readonly state: TemporaryHome;
  readonly controller: Controller;
  readonly binary: string | undefined;
}

/**
 * Creates a throwaway home, starts a controller in it, completes setup and
 * logs the CLI in. `env` is passed to the controller and to the runner it
 * starts for itself.
 */
const startInstance = async (
  binary: string | undefined,
  env?: Readonly<Record<string, string>>,
): Promise<Instance> => {
  const state = createTemporaryHome();
  const controller = await startController({ home: state.home, binary, env });
  const completed = await completeSetup({ home: state.home, url: controller.url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await runCli(
    [
      "login",
      controller.url,
      "--username",
      USERNAME,
      "--password-stdin",
      "--name",
      "e2e-text-generation-step",
    ],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  return { state, controller, binary };
};

/** Stops the controller and removes its home, including any copied credential. */
const stopInstance = async (instance: Instance | undefined): Promise<void> => {
  await instance?.controller.stop().catch(() => -1);
  instance?.state.remove();
};

const runInstanceCli = (instance: Instance, args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: instance.state.home, binary: instance.binary, stdin });

/** Sets the controller setting `textGeneration.model`, and fails when the update is refused. */
const setTextGenerationModel = async (instance: Instance, value: string): Promise<void> => {
  const ran: Ran = await runInstanceCli(instance, [
    "settings",
    "update",
    "--controller",
    JSON.stringify({ "textGeneration.model": value }),
    "--json",
  ]);
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
};

/** Stores the workflow and starts one run of it. Returns the run's id. */
const startTextGenerationRun = async (instance: Instance): Promise<string> => {
  const workflowId = parseJsonOutputOrFail<{ readonly workflow: { readonly id: string } }>(
    await runInstanceCli(instance, ["workflow", "create", "--json"], WORKFLOW_FILE),
  ).workflow.id;
  return parseJsonOutputOrFail<{ readonly runId: string }>(
    await runInstanceCli(instance, ["run", "start", "--workflow", workflowId, "--json"]),
  ).runId;
};

const readRun = async (instance: Instance, runId: string): Promise<Run> =>
  parseJsonOutputOrFail<Run>(await runInstanceCli(instance, ["run", "read", runId, "--json"]));

/**
 * Reads a run until `isReached` holds for it, and returns it. Throws with the
 * run and the controller's output at the deadline.
 */
const waitForRun = async (
  instance: Instance,
  runId: string,
  isReached: (run: Run) => boolean,
  deadlineMs: number,
): Promise<Run> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const run = await readRun(instance, runId);
    if (isReached(run)) return run;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} did not reach the expected state within ${String(deadlineMs)}ms; ` +
          `it reads ${JSON.stringify(run)}\n${instance.controller.output()}`,
      );
    }
    await Bun.sleep(250);
  }
};

const hasEnded = (run: Run): boolean => run.status !== "pending" && run.status !== "running";

/** Returns the run's record of the `classify` step, or undefined before the run makes one. */
const findClassifyRecord = (run: Run): StepRecord | undefined =>
  run.steps.find((step) => step.stepId === "classify");

describe("a text generation step with no model to run on", () => {
  let instance: Instance | undefined;

  beforeAll(async () => {
    // An empty key, so a developer's own `ANTHROPIC_API_KEY` cannot log the
    // runner in: these cases need a controller with no logged-in account.
    instance = await startInstance(findReleaseBinary(), { ANTHROPIC_API_KEY: "" });
  }, 90_000);

  afterAll(async () => {
    await stopInstance(instance);
  });

  it("fails the run with text_generation_off when the setting is off", async () => {
    await setTextGenerationModel(instance!, "off");
    const runId = await startTextGenerationRun(instance!);

    const run = await waitForRun(instance!, runId, hasEnded, RUN_DEADLINE_MS);

    expect(run.status, JSON.stringify(run)).toBe("failed");
    expect(run.failureReason).toBe("step-failed");
    expect(run.failedStepId).toBe("classify");
    const record = findClassifyRecord(run);
    expect(record?.status).toBe("failed");
    expect(record?.error?.code).toBe("text_generation_off");
  }, 60_000);

  it("keeps the run waiting while no model resolves, until it is cancelled", async () => {
    await setTextGenerationModel(instance!, "automatic");
    const runId = await startTextGenerationRun(instance!);

    await waitForRun(
      instance!,
      runId,
      (run) => run.status === "running" && findClassifyRecord(run)?.status === "running",
      RUN_DEADLINE_MS,
    );
    // The run keeps waiting, its record running while the call waits for a
    // runner: it neither fails nor completes on its own.
    const watchUntil = Date.now() + WAIT_OBSERVATION_MS;
    while (Date.now() < watchUntil) {
      const run = await readRun(instance!, runId);
      expect(run.status, JSON.stringify(run)).toBe("running");
      expect(findClassifyRecord(run)?.status).toBe("running");
      await Bun.sleep(250);
    }

    const info = parseJsonOutputOrFail<ControllerInfo>(
      await runInstanceCli(instance!, ["controller", "read", "--json"]),
    );
    expect(info.textGeneration.unavailableReason).toEqual(expect.any(String));

    const cancelled = await runInstanceCli(instance!, ["run", "cancel", runId, "--json"]);
    expect(cancelled.code, `${cancelled.stdout}\n${cancelled.stderr}`).toBe(0);
    const run = await waitForRun(instance!, runId, hasEnded, RUN_DEADLINE_MS);
    expect(run.status, JSON.stringify(run)).toBe("cancelled");
  }, 60_000);
});

/** Opt-in: `pnpm test:binary` on any machine must not silently spend a subscription. */
const wanted = isLiveSessionTestEnabled();

describe.skipIf(!wanted)("a text generation step with a logged-in model", () => {
  // The login routes copy a credential into the runner's storage, so this
  // case needs the release binary and its runner, as every live case does.
  const binary = join(ROOT, "hercule");
  let instance: Instance | undefined;

  beforeAll(async () => {
    if (!isLoginAvailable()) return;
    instance = await startInstance(binary);
    await prepareLoggedInAccount({
      home: instance.state.home,
      binary,
      url: instance.controller.url,
      apiKey: readApiKey(instance.state.home),
    });
  }, LOGIN_DEADLINE_MS * 2);

  afterAll(async () => {
    await stopInstance(instance);
  });

  it(
    "completes the run with an output that matches the step's schema",
    async (ctx) => {
      if (instance === undefined) {
        ctx.skip(
          "no login for the claude-code account: name a credentials file in " +
            "HERCULE_E2E_CLAUDE_CREDENTIALS, or put ANTHROPIC_API_KEY on the environment.",
        );
        return;
      }
      const runId = await startTextGenerationRun(instance);

      const run = await waitForRun(instance, runId, hasEnded, LIVE_RUN_DEADLINE_MS);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      const record = findClassifyRecord(run);
      expect(record?.status).toBe("completed");
      expect(Object.keys(record?.output ?? {})).toEqual(["mood"]);
      expect(record?.output?.["mood"]).toEqual(expect.any(String));
    },
    LIVE_RUN_DEADLINE_MS + 30_000,
  );
});
