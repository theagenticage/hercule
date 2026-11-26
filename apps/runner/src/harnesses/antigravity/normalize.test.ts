/**
 * Tests the Antigravity normalizer through its functions. The main tests play
 * the recordings of a real `agy` 1.5.15 session (`@hercule/acp/testing`) the way
 * the adapter will: the incoming `session/update` messages go to
 * `normalizeUpdate`, the prompt reply goes to `addPromptUsage` and `closeTurn`,
 * and an approval request asks `describeRequestItem`. The focused tests feed
 * hand-written updates for the cases the recordings do not hold. The tests do
 * not check event ids or timestamps.
 */
import type { SessionUpdate, SessionUpdateNotification, ToolCall } from "@hercule/acp";
import { readRecording, type RecordingName } from "@hercule/acp/testing";
import { MAX_TODO_STEPS, type HarnessEvent } from "@hercule/protocol";
import { describe, expect, it } from "vitest";
import {
  addPromptUsage,
  buildNormalizerState,
  buildProcessEndEvents,
  closeTurn,
  describeRequestItem,
  findRequestOwner,
  holdTurn,
  makeEventSecretHider,
  markDeclined,
  normalizeUnhandled,
  normalizeUpdate,
  openTurn,
  releaseTurn,
  type NormalizerState,
  type RequestItem,
} from "./normalize";
import { buildPlanFilePaths } from "./harness-home";

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const HOME = "/tmp/agy-spike/acctC";

const KNOWN_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "current_mode_update",
  "config_option_update",
]);

/** Builds the notification the connection hands over for the `params` of a `session/update`. */
const buildNotification = (params: {
  sessionId: string;
  update: { sessionUpdate: string };
}): SessionUpdateNotification => ({
  nativeSessionId: params.sessionId,
  update: KNOWN_UPDATES.has(params.update.sessionUpdate)
    ? (params.update as unknown as SessionUpdate)
    : { sessionUpdate: "other", name: params.update.sessionUpdate },
  raw: params,
});

interface Played {
  readonly state: NormalizerState;
  readonly events: HarnessEvent[];
  readonly requests: Array<RequestItem | undefined>;
}

/**
 * Plays a recording through the normalizer as the adapter will. The first
 * prompt opens the turn, and the reply to it ends it: `cancelled` is
 * `interrupted`, anything else `completed`. A deny answer marks the call
 * declined.
 */
const playRecording = (name: RecordingName): Played => {
  const messages = readRecording(name);
  const nativeSessionId = messages
    .map((entry) => (entry.message.result as { sessionId?: string } | undefined)?.sessionId)
    .find((id) => id !== undefined)!;
  const state = buildNormalizerState({
    sessionId: SESSION,
    nativeSessionId,
    planFilePaths: buildPlanFilePaths(HOME, nativeSessionId),
  });
  const events: HarnessEvent[] = [];
  const requests: Array<RequestItem | undefined> = [];
  const callOfRequest = new Map<string | number, string>();
  let opened = false;
  for (const { direction, message } of messages) {
    const params = message.params as never as {
      sessionId: string;
      update: { sessionUpdate: string };
      toolCall?: ToolCall;
    };
    if (direction === "out" && message.method === "session/prompt" && !opened) {
      opened = true;
      holdTurn(state);
      events.push(...openTurn(state, "turn-1"));
    } else if (direction === "in" && message.method === "session/update") {
      events.push(...normalizeUpdate(state, buildNotification(params)));
    } else if (direction === "in" && message.method === "session/request_permission") {
      callOfRequest.set(message.id!, params.toolCall!.toolCallId);
      requests.push(describeRequestItem(state, params.toolCall!.toolCallId, params.toolCall!));
    } else if (direction === "out" && message.id !== undefined && "result" in message) {
      const answer = (message.result as { outcome?: { optionId?: string } }).outcome;
      const callId = callOfRequest.get(message.id);
      if (callId !== undefined && answer?.optionId === "deny") markDeclined(state, callId);
    } else if (
      direction === "in" &&
      message.result !== undefined &&
      "stopReason" in (message.result as object)
    ) {
      const reply = message.result as { stopReason: string; usage?: never };
      events.push(
        ...addPromptUsage(state, reply.usage),
        ...closeTurn(state, {
          state: reply.stopReason === "cancelled" ? "interrupted" : "completed",
        }),
      );
    }
  }
  return { state, events, requests };
};

type Tagged<Tag extends HarnessEvent["_tag"]> = Extract<HarnessEvent, { _tag: Tag }>;

const only = <Tag extends HarnessEvent["_tag"]>(events: HarnessEvent[], tag: Tag): Tagged<Tag>[] =>
  events.filter((event): event is Tagged<Tag> => event._tag === tag);

const itemsOf = (events: HarnessEvent[], kind: string) =>
  only(events, "item.completed").filter((event) => event.kind === kind);

/** Returns the tags of the events in order, with the item kind for item events. */
const outline = (events: HarnessEvent[]): string[] =>
  events.map((event) => ("kind" in event ? `${event._tag} ${event.kind}` : event._tag));

const buildToolStart = (call: ToolCall): SessionUpdateNotification => ({
  nativeSessionId: "n",
  update: { sessionUpdate: "tool_call", ...call },
  raw: { start: call.toolCallId },
});

const buildToolUpdate = (call: ToolCall): SessionUpdateNotification => ({
  nativeSessionId: "n",
  update: { sessionUpdate: "tool_call_update", ...call },
  raw: { update: call.toolCallId },
});

const buildChunk = (
  text: string,
  kind: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk",
): SessionUpdateNotification => ({
  nativeSessionId: "n",
  update: { sessionUpdate: kind, content: { type: "text", text } },
  raw: { chunk: text },
});

const buildOther = (name: string): SessionUpdateNotification => ({
  nativeSessionId: "n",
  update: { sessionUpdate: "other", name },
  raw: { other: name },
});

