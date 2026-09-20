/**
 * The park: what the user is asked when the Hydra extension stops a tool call,
 * what is written back to pi for each answer, and what happens to a second
 * question asked while the first is still open. A request nobody can answer is
 * a session stuck with nothing said anywhere, so the absence of a response is
 * asserted as hard as its content.
 *
 * Nothing vendor-supplied runs. The frames pushed in are pi 0.85.1's own:
 * `tool_execution_start` and the `extension_ui_request` that
 * `dist/modes/rpc/rpc-mode.js`'s `createDialogPromise` emits for
 * `ctx.ui.confirm`, answered by the `extension_ui_response` shapes
 * `dist/modes/rpc/rpc-types.d.ts` declares: `{ confirmed }` or `{ cancelled }`.
 *
 * pi's response frame has nowhere to put a reason, so a second question asked
 * while one is open is written back as the bare deny value and the reason is
 * said on the session's own stream, as a runtime warning.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProviderEvent } from "@hercule/protocol";
import { busy, cleanupHomes, SESSION, sentOf, settle, taggedIn, until } from "./testing";

afterAll(cleanupHomes);

const CALL = "call_0199e0e7";

/** The id pi mints per dialog, which is the only handle the answer has. */
const UI = "3f1a0c7e-0000-4000-8000-00000000abcd";

const SECOND_UI = "3f1a0c7e-0000-4000-8000-00000000abce";

const SECOND_CALL = "call_0199e0e8";

/**
 * What Hydra's own approval hook writes in the dialog: which call it is asking about.
 * pi's dialog carries no call of its own, and the card is rendered from the
 * call rather than from this, so the name and the id are all it says.
 */
const about = (toolCallId: string, toolName: string): string =>
  JSON.stringify({ toolCallId, toolName });

const COMMAND = "rm -rf build && echo rebuilt";

type DrivenAdapter = Awaited<ReturnType<typeof busy>>;

/** A turn stopped on a call the extension will not run unasked. */
const parkedOn = async (
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Promise<DrivenAdapter> => {
  const run = await busy();
  run.child.push({ type: "tool_execution_start", toolCallId: CALL, toolName, args });
  run.child.push({
    type: "extension_ui_request",
    id: UI,
    method: "confirm",
    title: `Approve ${toolName}?`,
    message: about(CALL, toolName),
  });
  return run;
};

/** A turn stopped on a shell command, which is what most of this file drives. */
const parked = (): Promise<DrivenAdapter> => parkedOn("bash", { command: COMMAND });

const openedIn = async (
  run: DrivenAdapter,
): Promise<Extract<ProviderEvent, { _tag: "request.opened" }>> => {
  await until("docked the request", () => taggedIn(run.seen, "request.opened").length === 1);
  return taggedIn(run.seen, "request.opened")[0]!;
};

/** What the adapter wrote back to pi for one dialog, once it has written it. */
const answerTo = async (run: DrivenAdapter, id: string): Promise<Record<string, unknown>> => {
  await until(`answered dialog ${id}`, () =>
    sentOf(run.sent, "extension_ui_response").some((written) => written["id"] === id),
  );
  return sentOf(run.sent, "extension_ui_response").find((written) => written["id"] === id)!;
};

const resolvedIn = async (
  run: DrivenAdapter,
): Promise<Extract<ProviderEvent, { _tag: "request.resolved" }>> => {
  await until("ended the park", () => taggedIn(run.seen, "request.resolved").length === 1);
  return taggedIn(run.seen, "request.resolved")[0]!;
};

/**
 * What a held call is asked as, by tool. The approval hook decides whether to hold a
 * call; what the card over it is called follows from what the call does, so a
 * shell is a command, a file written or edited is a change, and anything the
 * adapter does not recognise is the tool by its name.
 */
describe("what a held call is asked as", () => {
  const CARDS: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>, string]> = [
    ["bash", { command: COMMAND }, "command_approval"],
    // The same shell on another machine is the same question to the user.
    ["powershell", { command: COMMAND }, "command_approval"],
    ["write", { path: "src/new.ts" }, "file_change_approval"],
    ["edit", { path: "src/new.ts" }, "file_change_approval"],
    // An MCP tool, or one a later pi adds: named, never guessed at.
    ["mcp__jira__create", { summary: "ship it" }, "tool_approval"],
  ];

  for (const [toolName, args, kind] of CARDS) {
    it(`asks about ${toolName} as a ${kind}`, async () => {
      const run = await parkedOn(toolName, args);

      expect((await openedIn(run)).request.kind).toBe(kind);
    });
  }
});

describe("what a parked shell command asks the user", () => {
  it("docks a command approval on the item the command started", async () => {
    const run = await parked();

    const opened = await openedIn(run);
    const item = taggedIn(run.seen, "item.started").find(
      (event) => event.kind === "command_execution",
    );
    expect(opened.request.kind).toBe("command_approval");
    expect(opened.request.requestId).not.toBe("");
    // The card overlays the command it is about, so it carries that item's id.
    expect(opened.request.itemId).toBe(item?.itemId);
    expect(opened.request.decisions).toEqual(["allow", "deny", "cancel"]);
    expect(opened.request.detail).toEqual({ command: COMMAND });
  });

  it("says nothing to pi until the user answers", async () => {
    const run = await parked();
    await openedIn(run);

    await settle();

    // pi is holding the tool call open; an answer written early runs it.
    expect(sentOf(run.sent, "extension_ui_response")).toEqual([]);
    expect(taggedIn(run.seen, "request.resolved")).toEqual([]);
  });
});

