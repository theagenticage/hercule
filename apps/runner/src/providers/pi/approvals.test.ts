/**
 * Tests parking on an approval: the request the user sees when the Hercule
 * extension holds a tool call, the response written back to pi for each
 * decision, and a second approval asked while the first is still open: pi
 * runs a message's tool calls at the same time, so both are open at once. A request nobody can answer leaves the session silently stuck,
 * so the tests check that no response is sent too early as carefully as they
 * check the response itself.
 *
 * No vendor code runs. The frames pushed in are pi 0.85.1's own:
 * `tool_execution_start`, and the `extension_ui_request` that
 * `createDialogPromise` in `dist/modes/rpc/rpc-mode.js` emits for
 * `ctx.ui.confirm`. The responses use the `extension_ui_response` shapes
 * `dist/modes/rpc/rpc-types.d.ts` declares: `{ confirmed }` or `{ cancelled }`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProviderEvent } from "@hercule/protocol";
import {
  startBusySession,
  cleanupHomes,
  SESSION,
  listSentCommands,
  settle,
  filterByTag,
  waitUntil,
} from "./testing";

afterAll(cleanupHomes);

const CALL = "call_0199e0e7";

/** The id pi gives the dialog. The response is matched to the dialog by this id alone. */
const UI = "3f1a0c7e-0000-4000-8000-00000000abcd";

const SECOND_UI = "3f1a0c7e-0000-4000-8000-00000000abce";

const SECOND_CALL = "call_0199e0e8";

/**
 * Builds the dialog message Hercule's approval hook writes: the call it asks
 * about. pi's dialog does not include the call, and the card is built from the
 * call itself, so the message holds only the call's id and tool name.
 */
const buildDialogMessage = (toolCallId: string, toolName: string): string =>
  JSON.stringify({ toolCallId, toolName });

const COMMAND = "rm -rf build && echo rebuilt";

type DrivenAdapter = Awaited<ReturnType<typeof startBusySession>>;

/** Starts a turn and pushes a tool call plus the approval dialog that holds it. */
const parkOnTool = async (
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Promise<DrivenAdapter> => {
  const run = await startBusySession();
  run.child.push({ type: "tool_execution_start", toolCallId: CALL, toolName, args });
  run.child.push({
    type: "extension_ui_request",
    id: UI,
    method: "confirm",
    title: `Approve ${toolName}?`,
    message: buildDialogMessage(CALL, toolName),
  });
  return run;
};

/** Parks a turn on a shell command, the case most tests in this file use. */
const parkOnCommand = (): Promise<DrivenAdapter> => parkOnTool("bash", { command: COMMAND });

const awaitOpenedRequest = async (
  run: DrivenAdapter,
): Promise<Extract<ProviderEvent, { _tag: "request.opened" }>> => {
  await waitUntil("docked the request", () => filterByTag(run.seen, "request.opened").length === 1);
  return filterByTag(run.seen, "request.opened")[0]!;
};

/** Waits for the adapter's response to one dialog, and returns it. */
const awaitAnswer = async (run: DrivenAdapter, id: string): Promise<Record<string, unknown>> => {
  await waitUntil(`answered dialog ${id}`, () =>
    listSentCommands(run.sent, "extension_ui_response").some((written) => written["id"] === id),
  );
  return listSentCommands(run.sent, "extension_ui_response").find(
    (written) => written["id"] === id,
  )!;
};

const awaitResolvedRequest = async (
  run: DrivenAdapter,
): Promise<Extract<ProviderEvent, { _tag: "request.resolved"; decision: unknown }>> => {
  await waitUntil("ended the park", () => filterByTag(run.seen, "request.resolved").length === 1);
  const [resolved] = filterByTag(run.seen, "request.resolved");
  // pi parks only on approvals, so a request it resolves always carries a decision.
  if (resolved === undefined || !("decision" in resolved))
    throw new Error("the request was resolved without a decision");
  return resolved;
};

/**
 * The request kind a held call opens, by tool. The approval hook decides
 * whether to hold a call; the kind follows from what the call does:
 *
 * - a shell is a command approval;
 * - writing or editing a file is a file change approval;
 * - reading, searching or listing files is a file read approval;
 * - any other tool is a tool approval, by name.
 */
describe("the request kind of a held call", () => {
  const CARDS: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>, string]> = [
    ["bash", { command: COMMAND }, "command_approval"],
    // PowerShell is a shell like bash, so the user is asked the same way.
    ["powershell", { command: COMMAND }, "command_approval"],
    ["write", { path: "src/new.ts" }, "file_change_approval"],
    ["edit", { path: "src/new.ts" }, "file_change_approval"],
    // These run unasked in the known modes, but a mode this build does not
    // know asks about everything, so they still need the right card.
    ["read", { path: "src/main.ts" }, "file_read_approval"],
    ["grep", { pattern: "TODO", path: "src" }, "file_read_approval"],
    ["find", { pattern: "*.ts" }, "file_read_approval"],
    ["ls", {}, "file_read_approval"],
    // An MCP tool, or one a later pi adds: shown by name, never guessed at.
    ["mcp__jira__create", { summary: "ship it" }, "tool_approval"],
  ];

  for (const [toolName, args, kind] of CARDS) {
    it(`opens a ${kind} for ${toolName}`, async () => {
      const run = await parkOnTool(toolName, args);

      expect((await awaitOpenedRequest(run)).request.kind).toBe(kind);
    });
  }
});