const freshState = () =>
  buildNormalizerState({
    sessionId: SESSION,
    nativeSessionId: "native-1",
    planFilePaths: buildPlanFilePaths("/b", "native-1"),
  });

const runCall = (id: string, command = "ls") => ({
  toolCallId: id,
  name: "run_command",
  kind: "execute",
  rawInput: { CommandLine: command },
});

describe("the edit-shell recording", () => {
  const { events, requests } = playRecording("edit-shell");

  it("is one turn that starts first and completes last, with the turn's usage", () => {
    expect(events[0]).toMatchObject({ _tag: "turn.started", turnId: "turn-1" });
    expect(events.at(-1)).toMatchObject({
      _tag: "turn.completed",
      state: "completed",
      usage: { inputTokens: 21453, outputTokens: 935, cacheReadTokens: 40912, cacheWriteTokens: 0 },
    });
    expect(only(events, "turn.started")).toHaveLength(1);
  });

  it("reports the process's usage in the complete form, never adding thought tokens", () => {
    expect(only(events, "session.usage.updated")).toMatchObject([
      {
        usage: {
          inputTokens: 21453,
          outputTokens: 935,
          cacheReadTokens: 40912,
          cacheWriteTokens: 0,
        },
      },
    ]);
  });

  it("starts and completes each tool item once, with the raw message and the call id", () => {
    const started = only(events, "item.started");
    const completed = only(events, "item.completed");
    expect(started.filter((e) => e.kind !== "assistant_message")).toHaveLength(5);
    for (const item of started) {
      expect(completed.filter((c) => c.itemId === item.itemId)).toHaveLength(1);
    }
    expect(started[0]).toMatchObject({
      kind: "file_read",
      itemId: "call_986309674396058287",
      detail: { path: "/tmp/agy-spike/rec/w-edit-shell/notes.txt" },
      harnessRefs: { toolCallId: "call_986309674396058287" },
      raw: { source: "antigravity.acp.message" },
    });
    expect(started[0]!.harnessRefs?.["nativeSessionId"]).toBe(
      "54f853ac-6b2b-4622-bca4-16ec1cca394c",
    );
  });

  it("shows an edit and a write by their rawInput path", () => {
    expect(itemsOf(events, "file_change").map((e) => [e.status, e.detail])).toEqual([
      ["completed", { path: "/tmp/agy-spike/rec/w-edit-shell/notes.txt" }],
      ["completed", { path: "/tmp/agy-spike/rec/w-edit-shell/hello.txt" }],
    ]);
  });

  it("shows a command with its output behind no header, and its exit code", () => {
    const [ls] = itemsOf(events, "command_execution");
    expect(ls).toMatchObject({
      status: "completed",
      detail: {
        command: "ls -la && cat hello.txt",
        description: "List directory and print hello.txt",
        exitCode: 0,
      },
    });
    const content = (ls!.detail as { content: string }).content;
    expect(content.startsWith("total 24\ndrwxr-xr-x@")).toBe(true);
    expect(content.endsWith("\nhi")).toBe(true);
    expect(content).not.toContain("Created At");
    expect(content).not.toContain("\r");
  });

  it("builds the approval Request of each held call from its item", () => {
    expect(requests.map((r) => r?.description.kind)).toEqual([
      "file_change_approval",
      "file_change_approval",
      "command_approval",
      "command_approval",
    ]);
    expect(requests[2]).toMatchObject({
      turnId: "turn-1",
      itemId: "call_3065961999687177868",
      description: { detail: { command: "ls -la && cat hello.txt" } },
    });
  });

  it("joins the chunks of the closing message into one item", () => {
    const messages = itemsOf(events, "assistant_message");
    expect(messages).toHaveLength(1);
    const deltas = only(events, "content.delta").filter((d) => d.itemId === messages[0]!.itemId);
    expect(deltas.every((d) => d.streamKind === "assistant_text")).toBe(true);
    expect(deltas.map((d) => d.delta).join("")).toMatch(
      /^I read \[notes\.txt\].*notes\.txt#L3\)\.$/,
    );
  });
});

describe("the cancel recording", () => {
  const { events } = playRecording("cancel");
  const turnEnd = events.findIndex((e) => e._tag === "turn.completed");

  it("ends the turn interrupted, with usage", () => {
    expect(events[turnEnd]).toMatchObject({ state: "interrupted", usage: { outputTokens: 532 } });
  });

  it("does not complete the command on the short status note that comes before the reply", () => {
    const completed = itemsOf(events, "command_execution");
    expect(completed).toHaveLength(1);
    expect(events.indexOf(completed[0]!)).toBeGreaterThan(turnEnd);
  });

  it("fails the command at the late update, in the turn it started in", () => {
    expect(itemsOf(events, "command_execution")[0]).toMatchObject({
      status: "failed",
      turnId: "turn-1",
      detail: { command: "sleep 90 && echo done" },
    });
    expect(only(events, "turn.started")).toHaveLength(1);
  });

  it("completes the two message chunks as one item before the turn ends", () => {
    const message = itemsOf(events, "assistant_message");
    expect(message).toHaveLength(1);
    expect(events.indexOf(message[0]!)).toBeLessThan(turnEnd);
  });
});

describe("the subagent recording", () => {
  const { events } = playRecording("subagent");

  it("shows the invoke_subagent call as a subagent item with its role and no ids", () => {
    expect(itemsOf(events, "subagent")).toMatchObject([
      {
        status: "completed",
        detail: { description: expect.stringContaining("Notes") as unknown, subagentIds: [] },
      },
    ]);
  });

  it("keeps two messages that a usage_update splits as two items", () => {
    expect(itemsOf(events, "assistant_message")).toHaveLength(2);
  });

  it("reports usage in the incomplete form because a subagent ran", () => {
    expect(only(events, "session.usage.updated")).toMatchObject([
      { usageReport: { status: "incomplete", counts: { inputTokens: 15385, outputTokens: 783 } } },
    ]);
  });
});

