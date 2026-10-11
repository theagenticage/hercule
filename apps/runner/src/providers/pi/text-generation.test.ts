/**
 * Tests the pi adapter's text generation with a fake pi, so no vendor code
 * runs: how pi is launched, and how each way the call can end is reported.
 * The events pushed to the fake follow the shapes pi 0.85.1 emits.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import type { OutputSchema, TextGenerationOutcome, TextGenerationSpec } from "@hercule/protocol";
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
  model: { model: "glm-5.3-flash", options: {} },
  instructions: INSTRUCTIONS,
  input: "can you help me fix the flaky login test?",
  outputSchema: OUTPUT_SCHEMA,
};

const ANSWER = { title: "Fixing a flaky login test", needsRefinement: false };

const SUBMIT_CALL = "call-submit-1";

const USAGE = { input: 261, output: 27, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0000263 } };

/** Starts a text generation on a fake pi and waits until the adapter has launched pi. */
const startGeneration = async (
  behaviour: FakePiBehaviour = {},
): Promise<{
  readonly outcome: Promise<TextGenerationOutcome>;
  readonly child: Spawn;
  readonly spawns: ReadonlyArray<Spawn>;
}> => {
  const { seam, spawns } = buildFakePiSeam(behaviour);
  const adapter = makePiAdapter(seam);
  const outcome = Effect.runPromise(adapter.generateText(buildContext(createPiHome()), {}, SPEC));
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

  it("reports a failure with pi's last error output when pi exits before it answers", async () => {
    const { outcome, child } = await startGeneration();

    child.crash("pi: Z.ai rejected the key");

    await expect(outcome).resolves.toEqual({
      outcome: "failed",
      message: "pi: Z.ai rejected the key",
    });
  });

  it("reports a failure when pi will not start", async () => {
    const { seam } = buildFakePiSeam({ dies: true });
    const adapter = makePiAdapter(seam);

    const outcome = await Effect.runPromise(
      adapter.generateText(buildContext(createPiHome()), {}, SPEC),
    );

    expect(outcome).toEqual({ outcome: "failed", message: "pi: could not start" });
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

  it("reports a failure when the machine has no pi", async () => {
    const { seam, spawns } = buildFakePiSeam();
    const adapter = makePiAdapter(seam);
    const ctx = { ...buildContext(createPiHome()), binary: undefined };

    const outcome = await Effect.runPromise(adapter.generateText(ctx, {}, SPEC));

    expect(outcome).toEqual({ outcome: "failed", message: "no pi on this machine" });
    expect(spawns).toHaveLength(0);
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

  it("gives pi the schema and no approval hook, and none of a session's other settings", async () => {
    const { outcome, child } = await startGeneration();

    expect(child.env[OUTPUT_SCHEMA_VARIABLE]).toBe(JSON.stringify(OUTPUT_SCHEMA));
    expect(child.env[ACCESS_MODE_VARIABLE]).toBe("full-access");
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

  it("runs pi in a scratch directory, and removes it with pi's files once the call ends", async () => {
    const { outcome, child } = await startGeneration();
    const scratch = child.cwd!;
    // pi's agent directory is the scratch directory too, so the files pi
    // writes there go when the call ends.
    expect(child.env["PI_CODING_AGENT_DIR"]).toBe(scratch);
    expect(existsSync(join(scratch, "extension.ts"))).toBe(true);
    expect(readFlagValue(child.command, "--system-prompt")!.startsWith(scratch)).toBe(true);
    expect(readFlagValue(child.command, "-e")!.startsWith(scratch)).toBe(true);

    answerWith(child, ANSWER);
    await outcome;

    expect(existsSync(scratch)).toBe(false);
    expect(child.kills()).toBe(1);
  });

  it("writes nothing into the instance's home", async () => {
    const { seam, spawns } = buildFakePiSeam();
    const home = createPiHome();
    const adapter = makePiAdapter(seam);
    const outcome = Effect.runPromise(adapter.generateText(buildContext(home), {}, SPEC));
    await waitUntil("launched a pi", () => spawns.length === 1);

    answerWith(spawns[0]!, ANSWER);
    await outcome;

    expect(readdirSync(home)).toEqual([]);
  });

  it("kills pi and removes the scratch directory when the caller gives up", async () => {
    const { seam, spawns } = buildFakePiSeam();
    const adapter = makePiAdapter(seam);
    const call = Effect.runPromise(
      adapter
        .generateText(buildContext(createPiHome()), {}, SPEC)
        .pipe(Effect.timeoutOption("50 millis")),
    );
    await waitUntil("launched a pi", () => spawns.length === 1);
    const scratch = spawns[0]!.cwd!;

    expect(Option.isNone(await call)).toBe(true);
    await settle();

    expect(spawns[0]!.kills()).toBe(1);
    expect(existsSync(scratch)).toBe(false);
  });
});