describe("the paths on a parked file call", () => {
  it("shows the path a read is about", async () => {
    const run = await parkOnTool("read", { path: "src/main.ts" });

    expect((await awaitOpenedRequest(run)).request.detail).toEqual({ paths: ["src/main.ts"] });
  });

  // The protocol refuses an empty path, and a frame it refuses is lost, which
  // would leave pi holding the call with no card for the user to answer.
  for (const [toolName, args] of [
    ["ls", {}],
    ["find", { pattern: "*.ts", path: "" }],
    ["write", { content: "b" }],
  ] as const) {
    it(`shows no paths when a held ${toolName} call has no path`, async () => {
      const run = await parkOnTool(toolName, args);

      expect((await awaitOpenedRequest(run)).request.detail).toEqual({ paths: [] });
    });
  }
});

describe("the request for a parked shell command", () => {
  it("opens a command approval on the command's item", async () => {
    const run = await parkOnCommand();

    const opened = await awaitOpenedRequest(run);
    const item = filterByTag(run.seen, "item.started").find(
      (event) => event.kind === "command_execution",
    );
    expect(opened.request.kind).toBe("command_approval");
    expect(opened.request.requestId).not.toBe("");
    // The card is shown on the command it is about, so it carries that item's id.
    expect(opened.request.itemId).toBe(item?.itemId);
    expect(opened.request).toMatchObject({ decisions: ["allow", "deny", "cancel"] });
    expect(opened.request.detail).toEqual({ command: COMMAND });
  });

  it("sends pi nothing until the user answers", async () => {
    const run = await parkOnCommand();
    await awaitOpenedRequest(run);

    await settle();

    // pi is holding the tool call; a response sent early would run it.
    expect(listSentCommands(run.sent, "extension_ui_response")).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });
});