describe("the todo recording", () => {
  const { events } = playRecording("todo");
  const lists = only(events, "item.started")
    .concat(only(events, "item.updated") as never)
    .filter((e) => e.kind === "todo_list");

  it("shows one todo_list item that starts, updates with the whole list, and completes before the turn", () => {
    expect(outline(events).filter((line) => line.includes("todo_list"))).toEqual([
      "item.started todo_list",
      "item.updated todo_list",
      "item.updated todo_list",
      "item.completed todo_list",
    ]);
    expect(lists).toHaveLength(3);
    const [started, first, second] = events.filter(
      (e) => "kind" in e && e.kind === "todo_list" && e._tag !== "item.completed",
    );
    expect(started).toMatchObject({
      detail: {
        steps: [
          { text: "read package.json", status: "pending" },
          { text: "read notes.txt", status: "pending" },
          { text: "summarise", status: "pending" },
        ],
      },
    });
    expect(first).toMatchObject({
      detail: {
        steps: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }],
      },
    });
    expect(second).toMatchObject({
      detail: {
        steps: [{ status: "completed" }, { status: "completed" }, { status: "completed" }],
      },
    });
    const names = outline(events);
    expect(names.at(-2)).toBe("item.completed todo_list");
    expect(names.at(-1)).toBe("turn.completed");
  });

  it("keeps each task.md write as a file_change item too", () => {
    expect(itemsOf(events, "file_change")).toHaveLength(3);
  });
});

describe("the plan-mode recording", () => {
  it("shows implementation_plan.md as a plan item holding the file's text, beside its file_change", () => {
    const { events } = playRecording("plan-mode");
    const [plan] = itemsOf(events, "plan");
    expect((plan!.detail as { content: string }).content).toMatch(/^# Add LICENSE/);
    expect(itemsOf(events, "file_change")).toHaveLength(1);
    expect(outline(events).filter((line) => line.includes("todo_list"))).toEqual([]);
  });
});

describe("the websearch recording", () => {
  const { events } = playRecording("websearch");

  it("shows search_web as a web_search item with its query", () => {
    expect(itemsOf(events, "web_search")).toMatchObject([
      { detail: { query: "Bun JavaScript runtime latest stable release version" } },
    ]);
  });
});

describe("a text item whose first chunk holds the start of the token", () => {
  it("carries none of the chunk in its start event", () => {
    const secret = "sess-tok-7f3a91c2e8";
    const hide = makeEventSecretHider(secret);
    const state = freshState();
    openTurn(state, "t");
    const events = [
      ...normalizeUpdate(state, buildChunk(`Bearer ${secret.slice(0, -1)}`)),
      ...normalizeUpdate(state, buildChunk(secret.slice(-1))),
    ].flatMap((event) => hide([event]));
    expect(JSON.stringify(events)).not.toContain(secret.slice(0, 8));
  });
});

describe("a web search with a domain", () => {
  it("shows the domain beside the query", () => {
    const state = freshState();
    openTurn(state, "t");
    const events = normalizeUpdate(
      state,
      buildToolStart({
        toolCallId: "s1",
        name: "search_web",
        rawInput: { query: "bun", domain: "bun.sh" },
      }),
    );
    expect(events).toMatchObject([{ kind: "web_search", detail: { query: "bun site:bun.sh" } }]);
  });
});

describe("the deny2 recording", () => {
  it("shows a call that the adapter denied as declined, not failed", () => {
    const { events } = playRecording("deny2");
    expect(itemsOf(events, "command_execution")).toMatchObject([{ status: "declined" }]);
  });

  it("shows the same failed update as failed when nothing marked the call declined", () => {
    const state = freshState();
    holdTurn(state);
    openTurn(state, "t");
    normalizeUpdate(state, buildToolStart(runCall("c1")));
    const events = normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status: "failed" }));
    expect(events).toMatchObject([{ _tag: "item.completed", status: "failed" }]);
  });
});

