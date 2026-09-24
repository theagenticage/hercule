/**
 * How the pi adapter launches a session and what an input does to one, over a
 * fake pi: nothing vendor-supplied runs. The flags are pi 0.85.1's own and
 * the commands and responses are the shapes `dist/modes/rpc/rpc-types.d.ts`
 * declares.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { OutputSchema, SessionSpec } from "@hercule/protocol";
import { makePiAdapter, REPROMPT } from "./adapter";
import { OUTPUT_SCHEMA_VARIABLE, SUBMIT_RESULT_TOOL } from "./extension";
import {
  buildFakePiSeam,
  startBusySession,
  cleanupHomes,
  buildContext,
  createDriving,
  createPiHome,
  TEST_ZAI_KEY,
  PRIOR,
  buildRefusal,
  SESSION,
  listSentCommands,
  settle,
  SPEC,
  startTestSession,
  filterByTag,
  waitUntil,
  type Spawn,
} from "./testing";

afterAll(cleanupHomes);

/** The flags every pi this adapter starts is launched with, in order. */
const buildFlags = (home: string): ReadonlyArray<string> => [
  "--mode",
  "rpc",
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-approve",
  "--offline",
  "-e",
  join(home, "hercule-extension.ts"),
  "--session-dir",
  join(home, "sessions"),
  "--session-id",
  SESSION,
  "--model",
  "zai/glm-5.3",
  "--thinking",
  "high",
];

/** A session file pi would have written for a native session of that id. */
const writePriorSessionFile = (home: string, id: string): string => {
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-09-19T10-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", id, timestamp: 0 })}\n`);
  return path;
};

const readFlagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];

describe("the pi a session is launched as", () => {
  it("launches it with the user's own material, extensions and approvals all off", async () => {
    const run = await startTestSession();

    expect(run.child.command).toEqual([run.ctx.binary, ...buildFlags(run.ctx.home)]);
  });

  it("starts it in the session's own directory", async () => {
    const run = await startTestSession();

    // pi resolves every relative path against the directory it runs in, so a
    // child that inherited the runner's own would write the user's work into
    // whatever directory the daemon was launched from.
    expect(run.child.cwd).toBe(run.ctx.cwd);
  });

  it("gives it the instance's own agent directory and the Z.ai key, and skips the update check", async () => {
    const run = await startTestSession();

    expect(run.child.env["PI_CODING_AGENT_DIR"]).toBe(run.ctx.home);
    expect(run.child.env["PI_SKIP_VERSION_CHECK"]).toBe("1");
    expect(run.child.env["ZAI_API_KEY"]).toBe(TEST_ZAI_KEY);
  });

  it("runs on the instance's key alone, never on one the machine exports", async () => {
    const run = createDriving();
    const ctx = {
      ...run.ctx,
      secrets: {},
      env: { ...run.ctx.env, ZAI_API_KEY: "the runner daemon's own key" },
    };

    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, ctx));
    const probed = await Effect.runPromise(run.adapter.probe(ctx, {}));

    // An instance nobody has entered a key on would otherwise run on whatever
    // the machine exports, and report itself as logged in on it.
    expect(run.spawns[0]!.env["ZAI_API_KEY"]).toBeUndefined();
    expect(probed.auth.status).toBe("unauthenticated");
  });

  it("writes the extension pi loads, and parks its decision on the abort signal", async () => {
    const run = await startTestSession();

    const path = join(run.ctx.home, "hercule-extension.ts");
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).not.toBe("");
    // Without the signal an abort leaves the dialog waiting forever, and the
    // session with it.
    expect(source).toContain("signal: ctx.signal");
  });

  it("carries on a native session by its file, never by its id", async () => {
    const run = createDriving();
    const path = writePriorSessionFile(run.ctx.home, PRIOR);
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };

    await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));

    // An id would make pi look the session up, and ask on stdin - Hercule's own
    // JSON channel - whether to fork it into this directory.
    expect(readFlagValue(run.spawns[0]!.command, "--session")).toBe(path);
    expect(run.spawns[0]!.command).not.toContain("--fork");
  });

  it("branches off a native session by its file", async () => {
    const run = createDriving();
    const path = writePriorSessionFile(run.ctx.home, PRIOR);
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "fork" } };

    await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));

    expect(readFlagValue(run.spawns[0]!.command, "--fork")).toBe(path);
  });

  it("refuses a session whose transcript is gone, rather than launching a pi that hangs", async () => {
    const run = createDriving();
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };

    const refused = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, spec, run.ctx)),
    );

    expect(refused).toContain(PRIOR);
    expect(run.spawns).toEqual([]);
    // The start is what failed, and the supervisor reports a failed start: an
    // exit from here as well would be one end reported twice.
    await settle();
    expect(filterByTag(run.seen, "session.exited")).toEqual([]);
  });
});