describe("what each decision does to the parked session", () => {
  it("lets the command run on an allow, and reports the request resolved", async () => {
    const run = await parkOnCommand();
    const opened = await awaitOpenedRequest(run);

    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, opened.request.requestId, "allow"),
    );

    const written = await awaitAnswer(run, UI);
    expect(written["confirmed"]).toBe(true);
    expect(written["cancelled"]).toBeUndefined();
    const resolved = await awaitResolvedRequest(run);
    expect(resolved.requestId).toBe(opened.request.requestId);
    expect(resolved.decision).toBe("allow");
  });

  it("blocks the command on a deny, and reports the item as declined with pi's reason", async () => {
    const reason = "Denied by the user in Hercule";
    const run = await parkOnCommand();
    const opened = await awaitOpenedRequest(run);

    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, opened.request.requestId, "deny"),
    );
    const written = await awaitAnswer(run, UI);
    run.child.push({
      type: "tool_execution_end",
      toolCallId: CALL,
      toolName: "bash",
      result: { content: [{ type: "text", text: reason }], details: {} },
      isError: true,
    });

    expect(written["confirmed"]).toBe(false);
    expect((await awaitResolvedRequest(run)).decision).toBe("deny");
    await waitUntil("completed the blocked command", () => {
      const done = filterByTag(run.seen, "item.completed");
      return done.some((event) => event.itemId === opened.request.itemId);
    });
    const completed = filterByTag(run.seen, "item.completed").find(
      (event) => event.itemId === opened.request.itemId,
    )!;
    expect(completed.status).toBe("declined");
    // The reason must reach the transcript. A plain failure would look like a
    // broken command, not a decision the user made.
    expect(JSON.stringify(run.seen)).toContain(reason);
  });

  it("blocks the command and ends the turn on a cancel", async () => {
    const run = await parkOnCommand();
    const opened = await awaitOpenedRequest(run);

    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, opened.request.requestId, "cancel"),
    );

    const written = await awaitAnswer(run, UI);
    expect(written["cancelled"]).toBe(true);
    expect((await awaitResolvedRequest(run)).decision).toBe("cancel");
    // A cancel is more than a no to one command. pi treats a blocked call as
    // one tool it may not run and carries on with the rest of its plan, so the
    // turn must end too.
    await waitUntil("stopped the turn", () => listSentCommands(run.sent, "abort").length === 1);
    run.child.push({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
    run.child.push({ type: "agent_settled" });

    await waitUntil("ended the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    expect(filterByTag(run.seen, "turn.completed")[0]?.state).toBe("interrupted");
    // The request is resolved once. Ending the turn must not resolve the same
    // request a second time.
    expect(filterByTag(run.seen, "request.resolved")).toHaveLength(1);
  });

  it("cancels the dialog and ends the turn when the session is interrupted", async () => {
    const run = await parkOnCommand();
    const opened = await awaitOpenedRequest(run);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    const written = await awaitAnswer(run, UI);
    // `cancelled` is the only response pi reads as "no decision was made".
    expect(written["cancelled"]).toBe(true);
    const resolved = await awaitResolvedRequest(run);
    expect(resolved.requestId).toBe(opened.request.requestId);
    expect(resolved.decision).toBe("cancel");
    await waitUntil("stopped the turn", () => listSentCommands(run.sent, "abort").length === 1);
    run.child.push({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
    run.child.push({ type: "agent_settled" });

    await waitUntil("ended the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
    // Ending the turn does not resolve the request a second time.
    expect(filterByTag(run.seen, "request.resolved")).toHaveLength(1);
  });
});

describe("a second approval asked while one is open", () => {
  /**
   * Parks on a shell command, then pushes a second call and its dialog, as pi
   * does when it runs two tool calls of one message at the same time.
   */
  const parkOnTwoCommands = async (): Promise<DrivenAdapter> => {
    const run = await parkOnCommand();
    await awaitOpenedRequest(run);
    run.child.push({
      type: "tool_execution_start",
      toolCallId: SECOND_CALL,
      toolName: "bash",
      args: { command: "ls" },
    });
    run.child.push({
      type: "extension_ui_request",
      id: SECOND_UI,
      method: "confirm",
      title: "Approve bash?",
      message: buildDialogMessage(SECOND_CALL, "bash"),
    });
    await waitUntil("docked both", () => filterByTag(run.seen, "request.opened").length === 2);
    return run;
  };

  it("opens a second card while the first is still open, and answers pi nothing yet", async () => {
    const run = await parkOnTwoCommands();
    await settle();
    expect(listSentCommands(run.sent, "extension_ui_response")).toHaveLength(0);
  });

  it("answers each dialog on its own, the second one first", async () => {
    const run = await parkOnTwoCommands();
    const [first, second] = filterByTag(run.seen, "request.opened");

    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, second!.request.requestId, "deny"),
    );
    expect((await awaitAnswer(run, SECOND_UI))["confirmed"]).toBe(false);
    expect(listSentCommands(run.sent, "extension_ui_response")).toHaveLength(1);

    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, first!.request.requestId, "allow"),
    );
    expect((await awaitAnswer(run, UI))["confirmed"]).toBe(true);
    expect(filterByTag(run.seen, "request.resolved").map((resolved) => resolved.requestId)).toEqual(
      [second!.request.requestId, first!.request.requestId],
    );
  });

  it("cancels both when the session is interrupted", async () => {
    const run = await parkOnTwoCommands();

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect((await awaitAnswer(run, UI))["cancelled"]).toBe(true);
    expect((await awaitAnswer(run, SECOND_UI))["cancelled"]).toBe(true);
    expect(filterByTag(run.seen, "request.resolved")).toHaveLength(2);
  });
});