describe("a call the pre-tool hook denied", () => {
  // The updates of recordings/rec12/c4-default.jsonl (lines 19 and 28), with
  // the reason Hercule's hook gives where the recording has an empty one.
  const buildDeniedUpdate = (call: ToolCall, reason: string): SessionUpdateNotification =>
    buildToolUpdate({
      ...call,
      status: "failed",
      rawOutput: reason,
      content: [{ type: "content", content: { type: "text", text: reason } }],
    });
  const WRITE = {
    toolCallId: "call_4241516389100288659",
    name: "write_file",
    kind: "edit",
    title: "File hello.txt",
    locations: [{ path: "/w/hello.txt" }],
    rawInput: { Content: "hi", Path: "/w/hello.txt" },
  };
  const RUN = {
    toolCallId: "call_980776587974295514",
    name: "run_command",
    kind: "execute",
    title: "echo hi",
    rawInput: { CommandLine: "echo hi", WaitMsBeforeAsync: 5000, toolSummary: "Echo hi" },
  };
  const REASON = "tool call denied by pre-tool hook: Web search is off in Approval required.";
  const complete = (call: ToolCall, reason = REASON) => {
    const state = freshState();
    openTurn(state, "t");
    normalizeUpdate(state, buildToolStart(call));
    return normalizeUpdate(state, buildDeniedUpdate(call, reason));
  };

  it("shows the reason in the detail of a failed file_change", () => {
    expect(complete(WRITE)).toMatchObject([
      {
        _tag: "item.completed",
        kind: "file_change",
        status: "failed",
        detail: { content: REASON },
      },
    ]);
  });

  it("shows the reason in the detail of a failed command_execution", () => {
    expect(complete(RUN)).toMatchObject([
      {
        _tag: "item.completed",
        kind: "command_execution",
        status: "failed",
        detail: { command: "echo hi", content: REASON },
      },
    ]);
  });

  it("hides the session token when it is in the reason", () => {
    const secret = "sess-tok-7f3a91c2e8";
    const hide = makeEventSecretHider(secret);
    const events = hide(complete(WRITE, `tool call denied by pre-tool hook: ${secret}`));
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe("tool items", () => {
  const openState = () => {
    const state = freshState();
    openTurn(state, "t1");
    return state;
  };

  it("never starts an item twice or reopens one that ended", () => {
    const state = openState();
    normalizeUpdate(state, buildToolStart(runCall("c1")));
    expect(normalizeUpdate(state, buildToolStart(runCall("c1")))).toEqual([]);
    expect(
      normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status: "completed" })),
    ).toHaveLength(1);
    expect(
      normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status: "in_progress" })),
    ).toEqual([]);
    expect(normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status: "failed" }))).toEqual(
      [],
    );
  });

  it("ignores a late update of an ended call without closing the open message", () => {
    const state = openState();
    normalizeUpdate(state, buildToolStart(runCall("c1")));
    normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status: "completed" }));
    normalizeUpdate(state, buildChunk("Hello "));
    expect(
      normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status: "completed" })),
    ).toEqual([]);
    const events = normalizeUpdate(state, buildChunk("world"));
    expect(outline(events)).toEqual(["content.delta"]);
  });

  it("does not split the open message for a late update of a call of an earlier turn", () => {
    const state = freshState();
    openTurn(state, "t1");
    normalizeUpdate(state, buildToolStart(runCall("old")));
    closeTurn(state, { state: "completed" });
    openTurn(state, "t2");
    const events = [
      ...normalizeUpdate(state, buildChunk("Hel")),
      ...normalizeUpdate(state, buildToolUpdate({ ...runCall("old"), status: "completed" })),
      ...normalizeUpdate(state, buildChunk("lo")),
      ...closeTurn(state, { state: "completed" }),
    ];
    const messages = only(events, "item.completed").filter(
      (event) => event.kind === "assistant_message",
    );
    expect(messages).toHaveLength(1);
    expect(
      only(events, "content.delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe("Hello");
    expect(
      only(events, "item.completed").find((event) => event.kind === "command_execution"),
    ).toMatchObject({
      turnId: "t1",
      status: "completed",
    });
  });

  it("records no decline for a call that is unknown or ended", () => {
    const state = openState();
    markDeclined(state, "never-seen");
    normalizeUpdate(state, buildToolStart(runCall("c1")));
    normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status: "completed" }));
    markDeclined(state, "c1");
    expect(state.declined.size).toBe(0);
  });

  it("ignores every later update of a call that ended, whatever it carries", () => {
    const state = openState();
    normalizeUpdate(state, buildToolStart(runCall("c1")));
    normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status: "completed" }));
    closeTurn(state, { state: "completed" });
    for (const status of ["in_progress", "pending", "completed", "failed"]) {
      expect(normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status }))).toEqual([]);
    }
    expect(normalizeUpdate(state, buildToolStart(runCall("c1")))).toEqual([]);
  });

  it("does not end an item on pending or in_progress", () => {
    const state = openState();
    normalizeUpdate(state, buildToolStart(runCall("c1")));
    for (const status of ["pending", "in_progress"]) {
      expect(normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status }))).toEqual([]);
    }
  });

  it("keeps a field that an update leaves out", () => {
    const state = openState();
    normalizeUpdate(state, buildToolStart(runCall("c1", "make test")));
    const events = normalizeUpdate(
      state,
      buildToolUpdate({
        toolCallId: "c1",
        status: "completed",
        rawInput: { toolSummary: "Run tests" },
        rawOutput: { output: "ok", exit_code: 0 },
      }),
    );
    expect(events[0]).toMatchObject({
      detail: { description: "Run tests", content: "ok", exitCode: 0 },
    });
  });

  it("completes an item of an ended turn in that turn, and opens no turn for it", () => {
    const state = openState();
    normalizeUpdate(state, buildToolStart(runCall("c1")));
    closeTurn(state, { state: "interrupted" });
    const events = normalizeUpdate(state, buildToolUpdate({ ...runCall("c1"), status: "failed" }));
    expect(events).toMatchObject([{ _tag: "item.completed", turnId: "t1", status: "failed" }]);
  });

  it("describes the Request of a running call, and not of an unknown or ended one or one of an ended turn", () => {
    const state = openState();
    normalizeUpdate(state, buildToolStart(runCall("c1", "ls")));
    const snapshot = { toolCallId: "c1", rawInput: { CommandLine: "ls -la" }, title: "x" };
    expect(describeRequestItem(state, "c1", snapshot)).toMatchObject({
      turnId: "t1",
      itemId: "c1",
      description: { kind: "command_approval", detail: { command: "ls -la" } },
    });
    expect(describeRequestItem(state, "c1", { toolCallId: "c1" })).toMatchObject({
      description: { detail: { command: "ls" } },
    });
    expect(describeRequestItem(state, "nope", { toolCallId: "nope" })).toBeUndefined();
    closeTurn(state, { state: "completed" });
    expect(describeRequestItem(state, "c1", { toolCallId: "c1" })).toBeUndefined();
  });

  it("finds the owner of a Request without describing the call", () => {
    const state = openState();
    normalizeUpdate(state, buildToolStart(runCall("c1", "ls")));
    expect(findRequestOwner(state, "c1")).toEqual({ turnId: "t1", itemId: "c1" });
    expect(findRequestOwner(state, "nope")).toBeUndefined();
    closeTurn(state, { state: "completed" });
    expect(findRequestOwner(state, "c1")).toBeUndefined();
  });

  it("closes the turn in flight only when it has the expected id", () => {
    const state = openState();
    expect(closeTurn(state, { state: "interrupted", turnId: "older" })).toEqual([]);
    expect(closeTurn(state, { state: "interrupted", turnId: "t1" })).toMatchObject([
      { _tag: "turn.completed", turnId: "t1" },
    ]);
  });

  it("starts an item for an update of a call it never saw, only when the update is whole", () => {
    const state = openState();
    expect(normalizeUpdate(state, buildToolUpdate({ toolCallId: "x", status: "failed" }))).toEqual(
      [],
    );
    const events = normalizeUpdate(
      state,
      buildToolUpdate({ ...runCall("y"), status: "completed" }),
    );
    expect(outline(events)).toEqual([
      "item.started command_execution",
      "item.completed command_execution",
    ]);
  });
});