describe("what an input does to a pi session", () => {
  it("prompts when nothing is running, and says it opened a turn", async () => {
    const run = await startTestSession();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    expect(sent.delivery).toBe("opened");
    expect(sent.turnId).not.toBe("");
    expect(listSentCommands(run.sent, "prompt")).toEqual([
      expect.objectContaining({ message: "hello" }),
    ]);
    expect(listSentCommands(run.sent, "steer")).toEqual([]);
  });

  it("steers the running turn instead of opening a second one", async () => {
    const run = await startBusySession();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "and the tests" }));

    expect(sent.delivery).toBe("steered");
    expect(listSentCommands(run.sent, "steer")).toEqual([
      expect.objectContaining({ message: "and the tests" }),
    ]);
    // The first prompt is the one the input before it sent; steering sent no second.
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(1);
  });

  it("reports the user's own message as an item of the turn it opened", async () => {
    const run = await startTestSession();

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    await waitUntil(
      "reported the user's message",
      () => filterByTag(run.seen, "item.completed").length === 1,
    );
    const item = filterByTag(run.seen, "item.started")[0];
    expect(item?.kind).toBe("user_message");
    expect(JSON.stringify(item?.detail)).toContain("hello");
  });

  it("changes the model and its thinking level before prompting on it", async () => {
    const run = await startTestSession();

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "hello",
        modelSelection: { model: "glm-5.3-flash", options: { thinking: "low" } },
      }),
    );

    expect(run.sent.map((one) => one.type)).toEqual(["set_model", "set_thinking_level", "prompt"]);
    expect(listSentCommands(run.sent, "set_model")[0]).toMatchObject({
      provider: "zai",
      modelId: "glm-5.3-flash",
    });
    expect(listSentCommands(run.sent, "set_thinking_level")[0]).toMatchObject({ level: "low" });
  });

  it("fails the input with what pi said when the model cannot be changed", async () => {
    const run = await startTestSession({
      answers: { set_model: () => buildRefusal("Model not found: zai/glm-9") },
    });

    const refused = await Effect.runPromise(
      Effect.flip(
        run.adapter.sendInput(SESSION, {
          text: "hello",
          modelSelection: { model: "glm-9", options: {} },
        }),
      ),
    );

    expect(refused).toContain("Model not found");
    // Nothing was asked on a model pi refused to switch to.
    expect(listSentCommands(run.sent, "prompt")).toEqual([]);
  });

  it("prompts again after a prompt pi refused, rather than steering", async () => {
    const run = await startTestSession({ answers: { prompt: () => buildRefusal("busy") } });

    await Effect.runPromise(Effect.flip(run.adapter.sendInput(SESSION, { text: "hello" })));
    await Effect.runPromise(Effect.flip(run.adapter.sendInput(SESSION, { text: "hello again" })));

    // A refused prompt opened no turn, and steering one that never started is
    // an input pi refuses too: the session would take nothing from then on.
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(2);
    expect(listSentCommands(run.sent, "steer")).toEqual([]);
  });
});

/** pi's own report that its run is over, on the message that ended it. */
const pushAgentEnd = (child: Spawn, message: Record<string, unknown>): void => {
  child.push({ type: "agent_end", messages: [{ role: "assistant", ...message }] });
  child.push({ type: "agent_settled" });
};

describe("how a turn the user stopped ends", () => {
  it("is interrupted, whatever pi says about the message it was in the middle of", async () => {
    const run = await startBusySession();

    await Effect.runPromise(run.adapter.interrupt(SESSION));
    // What pi reports when the abort lands while a tool is running: the tool
    // is cancelled and the message it belonged to carries the cancellation as
    // its own error.
    pushAgentEnd(run.child, { stopReason: "error", errorMessage: "The operation was aborted." });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    expect(filterByTag(run.seen, "turn.completed")[0]!.state).toBe("interrupted");
    // Nobody is told that something went wrong. The user asked for this.
    expect(filterByTag(run.seen, "runtime.error")).toEqual([]);
  });

  it("still fails a turn that broke on an error nobody asked for", async () => {
    const run = await startBusySession();

    pushAgentEnd(run.child, {
      stopReason: "error",
      errorMessage: "the model provider refused the request",
    });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    const completed = filterByTag(run.seen, "turn.completed")[0]!;
    expect(completed.state).toBe("failed");
    expect(JSON.stringify(completed.error)).toContain("refused the request");
    expect(filterByTag(run.seen, "runtime.error")).toHaveLength(1);
  });
});

