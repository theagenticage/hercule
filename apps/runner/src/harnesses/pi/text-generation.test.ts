/**
 * Tests the pi adapter's text generation with a fake pi, so no vendor code
 * runs: how pi is launched, and how each way the call can end is reported.
 * The events pushed to the fake follow the shapes pi 0.85.1 emits.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import type { OutputSchema, TextGenerationOutcome, TextGenerationSpec } from "@hercule/protocol";
import { buildTextGenerationContext } from "../testing";
import type { HarnessAdapter } from "../index";
import { makePiAdapter } from "./adapter";
import {
  ACCESS_MODE_VARIABLE,
  OUTPUT_SCHEMA_VARIABLE,
  SUBAGENTS_VARIABLE,
  SUBMIT_RESULT_TOOL,
} from "./extension";
import {
  buildContext,
  buildFakePiSeam,
  cleanupHomes,
  createPiHome,
  settle,
  waitUntil,
  type FakePiBehaviour,
  type Spawn,
} from "./testing";

afterAll(cleanupHomes);

const OUTPUT_SCHEMA: OutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "needsRefinement"],
  properties: { title: { type: "string" }, needsRefinement: { type: "boolean" } },
};

const INSTRUCTIONS = "Write a short title for the conversation.";

const SPEC: TextGenerationSpec = {
  model: "glm-5.3-flash",
  instructions: INSTRUCTIONS,
  input: "can you help me fix the flaky login test?",
  outputSchema: OUTPUT_SCHEMA,
};

const ANSWER = { title: "Fixing a flaky login test", needsRefinement: false };

const SUBMIT_CALL = "call-submit-1";

const USAGE = { input: 261, output: 27, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0000263 } };

/**
 * Makes a text generation on `adapter` in a new scratch directory, which the
 * runner makes and removes in production. An error message the adapter fails
 * with becomes a `failed` outcome, as the runner does.
 */
const generate = (
  adapter: HarnessAdapter,
  home: string = createPiHome(),
): Effect.Effect<TextGenerationOutcome> =>
  Effect.catch(
    adapter.generateText(buildTextGenerationContext(buildContext(home)), SPEC),
    (message) => Effect.succeed<TextGenerationOutcome>({ outcome: "failed", message }),
  );

/** Starts a text generation on a fake pi and waits until the adapter has launched pi. */
const startGeneration = async (
  behaviour: FakePiBehaviour = {},
): Promise<{
  readonly outcome: Promise<TextGenerationOutcome>;
  readonly child: Spawn;
  readonly spawns: ReadonlyArray<Spawn>;
}> => {
  const { seam, spawns } = buildFakePiSeam(behaviour);
  const outcome = Effect.runPromise(generate(makePiAdapter(seam)));
  await waitUntil("launched a pi", () => spawns.length === 1);
  return { outcome, child: spawns[0]!, spawns };
};

/** Pushes the events of a turn in which the model calls `submit_result` with `args`. */
const answerWith = (child: Spawn, args: Record<string, unknown>): void => {
  child.push({ type: "agent_start" });
  child.push({
    type: "tool_execution_start",
    toolCallId: SUBMIT_CALL,
    toolName: SUBMIT_RESULT_TOOL,
    args,
  });
  child.push({
    type: "tool_execution_end",
    toolCallId: SUBMIT_CALL,
    toolName: SUBMIT_RESULT_TOOL,
    result: { content: [{ type: "text", text: "Recorded." }] },
  });
  child.push({
    type: "turn_end",
    message: { role: "assistant", stopReason: "toolUse", usage: USAGE },
  });
  child.push({ type: "agent_settled" });
};

const readFlagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];

