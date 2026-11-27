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
import { APP_DATA_DIR, buildPlanFilePaths } from "./harness-home";
import { buildNormalizerState } from "./normalize";
import { openAgyFiles, type AgyStep } from "./agy-files";
import {
  buildSubagentsState,
  endUnreadableSubagent,
  endUnreadableSubagents,
  hasOpenSubagentTurn,
  interruptSubagentTurns,
  introduceSubagent,
  normalizeSubagentStep,
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
    openAgyFiles({ home, conversationId: root, skipExisting: false }),
  );
  const { observations } = await Effect.runPromise(files.read);
  const state = buildSubagents(root);
  const events: HarnessEvent[] = [];
  for (const observation of observations) {
    if (observation.kind === "subagent") {
      events.push(...introduceSubagent(state, observation.link, findNothing));
    }
    if (observation.kind === "step" && observation.conversationId !== root) {
      events.push(...normalizeSubagentStep(state, observation.conversationId, observation.step));
    }
  }
  return { state, events };
};

/** Returns the state of a session's subagents, over the normalizer of a session whose own conversation is `root`. */
const buildSubagents = (
  root: string,
  known: ReadonlyArray<{ readonly subagentId: string }> = [],
): SubagentsState =>
  buildSubagentsState({
    normalizer: buildNormalizerState({
      sessionId: SESSION,
      nativeSessionId: root,
      planFilePaths: buildPlanFilePaths("/tmp/agy-home", root),
    }),
    known,
  });

/** Stands in for the session's lookup of a launch item when the test has none. */
const findNothing = () => undefined;

const step = (index: number, type: string, extra: Partial<AgyStep> = {}): AgyStep => ({
  index,
  type,
  status: "DONE",
  toolCalls: [],
  ...extra,
});

const command = () => ({ name: "run_command", args: { CommandLine: "ls", toolSummary: "List" } });

/** The conversation id of the session's own agent, which is the sender of a message to a subagent. */
const PARENT = FULL_ROOT;

