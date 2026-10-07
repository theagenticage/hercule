/**
 * Tests subagents on a fake pi: the second pi process the adapter starts when
 * an agent calls the `subagent` tool, the events attributed to it, the reply
 * its parent gets, the limits on how many may run and how deep, and every way
 * a subagent is stopped before it finishes. A subagent left running would keep
 * the instance's key and its model calls, and a parent left without a reply
 * would wait forever, so the tests check both as carefully as the happy path.
 *
 * No vendor code runs. The frames pushed in are pi 0.85.1's own:
 * `tool_execution_start`, `turn_end`, `agent_end`, `agent_settled`, and the
 * `extension_ui_request` that `createDialogPromise` in
 * `dist/modes/rpc/rpc-mode.js` emits for the extension's `ctx.ui.input` and
 * `ctx.ui.confirm`. The reply goes back as an `extension_ui_response` with a
 * `value`, as `dist/modes/rpc/rpc-types.d.ts` declares for an input dialog.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { OutputSchema, ProviderEvent, SessionSpec, SubagentId } from "@hercule/protocol";
import {
  OUTPUT_SCHEMA_VARIABLE,
  SUBAGENT_DIALOG,
  SUBAGENT_TOOL,
  SUBAGENTS_VARIABLE,
  type SubagentReply,
} from "./extension";
import {
  startBusySession,
  cleanupHomes,
  SESSION,
  SPEC,
  listSentCommands,
  settle,
  filterByTag,
  waitUntil,
  type Spawn,
} from "./testing";

afterAll(cleanupHomes);

type DrivenAdapter = Awaited<ReturnType<typeof startBusySession>>;

/** A subagent the adapter started, and the ids its parent's call and dialog had. */
interface StartedSubagent {
  readonly child: Spawn;
  readonly subagentId: SubagentId;
  readonly toolCallId: string;
  readonly dialogId: string;
}

const DESCRIPTION = "Survey the failing tests";

const PROMPT = "List every failing test in this repository, with its error.";

/**
 * Pushes a `subagent` call to `parent` and the dialog the extension opens for
 * it, then waits for the adapter to start the subagent. Returns the new pi
 * process and the subagent's id.
 */
const askForSubagent = async (
  run: DrivenAdapter,
  parent: Spawn,
  description: string = DESCRIPTION,
): Promise<StartedSubagent> => {
  const toolCallId = `call_${crypto.randomUUID()}`;
  const dialogId = crypto.randomUUID();
  const spawned = run.spawns.length;
  const started = filterByTag(run.seen, "subagent.started").length;
  parent.push({
    type: "tool_execution_start",
    toolCallId,
    toolName: SUBAGENT_TOOL,
    args: { description, prompt: PROMPT },
  });
  parent.push(buildSubagentDialog(dialogId, toolCallId, description));
  await waitUntil(
    "started the subagent",
    () => filterByTag(run.seen, "subagent.started").length > started,
  );
  return {
    child: run.spawns[spawned]!,
    subagentId: filterByTag(run.seen, "subagent.started")[started]!.subagentId,
    toolCallId,
    dialogId,
  };
};

/** Builds the input dialog the extension's `subagent` tool opens, with the task in its placeholder. */
const buildSubagentDialog = (
  dialogId: string,
  toolCallId: string,
  description: string,
): Record<string, unknown> => ({
  type: "extension_ui_request",
  id: dialogId,
  method: "input",
  title: SUBAGENT_DIALOG,
  placeholder: JSON.stringify({ toolCallId, description, prompt: PROMPT }),
});

/** Opens the subagent's turn the way pi does once it takes the prompt. */
const openSubagentTurn = async (run: DrivenAdapter, subagent: StartedSubagent): Promise<void> => {
  subagent.child.push({ type: "agent_start" });
  await waitUntil("reported the subagent's turn open", () =>
    filterByTag(run.seen, "turn.started").some((event) => event.subagentId === subagent.subagentId),
  );
};

/** pi's usage on one assistant message, as `turn_end` reports it. */
interface PiUsage {
  readonly input: number;
  readonly output: number;
}

/** Pushes the frames that end one pi turn on an assistant message with `text` and `usage`. */
const pushFinishedTurn = (child: Spawn, text: string, usage: PiUsage): void => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { ...usage, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
  };
  child.push({ type: "turn_end", message, toolResults: [] });
  child.push({ type: "agent_end", messages: [message] });
  child.push({ type: "agent_settled" });
};

