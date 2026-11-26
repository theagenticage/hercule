/**
 * Tests the normalizer of `agy`'s subagents. The main tests read the recorded
 * session files of `agy` 1.5.15 (fixtures/session-files) with the real reader
 * and feed what it returns to the normalizer. The focused tests feed
 * hand-written steps for the cases the recordings do not hold. The tests do
 * not check event ids or timestamps.
 */
import { cpSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "@hercule/protocol";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { cleanupHomes, createScratchHome } from "../testing";
import { APP_DATA_DIR } from "./harness-home";
import { openSessionFiles, type AgyStep } from "./session-files";
import {
  buildSubagentsState,
  findSubagentLaunchItem,
  hasOpenSubagentTurn,
  interruptSubagentTurns,
  introduceSubagent,
  normalizeSubagentStep,
  readSubagentUsage,
  type SubagentsState,
} from "./subagents";

afterEach(() => {
  cleanupHomes();
});

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const FIXTURES = join(import.meta.dirname, "fixtures", "session-files");
const FULL_ROOT = "86a5c11a-cc0d-4231-b6a7-4df5e51875e0";
const FULL_CHILD = "e4553827-0073-42e6-bc63-8e9619a7d435";
const STUCK_ROOT = "d88dcaa6-637b-40a5-9346-6c0d3ffd1603";
const STUCK_CHILD = "53814e0e-a5c1-4d5a-8a7f-a9c4c143df6e";

/** Reads a recorded scenario with the real reader and normalizes every subagent observation. */
const playFixture = async (
  scenario: string,
  root: string,
): Promise<{ state: SubagentsState; events: HarnessEvent[] }> => {
  const home = createScratchHome("subagents");
  cpSync(join(FIXTURES, scenario, "brain"), join(home, APP_DATA_DIR, "brain"), {
    recursive: true,
  });
  const files = await Effect.runPromise(
    openSessionFiles({ home, conversationId: root, skipExisting: false }),
  );
  const observations = await Effect.runPromise(files.read);
  const state = buildSubagentsState({ sessionId: SESSION, nativeSessionId: root, known: [] });
  const events: HarnessEvent[] = [];
  for (const observation of observations) {
    if (observation.kind === "subagent") {
      events.push(...introduceSubagent(state, observation.link, undefined));
    }
    if (observation.kind === "step" && observation.conversationId !== root) {
      events.push(...normalizeSubagentStep(state, observation.conversationId, observation.step));
    }
  }
  return { state, events };
};

const step = (index: number, type: string, extra: Partial<AgyStep> = {}): AgyStep => ({
  index,
  type,
  status: "DONE",
  toolCalls: [],
  ...extra,
});

const command = () => ({ name: "run_command", args: { CommandLine: "ls", toolSummary: "List" } });

const message = (sender: string, content: string): AgyStep =>
  step(0, "SYSTEM_MESSAGE", {
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T21:05:31Z sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${content}\n</SYSTEM_MESSAGE>`,
  });

const tags = (events: ReadonlyArray<HarnessEvent>) => events.map((event) => event._tag);
const find = <T extends HarnessEvent["_tag"]>(events: ReadonlyArray<HarnessEvent>, tag: T) =>
  events.filter((event): event is Extract<HarnessEvent, { _tag: T }> => event._tag === tag);
const userMessages = (events: ReadonlyArray<HarnessEvent>) =>
  find(events, "item.started")
    .filter((event) => event.kind === "user_message")
    .map((event) => event.detail);

/** A state with one subagent `A` of the session's own agent, introduced. */
const buildStateWithChild = () => {
  const state = buildSubagentsState({ sessionId: SESSION, nativeSessionId: "root", known: [] });
  introduceSubagent(
    state,
    { conversationId: "A", parentConversationId: "root", brief: "Do it" },
    undefined,
  );
  return state;
};

describe("a recorded child that finishes", () => {
  it("shows the brief, the command with its output, the report and exact usage", async () => {
    const { state, events } = await playFixture("subagent-full", FULL_ROOT);

    const started = find(events, "subagent.started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      subagentId: FULL_CHILD,
      description: "File Writer",
      agentType: "self",
    });
    expect(started[0]).not.toHaveProperty("parentSubagentId");

    expect(tags(events)).toEqual([
      "subagent.started",
      "turn.started",
      "item.started", // user_message
      "item.completed",
      "item.started", // run_command
      "session.usage.updated",
      "item.completed",
      "item.started", // send_message
      "session.usage.updated",
      "item.completed",
      "item.started", // reply
      "content.delta",
      "item.completed",
      "session.usage.updated",
      "turn.completed",
    ]);
    expect(
      events.slice(1).every((event) => "subagentId" in event && event.subagentId === FULL_CHILD),
    ).toBe(true);
    expect(find(events, "turn.started")[0]).toMatchObject({ model: "gemini-4-neon-high" });
    expect(userMessages(events)).toEqual([
      {
        text: "Run the shell command `echo SUBMARK > sub.txt` in the workspace `/var/tmp/hercule-1283-work/subagent-full`, and then report back to me once it has completed.",
      },
    ]);

    const completed = find(events, "item.completed");
    expect(completed.find((e) => e.kind === "command_execution")).toMatchObject({
      status: "completed",
      detail: { content: "SUBMARK\n", exitCode: 0 },
    });
    expect(completed.some((e) => e.kind === "tool_call")).toBe(true);
    expect(find(events, "content.delta")[0]?.delta).toBe(
      "Done. Reported completion to the parent agent.",
    );

    const expected = {
      inputTokens: 2069 + 2302 + 2430,
      cacheReadTokens: 6964 + 6976 + 7229,
      outputTokens: 160 + 146 + 23,
      cacheWriteTokens: 0,
    };
    expect(find(events, "turn.completed")[0]).toMatchObject({
      state: "completed",
      usage: expected,
    });
    expect(find(events, "session.usage.updated").at(-1)).toMatchObject({ usage: expected });
    expect(readSubagentUsage(state)).toEqual(expected);
    expect(hasOpenSubagentTurn(state)).toBe(false);
  });
});

describe("a recorded child that is stuck", () => {
  it("keeps its turn open with the command running until the session interrupts it", async () => {
    const { state, events } = await playFixture("subagent-approval-watch", STUCK_ROOT);
    expect(find(events, "turn.completed")).toEqual([]);
    expect(find(events, "item.started").some((e) => e.kind === "command_execution")).toBe(true);
    expect(find(events, "item.completed").some((e) => e.kind === "command_execution")).toBe(false);
    expect(hasOpenSubagentTurn(state)).toBe(true);

    const interrupted = interruptSubagentTurns(state);
    expect(interrupted).toHaveLength(2);
    expect(interrupted[0]).toMatchObject({
      _tag: "item.completed",
      kind: "command_execution",
      status: "failed",
      subagentId: STUCK_CHILD,
    });
    expect(interrupted[0]).toMatchObject({
      itemId: find(events, "item.started").find((e) => e.kind === "command_execution")?.itemId,
    });
    expect(interrupted[1]).toMatchObject({
      _tag: "turn.completed",
      state: "interrupted",
      subagentId: STUCK_CHILD,
      usage: { inputTokens: 9107, outputTokens: 249, cacheReadTokens: 0 },
    });
    expect(hasOpenSubagentTurn(state)).toBe(false);
    expect(interruptSubagentTurns(state)).toEqual([]);
  });
});

describe("tool results", () => {
  it("fails a call whose result is an ERROR, with the error text", () => {
    const state = buildStateWithChild();
    normalizeSubagentStep(state, "A", step(1, "PLANNER_RESPONSE", { toolCalls: [command()] }));
    const events = normalizeSubagentStep(
      state,
      "A",
      step(2, "GENERIC", { status: "ERROR", error: "denied by hook" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      _tag: "item.completed",
      status: "failed",
      detail: { content: "denied by hook" },
    });
  });

  it("matches results to calls in call order and leaves a RUNNING call running", () => {
    const state = buildStateWithChild();
    const started = normalizeSubagentStep(
      state,
      "A",
      step(1, "PLANNER_RESPONSE", {
        toolCalls: [command(), { name: "read_file", args: { Path: "/a" } }],
      }),
    );
    const [first, second] = find(started, "item.started").filter((e) => e.kind !== "user_message");
    expect(normalizeSubagentStep(state, "A", step(2, "GENERIC", { status: "RUNNING" }))).toEqual(
      [],
    );
    const done = normalizeSubagentStep(state, "A", step(3, "GENERIC", { content: "x" }));
    expect(done[0]).toMatchObject({ itemId: second?.itemId, kind: "file_read" });
    expect(done[0]).not.toMatchObject({ itemId: first?.itemId });
    expect(normalizeSubagentStep(state, "A", step(4, "GENERIC"))).toEqual([]);
  });
});

describe("model errors", () => {
  it("warns once per turn in the provider's words and keeps the turn open", () => {
    const state = buildStateWithChild();
    normalizeSubagentStep(state, "A", step(1, "PLANNER_RESPONSE", { toolCalls: [command()] }));
    const first = normalizeSubagentStep(
      state,
      "A",
      step(2, "ERROR_MESSAGE", { error: "503 Service Unavailable" }),
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ _tag: "runtime.warning", subagentId: "A" });
    expect((first[0] as { message: string }).message).toContain("503 Service Unavailable");
    expect(normalizeSubagentStep(state, "A", step(3, "ERROR_MESSAGE", { error: "again" }))).toEqual(
      [],
    );
    expect(hasOpenSubagentTurn(state)).toBe(true);
  });
});

describe("messages to a subagent", () => {
  const finishTurn = (state: SubagentsState) => {
    normalizeSubagentStep(state, "A", message("root", "Do it"));
    normalizeSubagentStep(state, "A", step(1, "PLANNER_RESPONSE", { content: "done" }));
  };

  it("wakes the subagent with a second turn whose input is the parent's message", () => {
    const state = buildStateWithChild();
    finishTurn(state);
    expect(hasOpenSubagentTurn(state)).toBe(false);
    expect(normalizeSubagentStep(state, "A", message("root", "Now do more"))).toEqual([]);
    const events = normalizeSubagentStep(
      state,
      "A",
      step(3, "PLANNER_RESPONSE", { content: "ok" }),
    );
    expect(tags(events).slice(0, 2)).toEqual(["turn.started", "item.started"]);
    expect(userMessages(events)).toEqual([{ text: "Now do more" }]);
  });

  it("shows a message that arrives during a turn as a steered input", () => {
    const state = buildStateWithChild();
    normalizeSubagentStep(state, "A", step(1, "PLANNER_RESPONSE", { toolCalls: [command()] }));
    const events = normalizeSubagentStep(state, "A", message("root", "also this"));
    expect(userMessages(events)).toEqual([{ text: "also this", steered: true }]);
  });

  it("opens a turn without a user_message for a message from a task or from the system", () => {
    const state = buildStateWithChild();
    finishTurn(state);
    normalizeSubagentStep(state, "A", message("root/task-2", "finished"));
    normalizeSubagentStep(state, "A", message("system", "[Notice]"));
    const events = normalizeSubagentStep(
      state,
      "A",
      step(3, "PLANNER_RESPONSE", { content: "ok" }),
    );
    expect(tags(events)[0]).toBe("turn.started");
    expect(userMessages(events)).toEqual([]);
  });

  it("ignores a hook's reminder: it opens no turn and adds no input", () => {
    const state = buildStateWithChild();
    finishTurn(state);
    const reminder = step(5, "SYSTEM_MESSAGE", {
      content: "<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>",
    });
    expect(normalizeSubagentStep(state, "A", reminder)).toEqual([]);
    expect(hasOpenSubagentTurn(state)).toBe(false);
  });
});

describe("which subagent a step belongs to", () => {
  it("gives a grandchild the child as its parent, and finds the item that launched it", () => {
    const state = buildStateWithChild();
    const calls = normalizeSubagentStep(
      state,
      "A",
      step(1, "PLANNER_RESPONSE", {
        toolCalls: [{ name: "invoke_subagent", args: { Role: "Helper" } }],
      }),
    );
    normalizeSubagentStep(state, "A", step(2, "GENERIC"));
    normalizeSubagentStep(
      state,
      "A",
      step(3, "PLANNER_RESPONSE", { toolCalls: [{ name: "swarm", args: {} }] }),
    );
    normalizeSubagentStep(state, "A", step(4, "GENERIC"));
    expect(findSubagentLaunchItem(state, "A", 4)).toBeDefined();
    const itemId = findSubagentLaunchItem(state, "A", 2);
    expect(itemId).toBe(find(calls, "item.started").find((e) => e.kind === "subagent")?.itemId);
    expect(findSubagentLaunchItem(state, "A", 9)).toBeUndefined();

    const started = introduceSubagent(
      state,
      { conversationId: "B", parentConversationId: "A", role: "Helper" },
      itemId,
    );
    expect(started[0]).toMatchObject({
      _tag: "subagent.started",
      subagentId: "B",
      parentSubagentId: "A",
      itemId,
    });
  });

  it("introduces a resumed subagent once, keeps its parent, and shows no old brief", () => {
    const state = buildSubagentsState({
      sessionId: SESSION,
      nativeSessionId: "root",
      known: [{ subagentId: "A", parentSubagentId: "P" }],
    });
    const link = { conversationId: "A", parentConversationId: "root", brief: "old brief" };
    expect(introduceSubagent(state, link, undefined)[0]).toMatchObject({
      _tag: "subagent.started",
      subagentId: "A",
      parentSubagentId: "P",
    });
    expect(introduceSubagent(state, link, undefined)).toEqual([]);
    const events = normalizeSubagentStep(
      state,
      "A",
      step(9, "PLANNER_RESPONSE", { content: "hi" }),
    );
    expect(userMessages(events)).toEqual([]);
  });

  it("introduces a resumed subagent before its first event when it works unannounced", () => {
    const state = buildSubagentsState({
      sessionId: SESSION,
      nativeSessionId: "root",
      known: [{ subagentId: "A" }],
    });
    const events = normalizeSubagentStep(
      state,
      "A",
      step(9, "PLANNER_RESPONSE", { content: "hi" }),
    );
    expect(tags(events).slice(0, 2)).toEqual(["subagent.started", "turn.started"]);
  });

  it("gives a step of an unknown conversation to nobody", () => {
    const state = buildStateWithChild();
    const stray = step(1, "PLANNER_RESPONSE", {
      content: "hi",
      usage: { inputTokens: 5, cacheReadTokens: 0, outputTokens: 1 },
    });
    expect(normalizeSubagentStep(state, "unknown", stray)).toEqual([]);
    expect(hasOpenSubagentTurn(state)).toBe(false);
    expect(readSubagentUsage(state)).toMatchObject({ inputTokens: 0 });
  });
});