describe("a pi that dies while its turn is running", () => {
  it("fails the turn with what it complained about, and says the same on the exit", async () => {
    const run = await startBusySession();
    const complaint = "pi: the model provider refused the request";

    run.child.crash(complaint);

    await waitUntil(
      "said the session ended",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    const completed = filterByTag(run.seen, "turn.completed")[0];
    // Not interrupted: that is the word for a stop the user asked for, and a
    // turn that reads as stopped on purpose hides that the session crashed.
    expect(completed?.state).toBe("failed");
    expect(JSON.stringify(completed?.error)).toContain(complaint);
    const exited = filterByTag(run.seen, "session.exited")[0];
    expect(exited?.reason).toBe("process_exit");
    expect(JSON.stringify(exited?.message)).toContain(complaint);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });
});

describe("a session the supervisor stops", () => {
  it("kills a pi that stayed behind after its stdin closed", async () => {
    const run = await startTestSession({ lingers: true });

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // A pi parked on a question is waiting for its answer on the stdin that
    // was just closed: nothing it hears will ever make it leave.
    expect(run.child.stdinClosed()).toBe(true);
    expect(run.child.kills()).toBe(1);
    expect(filterByTag(run.seen, "session.exited")[0]?.reason).toBe("stopped");
    // The entry goes only once its pi is gone: a second one started on this
    // transcript while the first was still writing would corrupt it. A pi that
    // did go needs no warning about one that stayed.
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
    expect(filterByTag(run.seen, "runtime.warning")).toEqual([]);
  }, 10_000);

  it("holds the session until its pi is gone, so nothing starts under the id meanwhile", async () => {
    const run = await startTestSession({ lingers: true });
    run.child.push({ type: "agent_start" });
    await waitUntil(
      "reported the turn open",
      () => filterByTag(run.seen, "turn.started").length === 1,
    );

    const stopping = Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    const refused = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, SPEC, run.ctx)),
    );
    await stopping;

    expect(refused).toContain("still running");
    // The turn goes with the session: a turn left open is a thread that reads
    // as working for as long as anyone looks at it.
    expect(filterByTag(run.seen, "turn.completed")[0]?.state).toBe("interrupted");
    expect(run.spawns).toHaveLength(1);
  }, 10_000);

  it("closes pi's stdin, lets it leave, and reports the reason it was given", async () => {
    const run = await startTestSession();

    await Effect.runPromise(run.adapter.stopSession(SESSION, "idle_unload"));

    await waitUntil(
      "said the session ended",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    // Stdin's end is pi's own cue to leave: killing it would lose the
    // transcript flush that makes the session resumable.
    expect(run.child.stdinClosed()).toBe(true);
    expect(run.child.kills()).toBe(0);
    expect(filterByTag(run.seen, "session.exited")[0]?.reason).toBe("idle_unload");
    await settle();
    expect(filterByTag(run.seen, "session.exited")).toHaveLength(1);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });
});

/**
 * What an Agent puts on a pi session: instructions of its own, tool families
 * taken away, and a schema every turn has to answer under (spec 06 section 7).
 * pi takes the first two as flags and reads the schema out of its environment,
 * so the argv stays exactly what this adapter authored.
 */
const OUTPUT_SCHEMA: OutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["accept", "dismiss"] },
    confidence: { type: "number" },
  },
};

const SYSTEM_PROMPT = "You assess tasks and answer with a verdict.";

const STRUCTURED: SessionSpec = {
  ...SPEC,
  systemPrompt: SYSTEM_PROMPT,
  disallowedTools: ["edit", "shell", "web-search"],
  outputSchema: OUTPUT_SCHEMA,
};

/** What pi's own tool was called with, which is the turn's answer. */
const ANSWER = { verdict: "accept", confidence: 0.9 };

/** pi's own id for the call that answered. */
const SUBMIT_CALL = "call-submit-1";

/** Starts a session and opens a turn on it, which is where a result is produced. */
const openTurn = async (
  spec: SessionSpec = STRUCTURED,
): Promise<ReturnType<typeof createDriving> & { readonly child: Spawn }> => {
  const run = await startTestSession({}, spec);
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
  run.child.push({ type: "agent_start" });
  await waitUntil(
    "reported the turn open",
    () => filterByTag(run.seen, "turn.started").length === 1,
  );
  return run;
};