describe("text items", () => {
  it("starts at the first chunk, streams deltas, and completes at the next other update", () => {
    const state = freshState();
    openTurn(state, "t");
    const first = normalizeUpdate(state, buildChunk("Hel"));
    expect(outline(first)).toEqual(["item.started assistant_message", "content.delta"]);
    expect(normalizeUpdate(state, buildChunk("lo"))).toMatchObject([
      { _tag: "content.delta", delta: "lo" },
    ]);
    expect(outline(normalizeUpdate(state, buildToolStart(runCall("c"))))).toEqual([
      "item.completed assistant_message",
      "item.started command_execution",
    ]);
  });

  it("switches between a message and a reasoning item", () => {
    const state = freshState();
    openTurn(state, "t");
    normalizeUpdate(state, buildChunk("thinking", "agent_thought_chunk"));
    const events = normalizeUpdate(state, buildChunk("answer"));
    expect(outline(events)).toEqual([
      "item.completed reasoning",
      "item.started assistant_message",
      "content.delta",
    ]);
  });

  it("closes at usage_update, so two messages around it are two items", () => {
    const state = freshState();
    openTurn(state, "t");
    normalizeUpdate(state, buildChunk("one"));
    expect(outline(normalizeUpdate(state, buildOther("usage_update")))).toEqual([
      "item.completed assistant_message",
    ]);
    expect(outline(normalizeUpdate(state, buildChunk("two")))[0]).toBe(
      "item.started assistant_message",
    );
  });

  it("is not split by the updates that are dropped", () => {
    const state = freshState();
    openTurn(state, "t");
    normalizeUpdate(state, buildChunk("one"));
    for (const name of ["available_commands_update", "session_info_update", "user_message_chunk"]) {
      expect(normalizeUpdate(state, buildOther(name))).toEqual([]);
    }
    expect(normalizeUpdate(state, buildChunk("two"))).toMatchObject([{ _tag: "content.delta" }]);
  });

  it("completes with the turn", () => {
    const state = freshState();
    openTurn(state, "t");
    normalizeUpdate(state, buildChunk("one"));
    expect(outline(closeTurn(state, { state: "failed", error: "boom" }))).toEqual([
      "item.completed assistant_message",
      "turn.completed",
    ]);
  });
});

describe("synthetic turns", () => {
  it("opens one for a text chunk with no turn, and closes it at the usage_update", () => {
    const state = freshState();
    const opened = normalizeUpdate(state, buildChunk("hello"));
    expect(outline(opened)).toEqual([
      "turn.started",
      "session.usage.updated",
      "item.started assistant_message",
      "content.delta",
    ]);
    const closed = normalizeUpdate(state, buildOther("usage_update"));
    expect(outline(closed)).toEqual(["item.completed assistant_message", "turn.completed"]);
    expect(closed[1]).toMatchObject({
      state: "completed",
      turnId: (opened[0] as { turnId: string }).turnId,
    });
  });

  it("opens one for a tool call, and closes it right after the call completes", () => {
    const state = freshState();
    expect(outline(normalizeUpdate(state, buildToolStart(runCall("c"))))).toEqual([
      "turn.started",
      "session.usage.updated",
      "item.started command_execution",
    ]);
    expect(
      outline(normalizeUpdate(state, buildToolUpdate({ ...runCall("c"), status: "completed" }))),
    ).toEqual(["item.completed command_execution", "turn.completed"]);
  });

  it("holds its turn open while a second call is still running", () => {
    const state = freshState();
    normalizeUpdate(state, buildToolStart(runCall("a")));
    normalizeUpdate(state, buildToolStart(runCall("b")));
    expect(
      outline(normalizeUpdate(state, buildToolUpdate({ ...runCall("a"), status: "completed" }))),
    ).toEqual(["item.completed command_execution"]);
  });

  it("marks usage incomplete", () => {
    const state = freshState();
    normalizeUpdate(state, buildChunk("x"));
    expect(
      addPromptUsage(state, { totalTokens: 3, inputTokens: 1, outputTokens: 2 }),
    ).toMatchObject([
      { usageReport: { status: "incomplete", counts: { inputTokens: 1, outputTokens: 2 } } },
    ]);
  });

  it("opens none while a turn is open", () => {
    const state = freshState();
    openTurn(state, "t");
    normalizeUpdate(state, buildToolStart(runCall("c")));
    expect(
      normalizeUpdate(state, buildToolUpdate({ ...runCall("c"), status: "completed" })),
    ).toHaveLength(1);
  });
});