describe("a text generation on pi", () => {
  it("returns the submitted value and the usage when the value matches the schema", async () => {
    const { outcome, child } = await startGeneration();

    answerWith(child, ANSWER);

    await expect(outcome).resolves.toEqual({
      outcome: "ok",
      value: ANSWER,
      usage: {
        inputTokens: 261,
        outputTokens: 27,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0000263,
      },
    });
  });

  it("sends the input as the one prompt", async () => {
    const { outcome, child } = await startGeneration();

    answerWith(child, ANSWER);
    await outcome;

    expect(child.sent.filter((one) => one.type === "prompt").map((one) => one.command)).toEqual([
      expect.objectContaining({ message: SPEC.input }),
    ]);
  });

  it("reports invalid output when the submitted value does not match the schema", async () => {
    const { outcome, child } = await startGeneration();

    answerWith(child, { title: 42, needsRefinement: false });

    const result = await outcome;

    expect(result.outcome).toBe("invalid-output");
    expect(result.outcome === "invalid-output" && result.reason).toContain("title");
  });

  it("reports invalid output, without asking again, when pi settles with no submission", async () => {
    const { outcome, child } = await startGeneration();

    child.push({ type: "agent_start" });
    child.push({
      type: "turn_end",
      message: { role: "assistant", stopReason: "stop", usage: USAGE },
    });
    child.push({ type: "agent_settled" });

    const result = await outcome;

    expect(result.outcome).toBe("invalid-output");
    expect(result.outcome === "invalid-output" && result.reason).toContain(SUBMIT_RESULT_TOOL);
    expect(child.sent.filter((one) => one.type === "prompt")).toHaveLength(1);
  });

  it("stops a model that keeps sending values the schema rejects, and reports invalid output", async () => {
    const { outcome, child } = await startGeneration();

    child.push({ type: "agent_start" });
    for (const callId of ["call-1", "call-2", "call-3"]) {
      child.push({
        type: "tool_execution_start",
        toolCallId: callId,
        toolName: SUBMIT_RESULT_TOOL,
        args: { title: 1 },
      });
      child.push({
        type: "tool_execution_end",
        toolCallId: callId,
        toolName: SUBMIT_RESULT_TOOL,
        isError: true,
        result: { content: [{ type: "text", text: "Validation failed" }] },
      });
    }
    await waitUntil("asked pi to abort", () => child.sent.some((one) => one.type === "abort"));
    child.push({ type: "agent_settled" });

    await expect(outcome).resolves.toMatchObject({ outcome: "invalid-output" });
  });

  it("reports a failure with pi's error when the model call ends in an error", async () => {
    const { outcome, child } = await startGeneration();

    child.push({ type: "agent_start" });
    child.push({
      type: "turn_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "401 invalid api key" },
    });
    child.push({ type: "agent_end", messages: [], willRetry: false });
    child.push({ type: "agent_settled" });

    await expect(outcome).resolves.toEqual({ outcome: "failed", message: "401 invalid api key" });
  });

  it("reports a failure without pi's error output when pi exits before it answers", async () => {
    const { outcome, child } = await startGeneration();

    // The message is stored and shown, and error output can hold a credential.
    child.crash("pi: Z.ai rejected the key zai-secret-123");

    await expect(outcome).resolves.toEqual({
      outcome: "failed",
      message: "pi exited before it answered",
    });
  });

  it("reports a failure when pi will not start", async () => {
    const { seam } = buildFakePiSeam({ dies: true });

    const outcome = await Effect.runPromise(generate(makePiAdapter(seam)));

    expect(outcome).toEqual({ outcome: "failed", message: "pi exited before it answered" });
  });

  it("reports a failure when pi refuses the prompt", async () => {
    const { outcome } = await startGeneration({
      answers: { prompt: () => ({ success: false, error: "No API key found for zai" }) },
    });

    await expect(outcome).resolves.toEqual({
      outcome: "failed",
      message: "No API key found for zai",
    });
  });

  it("fails at once, without waiting for the turn, when the model calls another tool", async () => {
    const { outcome, child } = await startGeneration();

    child.push({ type: "agent_start" });
    child.push({
      type: "tool_execution_start",
      toolCallId: "call-bash-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    await expect(outcome).resolves.toEqual({
      outcome: "failed",
      message: `the model tried to use a tool other than ${SUBMIT_RESULT_TOOL}, and a text generation allows only ${SUBMIT_RESULT_TOOL}`,
    });
    expect(child.kills()).toBe(1);
  });

  it("keeps the name of a tool the model chose out of the failure message", async () => {
    const { outcome, child } = await startGeneration();
    const modelChosenName = "PRIVATE_CUSTOMER_KEY_73dbfa";

    // pi reports the start of a call to a tool that does not exist before it
    // finds out that the tool does not exist, so the name is the model's text.
    child.push({
      type: "tool_execution_start",
      toolCallId: "call-made-up-1",
      toolName: modelChosenName,
      args: {},
    });

    const settled = await outcome;
    expect(settled.outcome).toBe("failed");
    expect(JSON.stringify(settled)).not.toContain(modelChosenName);
  });

  it("fails, and does not judge a later answer, when pi asks for an approval", async () => {
    const { outcome, child } = await startGeneration();

    child.push({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Approve write?",
      message: JSON.stringify({ toolCallId: "call-write-1", command: "", path: "/etc/hosts" }),
    });
    // A valid answer after the request must not count.
    answerWith(child, ANSWER);

    await expect(outcome).resolves.toEqual({
      outcome: "failed",
      message: `pi asked for approval, and a text generation allows only ${SUBMIT_RESULT_TOOL} and has nobody to ask`,
    });
    expect(child.kills()).toBe(1);
  });

  it("does not fail the call for pi's notifications, which need no answer", async () => {
    const { outcome, child } = await startGeneration();

    child.push({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "hello" });
    answerWith(child, ANSWER);

    await expect(outcome).resolves.toMatchObject({ outcome: "ok", value: ANSWER });
  });
});