describe("what each answer does to the parked session", () => {
  it("lets the command run on an allow, and reports the park over", async () => {
    const run = await parked();
    const opened = await openedIn(run);

    await Effect.runPromise(
      run.adapter.respondToRequest(SESSION, opened.request.requestId, "allow"),
    );

    const written = await answerTo(run, UI);
    expect(written["confirmed"]).toBe(true);
    expect(written["cancelled"]).toBeUndefined();
    const resolved = await resolvedIn(run);
    expect(resolved.requestId).toBe(opened.request.requestId);
    expect(resolved.decision).toBe("allow");
  });

  it("blocks the command on a deny, with the reason pi reports on the item", async () => {
    const reason = "Denied by the user in Hydra";
    const run = await parked();
    const opened = await openedIn(run);

    await Effect.runPromise(
      run.adapter.respondToRequest(SESSION, opened.request.requestId, "deny"),
    );
    const written = await answerTo(run, UI);
    run.child.push({
      type: "tool_execution_end",
      toolCallId: CALL,
      toolName: "bash",
      result: { content: [{ type: "text", text: reason }], details: {} },
      isError: true,
    });

    expect(written["confirmed"]).toBe(false);
    expect((await resolvedIn(run)).decision).toBe("deny");
    await until("completed the blocked command", () => {
      const done = taggedIn(run.seen, "item.completed");
      return done.some((event) => event.itemId === opened.request.itemId);
    });
    const completed = taggedIn(run.seen, "item.completed").find(
      (event) => event.itemId === opened.request.itemId,
    )!;
    expect(completed.status).toBe("declined");
    // Why it did not run has to reach the transcript; a bare failure reads as
    // a broken command rather than a decision the user made.
    expect(JSON.stringify(run.seen)).toContain(reason);
  });

  it("refuses the command and ends the turn on a cancel", async () => {
    const run = await parked();
    const opened = await openedIn(run);

    await Effect.runPromise(
      run.adapter.respondToRequest(SESSION, opened.request.requestId, "cancel"),
    );

    const written = await answerTo(run, UI);
    expect(written["cancelled"]).toBe(true);
    expect((await resolvedIn(run)).decision).toBe("cancel");
    // A cancel is not a no to one command: pi reads a refusal as one tool it
    // may not run and carries on with the rest of what it planned, so the turn
    // has to go with it.
    await until("stopped the turn", () => sentOf(run.sent, "abort").length === 1);
    run.child.push({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
    run.child.push({ type: "agent_settled" });

    await until("ended the turn", () => taggedIn(run.seen, "turn.completed").length === 1);
    expect(taggedIn(run.seen, "turn.completed")[0]?.state).toBe("interrupted");
    // The park ended once. A turn that ended a second time over the same
    // question would leave a card reported as resolved twice.
    expect(taggedIn(run.seen, "request.resolved")).toHaveLength(1);
  });

  it("cancels the dialog and ends the turn when the session is interrupted", async () => {
    const run = await parked();
    const opened = await openedIn(run);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    const written = await answerTo(run, UI);
    // A `cancelled` is the only answer pi reads as "no decision was made".
    expect(written["cancelled"]).toBe(true);
    const resolved = await resolvedIn(run);
    expect(resolved.requestId).toBe(opened.request.requestId);
    expect(resolved.decision).toBe("cancel");
    await until("stopped the turn", () => sentOf(run.sent, "abort").length === 1);
    run.child.push({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
    run.child.push({ type: "agent_settled" });

    await until("ended the turn", () => taggedIn(run.seen, "turn.completed").length === 1);
    // The turn ending does not end the park a second time.
    expect(taggedIn(run.seen, "request.resolved")).toHaveLength(1);
  });
});

describe("a second question asked while one is open", () => {
  it("refuses it at once and docks nothing", async () => {
    const run = await parked();
    await openedIn(run);

    run.child.push({
      type: "extension_ui_request",
      id: SECOND_UI,
      method: "confirm",
      title: "Run a shell command?",
      message: about(SECOND_CALL, "bash"),
    });

    const written = await answerTo(run, SECOND_UI);
    expect(written["confirmed"]).toBe(false);
    await settle();
    // One card is docked on the composer; a second would have nowhere to go.
    expect(taggedIn(run.seen, "request.opened")).toHaveLength(1);
    expect(sentOf(run.sent, "extension_ui_response")).toHaveLength(1);
  });

  it("says why it refused", async () => {
    const run = await parked();
    await openedIn(run);

    run.child.push({
      type: "extension_ui_request",
      id: SECOND_UI,
      method: "confirm",
      title: "Run a shell command?",
      message: about(SECOND_CALL, "bash"),
    });
    await answerTo(run, SECOND_UI);

    const said = taggedIn(run.seen, "runtime.warning")
      .map((event) => event.message)
      .join(" ");
    expect(said.toLowerCase()).toContain("one at a time");
  });
});
