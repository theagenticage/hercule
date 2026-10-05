/**
 * Tests how the pi adapter launches a session and handles inputs, stops and
 * output schemas, using a fake pi, so no vendor code runs. The flags are
 * pi 0.85.1's, and the commands and responses follow the shapes
 * `dist/modes/rpc/rpc-types.d.ts` declares.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { OutputSchema, SessionSpec } from "@hercule/protocol";
import type { UserMaterial } from "../index";
import { NO_USER_MATERIAL_PATHS } from "../testing";
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

/** Returns the flags every pi this adapter starts is given, in order. */
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

/** Writes the transcript file pi would have written for a native session with this id. Returns its path. */
const writePriorSessionFile = (home: string, id: string): string => {
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-09-19T10-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", id, timestamp: 0 })}\n`);
  return path;
};

const readFlagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];

describe("launching pi for a session", () => {
  it("turns off context files, the user's own extensions and pi's own approvals for a workspace-less session", async () => {
    const run = await startTestSession();

    expect(run.child.command).toEqual([run.ctx.binary, ...buildFlags(run.ctx.home)]);
  });

  it("reads the workspace's own context files when the session has a workspace", async () => {
    const run = await startTestSession(
      {},
      {
        ...SPEC,
        workspaceId: "0199e0e7-0000-7000-8000-00000000000b",
      },
    );

    expect(run.child.command).toEqual([
      run.ctx.binary,
      ...buildFlags(run.ctx.home).filter((flag) => flag !== "--no-context-files"),
    ]);
  });

  it("starts pi in the session's working directory", async () => {
    const run = await startTestSession();

    // pi resolves every relative path against the directory it runs in, so a
    // child that inherited the runner's directory would write the user's work
    // into whatever directory the runner was started from.
    expect(run.child.cwd).toBe(run.ctx.cwd);
  });

  it("sets the instance's agent directory and Z.ai key, and turns off the update check", async () => {
    const run = await startTestSession();

    expect(run.child.env["PI_CODING_AGENT_DIR"]).toBe(run.ctx.home);
    expect(run.child.env["PI_SKIP_VERSION_CHECK"]).toBe("1");
    expect(run.child.env["ZAI_API_KEY"]).toBe(TEST_ZAI_KEY);
  });

  it("uses only the instance's key, never a key from the runner's environment", async () => {
    const run = createDriving();
    const ctx = {
      ...run.ctx,
      secrets: {},
      env: { ...run.ctx.env, ZAI_API_KEY: "the runner daemon's own key" },
    };

    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, ctx));
    const probed = await Effect.runPromise(run.adapter.probe(ctx, {}));

    // Otherwise an instance with no key entered would run on the machine's
    // key, and report itself as logged in.
    expect(run.spawns[0]!.env["ZAI_API_KEY"]).toBeUndefined();
    expect(probed.auth.status).toBe("unauthenticated");
  });

  it("writes the extension pi loads, with the approval dialog tied to the abort signal", async () => {
    const run = await startTestSession();

    const path = join(run.ctx.home, "hercule-extension.ts");
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).not.toBe("");
    // Without the signal, an abort leaves the dialog waiting forever, and the
    // session stuck with it.
    expect(source).toContain("signal: ctx.signal");
  });

  it("resumes a native session by its transcript file, never by its id", async () => {
    const run = createDriving();
    const path = writePriorSessionFile(run.ctx.home, PRIOR);
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };

    await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));

    // With an id, pi would search for the session and ask on stdin, which is
    // Hercule's JSON channel, whether to fork it into this directory.
    expect(readFlagValue(run.spawns[0]!.command, "--session")).toBe(path);
    expect(run.spawns[0]!.command).not.toContain("--fork");
  });

  it("forks a native session by its transcript file", async () => {
    const run = createDriving();
    const path = writePriorSessionFile(run.ctx.home, PRIOR);
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "fork" } };

    await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));

    expect(readFlagValue(run.spawns[0]!.command, "--fork")).toBe(path);
  });

  it("fails to resume a session whose transcript is gone, instead of launching a pi that hangs", async () => {
    const run = createDriving();
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };

    const refused = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, spec, run.ctx)),
    );

    expect(refused).toContain(PRIOR);
    expect(run.spawns).toEqual([]);
    // The start failed, and the supervisor reports a failed start. Emitting
    // an exit here too would report the same end twice.
    await settle();
    expect(filterByTag(run.seen, "session.exited")).toEqual([]);
  });
});

