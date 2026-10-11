/**
 * Tests for the Codex text generation, run against a scripted app-server. No
 * Codex code runs. The notification shapes are copied from a live run of
 * codex 0.154.0 (`items`, `thread/tokenUsage/updated`, `turn/completed`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import type { TextGenerationOutcome, TextGenerationSpec } from "@hercule/protocol";
import { makeCodexAdapter } from "./adapter";
import { buildTextGenerationContext } from "../testing";
import {
  buildContext,
  buildScriptedSeam,
  cleanupHomes,
  createCodexHome,
  listSentParams,
  THREAD,
  TURN,
  settle,
  waitUntil,
  type Answers,
  type Spawn,
} from "./testing";

afterAll(cleanupHomes);

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, needsRefinement: { type: "boolean" } },
  required: ["title", "needsRefinement"],
  additionalProperties: false,
} as const;

const SPEC = {
  model: "gpt-5.6-luna",
  instructions: "Write a short title for the message.",
  input: "Why does the nightly backup fail?",
  outputSchema: OUTPUT_SCHEMA,
} as TextGenerationSpec;

const ANSWER = JSON.stringify({ title: "Backup failures", needsRefinement: false });

const item = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type,
  id: `${type}-1`,
  ...extra,
});

const started = (type: string): unknown => ({
  method: "item/started",
  params: { item: item(type), threadId: THREAD, turnId: TURN },
});

const completedMessage = (text: string): unknown => ({
  method: "item/completed",
  params: {
    item: item("agentMessage", { text, phase: "final_answer", memoryCitation: null }),
    threadId: THREAD,
    turnId: TURN,
  },
});

const tokenUsage = (
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): unknown => {
  const counts = {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
  };
  return {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: { total: counts, last: counts, modelContextWindow: 258400 },
    },
  };
};

const turnCompleted = (status: string, message?: string): unknown => ({
  method: "turn/completed",
  params: {
    threadId: THREAD,
    turn: {
      id: TURN,
      items: [],
      itemsView: "summary",
      status,
      error: message === undefined ? null : { message },
    },
  },
});

/** What a model that answers once, with the given final message, sends. */
const answering = (text: string, usage = tokenUsage(1742, 100, 31)): ReadonlyArray<unknown> => [
  started("userMessage"),
  started("agentMessage"),
  completedMessage(text),
  usage,
  turnCompleted("completed"),
];

interface Generation {
  readonly outcome: TextGenerationOutcome;
  readonly spawns: Array<Spawn>;
  readonly requests: ReturnType<typeof buildScriptedSeam>["requests"];
  readonly answered: ReturnType<typeof buildScriptedSeam>["answered"];
  /** The scratch directory the call ran in, which the runner made and the adapter never removes. */
  readonly scratch: string;
  /** The directory the thread was started in. */
  readonly threadCwd: () => string | undefined;
}

/** Runs a text generation; an error message the adapter fails with becomes a `failed` outcome, as the runner does. */
const runGeneration = (
  adapter: ReturnType<typeof makeCodexAdapter>,
  ctx: ReturnType<typeof buildTextGenerationContext>,
): Effect.Effect<TextGenerationOutcome> =>
  Effect.catch(adapter.generateText(ctx, {}, SPEC), (message) =>
    Effect.succeed<TextGenerationOutcome>({ outcome: "failed", message }),
  );

/**
 * Runs one text generation on a scripted app-server that sends `frames` as
 * soon as it gets `turn/start`.
 */