/** Pushes a shell call to `agent` and the confirm dialog the approval hook opens to hold it. */
const parkOnCommand = (agent: Spawn, dialogId: string): void => {
  const toolCallId = `call_${crypto.randomUUID()}`;
  agent.push({
    type: "tool_execution_start",
    toolCallId,
    toolName: "bash",
    args: { command: "rm -rf build" },
  });
  agent.push({
    type: "extension_ui_request",
    id: dialogId,
    method: "confirm",
    title: "Approve bash?",
    message: JSON.stringify({ toolCallId, toolName: "bash" }),
  });
};

/** Returns every response the adapter wrote to one pi's dialog `dialogId`. */
const listDialogAnswers = (
  agent: Spawn,
  dialogId: string,
): ReadonlyArray<Record<string, unknown>> =>
  listSentCommands(agent.sent, "extension_ui_response").filter(
    (written) => written["id"] === dialogId,
  );

/** Waits for the adapter's response to one dialog of `agent`'s pi, and returns it. */
const awaitDialogAnswer = async (
  agent: Spawn,
  dialogId: string,
): Promise<Record<string, unknown>> => {
  await waitUntil(
    `answered dialog ${dialogId}`,
    () => listDialogAnswers(agent, dialogId).length > 0,
  );
  return listDialogAnswers(agent, dialogId)[0]!;
};

/** Waits for the reply the subagent's parent gets, and parses it. */
const awaitReply = async (parent: Spawn, subagent: StartedSubagent): Promise<SubagentReply> => {
  const answer = await awaitDialogAnswer(parent, subagent.dialogId);
  return JSON.parse(String(answer["value"])) as SubagentReply;
};

/** Returns the events attributed to one agent: a subagent by id, or the session's own when undefined. */
const listEventsOf = (
  run: DrivenAdapter,
  subagentId: SubagentId | undefined,
): ReadonlyArray<ProviderEvent> =>
  run.seen.filter(
    (event) =>
      event._tag !== "subagent.started" &&
      ("subagentId" in event ? event.subagentId : undefined) === subagentId,
  );

/** Waits for one agent's `turn.completed`, and returns it. */
const awaitTurnCompleted = async (
  run: DrivenAdapter,
  subagentId: SubagentId | undefined,
): Promise<Extract<ProviderEvent, { _tag: "turn.completed" }>> => {
  const find = () =>
    filterByTag(run.seen, "turn.completed").find((event) => event.subagentId === subagentId);
  await waitUntil(
    `ended the turn of ${subagentId ?? "the session's agent"}`,
    () => find() !== undefined,
  );
  return find()!;
};

const OUTPUT_SCHEMA: OutputSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string" } },
};

describe("how a subagent's pi is started", () => {
  it("keeps no transcript, gets neither the Agent's instructions nor the output schema, and may start subagents itself", async () => {
    const spec: SessionSpec = {
      ...SPEC,
      systemPrompt: "You assess tasks and answer with a verdict.",
      outputSchema: OUTPUT_SCHEMA,
    };
    const run = await startBusySession({}, spec);

    const { child } = await askForSubagent(run, run.child);

    expect(child.command).toContain("--no-session");
    expect(child.command).not.toContain("--session-dir");
    expect(child.command).not.toContain("--session-id");
    // The parent's prompt is the subagent's whole brief, so the Agent's
    // instructions file is passed to the session's own pi alone.
    const instructions = (command: ReadonlyArray<string>) =>
      command.filter((arg) => arg.endsWith(`system-prompt-${SESSION}.txt`));
    expect(instructions(run.child.command)).toHaveLength(1);
    expect(instructions(child.command)).toEqual([]);
    expect(child.env[SUBAGENTS_VARIABLE]).toBe("1");
    // Only the session's own agent answers with the schema.
    expect(child.env[OUTPUT_SCHEMA_VARIABLE]).toBeUndefined();
    expect(run.child.env[SUBAGENTS_VARIABLE]).toBe("1");
    expect(run.child.env[OUTPUT_SCHEMA_VARIABLE]).toBeDefined();
  });

  it("gives a subagent's subagent no subagent tool, because it runs at the deepest level allowed", async () => {
    const run = await startBusySession();
    const child = await askForSubagent(run, run.child);
    await openSubagentTurn(run, child);

    const grandchild = await askForSubagent(run, child.child, "Read one failing test");

    expect(child.child.env[SUBAGENTS_VARIABLE]).toBe("1");
    expect(grandchild.child.env[SUBAGENTS_VARIABLE]).toBeUndefined();
  });
});