/** The User Material the runner finds on a machine that has all of the user's material. */
const USER_MATERIAL: UserMaterial = {
  skillDirs: ["/Users/someone/.agents/skills", "/Users/someone/.pi/agent/skills"],
  promptTemplateDirs: ["/Users/someone/.pi/agent/prompts"],
  instructionsFile: "/Users/someone/.pi/agent/AGENTS.md",
};

/** The flags that load `USER_MATERIAL` into pi, in the order the adapter adds them. */
const USER_MATERIAL_FLAGS = [
  "--skill",
  "/Users/someone/.agents/skills",
  "--skill",
  "/Users/someone/.pi/agent/skills",
  "--prompt-template",
  "/Users/someone/.pi/agent/prompts",
  "--append-system-prompt",
  "/Users/someone/.pi/agent/AGENTS.md",
];

/** Starts a session on a fake pi with the given user material. Returns the setup and the pi spawned. */
const startSessionWithMaterial = async (
  userMaterial: UserMaterial | undefined,
  spec: SessionSpec = SPEC,
): Promise<ReturnType<typeof createDriving> & { readonly child: Spawn }> => {
  const run = createDriving();
  const ctx = { ...run.ctx, ...(userMaterial === undefined ? {} : { userMaterial }) };
  await Effect.runPromise(run.adapter.startSession(SESSION, spec, ctx));
  return { ...run, ctx, child: run.spawns[0]! };
};

describe("launching pi for a Thread that sees the user's own material", () => {
  it("loads the user's skills, prompt templates and instructions by name, and keeps pi's own discovery off", async () => {
    const run = await startSessionWithMaterial(USER_MATERIAL);

    // The `--no-*` flags stay: they stop pi's own discovery, while a directory
    // named on the command line still loads. Extensions stay off even here.
    expect(run.child.command).toEqual([
      run.ctx.binary,
      ...buildFlags(run.ctx.home),
      ...USER_MATERIAL_FLAGS,
    ]);
  });

  it("puts the user's instructions after the Agent's own system prompt", async () => {
    const run = await startSessionWithMaterial(USER_MATERIAL, {
      ...SPEC,
      systemPrompt: "You review pull requests.",
    });

    // pi appends each `--append-system-prompt` in the order given.
    expect(run.child.command).toEqual([
      run.ctx.binary,
      ...buildFlags(run.ctx.home),
      "--append-system-prompt",
      join(run.ctx.home, `system-prompt-${SESSION}.txt`),
      ...USER_MATERIAL_FLAGS,
    ]);
  });

  it("adds nothing for a Thread whose user has no material on this machine", async () => {
    const run = await startSessionWithMaterial(NO_USER_MATERIAL_PATHS);

    expect(run.child.command).toEqual([run.ctx.binary, ...buildFlags(run.ctx.home)]);
  });

  it("adds none of the user's material to an isolated session", async () => {
    const run = await startSessionWithMaterial(undefined);

    expect(run.child.command).not.toContain("--skill");
    expect(run.child.command).not.toContain("--prompt-template");
    expect(run.child.command).not.toContain("--append-system-prompt");
  });

  it("writes nothing of the user's material into the instance's agent directory", async () => {
    const thread = await startSessionWithMaterial(USER_MATERIAL);
    const isolated = await startSessionWithMaterial(undefined);

    // Every session of the instance reads that directory, so anything written
    // there for a Thread would reach the instance's other sessions too.
    expect(readdirSync(thread.ctx.home).sort()).toEqual(readdirSync(isolated.ctx.home).sort());
  });
});