describe("launching pi for a text generation", () => {
  it("keeps no session and has only the submit_result tool", async () => {
    const { outcome, child } = await startGeneration();
    const argv = child.command;

    expect(argv).toContain("--no-session");
    expect(argv).toContain("--no-builtin-tools");
    // `--no-tools` would also remove the extension's `submit_result`.
    expect(argv).not.toContain("--no-tools");
    // The extension always registers `bash`, which `--no-builtin-tools` keeps.
    expect(readFlagValue(argv, "--exclude-tools")).toBe("bash");
    expect(argv).not.toContain("--session-dir");
    expect(readFlagValue(argv, "--model")).toBe("zai/glm-5.3-flash");
    expect(readFlagValue(argv, "--thinking")).toBe("off");

    answerWith(child, ANSWER);
    await outcome;
  });

  it("gives pi the schema and the approval hook, and none of a session's other settings", async () => {
    const { outcome, child } = await startGeneration();

    expect(child.env[OUTPUT_SCHEMA_VARIABLE]).toBe(JSON.stringify(OUTPUT_SCHEMA));
    // Never full access: a tool pi kept by mistake would then run unasked.
    expect(child.env[ACCESS_MODE_VARIABLE]).toBe("approval-required");
    expect(child.env[SUBAGENTS_VARIABLE]).toBeUndefined();

    answerWith(child, ANSWER);
    await outcome;
  });

  it("passes the instructions as a file path, not as text", async () => {
    const { outcome, child } = await startGeneration();

    const path = readFlagValue(child.command, "--system-prompt")!;
    expect(readFileSync(path, "utf8")).toBe(INSTRUCTIONS);
    expect(child.command).not.toContain(INSTRUCTIONS);

    answerWith(child, ANSWER);
    await outcome;
  });

  it("runs pi in the scratch directory of the call, and keeps pi's files in it", async () => {
    const { outcome, child } = await startGeneration();
    const scratch = child.cwd!;
    // pi's agent directory is the scratch directory too, so the files pi
    // writes there go when the runner removes it.
    expect(child.env["PI_CODING_AGENT_DIR"]).toBe(scratch);
    expect(existsSync(join(scratch, "extension.ts"))).toBe(true);
    expect(readFlagValue(child.command, "--system-prompt")!.startsWith(scratch)).toBe(true);
    expect(readFlagValue(child.command, "-e")!.startsWith(scratch)).toBe(true);

    answerWith(child, ANSWER);
    await outcome;

    expect(child.kills()).toBe(1);
  });

  it("gives pi the model catalog the probe stored in the Harness Home", async () => {
    const { seam, spawns } = buildFakePiSeam();
    const home = createPiHome();
    const catalog = '{"models":["a-model-newer-than-pi"]}';
    writeFileSync(join(home, "models-store.json"), catalog, { mode: 0o600 });
    const outcome = Effect.runPromise(generate(makePiAdapter(seam), home));
    await waitUntil("launched a pi", () => spawns.length === 1);
    const child = spawns[0]!;

    const copy = join(child.cwd!, "models-store.json");
    expect(readFileSync(copy, "utf8")).toBe(catalog);
    expect(statSync(copy).mode & 0o777).toBe(0o600);

    answerWith(child, ANSWER);
    await outcome;
  });

  it("starts pi when the Harness Home holds no stored model catalog", async () => {
    const { outcome, child } = await startGeneration();

    expect(existsSync(join(child.cwd!, "models-store.json"))).toBe(false);

    answerWith(child, ANSWER);
    await expect(outcome).resolves.toMatchObject({ outcome: "ok" });
  });

  it("writes nothing into the Harness Home", async () => {
    const { seam, spawns } = buildFakePiSeam();
    const home = createPiHome();
    const outcome = Effect.runPromise(generate(makePiAdapter(seam), home));
    await waitUntil("launched a pi", () => spawns.length === 1);

    answerWith(spawns[0]!, ANSWER);
    await outcome;

    expect(readdirSync(home)).toEqual([]);
  });

  it("kills pi when the caller gives up", async () => {
    const { seam, spawns } = buildFakePiSeam();
    const adapter = makePiAdapter(seam);
    const call = Effect.runPromise(
      adapter
        .generateText(buildTextGenerationContext(buildContext(createPiHome())), SPEC)
        .pipe(Effect.timeoutOption("50 millis")),
    );
    await waitUntil("launched a pi", () => spawns.length === 1);

    expect(Option.isNone(await call)).toBe(true);
    await settle();

    expect(spawns[0]!.kills()).toBe(1);
  });

  it("returns only after a pi that shuts down slowly has exited", async () => {
    const exit = Promise.withResolvers<void>();
    const { seam, spawns } = buildFakePiSeam({ exitsAfterKill: exit.promise });
    const outcome = Effect.runPromise(generate(makePiAdapter(seam)));
    await waitUntil("launched a pi", () => spawns.length === 1);
    answerWith(spawns[0]!, ANSWER);
    await waitUntil("asked pi to stop", () => spawns[0]!.kills() === 1);

    let returned = false;
    void outcome.then(() => {
      returned = true;
    });
    await settle();
    expect(returned).toBe(false);

    exit.resolve();
    await expect(outcome).resolves.toMatchObject({ outcome: "ok" });
  });
});