describe("what a running subagent reports", () => {
  it("is announced on its parent's call, and its own events carry its id while its parent's carry none", async () => {
    const run = await startBusySession();

    const subagent = await askForSubagent(run, run.child);
    await openSubagentTurn(run, subagent);
    subagent.child.push({
      type: "tool_execution_start",
      toolCallId: "call_read",
      toolName: "read",
      args: { path: "a.test.ts" },
    });
    pushFinishedTurn(subagent.child, "Two tests fail.", { input: 30, output: 3 });
    await awaitTurnCompleted(run, subagent.subagentId);

    const call = filterByTag(run.seen, "item.started").find((event) => event.kind === "subagent");
    const [started] = filterByTag(run.seen, "subagent.started");
    expect(started).toMatchObject({ itemId: call?.itemId, description: DESCRIPTION });
    // The session's own agent started it, so it has no parent subagent.
    expect(started).not.toHaveProperty("parentSubagentId");
    // The call itself belongs to the parent's transcript.
    expect(call).not.toHaveProperty("subagentId");
    expect(subagent.child.sent.find((sent) => sent.type === "prompt")?.command["message"]).toBe(
      PROMPT,
    );

    const own = listEventsOf(run, subagent.subagentId).map((event) =>
      event._tag === "item.started" || event._tag === "item.completed"
        ? `${event._tag}:${event.kind}`
        : event._tag,
    );
    expect(own).toEqual(
      expect.arrayContaining([
        "item.started:user_message",
        "item.completed:user_message",
        "item.started:tool_call",
        "turn.started",
        "session.usage.updated",
        "turn.completed",
      ]),
    );
    const userMessage = filterByTag(run.seen, "item.started").find(
      (event) => event.kind === "user_message" && event.subagentId === subagent.subagentId,
    );
    expect(userMessage?.detail).toEqual({ text: PROMPT });

    const parents = listEventsOf(run, undefined).map((event) => event._tag);
    expect(parents).toEqual(expect.arrayContaining(["turn.started", "item.started"]));
    expect(
      filterByTag(run.seen, "turn.started").filter((event) => event.subagentId === undefined),
    ).toHaveLength(1);
  });

  it("names its subagent's parent when a subagent starts one", async () => {
    const run = await startBusySession();
    const child = await askForSubagent(run, run.child);
    await openSubagentTurn(run, child);

    await askForSubagent(run, child.child, "Read one failing test");

    const [, grandchild] = filterByTag(run.seen, "subagent.started");
    expect(grandchild?.parentSubagentId).toBe(child.subagentId);
    expect(grandchild?.itemId).toBe(
      filterByTag(run.seen, "item.started").find(
        (event) => event.kind === "subagent" && event.subagentId === child.subagentId,
      )?.itemId,
    );
  });
});

describe("a subagent that finishes", () => {
  it("replies to its parent with its last message, and reports its own usage beside the session's total", async () => {
    const run = await startBusySession();
    // The session's own agent spends some tokens before it delegates, so the
    // session total differs from the subagent's own.
    run.child.push({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        stopReason: "toolUse",
      },
      toolResults: [],
    });
    const subagent = await askForSubagent(run, run.child);
    await openSubagentTurn(run, subagent);

    pushFinishedTurn(subagent.child, "Two tests fail: a.test.ts and b.test.ts.", {
      input: 30,
      output: 3,
    });

    expect(await awaitReply(run.child, subagent)).toEqual({
      text: "Two tests fail: a.test.ts and b.test.ts.",
    });
    const completed = await awaitTurnCompleted(run, subagent.subagentId);
    expect(completed.state).toBe("completed");
    expect(completed.usage).toMatchObject({ inputTokens: 30, outputTokens: 3 });
    const usages = filterByTag(run.seen, "session.usage.updated");
    expect(usages.find((event) => event.subagentId === subagent.subagentId)?.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 3,
    });
    expect(usages.find((event) => event.subagentId === undefined)?.usage).toMatchObject({
      inputTokens: 130,
      outputTokens: 13,
    });
    // A finished subagent's pi is closed, so it stops holding the key.
    await waitUntil("closed the subagent's pi", () => subagent.child.stdinClosed());
  });

  it("is listed on its parent's call when the call completes", async () => {
    const run = await startBusySession();
    const subagent = await askForSubagent(run, run.child);
    await openSubagentTurn(run, subagent);
    pushFinishedTurn(subagent.child, "Two tests fail.", { input: 30, output: 3 });
    await awaitReply(run.child, subagent);

    run.child.push({
      type: "tool_execution_end",
      toolCallId: subagent.toolCallId,
      toolName: SUBAGENT_TOOL,
      result: { content: [{ type: "text", text: "Two tests fail." }], details: {} },
      isError: false,
    });

    await waitUntil("completed the call", () =>
      filterByTag(run.seen, "item.completed").some((event) => event.kind === "subagent"),
    );
    const call = filterByTag(run.seen, "item.completed").find((event) => event.kind === "subagent");
    expect(call?.status).toBe("completed");
    expect(call?.detail).toMatchObject({ subagentIds: [subagent.subagentId] });
  });
});