/** pi calling the tool, as it reports a call it ran: a start and its end. */
const submitAnswer = (child: Spawn, args: Record<string, unknown>): void => {
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
    args,
    result: { content: [{ type: "text", text: "recorded" }] },
  });
};

/** Reports pi refusing a call whose arguments its own validator would not accept. */
const refuseAnswer = (child: Spawn, callId: string, args: Record<string, unknown>): void => {
  child.push({
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: SUBMIT_RESULT_TOOL,
    args,
  });
  child.push({
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: SUBMIT_RESULT_TOOL,
    isError: true,
    result: {
      content: [{ type: "text", text: `Validation failed for tool "${SUBMIT_RESULT_TOOL}"` }],
    },
  });
};

describe("the pi a session under an Agent is launched as", () => {
  it("appends the agent's instructions to pi's own system prompt, by a file of the session's own", async () => {
    const run = await startTestSession({}, STRUCTURED);

    expect(run.child.command).toContain("--append-system-prompt");
    // The path, never the text: instructions on the argv are instructions in
    // the machine's process list.
    const path = readFlagValue(run.child.command, "--append-system-prompt")!;
    expect(path.startsWith(run.ctx.home)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(SYSTEM_PROMPT);
    expect(run.child.command).not.toContain(SYSTEM_PROMPT);
  });

  it("takes the session's instructions file away with the session", async () => {
    const run = await startTestSession({}, STRUCTURED);
    const path = readFlagValue(run.child.command, "--append-system-prompt")!;
    expect(existsSync(path)).toBe(true);

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // One file per session ever started would otherwise pile up in the
    // instance's own home, each holding an Agent's instructions.
    await waitUntil(
      "said the session ended",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    expect(existsSync(path)).toBe(false);
  });

  it("takes them away again when the pi they were written for never starts", async () => {
    const ctx = buildContext(createPiHome());
    const { seam } = buildFakePiSeam();
    const refusing = makePiAdapter({
      ...seam,
      spawn: () => {
        throw new Error("spawn: permission denied");
      },
    });

    const failed = await Effect.runPromise(
      Effect.flip(refusing.startSession(SESSION, STRUCTURED, ctx)),
    );

    expect(failed).toContain("permission denied");
    // No session was opened, so nothing will ever end and take the file away.
    expect(existsSync(join(ctx.home, `system-prompt-${SESSION}.txt`))).toBe(false);
  });

  it("hands over instructions that read like a filename as the instructions they are", async () => {
    const run = await startTestSession({}, { ...STRUCTURED, systemPrompt: "AGENTS.md" });

    // pi reads a value naming a file it can open as that file's contents, so a
    // prompt passed as text would become whatever the session's directory
    // happens to hold under that name.
    expect(readFileSync(readFlagValue(run.child.command, "--append-system-prompt")!, "utf8")).toBe(
      "AGENTS.md",
    );
  });

  it("names pi's own tool for each family the spec took away", async () => {
    const run = await startTestSession({}, STRUCTURED);

    // The web family adds nothing: pi 0.85.1 has no web tool, and a name it
    // does not know would be a flag it refuses to start on.
    expect(run.child.command).toContain("--exclude-tools");
    expect(readFlagValue(run.child.command, "--exclude-tools")).toBe("edit,bash");
  });

  it("leaves the flag off when every family the spec named is one pi has no tool for", async () => {
    const run = await startTestSession({}, { ...STRUCTURED, disallowedTools: ["web-fetch"] });

    // An empty list would be a flag saying nothing, which pi reads as a flag
    // with a missing value.
    expect(run.child.command).not.toContain("--exclude-tools");
  });

  it("hands the schema to the extension through pi's environment, so the argv stays exact", async () => {
    const run = await startTestSession({}, STRUCTURED);

    expect(run.child.env[OUTPUT_SCHEMA_VARIABLE]).toBe(JSON.stringify(OUTPUT_SCHEMA));
  });

  it("carries none of the three for a Thread, which has none of the three fields", async () => {
    const run = await startTestSession();

    expect(run.child.command).not.toContain("--append-system-prompt");
    expect(run.child.command).not.toContain("--exclude-tools");
    // Absent, not empty: an empty schema in the environment would register a
    // tool on a session that was never asked for a value.
    expect(OUTPUT_SCHEMA_VARIABLE in run.child.env).toBe(false);
  });
});

describe("what a pi turn under an output schema answers with", () => {
  it("reports the arguments the tool was called with as the turn's result", async () => {
    const run = await openTurn();

    submitAnswer(run.child, ANSWER);
    run.child.push({ type: "agent_settled" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    expect(filterByTag(run.seen, "turn.completed")[0]!.structuredResult).toEqual({
      outcome: "ok",
      value: ANSWER,
    });
  });

  it("reports a schema failure naming the field when the arguments violate the schema", async () => {
    const run = await openTurn();

    submitAnswer(run.child, { verdict: "maybe", confidence: 0.9 });
    run.child.push({ type: "agent_settled" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    expect(filterByTag(run.seen, "turn.completed")[0]!.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("verdict") as string,
    });
  });

  it("asks again, inside the same turn, when the agent settled without calling the tool", async () => {
    const run = await openTurn();

    run.child.push({ type: "agent_settled" });

    await waitUntil(
      "asked again for the tool",
      () => listSentCommands(run.sent, "prompt").length === 2,
    );
    expect(listSentCommands(run.sent, "prompt")[1]).toMatchObject({ message: REPROMPT });
    // The re-prompt stays inside the one Hercule turn: a second `turn.started`
    // would bracket one episode twice, and a completion here would report an
    // answer the session is still being asked for.
    await settle();
    expect(filterByTag(run.seen, "turn.started")).toHaveLength(1);
    expect(filterByTag(run.seen, "turn.completed")).toEqual([]);
  });

  it("gives up after the second re-prompt and says the tool was never called", async () => {
    const run = await openTurn();

    run.child.push({ type: "agent_settled" });
    await waitUntil("asked again", () => listSentCommands(run.sent, "prompt").length === 2);
    run.child.push({ type: "agent_settled" });
    await waitUntil("asked a second time", () => listSentCommands(run.sent, "prompt").length === 3);
    run.child.push({ type: "agent_settled" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    // Two re-prompts and no more: a third would be a session that never ends.
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(3);
    expect(filterByTag(run.seen, "turn.completed")[0]!.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/\S/) as string,
    });
    expect(filterByTag(run.seen, "turn.started")).toHaveLength(1);
  });

  it("stops the turn once pi has refused enough answers, and reports the last one", async () => {
    const run = await openTurn();

    // pi hands a call whose arguments its schema refuses back to the model as
    // the call's own result, and a model that cannot satisfy the schema
    // answers that complaint for as long as it is let to.
    for (const attempt of [1, 2, 3]) {
      refuseAnswer(run.child, `call-refused-${String(attempt)}`, { verdict: "maybe" });
    }
    await waitUntil("ended pi's run", () => listSentCommands(run.sent, "abort").length === 1);
    run.child.push({ type: "agent_settled" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    const completed = filterByTag(run.seen, "turn.completed")[0]!;
    // Completed, not interrupted: the turn ran to its end and answered, and
    // the answer is what failed.
    expect(completed.state).toBe("completed");
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("verdict") as string,
    });
    expect(filterByTag(run.seen, "runtime.warning")).toHaveLength(1);
  });

  it("says nothing about a result, and never asks again, on a turn the user stopped", async () => {
    const run = await openTurn();

    await Effect.runPromise(run.adapter.interrupt(SESSION));
    pushAgentEnd(run.child, { stopReason: "aborted" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    const completed = filterByTag(run.seen, "turn.completed")[0]!;
    expect(completed.state).toBe("interrupted");
    // A turn the user ended is a turn nobody asked a verdict about, and a
    // question put to a session that was just stopped is one nothing answers.
    expect("structuredResult" in completed).toBe(false);
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(1);
  });

  it("says nothing about a result on a turn that failed for its own reasons", async () => {
    const run = await openTurn();

    pushAgentEnd(run.child, {
      stopReason: "error",
      errorMessage: "the model provider refused the request",
    });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    const completed = filterByTag(run.seen, "turn.completed")[0]!;
    expect(completed.state).toBe("failed");
    // The turn is what went wrong, and a schema verdict here would read as an
    // answer that was judged and found wanting.
    expect("structuredResult" in completed).toBe(false);
  });

  it("says nothing about a result, and never asks again, on a session with no schema", async () => {
    const run = await openTurn(SPEC);

    run.child.push({ type: "agent_settled" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    // A Thread answers prose: a key on every turn of every session would be a
    // second meaning for "ok", and a re-prompt would ask for a value nobody
    // asked this session for.
    expect("structuredResult" in filterByTag(run.seen, "turn.completed")[0]!).toBe(false);
    await settle();
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(1);
  });
});