describe("sending an input to a pi session", () => {
  it("sends a prompt when no turn is running, and reports that it opened a turn", async () => {
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
    // The one prompt came from the first input; the steer sent no second prompt.
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(1);
  });

  it("reports the user's message as an item of the turn it opened", async () => {
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

  it("fails the input with pi's error when the model cannot be changed", async () => {
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
    // No prompt was sent after pi rejected the model change.
    expect(listSentCommands(run.sent, "prompt")).toEqual([]);
  });

  it("sends a prompt, not a steer, after pi rejected the previous prompt", async () => {
    const run = await startTestSession({ answers: { prompt: () => buildRefusal("busy") } });

    await Effect.runPromise(Effect.flip(run.adapter.sendInput(SESSION, { text: "hello" })));
    await Effect.runPromise(Effect.flip(run.adapter.sendInput(SESSION, { text: "hello again" })));

    // A rejected prompt opened no turn, and pi also rejects a steer when no
    // turn is running: the session would accept no input from then on.
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(2);
    expect(listSentCommands(run.sent, "steer")).toEqual([]);
  });
});

/** Pushes pi's `agent_end` with the given last message, then `agent_settled`. */
const pushAgentEnd = (child: Spawn, message: Record<string, unknown>): void => {
  child.push({ type: "agent_end", messages: [{ role: "assistant", ...message }] });
  child.push({ type: "agent_settled" });
};

describe("how a turn ends after the user stops it", () => {
  it("ends as interrupted, whatever pi reports about the message in flight", async () => {
    const run = await startBusySession();

    await Effect.runPromise(run.adapter.interrupt(SESSION));
    // This is what pi reports when the abort arrives while a tool is running:
    // the tool is cancelled, and its message reports the cancellation as an
    // error.
    pushAgentEnd(run.child, { stopReason: "error", errorMessage: "The operation was aborted." });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    expect(filterByTag(run.seen, "turn.completed")[0]!.state).toBe("interrupted");
    // No error is reported, because the user asked for this.
    expect(filterByTag(run.seen, "runtime.error")).toEqual([]);
  });

  it("is not stopped by an interrupt that names a subagent, because the adapter reports no subagents yet", async () => {
    const run = await startBusySession();

    // The user asked to stop one subagent, not the session's own turn.
    await Effect.runPromise(run.adapter.interrupt(SESSION, "child-1"));
    expect(listSentCommands(run.sent, "abort")).toEqual([]);

    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(listSentCommands(run.sent, "abort")).toHaveLength(1);
  });

  it("still fails a turn that ended on a real error", async () => {
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

describe("a pi that exits while its turn is running", () => {
  it("fails the turn with pi's stderr output, and puts the same text on the exit", async () => {
    const run = await startBusySession();
    const complaint = "pi: the model provider refused the request";

    run.child.crash(complaint);

    await waitUntil(
      "said the session ended",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    const completed = filterByTag(run.seen, "turn.completed")[0];
    // Not interrupted: that state means the user stopped the turn, and it
    // would hide that the session crashed.
    expect(completed?.state).toBe("failed");
    expect(JSON.stringify(completed?.error)).toContain(complaint);
    const exited = filterByTag(run.seen, "session.exited")[0];
    expect(exited?.reason).toBe("process_exit");
    expect(JSON.stringify(exited?.message)).toContain(complaint);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });
});

describe("stopping a session", () => {
  it("kills a pi that keeps running after its stdin is closed", async () => {
    const run = await startTestSession({ lingers: true });

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // A pi parked on an approval waits for the answer on the stdin that was
    // just closed, so nothing will ever make it exit by itself.
    expect(run.child.stdinClosed()).toBe(true);
    expect(run.child.kills()).toBe(1);
    expect(filterByTag(run.seen, "session.exited")[0]?.reason).toBe("stopped");
    // The session entry is removed only once its pi has exited: a second pi
    // started on this transcript while the first was still writing would
    // corrupt it. The kill worked, so no warning is needed.
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
    expect(filterByTag(run.seen, "runtime.warning")).toEqual([]);
  }, 10_000);

  it("keeps the session until its pi has exited, so no new session starts under its id meanwhile", async () => {
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
    // The turn ends with the session: a turn left open would make the thread
    // look busy forever.
    expect(filterByTag(run.seen, "turn.completed")[0]?.state).toBe("interrupted");
    expect(run.spawns).toHaveLength(1);
  }, 10_000);

  it("closes pi's stdin, lets it exit, and reports the stop reason", async () => {
    const run = await startTestSession();

    await Effect.runPromise(run.adapter.stopSession(SESSION, "idle_unload"));

    await waitUntil(
      "said the session ended",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    // Closing stdin tells pi to exit. Killing it would skip the transcript
    // flush that makes the session resumable.
    expect(run.child.stdinClosed()).toBe(true);
    expect(run.child.kills()).toBe(0);
    expect(filterByTag(run.seen, "session.exited")[0]?.reason).toBe("idle_unload");
    await settle();
    expect(filterByTag(run.seen, "session.exited")).toHaveLength(1);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });
});

/**
 * What an Agent adds to a pi session (spec 06 section 7):
 *
 * - its own instructions;
 * - tool families the session may not use;
 * - an output schema every turn must answer with.
 *
 * pi gets the first two as flags and reads the schema from its environment,
 * so the arguments stay exactly as this adapter built them.
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

/** The arguments `submit_result` is called with, which are the turn's answer. */
const ANSWER = { verdict: "accept", confidence: 0.9 };

/** pi's id for the `submit_result` call. */
const SUBMIT_CALL = "call-submit-1";

/** Starts a session and opens a turn on it, since only a turn produces a result. */
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

/** Pushes a successful `submit_result` call: its start event and its end event. */
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

/** Pushes a `submit_result` call that pi's validator rejects. */
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

describe("launching pi for a session with an Agent", () => {
  it("appends the agent's instructions to pi's system prompt, through a file for the session", async () => {
    const run = await startTestSession({}, STRUCTURED);

    expect(run.child.command).toContain("--append-system-prompt");
    // The path, never the text: instructions on the command line would be
    // visible in the machine's process list.
    const path = readFlagValue(run.child.command, "--append-system-prompt")!;
    expect(path.startsWith(run.ctx.home)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(SYSTEM_PROMPT);
    expect(run.child.command).not.toContain(SYSTEM_PROMPT);
  });

  it("deletes the session's instructions file when the session ends", async () => {
    const run = await startTestSession({}, STRUCTURED);
    const path = readFlagValue(run.child.command, "--append-system-prompt")!;
    expect(existsSync(path)).toBe(true);

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // Otherwise one file per session ever started would pile up in the
    // instance's home, each holding an Agent's instructions.
    await waitUntil(
      "said the session ended",
      () => filterByTag(run.seen, "session.exited").length === 1,
    );
    expect(existsSync(path)).toBe(false);
  });

  it("deletes the instructions file when pi fails to start", async () => {
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
    // No session was opened, so no session end will ever delete the file.
    expect(existsSync(join(ctx.home, `system-prompt-${SESSION}.txt`))).toBe(false);
  });

  it("passes instructions that look like a filename as text, not as that file", async () => {
    const run = await startTestSession({}, { ...STRUCTURED, systemPrompt: "AGENTS.md" });

    // When the value names a file pi can open, pi reads that file. A prompt
    // passed as text would be replaced by whatever file of that name the
    // session's directory holds.
    expect(readFileSync(readFlagValue(run.child.command, "--append-system-prompt")!, "utf8")).toBe(
      "AGENTS.md",
    );
  });

  it("excludes pi's tool for each tool family the spec disallows", async () => {
    const run = await startTestSession({}, STRUCTURED);

    // The web family adds nothing: pi 0.85.1 has no web tool, and pi fails to
    // start when given a tool name it does not know.
    expect(run.child.command).toContain("--exclude-tools");
    expect(readFlagValue(run.child.command, "--exclude-tools")).toBe("edit,bash");
  });

  it("leaves the flag out when pi has no tool in any disallowed family", async () => {
    const run = await startTestSession({}, { ...STRUCTURED, disallowedTools: ["web-fetch"] });

    // pi would read the flag with an empty list as a flag with a missing
    // value.
    expect(run.child.command).not.toContain("--exclude-tools");
  });

  it("passes the schema to the extension in pi's environment, not on the command line", async () => {
    const run = await startTestSession({}, STRUCTURED);

    expect(run.child.env[OUTPUT_SCHEMA_VARIABLE]).toBe(JSON.stringify(OUTPUT_SCHEMA));
  });

  it("adds none of the three for a Thread, which has none of these fields", async () => {
    const run = await startTestSession();

    expect(run.child.command).not.toContain("--append-system-prompt");
    expect(run.child.command).not.toContain("--exclude-tools");
    // Absent, not empty: an empty schema in the environment would register
    // `submit_result` on a session that has no output schema.
    expect(OUTPUT_SCHEMA_VARIABLE in run.child.env).toBe(false);
  });
});

describe("the result of a pi turn with an output schema", () => {
  it("reports the arguments of the submit_result call as the turn's result", async () => {
    const run = await openTurn();

    submitAnswer(run.child, ANSWER);
    run.child.push({ type: "agent_settled" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    expect(filterByTag(run.seen, "turn.completed")[0]!.structuredResult).toEqual({
      outcome: "ok",
      value: ANSWER,
    });
  });

  it("reports a schema failure naming the field when the arguments do not match the schema", async () => {
    const run = await openTurn();

    submitAnswer(run.child, { verdict: "maybe", confidence: 0.9 });
    run.child.push({ type: "agent_settled" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    expect(filterByTag(run.seen, "turn.completed")[0]!.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("verdict") as string,
    });
  });

  it("re-prompts inside the same turn when the agent finishes without calling the tool", async () => {
    const run = await openTurn();

    run.child.push({ type: "agent_settled" });

    await waitUntil(
      "asked again for the tool",
      () => listSentCommands(run.sent, "prompt").length === 2,
    );
    expect(listSentCommands(run.sent, "prompt")[1]).toMatchObject({ message: REPROMPT });
    // The re-prompt stays inside the same Hercule turn: a second
    // `turn.started` would split one turn in two, and a `turn.completed` here
    // would report a result while the session is still being asked for it.
    await settle();
    expect(filterByTag(run.seen, "turn.started")).toHaveLength(1);
    expect(filterByTag(run.seen, "turn.completed")).toEqual([]);
  });

  it("gives up after the second re-prompt and reports that the tool was never called", async () => {
    const run = await openTurn();

    run.child.push({ type: "agent_settled" });
    await waitUntil("asked again", () => listSentCommands(run.sent, "prompt").length === 2);
    run.child.push({ type: "agent_settled" });
    await waitUntil("asked a second time", () => listSentCommands(run.sent, "prompt").length === 3);
    run.child.push({ type: "agent_settled" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    // Two re-prompts and no more: more could make a session that never ends.
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(3);
    expect(filterByTag(run.seen, "turn.completed")[0]!.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/\S/) as string,
    });
    expect(filterByTag(run.seen, "turn.started")).toHaveLength(1);
  });

  it("ends the turn after pi rejects too many answers, and reports the last one", async () => {
    const run = await openTurn();

    // pi returns a validation error to the model as the call's result, and a
    // model that cannot satisfy the schema keeps retrying for as long as it
    // is allowed to.
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

  it("reports no result and does not re-prompt when the user stopped the turn", async () => {
    const run = await openTurn();

    await Effect.runPromise(run.adapter.interrupt(SESSION));
    pushAgentEnd(run.child, { stopReason: "aborted" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    const completed = filterByTag(run.seen, "turn.completed")[0]!;
    expect(completed.state).toBe("interrupted");
    // Nobody expects a result from a turn the user stopped, and re-prompting
    // a session that was just stopped would get no answer.
    expect("structuredResult" in completed).toBe(false);
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(1);
  });

  it("reports no result when the turn failed on an error", async () => {
    const run = await openTurn();

    pushAgentEnd(run.child, {
      stopReason: "error",
      errorMessage: "the model provider refused the request",
    });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    const completed = filterByTag(run.seen, "turn.completed")[0]!;
    expect(completed.state).toBe("failed");
    // The turn itself failed. A schema failure here would wrongly suggest
    // that an answer was checked and rejected.
    expect("structuredResult" in completed).toBe(false);
  });

  it("reports no result and does not re-prompt on a session with no schema", async () => {
    const run = await openTurn(SPEC);

    run.child.push({ type: "agent_settled" });

    await waitUntil("closed the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    // A Thread answers in prose. A result on every turn of every session
    // would give "ok" a second meaning, and a re-prompt would ask for a value
    // this session was never asked for.
    expect("structuredResult" in filterByTag(run.seen, "turn.completed")[0]!).toBe(false);
    await settle();
    expect(listSentCommands(run.sent, "prompt")).toHaveLength(1);
  });
});