describe("approvals asked by two subagents at once", () => {
  it("opens both, each under its subagent, and sends each answer to the subagent that asked", async () => {
    const run = await startBusySession();
    const first = await askForSubagent(run, run.child, "Clean the first build");
    const second = await askForSubagent(run, run.child, "Clean the second build");
    await openSubagentTurn(run, first);
    await openSubagentTurn(run, second);
    parkOnCommand(first.child, "dialog-first");
    parkOnCommand(second.child, "dialog-second");
    await waitUntil("opened both", () => filterByTag(run.seen, "request.opened").length === 2);
    const opened = filterByTag(run.seen, "request.opened");
    const firstRequest = opened.find((event) => event.subagentId === first.subagentId);
    const secondRequest = opened.find((event) => event.subagentId === second.subagentId);
    expect(firstRequest).toBeDefined();
    expect(secondRequest).toBeDefined();

    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, secondRequest!.request.requestId, "deny"),
    );
    expect((await awaitDialogAnswer(second.child, "dialog-second"))["confirmed"]).toBe(false);
    // The first subagent is still waiting for its own answer.
    expect(listSentCommands(first.child.sent, "extension_ui_response")).toEqual([]);

    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, firstRequest!.request.requestId, "allow"),
    );
    expect((await awaitDialogAnswer(first.child, "dialog-first"))["confirmed"]).toBe(true);
    expect(listDialogAnswers(second.child, "dialog-first")).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.subagentId)).toEqual([
      second.subagentId,
      first.subagentId,
    ]);
  });
});