const generate = async (
  frames: ReadonlyArray<unknown>,
  options: { readonly answers?: Answers; readonly dies?: boolean } = {},
): Promise<Generation> => {
  let threadCwd: string | undefined;
  const scripted = buildScriptedSeam(
    {
      "thread/start": (params) => {
        threadCwd = (params as { cwd: string }).cwd;
        return { thread: { id: THREAD } };
      },
      "turn/start": () => {
        for (const frame of frames) scripted.spawns[0]!.push(frame);
        return { turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" } };
      },
      ...options.answers,
    },
    { dies: options.dies === true },
  );
  const adapter = makeCodexAdapter(scripted.seam);
  const ctx = buildTextGenerationContext(buildContext(createCodexHome()));
  const outcome = await Effect.runPromise(runGeneration(adapter, ctx));
  return {
    outcome,
    spawns: scripted.spawns,
    requests: scripted.requests,
    answered: scripted.answered,
    scratch: ctx.cwd,
    threadCwd: () => threadCwd,
  };
};

describe("codex generateText: ok", () => {
  it("returns the parsed answer and the usage with cached reads taken out of the input", async () => {
    const run = await generate(answering(ANSWER));
    expect(run.outcome).toEqual({
      outcome: "ok",
      value: { title: "Backup failures", needsRefinement: false },
      usage: { inputTokens: 1642, outputTokens: 31, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });
  });

  it("returns null usage when Codex reports none", async () => {
    const run = await generate([
      started("agentMessage"),
      completedMessage(ANSWER),
      turnCompleted("completed"),
    ]);
    expect(run.outcome).toMatchObject({ outcome: "ok", usage: null });
  });

  it("accepts reasoning items before the answer", async () => {
    const run = await generate([
      started("userMessage"),
      started("reasoning"),
      started("agentMessage"),
      completedMessage(ANSWER),
      turnCompleted("completed"),
    ]);
    expect(run.outcome.outcome).toBe("ok");
  });
});

describe("codex generateText: invalid-output", () => {
  it("reports an answer that is not JSON", async () => {
    const run = await generate(answering("Sure! Here is a title: Backup failures"));
    expect(run.outcome).toEqual({
      outcome: "invalid-output",
      reason: "the final agent message is not JSON",
    });
  });

  it("reports an answer that breaks the schema, and names the problem", async () => {
    const run = await generate(answering(JSON.stringify({ title: 7, needsRefinement: false })));
    expect(run.outcome.outcome).toBe("invalid-output");
    expect((run.outcome as { reason: string }).reason).toMatch(/title/);
  });

  it("reports a turn that ended without a final agent message", async () => {
    const run = await generate([started("userMessage"), turnCompleted("completed")]);
    expect(run.outcome).toEqual({
      outcome: "invalid-output",
      reason: "the turn ended without a final agent message",
    });
  });
});

describe("codex generateText: failed", () => {
  it("fails when the app-server cannot start", async () => {
    const run = await generate([], { dies: true });
    expect(run.outcome.outcome).toBe("failed");
  });

  it("fails when the app-server exits during the turn", async () => {
    const scripted = buildScriptedSeam();
    const adapter = makeCodexAdapter(scripted.seam);
    const pending = Effect.runPromise(
      runGeneration(adapter, buildTextGenerationContext(buildContext(createCodexHome()))),
    );
    await waitUntil("sent turn/start", () =>
      scripted.requests.some((request) => request.method === "turn/start"),
    );
    scripted.spawns[0]!.crash();
    expect(await pending).toEqual({
      outcome: "failed",
      message: "the codex app-server exited before the turn ended",
    });
  });

  it("fails with Codex's own message when the turn fails", async () => {
    const run = await generate([
      started("userMessage"),
      turnCompleted("failed", "The 'no-such-model' model is not supported."),
    ]);
    expect(run.outcome).toEqual({
      outcome: "failed",
      message: "The 'no-such-model' model is not supported.",
    });
  });

  it("fails when the thread cannot be started", async () => {
    const run = await generate([], {
      answers: { "thread/start": () => ({ error: { code: -32600, message: "bad config" } }) },
    });
    expect(run.outcome.outcome).toBe("failed");
    expect((run.outcome as { message: string }).message).toContain("bad config");
  });

  it("fails, and does not judge the answer, when the model starts a tool call", async () => {
    // A command item followed by a valid answer: the answer must not count.
    const run = await generate([
      started("userMessage"),
      started("commandExecution"),
      started("agentMessage"),
      completedMessage(ANSWER),
      turnCompleted("completed"),
    ]);
    expect(run.outcome).toEqual({
      outcome: "failed",
      message:
        "the model tried to use a tool (commandExecution), and a text generation allows none",
    });
  });

  it("fails on a dynamic tool call the same way", async () => {
    const run = await generate([started("dynamicToolCall"), turnCompleted("completed")]);
    expect(run.outcome.outcome).toBe("failed");
  });

  it("refuses a server request and fails the call", async () => {
    const run = await generate([
      { id: 77, method: "item/commandExecution/requestApproval", params: { command: "ls" } },
      ...answering(ANSWER),
    ]);
    expect(run.outcome).toEqual({
      outcome: "failed",
      message:
        "the model asked for item/commandExecution/requestApproval, and a text generation allows no tools and has nobody to ask",
    });
    await waitUntil("answered the server request", () => run.answered.length > 0);
    expect(run.answered[0]).toMatchObject({ id: 77, error: { code: -32601 } });
  });
});

describe("codex generateText: what is asked of Codex", () => {
  it("starts an ephemeral, read-only, never-asking thread with the tools off", async () => {
    const run = await generate(answering(ANSWER));
    const [thread] = listSentParams(run.requests, "thread/start") as Array<Record<string, unknown>>;
    expect(thread).toMatchObject({
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: "gpt-5.6-luna",
      baseInstructions: SPEC.instructions,
    });
    expect(thread!["config"]).toMatchObject({
      "features.shell_tool": false,
      "features.view_image": false,
      "features.multi_agent": false,
      "features.apps": false,
      "features.plugins": false,
      "features.image_generation": false,
      web_search: "disabled",
    });
  });

  it("sends the input as the one user message with the output schema and the lowest effort", async () => {
    const run = await generate(answering(ANSWER));
    const [turn] = listSentParams(run.requests, "turn/start") as Array<Record<string, unknown>>;
    expect(turn).toEqual({
      threadId: THREAD,
      input: [{ type: "text", text: SPEC.input, text_elements: [] }],
      effort: "low",
      outputSchema: OUTPUT_SCHEMA,
    });
  });

  it("starts the app-server with the startup writes turned off", async () => {
    const run = await generate(answering(ANSWER));
    const command = run.spawns[0]!.command.join(" ");
    expect(command).toContain("--strict-config");
    for (const setting of [
      "features.plugins=false",
      "features.shell_snapshot=false",
      "features.memories=false",
      "skills.bundled.enabled=false",
    ]) {
      expect(command).toContain(setting);
    }
  });

  it("starts the thread in the scratch directory of the call", async () => {
    const run = await generate(answering(ANSWER));
    expect(run.threadCwd()).toBe(run.scratch);
  });

  it("stops its app-server when the call fails", async () => {
    const run = await generate([turnCompleted("failed", "boom")]);
    expect(run.spawns[0]!.kills()).toBe(1);
  });

  it("stops its app-server when the call succeeds", async () => {
    const run = await generate(answering(ANSWER));
    expect(run.spawns).toHaveLength(1);
    expect(run.spawns[0]!.kills()).toBe(1);
  });

  it("stops its app-server when the caller gives up", async () => {
    const scripted = buildScriptedSeam();
    const adapter = makeCodexAdapter(scripted.seam);
    const call = Effect.runPromise(
      adapter
        .generateText(buildTextGenerationContext(buildContext(createCodexHome())), {}, SPEC)
        .pipe(Effect.timeoutOption("50 millis")),
    );
    await waitUntil("sent turn/start", () =>
      scripted.requests.some((request) => request.method === "turn/start"),
    );

    expect(Option.isNone(await call)).toBe(true);
    await settle();

    expect(scripted.spawns[0]!.kills()).toBe(1);
  });
});