describe("holding a turn", () => {
  const holdAndBuffer = () => {
    const state = freshState();
    holdTurn(state);
    expect(normalizeUpdate(state, buildChunk("early"))).toEqual([]);
    expect(normalizeUpdate(state, buildOther("usage_update"))).toEqual([]);
    expect(normalizeUpdate(state, buildChunk("later"))).toEqual([]);
    expect(normalizeUnhandled(state, { method: "x/y", reason: "r", raw: {} })).toEqual([]);
    return state;
  };

  it("replays the buffer into the turn that opens, keeping the usage_update split", () => {
    const state = holdAndBuffer();
    const events = openTurn(state, "t-user");
    expect(outline(events)).toEqual([
      "turn.started",
      "item.started assistant_message",
      "content.delta",
      "item.completed assistant_message",
      "item.started assistant_message",
      "content.delta",
      "item.completed assistant_message",
      "item.started unknown",
      "item.completed unknown",
    ]);
    expect(only(events, "item.started").every((e) => e.turnId === "t-user")).toBe(true);
  });

  it("replays the buffer as unsolicited output when the input is released", () => {
    const state = holdAndBuffer();
    const events = releaseTurn(state);
    const turns = only(events, "turn.started");
    expect(turns).toHaveLength(2);
    expect(only(events, "turn.completed")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ _tag: "turn.completed", state: "completed" });
  });

  it("opens no synthetic turn for output while held, and lets an update of a known call through", () => {
    const state = freshState();
    normalizeUpdate(state, buildToolStart(runCall("c")));
    closeTurn(state, { state: "completed" });
    holdTurn(state);
    expect(normalizeUpdate(state, buildToolStart(runCall("d")))).toEqual([]);
    expect(
      normalizeUpdate(state, buildToolUpdate({ ...runCall("c"), status: "completed" })),
    ).toMatchObject([{ _tag: "item.completed", itemId: "c" }]);
  });

  it("closes a synthetic turn that is still open when the input's turn opens", () => {
    const state = freshState();
    normalizeUpdate(state, buildToolStart(runCall("c")));
    holdTurn(state);
    expect(outline(openTurn(state, "t-user"))).toEqual(["turn.completed", "turn.started"]);
  });
});

describe("unknown items", () => {
  it("shows plan and an unknown update as unknown items labelled with the name", () => {
    const state = freshState();
    openTurn(state, "t");
    for (const name of ["plan", "brand_new_update"]) {
      expect(normalizeUpdate(state, buildOther(name))).toMatchObject([
        {
          _tag: "item.started",
          kind: "unknown",
          detail: { label: `antigravity: ${name}` },
          raw: { source: "antigravity.acp.message" },
        },
        { _tag: "item.completed", kind: "unknown", status: "completed" },
      ]);
    }
  });

  it("shows an unhandled message labelled with its method, escaping control characters", () => {
    const state = freshState();
    openTurn(state, "t");
    expect(
      normalizeUnhandled(state, { method: "fs/read\n‮", reason: "r", raw: { a: 1 } })[0],
    ).toMatchObject({
      detail: { label: "antigravity: fs/read\\u{a}\\u{202e}" },
    });
  });

  it("shows a chunk that holds no text as an unknown item", () => {
    const state = freshState();
    openTurn(state, "t");
    const image = {
      nativeSessionId: "n",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "image" } },
      raw: {},
    } as SessionUpdateNotification;
    expect(normalizeUpdate(state, image)[0]).toMatchObject({
      detail: { label: "antigravity: agent_message_chunk" },
    });
  });

  it("opens a synthetic turn that closes right after, when no turn is open", () => {
    const state = freshState();
    expect(outline(normalizeUpdate(state, buildOther("plan")))).toEqual([
      "turn.started",
      "session.usage.updated",
      "item.started unknown",
      "item.completed unknown",
      "turn.completed",
    ]);
  });

  it("drops the updates that need no item", () => {
    const state = freshState();
    openTurn(state, "t");
    for (const name of ["available_commands_update", "session_info_update", "user_message_chunk"]) {
      expect(normalizeUpdate(state, buildOther(name))).toEqual([]);
    }
    for (const update of [
      { sessionUpdate: "current_mode_update", currentModeId: "auto" },
      { sessionUpdate: "config_option_update", configOptions: [] },
    ] as const) {
      expect(normalizeUpdate(state, { nativeSessionId: "n", update, raw: {} })).toEqual([]);
    }
  });
});