describe("stopping subagents", () => {
  it("stops one subagent and the subagent below it, and tells its parent the user stopped it", async () => {
    const run = await startBusySession();
    const child = await askForSubagent(run, run.child);
    await openSubagentTurn(run, child);
    const grandchild = await askForSubagent(run, child.child, "Read one failing test");
    await openSubagentTurn(run, grandchild);
    parkOnCommand(child.child, "dialog-child");
    parkOnCommand(grandchild.child, "dialog-grandchild");
    await waitUntil("opened both", () => filterByTag(run.seen, "request.opened").length === 2);

    await Effect.runPromise(run.adapter.interrupt(SESSION, child.subagentId));

    expect((await awaitTurnCompleted(run, grandchild.subagentId)).state).toBe("interrupted");
    expect((await awaitTurnCompleted(run, child.subagentId)).state).toBe("interrupted");
    expect(await awaitReply(run.child, child)).toEqual({
      error: "The user stopped this subagent.",
    });
    await settle();
    // The subagent that waited for the grandchild is stopping too, so it gets no reply.
    expect(listDialogAnswers(child.child, grandchild.dialogId)).toEqual([]);
    // Nobody decided the approvals; their agents stopped waiting.
    const resolved = filterByTag(run.seen, "request.resolved");
    expect(resolved.map((event) => ("decision" in event ? event.decision : undefined))).toEqual([
      "cancel",
      "cancel",
    ]);
    expect(listDialogAnswers(child.child, "dialog-child")[0]?.["cancelled"]).toBe(true);
    expect(listDialogAnswers(grandchild.child, "dialog-grandchild")[0]?.["cancelled"]).toBe(true);
    // The session's own agent keeps working, with the stop as the call's result.
    expect(listSentCommands(run.child.sent, "abort")).toEqual([]);
    expect(child.child.stdinClosed()).toBe(true);
    expect(grandchild.child.stdinClosed()).toBe(true);
  });

  it("ends every subagent without a reply when the whole session is interrupted, and aborts the session's turn", async () => {
    const run = await startBusySession();
    const first = await askForSubagent(run, run.child, "Clean the first build");
    const second = await askForSubagent(run, run.child, "Clean the second build");
    await openSubagentTurn(run, first);
    await openSubagentTurn(run, second);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect((await awaitTurnCompleted(run, first.subagentId)).state).toBe("interrupted");
    expect((await awaitTurnCompleted(run, second.subagentId)).state).toBe("interrupted");
    await waitUntil(
      "aborted the session's turn",
      () => listSentCommands(run.child.sent, "abort").length === 1,
    );
    await settle();
    // The abort ends the calls that waited for them, so neither gets a reply.
    expect(listSentCommands(run.child.sent, "extension_ui_response")).toEqual([]);
    expect(first.child.stdinClosed()).toBe(true);
    expect(second.child.stdinClosed()).toBe(true);
  });

  it("stops a subagent whose parent's call ended before it replied", async () => {
    const run = await startBusySession();
    const subagent = await askForSubagent(run, run.child);
    await openSubagentTurn(run, subagent);

    // pi ends the call this way when its turn is aborted mid call.
    run.child.push({
      type: "tool_execution_end",
      toolCallId: subagent.toolCallId,
      toolName: SUBAGENT_TOOL,
      result: { content: [{ type: "text", text: "The operation was aborted." }], details: {} },
      isError: true,
    });

    expect((await awaitTurnCompleted(run, subagent.subagentId)).state).toBe("interrupted");
    await settle();
    expect(listDialogAnswers(run.child, subagent.dialogId)).toEqual([]);
    expect(subagent.child.stdinClosed()).toBe(true);
  });

  it("stops a subagent whose parent's turn ended while it ran", async () => {
    const run = await startBusySession();
    const subagent = await askForSubagent(run, run.child);
    await openSubagentTurn(run, subagent);

    run.child.push({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    run.child.push({ type: "agent_settled" });

    await awaitTurnCompleted(run, undefined);
    expect((await awaitTurnCompleted(run, subagent.subagentId)).state).toBe("interrupted");
    await settle();
    expect(listDialogAnswers(run.child, subagent.dialogId)).toEqual([]);
    expect(subagent.child.stdinClosed()).toBe(true);
  });
});

describe("the limits on subagents", () => {
  it("refuses a fifth subagent while four run, without starting a pi for it", async () => {
    const run = await startBusySession();
    for (const number of [1, 2, 3, 4]) {
      await askForSubagent(run, run.child, `Task number ${String(number)}`);
    }
    const spawned = run.spawns.length;

    const toolCallId = "call_fifth";
    run.child.push({
      type: "tool_execution_start",
      toolCallId,
      toolName: SUBAGENT_TOOL,
      args: { description: "Task number 5", prompt: PROMPT },
    });
    run.child.push(buildSubagentDialog("dialog-fifth", toolCallId, "Task number 5"));

    const answer = await awaitDialogAnswer(run.child, "dialog-fifth");
    const reply = JSON.parse(String(answer["value"])) as SubagentReply;
    expect("error" in reply ? reply.error : "").toContain("4 subagents");
    await settle();
    expect(run.spawns).toHaveLength(spawned);
    expect(filterByTag(run.seen, "subagent.started")).toHaveLength(4);
  });
});

describe("a subagent whose pi exits by itself", () => {
  it("fails its turn and replies to its parent with pi's stderr", async () => {
    const run = await startBusySession();
    const subagent = await askForSubagent(run, run.child);
    await openSubagentTurn(run, subagent);
    const complaint = "pi: the model provider refused the request";

    subagent.child.crash(complaint);

    const completed = await awaitTurnCompleted(run, subagent.subagentId);
    expect(completed.state).toBe("failed");
    expect(completed.error).toContain(complaint);
    const reply = await awaitReply(run.child, subagent);
    expect("error" in reply ? reply.error : "").toContain(complaint);
    // A subagent's crash is not the session's: the session keeps running.
    expect(filterByTag(run.seen, "session.exited")).toEqual([]);
  });
});