const message = (sender: string, content: string): AgyStep =>
  step(0, "SYSTEM_MESSAGE", {
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T21:05:31Z sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${content}\n</SYSTEM_MESSAGE>`,
  });

/** Checks whether the event is the snapshot of the session's own usage, which a subagent's step also moves, and not an event of a subagent. */
const isSessionSnapshot = (event: HarnessEvent): boolean =>
  event._tag === "session.usage.updated" && event.subagentId === undefined;
const sessionSnapshots = (events: ReadonlyArray<HarnessEvent>) =>
  find(events, "session.usage.updated").filter(isSessionSnapshot);

const tags = (events: ReadonlyArray<HarnessEvent>) => events.map((event) => event._tag);
const find = <T extends HarnessEvent["_tag"]>(events: ReadonlyArray<HarnessEvent>, tag: T) =>
  events.filter((event): event is Extract<HarnessEvent, { _tag: T }> => event._tag === tag);
const userMessages = (events: ReadonlyArray<HarnessEvent>) =>
  find(events, "item.started")
    .filter((event) => event.kind === "user_message")
    .map((event) => event.detail);

/** A state with one subagent `A` of the session's own agent, introduced. */
const buildStateWithChild = () => {
  const state = buildSubagents("root");
  introduceSubagent(
    state,
    {
      conversationId: "A",
      launchToolCallId: "call_0",
      brief: "Do it",
    },
    findNothing,
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
      "session.usage.updated", // the subagent's, then the session's snapshot
      "session.usage.updated",
      "item.completed",
      "item.started", // send_message
      "session.usage.updated",
      "session.usage.updated",
      "item.completed",
      "item.started", // reply
      "content.delta",
      "item.completed",
      "session.usage.updated",
      "session.usage.updated",
      "turn.completed",
    ]);
    // Every event but the session's own snapshots belongs to the subagent.
    expect(
      events
        .slice(1)
        .filter((event) => !isSessionSnapshot(event))
        .every((event) => "subagentId" in event && event.subagentId === FULL_CHILD),
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
    // The session's own snapshot, which has no prompt of its own here, holds the subagent's tokens and is complete.
    expect(sessionSnapshots(events).at(-1)).toMatchObject({ usage: expected });
    expect(sessionSnapshots(events).at(-1)).not.toHaveProperty("usageReport");
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
    normalizeSubagentStep(state, "A", message(PARENT, "Do it"));
    normalizeSubagentStep(state, "A", step(1, "PLANNER_RESPONSE", { content: "done" }));
  };

  it("wakes the subagent with a second turn whose input is the parent's message", () => {
    const state = buildStateWithChild();
    finishTurn(state);
    expect(hasOpenSubagentTurn(state)).toBe(false);
    expect(normalizeSubagentStep(state, "A", message(PARENT, "Now do more"))).toEqual([]);
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
    const events = normalizeSubagentStep(state, "A", message(PARENT, "also this"));
    expect(userMessages(events)).toEqual([{ text: "also this", steered: true }]);
  });

  it("ignores a message from a task or from the system: it opens no turn and adds no input", () => {
    const state = buildStateWithChild();
    finishTurn(state);
    expect(normalizeSubagentStep(state, "A", message(`${PARENT}/task-2`, "finished"))).toEqual([]);
    expect(normalizeSubagentStep(state, "A", message("system", "[Notice]"))).toEqual([]);
    expect(hasOpenSubagentTurn(state)).toBe(false);
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
  it("asks the session's lookup for the launching item of a child of the session's own agent", () => {
    const state = buildSubagents("root");
    const started = introduceSubagent(
      state,
      { conversationId: "A", launchToolCallId: "call_1" },
      (toolCallId) => (toolCallId === "call_1" ? "item-1" : undefined),
    );
    expect(started[0]).toMatchObject({ _tag: "subagent.started", itemId: "item-1" });
  });

  it("introduces a resumed subagent once, and shows no old brief", () => {
    const state = buildSubagents("root", [{ subagentId: "A" }]);
    const link = {
      conversationId: "A",
      launchToolCallId: "call_0",
      brief: "old brief",
    };
    expect(introduceSubagent(state, link, findNothing)[0]).toMatchObject({
      _tag: "subagent.started",
      subagentId: "A",
    });
    expect(introduceSubagent(state, link, findNothing)).toEqual([]);
    const events = normalizeSubagentStep(
      state,
      "A",
      step(9, "PLANNER_RESPONSE", { content: "hi" }),
    );
    expect(userMessages(events)).toEqual([]);
  });

  it("introduces a resumed subagent before its first event when it works unannounced", () => {
    const state = buildSubagents("root", [{ subagentId: "A" }]);
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
  });
});

describe("incomplete usage", () => {
  const counts = { inputTokens: 5, cacheReadTokens: 0, outputTokens: 1 };

  it("reports the incomplete form and no turn usage once a step has invalid counts", () => {
    const state = buildStateWithChild();
    const first = normalizeSubagentStep(
      state,
      "A",
      step(1, "PLANNER_RESPONSE", { toolCalls: [command()], usage: counts }),
    );
    expect(find(first, "session.usage.updated")[0]).toMatchObject({ usage: { inputTokens: 5 } });
    const invalid = normalizeSubagentStep(
      state,
      "A",
      step(3, "PLANNER_RESPONSE", { content: "done", hasInvalidUsage: true }),
    );
    const updated = find(invalid, "session.usage.updated").filter((event) => event.subagentId);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      usageReport: { status: "incomplete", counts: { inputTokens: 5, outputTokens: 1 } },
    });
    expect(updated[0]).not.toHaveProperty("usage");
    const completed = find(invalid, "turn.completed")[0];
    expect(completed).toMatchObject({ state: "completed" });
    expect(completed).not.toHaveProperty("usage");
    // The session's own snapshot is incomplete too, with the tokens counted so far.
    expect(sessionSnapshots([...first, ...invalid]).at(-1)).toMatchObject({
      usageReport: { status: "incomplete", counts: { inputTokens: 5 } },
    });
  });
});

describe("a subagent that starts a subagent of its own", () => {
  const launch = (index: number) =>
    step(index, "PLANNER_RESPONSE", {
      toolCalls: [{ name: "invoke_subagent", args: { Role: "Helper" } }],
      usage: { inputTokens: 5, cacheReadTokens: 0, outputTokens: 1 },
    });

  it("warns once, naming the subagent, however many such calls follow, and marks the usage incomplete", () => {
    const state = buildStateWithChild();
    const first = normalizeSubagentStep(state, "A", launch(1));
    const warnings = find(first, "runtime.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ subagentId: "A" });
    expect(warnings[0]?.message).toContain("started a subagent of its own");
    expect(find(first, "session.usage.updated")[0]).toHaveProperty("usageReport");
    expect(sessionSnapshots(first).at(-1)).toHaveProperty("usageReport");
    const second = normalizeSubagentStep(state, "A", launch(2));
    expect(find(second, "runtime.warning")).toEqual([]);
  });
});

describe("an unreadable subagent", () => {
  it("fails its open turn and its pending items, and reports its usage incomplete", () => {
    const state = buildStateWithChild();
    normalizeSubagentStep(
      state,
      "A",
      step(1, "PLANNER_RESPONSE", {
        toolCalls: [command()],
        usage: { inputTokens: 5, cacheReadTokens: 0, outputTokens: 1 },
      }),
    );
    const events = endUnreadableSubagent(state, "A");
    expect(tags(events)).toEqual([
      "session.usage.updated",
      "session.usage.updated",
      "item.completed",
      "turn.completed",
    ]);
    expect(events[0]).toMatchObject({
      subagentId: "A",
      usageReport: { status: "incomplete", counts: { inputTokens: 5 } },
    });
    expect(sessionSnapshots(events)).toMatchObject([
      { usageReport: { status: "incomplete", counts: { inputTokens: 5 } } },
    ]);
    expect(events[2]).toMatchObject({ status: "failed", kind: "command_execution" });
    const ended = find(events, "turn.completed")[0];
    expect(ended).toMatchObject({ state: "failed", subagentId: "A" });
    expect(ended).not.toHaveProperty("usage");
    expect(hasOpenSubagentTurn(state)).toBe(false);
    expect(endUnreadableSubagent(state, "A")).toEqual([]);
  });

  it("reports the session's usage incomplete once for a conversation that is no known subagent, since its steps were never read", () => {
    const state = buildStateWithChild();

    const events = endUnreadableSubagent(state, "never-announced");

    expect(tags(events)).toEqual(["session.usage.updated"]);
    expect(events[0]).not.toHaveProperty("subagentId");
    expect(events[0]).toHaveProperty("usageReport");
    expect(endUnreadableSubagent(state, "another-never-announced")).toEqual([]);
  });
});

describe("every subagent when the session's own files are unreadable", () => {
  it("ends the open turn of each known subagent as failed and reports each one's usage incomplete", () => {
    const state = buildSubagents("root");
    for (const id of ["A", "B"]) {
      introduceSubagent(state, { conversationId: id, launchToolCallId: id }, findNothing);
      normalizeSubagentStep(state, id, step(1, "PLANNER_RESPONSE", { toolCalls: [command()] }));
    }

    const events = endUnreadableSubagents(state);

    expect(find(events, "turn.completed")).toMatchObject([
      { subagentId: "A", state: "failed" },
      { subagentId: "B", state: "failed" },
    ]);
    expect(find(events, "session.usage.updated").filter((event) => event.subagentId)).toHaveLength(
      2,
    );
    expect(sessionSnapshots(events)).toHaveLength(1);
    expect(hasOpenSubagentTurn(state)).toBe(false);
  });
});

describe("a subagent that a cancel stopped", () => {
  it("shows a late step of its work, and ends the turn that step opens as interrupted", () => {
    const state = buildStateWithChild();
    normalizeSubagentStep(state, "A", step(1, "PLANNER_RESPONSE", { toolCalls: [command()] }));
    interruptSubagentTurns(state);

    const events = normalizeSubagentStep(
      state,
      "A",
      step(2, "PLANNER_RESPONSE", { content: "late words", toolCalls: [command()] }),
    );

    expect(find(events, "turn.completed")).toMatchObject([{ state: "interrupted" }]);
    expect(userMessages(events)).toEqual([]);
    expect(tags(events)).toContain("turn.started");
    expect(hasOpenSubagentTurn(state)).toBe(false);
  });

  it("works normally again once a conversation sends it a message", () => {
    const state = buildStateWithChild();
    interruptSubagentTurns(state);

    normalizeSubagentStep(state, "A", message(PARENT, "Go on"));
    const events = normalizeSubagentStep(
      state,
      "A",
      step(3, "PLANNER_RESPONSE", { toolCalls: [command()] }),
    );

    expect(tags(events)).not.toContain("turn.completed");
    expect(hasOpenSubagentTurn(state)).toBe(true);
  });
});