describe("the files of the plan", () => {
  const writeFile = (path: string, text: string | undefined, id = "w1", status = "completed") =>
    buildToolUpdate({
      toolCallId: id,
      name: "write_file",
      kind: "edit",
      status,
      rawInput: { Path: path },
      ...(text === undefined ? {} : { content: [{ type: "diff", path, newText: text }] }),
    });

  const startWrite = (state: NormalizerState, path: string, id = "w1") =>
    normalizeUpdate(
      state,
      buildToolStart({ toolCallId: id, name: "write_file", rawInput: { Path: path } }),
    );

  const TASK = "/b/antigravity-acp/brain/native-1/task.md";

  const write = (
    state: NormalizerState,
    path: string,
    text: string | undefined,
    id = "w1",
    status = "completed",
  ) => {
    startWrite(state, path, id);
    return normalizeUpdate(state, writeFile(path, text, id, status));
  };

  const open = () => {
    const state = freshState();
    openTurn(state, "t");
    return state;
  };

  it("reads a task line of 80000 spaces in linear time", () => {
    const state = open();
    const line = `- [ ] x${" ".repeat(80_000)}x`;
    const started = performance.now();
    const events = write(state, TASK, `${line}\n`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(outline(events)).toEqual(["item.completed file_change", "item.started todo_list"]);
  });

  it("accepts the /private spelling of the plan files it was given", () => {
    const state = buildNormalizerState({
      sessionId: SESSION,
      nativeSessionId: "native-1",
      planFilePaths: buildPlanFilePaths("/tmp/b", "native-1", "darwin"),
    });
    openTurn(state, "t");
    expect(
      outline(write(state, "/private/tmp/b/antigravity-acp/brain/native-1/task.md", "- [ ] a\n")),
    ).toEqual(["item.completed file_change", "item.started todo_list"]);
  });

  it("ignores another session's folder, other file names, and a path that only looks alike", () => {
    const state = open();
    for (const path of [
      "/b/antigravity-acp/brain/other/task.md",
      "/b/antigravity-acp/brain/native-1/notes.md",
      "/b/antigravity-acp/brain/native-1/sub/task.md",
      "/b/antigravity-acp/brain/native-12/task.md",
      "/b/antigravity-acp/brain/native-1/task.md.bak",
    ]) {
      expect(outline(write(state, path, "- [ ] a\n", path))).toEqual([
        "item.completed file_change",
      ]);
    }
  });

  it("shows nothing for a write with no diff, a failed write, or a write of an ended turn", () => {
    const state = open();
    expect(outline(write(state, TASK, undefined, "a"))).toEqual(["item.completed file_change"]);
    expect(outline(write(state, TASK, "- [ ] a", "b", "failed"))).toEqual([
      "item.completed file_change",
    ]);
    startWrite(state, TASK, "late");
    closeTurn(state, { state: "completed" });
    expect(outline(normalizeUpdate(state, writeFile(TASK, "- [ ] a", "late")))).toEqual([
      "item.completed file_change",
    ]);
  });

  it("shows nothing for a list that did not change, and the whole list for one that did", () => {
    const state = open();
    write(state, TASK, "# T\n- [ ] a\n- [/] b\n", "w1");
    expect(outline(write(state, TASK, "# Other title\n- [ ] a\n- [/] b\n", "w2"))).toEqual([
      "item.completed file_change",
    ]);
    const changed = write(state, TASK, "- [x] a\n- [/] b\n  - [ ] c\n- [ ]\n", "w3");
    expect(changed[1]).toMatchObject({
      _tag: "item.updated",
      itemId: "t:todo",
      detail: {
        steps: [
          { text: "a", status: "completed" },
          { text: "b", status: "in_progress" },
          { text: "c", status: "pending" },
        ],
      },
    });
  });

  it("starts a new todo_list item in the next turn", () => {
    const state = open();
    write(state, TASK, "- [ ] a\n", "w1");
    closeTurn(state, { state: "completed" });
    openTurn(state, "t2");
    expect(write(state, TASK, "- [ ] a\n", "w2")[1]).toMatchObject({
      _tag: "item.started",
      itemId: "t2:todo",
    });
  });

  it("leaves the item and warns when the list is longer than the bound", () => {
    const state = open();
    write(state, TASK, "- [ ] a\n", "w1");
    const many = Array.from(
      { length: MAX_TODO_STEPS + 1 },
      (_, i) => `- [ ] step ${String(i)}`,
    ).join("\n");
    const events = write(state, TASK, many, "w2");
    expect(outline(events)).toEqual(["item.completed file_change", "runtime.warning"]);
    expect(events[1]).toMatchObject({
      turnId: "t",
      message: expect.stringContaining(String(MAX_TODO_STEPS + 1)) as unknown,
    });
    expect(outline(closeTurn(state, { state: "completed" }))).toEqual([
      "item.completed todo_list",
      "turn.completed",
    ]);
  });

  it("completes the item with the last list shown, also when the turn is interrupted", () => {
    const state = open();
    write(state, TASK, "- [x] a\n", "w1");
    expect(closeTurn(state, { state: "interrupted" })[0]).toMatchObject({
      kind: "todo_list",
      status: "completed",
      detail: { steps: [{ text: "a", status: "completed" }] },
    });
  });

  it("shows implementation_plan.md as a plan item", () => {
    const state = open();
    const events = write(
      state,
      "/b/antigravity-acp/brain/native-1/implementation_plan.md",
      "# Plan\nDo it",
    );
    expect(events.slice(1)).toMatchObject([
      { _tag: "item.started", kind: "plan" },
      {
        _tag: "item.completed",
        kind: "plan",
        status: "completed",
        detail: { content: "# Plan\nDo it" },
      },
    ]);
  });
});

describe("usage", () => {
  const reply = {
    totalTokens: 99,
    inputTokens: 10,
    outputTokens: 5,
    thoughtTokens: 4,
    cachedReadTokens: 7,
    cachedWriteTokens: 1,
  };

  it("adds the replies of the process, and gives the turn the sum of its own prompts", () => {
    const state = freshState();
    openTurn(state, "t1");
    addPromptUsage(state, reply);
    addPromptUsage(state, reply);
    expect(closeTurn(state, { state: "completed" }).at(-1)).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 14, cacheWriteTokens: 2 },
    });
    openTurn(state, "t2");
    addPromptUsage(state, reply);
    expect(closeTurn(state, { state: "completed" }).at(-1)).toMatchObject({
      usage: { inputTokens: 10 },
    });
    expect(
      addPromptUsage(state, { totalTokens: 0, inputTokens: 1, outputTokens: 0 }),
    ).toMatchObject([{ usage: { inputTokens: 31, outputTokens: 15 } }]);
  });

  it("reports the incomplete form once a reply had no usage, and keeps it so", () => {
    const state = freshState();
    expect(addPromptUsage(state, undefined)[0]).toMatchObject({
      usageReport: { status: "incomplete" },
    });
    expect(addPromptUsage(state, reply)[0]).toMatchObject({
      usageReport: { status: "incomplete", counts: { inputTokens: 10 } },
    });
  });

  it("reports the incomplete form once, when output comes with no prompt open", () => {
    const state = freshState();
    const first = normalizeUpdate(state, buildChunk("unasked"));
    expect(first.map((event) => event._tag)).toContain("session.usage.updated");
    const again = normalizeUpdate(state, buildToolStart(runCall("c1")));
    expect(again.map((event) => event._tag)).not.toContain("session.usage.updated");
  });

  it("leaves usage out of a turn whose prompts reported none", () => {
    const state = freshState();
    openTurn(state, "t");
    expect(closeTurn(state, { state: "completed" })[0]).not.toHaveProperty("usage");
  });
});

describe("buildProcessEndEvents", () => {
  it("fails every running item in its own turn, and closes a synthetic turn", () => {
    const state = freshState();
    openTurn(state, "t1");
    normalizeUpdate(state, buildToolStart(runCall("a")));
    closeTurn(state, { state: "interrupted" });
    normalizeUpdate(state, buildToolStart(runCall("b")));
    normalizeUpdate(state, buildChunk("partial"));
    const events = buildProcessEndEvents(state);
    const completed = only(events, "item.completed");
    expect(
      completed.map((e) => [e.itemId === "a" || e.itemId === "b" ? e.itemId : "text", e.turnId]),
    ).toEqual([
      ["text", expect.any(String)],
      ["a", "t1"],
      ["b", expect.any(String)],
    ]);
    expect(events.at(-1)?._tag).toBe("turn.completed");
    expect(completed.slice(1).map((e) => e.status)).toEqual(["failed", "failed"]);
  });

  it("leaves a turn of the user's open, and a failed late update of a closed call changes nothing", () => {
    const state = freshState();
    openTurn(state, "t1");
    normalizeUpdate(state, buildToolStart(runCall("a")));
    expect(outline(buildProcessEndEvents(state))).toEqual(["item.completed command_execution"]);
    expect(
      normalizeUpdate(state, buildToolUpdate({ ...runCall("a"), status: "completed" })),
    ).toEqual([]);
  });
});

describe("makeEventSecretHider", () => {
  const SECRET = "sess-tok-7f3a91c2e8";
  const fields = { sessionId: "s", turnId: "t1", itemId: "i1" } as never;
  const delta = (text: string, itemId = "i1"): HarnessEvent =>
    ({
      _tag: "content.delta",
      ...(fields as object),
      itemId,
      streamKind: "assistant_text",
      delta: text,
    }) as HarnessEvent;
  const closing = (tag: "item.completed" | "turn.completed" | "session.exited"): HarnessEvent =>
    ({ _tag: tag, ...(fields as object) }) as HarnessEvent;
  const joinEventText = (events: ReadonlyArray<HarnessEvent>): string =>
    events
      .map((event) => (event._tag === "content.delta" ? event.delta : `<${event._tag}>`))
      .join("");

  /** Fails when the text holds 8 consecutive characters of the token. */
  const expectNoRunOfEight = (text: string) => {
    for (let at = 0; at + 8 <= SECRET.length; at += 1) {
      expect(text).not.toContain(SECRET.slice(at, at + 8));
    }
  };

  it("leaves no 8 consecutive characters of the token at any split over 2 and 3 deltas of one stream", () => {
    const publish = (parts: ReadonlyArray<string>): string => {
      const hide = makeEventSecretHider(SECRET);
      const events = [
        ...parts.flatMap((part) => hide([delta(part)])),
        ...hide([closing("item.completed")]),
      ];
      return joinEventText(events);
    };
    for (let first = 1; first < SECRET.length; first += 1) {
      const two = publish([`before ${SECRET.slice(0, first)}`, `${SECRET.slice(first)} after`]);
      expect(two).toBe("before [hidden] after<item.completed>");
      for (let second = first + 1; second < SECRET.length; second += 1) {
        const three = publish([
          `before ${SECRET.slice(0, first)}`,
          SECRET.slice(first, second),
          `${SECRET.slice(second)} after`,
        ]);
        expectNoRunOfEight(three);
        expect(three).toBe("before [hidden] after<item.completed>");
      }
    }
  });

  it("hides the token split over every number of deltas", () => {
    const hide = makeEventSecretHider(SECRET);
    const events = [
      ...[...SECRET].flatMap((character) => hide([delta(character)])),
      ...hide([closing("item.completed")]),
    ];
    expect(joinEventText(events)).toBe("[hidden]<item.completed>");
  });

  it.each(["item.completed", "turn.completed", "session.exited"] as const)(
    "delivers text that ends in 1 to 7 characters of the token's start whole, and hides 8 or more, at %s",
    (tag) => {
      for (let length = 1; length < SECRET.length; length += 1) {
        const hide = makeEventSecretHider(SECRET);
        const events = [
          ...hide([delta(`The answer is ${SECRET.slice(0, length)}`)]),
          ...hide([closing(tag)]),
        ];
        const shown = length < 8 ? SECRET.slice(0, length) : "[hidden]";
        expect(joinEventText(events)).toBe(`The answer is ${shown}<${tag}>`);
      }
    },
  );

  it("treats every held stream's end the same way at the end of the turn", () => {
    const hide = makeEventSecretHider(SECRET);
    hide([delta(SECRET.slice(0, 3), "i1"), delta(SECRET.slice(0, 9), "i2")]);
    expect(joinEventText(hide([closing("turn.completed")]))).toBe(
      `${SECRET.slice(0, 3)}[hidden]<turn.completed>`,
    );
  });

  it("does not cover a token that another item interrupts: the end of it is published", () => {
    const hide = makeEventSecretHider(SECRET);
    const state = freshState();
    openTurn(state, "t");
    const events = [
      buildChunk(`text ${SECRET.slice(0, 10)}`),
      buildChunk("thinking", "agent_thought_chunk"),
      buildChunk(SECRET.slice(10)),
    ].flatMap((chunk) => normalizeUpdate(state, chunk).flatMap((event) => hide([event])));
    events.push(...hide(buildProcessEndEvents(state)));
    const text = JSON.stringify(events);
    // The held start was 10 characters, so it is hidden; the rest follows as it is.
    expect(text).not.toContain(SECRET.slice(0, 8));
    expect(text).toContain(SECRET.slice(10));
  });

  it("keeps the held start of one item when another item closes", () => {
    const hide = makeEventSecretHider(SECRET);
    hide([delta(SECRET.slice(0, 3), "i1")]);
    expect(
      joinEventText(hide([{ ...closing("item.completed"), itemId: "i2" } as HarnessEvent])),
    ).toBe("<item.completed>");
  });

  it("leaves ids and other events as they are", () => {
    const hide = makeEventSecretHider(SECRET);
    const event = closing("turn.completed");
    expect(hide([event])).toEqual([event]);
  });
});
