/**
 * End-to-end tests for a session's subagents: a fake runner reports events
 * for the session's own agent and for its subagents on the real runner
 * socket, and the tests read back what the controller made of them over HTTP.
 *
 * What the tests check:
 *
 * - The one rule: the session's status, its assistant's replies and the
 *   notices about its turns read only the session's own agent. A subagent
 *   that works, asks and ends leaves the session as it would be without it.
 * - Several Requests can be open at once, one per agent, and each closes on
 *   its own.
 * - `session.querySubagents` lists the records the events build.
 * - `transcript.read` reads one agent's transcript at a time.
 * - Interrupting a subagent withdraws only the notifications of its subtree.
 * - Token Usage adds up across a resume, for the session and for a subagent.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ProviderEvent,
  SessionInterrupt as SessionInterruptFrame,
  SessionRespondToApprovalRequest,
  SessionStart,
} from "@hercule/protocol";
import type { Session, Subagent } from "@hercule/contract";
import { get, post, send } from "../http/testing";
import {
  listMessages,
  readDefaultConversation,
  startConversationSession,
} from "../conversations/testing";
import {
  at,
  findInstanceId,
  listFrames,
  readApprovalNotifications,
  readSession,
  reportEvent,
  spawnSessionOrFail,
  waitForFrames,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  WAIT_DEADLINE_MS,
  withAgentFleet,
  type Arranged,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 10_000 });

/** The fields every event of one agent shares. Without `subagentId` the agent is the session's own. */
const buildBase = (sessionId: string, subagentId?: string) => ({
  eventId: crypto.randomUUID(),
  sessionId,
  at,
  ...(subagentId === undefined ? {} : { subagentId }),
});

/** Builds the events of one assistant message: started, streamed and completed. */
const buildAssistantMessage = (
  sessionId: string,
  turnId: string,
  itemId: string,
  text: string,
  subagentId?: string,
): ReadonlyArray<ProviderEvent> => [
  {
    ...buildBase(sessionId, subagentId),
    _tag: "item.started",
    turnId,
    itemId,
    kind: "assistant_message",
  },
  {
    ...buildBase(sessionId, subagentId),
    _tag: "content.delta",
    turnId,
    itemId,
    streamKind: "assistant_text",
    delta: text,
  },
  {
    ...buildBase(sessionId, subagentId),
    _tag: "item.completed",
    turnId,
    itemId,
    kind: "assistant_message",
    status: "completed",
  },
];

/** Builds a `request.opened` for a command approval, asked by `subagentId` or by the session's own agent. */
const buildApprovalRequest = (
  sessionId: string,
  requestId: string,
  subagentId?: string,
): ProviderEvent => ({
  ...buildBase(sessionId, subagentId),
  _tag: "request.opened",
  request: {
    requestId,
    itemId: `item-${requestId}`,
    kind: "command_approval",
    decisions: ["allow", "deny"],
    detail: { command: `run ${requestId}` },
  },
});

/** Builds the `request.resolved` that closes a Request after it was allowed. */
const buildResolved = (
  sessionId: string,
  requestId: string,
  subagentId?: string,
): ProviderEvent => ({
  ...buildBase(sessionId, subagentId),
  _tag: "request.resolved",
  requestId,
  decision: "allow",
});

/**
 * Reports `events` from sequence number `seq` on, and returns the next free
 * sequence number.
 */
const reportEvents = (
  arranged: Arranged,
  seq: number,
  events: ReadonlyArray<ProviderEvent>,
): number => {
  events.forEach((event, index) => reportEvent(arranged.wire, seq + index, event));
  return seq + events.length;
};

/**
 * Spawns a session and reports its `session.started` at sequence number 1.
 * The runner answers the prompt with `opened`, so the session is `busy`.
 */
const startSession = async (arranged: Arranged): Promise<Session> => {
  const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
  await waitForStartFrames(arranged, session.id, 1);
  reportEvent(arranged.wire, 1, { ...buildBase(session.id), _tag: "session.started" });
  return await waitForSession(arranged, session.id, (one) => one.status === "busy");
};

/** Returns one page of a session's subagents, failing the test on any status but 200. */
const listSubagents = async (
  arranged: Arranged,
  sessionId: string,
  query = "",
): Promise<{ readonly items: ReadonlyArray<Subagent>; readonly nextCursor?: string }> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/sessions/${sessionId}/subagents${query}`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as never;
};

/** Waits until a session's subagent exists and `ready` returns true for it, and returns it. */
const waitForSubagent = (
  arranged: Arranged,
  sessionId: string,
  subagentId: string,
  ready: (subagent: Subagent) => boolean,
): Promise<Subagent> =>
  waitUntil(`moved subagent ${subagentId}`, async () => {
    const found = (await listSubagents(arranged, sessionId)).items.find(
      (one) => one.id === subagentId,
    );
    return found !== undefined && ready(found) ? found : undefined;
  });

/** Reads a transcript page, for the session's own agent or for one subagent. */
const readTranscript = (arranged: Arranged, sessionId: string, query = ""): Promise<Response> =>
  get(arranged.harness.base, `/api/v1/sessions/${sessionId}/transcript${query}`, arranged.token);

/** Waits until a session has exactly these open Requests, by id, and returns the session. */
const waitForOpenRequests = (
  arranged: Arranged,
  sessionId: string,
  requestIds: ReadonlyArray<string>,
): Promise<Session> =>
  waitForSession(
    arranged,
    sessionId,
    (one) =>
      JSON.stringify(one.openRequests.map((request) => request.requestId)) ===
      JSON.stringify(requestIds),
  );

/** Returns the status of the approval notification about each of a session's Requests, by request id. */
const readNotificationStatuses = async (
  arranged: Arranged,
  sessionId: string,
): Promise<Record<string, string>> => {
  const notifications = await readApprovalNotifications(arranged, sessionId);
  return Object.fromEntries(
    notifications.map((notification) => {
      const subject = (notification.subject ?? []).find((one) => one.kind === "request");
      const requestId = subject?.kind === "request" ? subject.requestId : "";
      const status =
        notification.status === "resolved"
          ? `resolved:${notification.resolution?.kind ?? ""}`
          : notification.status;
      return [requestId, status];
    }),
  );
};

/** Returns a session without the fields that differ between any two sessions: the id and the times. */
const omitIdentity = (session: Session) => ({
  ...session,
  id: undefined,
  createdAt: undefined,
  startedAt: undefined,
  lastActivityAt: undefined,
});

describe("the one rule: the session reads only its own agent", () => {
  it("is left exactly as the main agent alone would leave it by a subagent that works, asks and ends", async () => {
    await withAgentFleet(async (arranged) => {
      const alone = await startSession(arranged);
      const helped = await startSession(arranged);
      const mainStart = (id: string): ReadonlyArray<ProviderEvent> => [
        { ...buildBase(id), _tag: "turn.started", turnId: "t1" },
      ];
      const mainEnd = (id: string): ReadonlyArray<ProviderEvent> => [
        ...buildAssistantMessage(id, "t1", "main-text", "Done."),
        {
          ...buildBase(id),
          _tag: "session.usage.updated",
          usage: { inputTokens: 10, outputTokens: 2 },
        },
        { ...buildBase(id), _tag: "turn.completed", turnId: "t1", state: "completed" },
      ];

      reportEvents(arranged, 2, [...mainStart(alone.id), ...mainEnd(alone.id)]);

      const id = helped.id;
      let seq = reportEvents(arranged, 2, [
        ...mainStart(id),
        {
          ...buildBase(id),
          _tag: "subagent.started",
          subagentId: "a1",
          itemId: "call-1",
          description: "Review the diff",
        },
        { ...buildBase(id, "a1"), _tag: "turn.started", turnId: "s1", model: "sonnet" },
        buildApprovalRequest(id, "sub-req", "a1"),
      ]);
      const asking = await waitForOpenRequests(arranged, id, ["sub-req"]);
      expect(asking.status).toBe("busy");
      expect(asking.openRequests[0]).toMatchObject({ subagentId: "a1" });

      seq = reportEvents(arranged, seq, [
        buildResolved(id, "sub-req", "a1"),
        {
          ...buildBase(id, "a1"),
          _tag: "session.usage.updated",
          usage: { inputTokens: 99, outputTokens: 9 },
        },
        ...buildAssistantMessage(id, "s1", "sub-text", "Looks fine.", "a1"),
        { ...buildBase(id, "a1"), _tag: "turn.completed", turnId: "s1", state: "completed" },
      ]);
      await waitForSubagent(arranged, id, "a1", (one) => one.status === "completed");
      // The subagent's turn ending does not end the session's turn.
      expect((await readSession(arranged, id)).status).toBe("busy");

      reportEvents(arranged, seq, mainEnd(id));

      const [aloneAfter, helpedAfter] = await Promise.all([
        waitForSession(arranged, alone.id, (one) => one.status === "idle"),
        waitForSession(arranged, id, (one) => one.status === "idle"),
      ]);
      expect(omitIdentity(helpedAfter)).toEqual(omitIdentity(aloneAfter));
      expect(helpedAfter.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    });
  });

  it("writes no reply and no notice for a subagent's messages and its failed turn", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      const id = session.id;

      reportEvents(arranged, 2, [
        { ...buildBase(id), _tag: "turn.started", turnId: "t1" },
        ...buildAssistantMessage(id, "t1", "main-text", "The main answer."),
        { ...buildBase(id), _tag: "subagent.started", subagentId: "a1" },
        // The subagent reuses the turn id: each agent's turns are its own.
        { ...buildBase(id, "a1"), _tag: "turn.started", turnId: "t1" },
        ...buildAssistantMessage(id, "t1", "sub-text", "A subagent's text.", "a1"),
        {
          ...buildBase(id, "a1"),
          _tag: "turn.completed",
          turnId: "t1",
          state: "failed",
          error: "boom",
        },
        { ...buildBase(id), _tag: "turn.completed", turnId: "t1", state: "completed" },
      ]);
      await waitForSession(arranged, id, (one) => one.status === "idle");

      // The main agent's last text is its reply, though the subagent wrote
      // after it, and the subagent's failed turn writes no notice.
      await waitUntil("wrote the reply", async () => {
        const items = (await listMessages(arranged, conversation.id, "sort=position:asc")).items;
        return items.length >= 2 ? items : undefined;
      });
      const messages = (await listMessages(arranged, conversation.id, "sort=position:asc")).items;
      expect(messages.map((one) => [one.senderRole, one.text])).toEqual([
        ["owner", "hi"],
        ["assistant", "The main answer."],
      ]);
    });
  });

  it("writes no segment reply for a subagent's completed message", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      const updated = await send(
        "PATCH",
        arranged.harness.base,
        `/api/v1/assistants/${assistant.id}`,
        {
          body: { reply: "segments" },
          token: arranged.token,
        },
      );
      expect(updated.status, await updated.clone().text()).toBe(200);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      const id = session.id;

      reportEvents(arranged, 2, [
        { ...buildBase(id), _tag: "turn.started", turnId: "t1" },
        { ...buildBase(id), _tag: "subagent.started", subagentId: "a1" },
        ...buildAssistantMessage(id, "s1", "sub-text", "A subagent's text.", "a1"),
        ...buildAssistantMessage(id, "t1", "main-text", "The main answer."),
        { ...buildBase(id), _tag: "turn.completed", turnId: "t1", state: "completed" },
      ]);
      await waitForSession(arranged, id, (one) => one.status === "idle");

      const replies = (await listMessages(arranged, conversation.id, "sort=position:asc")).items
        .filter((one) => one.senderRole === "assistant")
        .map((one) => one.text);
      expect(replies).toEqual(["The main answer."]);
    });
  });
});

describe("the open Requests of several agents", () => {
  /**
   * Starts a session whose own agent and subagent `a1` each ask one approval,
   * and waits until both are open. The next free sequence number is 7.
   */
  const startTwoRequests = async (arranged: Arranged): Promise<Session> => {
    const session = await startSession(arranged);
    const id = session.id;
    reportEvents(arranged, 2, [
      { ...buildBase(id), _tag: "turn.started", turnId: "t1" },
      {
        ...buildBase(id),
        _tag: "subagent.started",
        subagentId: "a1",
        description: "Review the diff",
      },
      { ...buildBase(id, "a1"), _tag: "turn.started", turnId: "s1" },
      buildApprovalRequest(id, "main-req"),
      buildApprovalRequest(id, "sub-req", "a1"),
    ]);
    return await waitForOpenRequests(arranged, id, ["main-req", "sub-req"]);
  };

  it("raises one notification per Request, naming the subagent that asked", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startTwoRequests(arranged);

      expect(session.openRequests[0]).not.toHaveProperty("subagentId");
      expect(session.openRequests[1]).toMatchObject({ requestId: "sub-req", subagentId: "a1" });
      const notifications = await waitUntil("raised both notifications", async () => {
        const found = await readApprovalNotifications(arranged, session.id);
        return found.length === 2 ? found : undefined;
      });
      const bodyFor = (requestId: string) =>
        notifications.find((one) =>
          (one.subject ?? []).some(
            (subject) => subject.kind === "request" && subject.requestId === requestId,
          ),
        )?.body;
      expect(bodyFor("sub-req")).toMatch(/^Asked by ` Review the diff `\n\n/);
      expect(bodyFor("main-req") ?? "").not.toContain("Asked by");
    });
  });

  it("closes each Request on its own when they are answered in reverse order", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startTwoRequests(arranged);
      const respond = (requestId: string) =>
        post(
          arranged.harness.base,
          `/api/v1/sessions/${session.id}/respond-to-approval-request`,
          { requestId, decision: "allow" },
          arranged.token,
        );

      const second = await respond("sub-req");
      expect(second.status, await second.clone().text()).toBe(200);
      const first = await respond("main-req");
      expect(first.status, await first.clone().text()).toBe(200);
      expect(
        (
          await waitForFrames<SessionRespondToApprovalRequest>(
            arranged.wire,
            "sessionRespondToApprovalRequest",
            2,
          )
        ).map((frame) => frame.requestId),
      ).toEqual(["sub-req", "main-req"]);

      reportEvent(arranged.wire, 7, buildResolved(session.id, "sub-req", "a1"));
      await waitForOpenRequests(arranged, session.id, ["main-req"]);
      reportEvent(arranged.wire, 8, buildResolved(session.id, "main-req"));
      await waitForOpenRequests(arranged, session.id, []);
      expect(await readNotificationStatuses(arranged, session.id)).toEqual({
        "main-req": "resolved:decided",
        "sub-req": "resolved:decided",
      });
    });
  });

  it("closes only the main agent's Request when the main agent's turn ends", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startTwoRequests(arranged);

      reportEvent(arranged.wire, 7, {
        ...buildBase(session.id),
        _tag: "turn.completed",
        turnId: "t1",
        state: "completed",
      });

      await waitForOpenRequests(arranged, session.id, ["sub-req"]);
      await waitUntil("withdrew the main agent's notification", async () => {
        const statuses = await readNotificationStatuses(arranged, session.id);
        return statuses["main-req"] === "resolved:withdrawn" ? statuses : undefined;
      });
      expect((await readNotificationStatuses(arranged, session.id))["sub-req"]).toBe("open");
    });
  });
});

describe("session.interrupt of a subagent", () => {
  it("refuses an unknown subagent, and otherwise withdraws only its subtree's notifications", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      const id = session.id;
      reportEvents(arranged, 2, [
        { ...buildBase(id), _tag: "turn.started", turnId: "t1" },
        { ...buildBase(id), _tag: "subagent.started", subagentId: "a1" },
        { ...buildBase(id), _tag: "subagent.started", subagentId: "a2", parentSubagentId: "a1" },
        { ...buildBase(id), _tag: "subagent.started", subagentId: "b1" },
        buildApprovalRequest(id, "main-req"),
        buildApprovalRequest(id, "child-req", "a2"),
        buildApprovalRequest(id, "other-req", "b1"),
      ]);
      await waitForOpenRequests(arranged, id, ["main-req", "child-req", "other-req"]);
      await waitUntil("raised the notifications", async () => {
        const statuses = await readNotificationStatuses(arranged, id);
        return Object.keys(statuses).length === 3 ? statuses : undefined;
      });
      const interrupt = (body: unknown) =>
        send("POST", arranged.harness.base, `/api/v1/sessions/${id}/interrupt`, {
          token: arranged.token,
          body,
        });

      const unknown = await interrupt({ subagentId: "nobody" });
      expect(unknown.status, await unknown.clone().text()).toBe(404);
      expect(listFrames<SessionInterruptFrame>(arranged.wire, "sessionInterrupt")).toEqual([]);

      const known = await interrupt({ subagentId: "a1" });
      expect(known.status, await known.clone().text()).toBe(200);
      const [frame] = await waitForFrames<SessionInterruptFrame>(
        arranged.wire,
        "sessionInterrupt",
        1,
      );
      expect(frame).toEqual({ _tag: "sessionInterrupt", sessionId: id, subagentId: "a1" });
      expect(await readNotificationStatuses(arranged, id)).toEqual({
        "main-req": "open",
        "child-req": "resolved:withdrawn",
        "other-req": "open",
      });
      const [entry] = await arranged.harness.audit("session.interrupted");
      expect(entry?.payload).toMatchObject({ subagentId: "a1" });
    });
  });
});

describe("session.querySubagents", () => {
  it("lists every field the events fill, oldest first, a page at a time", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      const id = session.id;
      reportEvents(arranged, 2, [
        { ...buildBase(id), _tag: "turn.started", turnId: "t1" },
        {
          ...buildBase(id),
          _tag: "subagent.started",
          subagentId: "a1",
          itemId: "call-1",
          description: "Review the diff",
          agentType: "reviewer",
        },
        { ...buildBase(id, "a1"), _tag: "turn.started", turnId: "s1", model: "sonnet" },
        {
          ...buildBase(id, "a1"),
          _tag: "item.started",
          turnId: "s1",
          itemId: "cmd",
          kind: "command_execution",
          detail: { command: "pnpm test" },
        },
        {
          ...buildBase(id, "a1"),
          _tag: "session.usage.updated",
          usage: { inputTokens: 40, outputTokens: 4, costUsd: 0.5 },
        },
        { ...buildBase(id), _tag: "subagent.started", subagentId: "a2", parentSubagentId: "a1" },
        {
          ...buildBase(id, "a2"),
          _tag: "item.started",
          turnId: "s2",
          itemId: "edit",
          kind: "file_change",
          detail: { path: "src/a.ts" },
        },
        ...buildAssistantMessage(id, "s1", "answer", "All tests pass.\nDetails follow.", "a1"),
        {
          ...buildBase(id, "a1"),
          _tag: "turn.completed",
          turnId: "s1",
          state: "completed",
        },
      ]);
      await waitForSubagent(arranged, id, "a1", (one) => one.status === "completed");
      await waitForSubagent(arranged, id, "a2", (one) => one.activity !== undefined);

      const first = await listSubagents(arranged, id, "?limit=1");
      expect(first.items).toEqual([
        {
          id: "a1",
          sessionId: id,
          itemId: "call-1",
          description: "Review the diff",
          agentType: "reviewer",
          model: "sonnet",
          status: "completed",
          toolCalls: 1,
          result: "All tests pass.",
          usage: { inputTokens: 40, outputTokens: 4, costUsd: 0.5 },
          startedAt: at,
          endedAt: at,
        },
      ]);
      expect(first.nextCursor).toBeDefined();
      const cursor = `?cursor=${encodeURIComponent(first.nextCursor!)}`;
      const rest = await listSubagents(arranged, id, cursor);
      expect(rest.items).toEqual([
        {
          id: "a2",
          sessionId: id,
          parentSubagentId: "a1",
          status: "running",
          toolCalls: 1,
          activity: "Editing src/a.ts",
          startedAt: at,
        },
      ]);
      expect(rest.nextCursor).toBeUndefined();

      // A cursor belongs to one session's list.
      const other = await startSession(arranged);
      const refused = await get(
        arranged.harness.base,
        `/api/v1/sessions/${other.id}/subagents${cursor}`,
        arranged.token,
      );
      expect(refused.status, await refused.clone().text()).toBe(400);
      const missing = await get(
        arranged.harness.base,
        "/api/v1/sessions/0199e0e7-9999-7000-8000-000000000000/subagents",
        arranged.token,
      );
      expect(missing.status).toBe(404);
    });
  });
});

describe("a subagent's spawn link", () => {
  it("comes from its parent's item even when the item comes before the introduction", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      const id = session.id;
      const call = (itemId: string): ProviderEvent => ({
        ...buildBase(id),
        _tag: "item.started",
        turnId: "t1",
        itemId,
        kind: "subagent",
        detail: { subagentIds: ["a1"] },
      });
      reportEvents(arranged, 2, [
        { ...buildBase(id), _tag: "turn.started", turnId: "t1" },
        call("agent-call"),
        { ...buildBase(id), _tag: "subagent.started", subagentId: "a1", description: "Fix it" },
        call("send-message"),
      ]);
      const subagent = await waitForSubagent(
        arranged,
        id,
        "a1",
        (one) => one.description !== undefined,
      );
      expect(subagent).toMatchObject({ itemId: "agent-call", description: "Fix it" });
    });
  });
});

describe("a subagent's description", () => {
  it("comes from its first turn's brief, never from a later turn's message", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      const id = session.id;
      const userMessage = (subagentId: string, turnId: string, text: string): ProviderEvent => ({
        ...buildBase(id, subagentId),
        _tag: "item.started",
        turnId,
        itemId: `brief-${turnId}`,
        kind: "user_message",
        detail: { text },
      });
      reportEvents(arranged, 2, [
        { ...buildBase(id, "briefed"), _tag: "turn.started", turnId: "b1" },
        userMessage("briefed", "b1", "Find the flaky test\nin the suite"),
        // Its first turn had no message, so a later turn's message is not its brief.
        { ...buildBase(id, "unbriefed"), _tag: "turn.started", turnId: "u1" },
        { ...buildBase(id, "unbriefed"), _tag: "turn.completed", turnId: "u1", state: "completed" },
        { ...buildBase(id, "unbriefed"), _tag: "turn.started", turnId: "u2" },
        userMessage("unbriefed", "u2", "Now also fix the lint"),
      ]);
      const unbriefed = await waitForSubagent(
        arranged,
        id,
        "unbriefed",
        (one) => one.activity === "Reading its brief",
      );
      expect(unbriefed).not.toHaveProperty("description");
      const briefed = await waitForSubagent(arranged, id, "briefed", () => true);
      expect(briefed.description).toBe("Find the flaky test");
    });
  });
});

describe("a subagent the session's end stops", () => {
  it("takes the first line of its last message as its result, or keeps the old one", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      const id = session.id;
      const turn = (subagentId: string, turnId: string, ended: boolean): ProviderEvent =>
        ended
          ? { ...buildBase(id, subagentId), _tag: "turn.completed", turnId, state: "completed" }
          : { ...buildBase(id, subagentId), _tag: "turn.started", turnId };
      // A message the exit cuts off: its item never completes, so its text
      // is still held back until the exit flushes it.
      const cutOff = (subagentId: string, turnId: string, text: string) =>
        buildAssistantMessage(id, turnId, `${turnId}-cut`, text, subagentId).slice(0, 2);
      const seq = reportEvents(arranged, 2, [
        // Continued, and its second turn writes a new message.
        turn("continued", "c1", false),
        ...buildAssistantMessage(id, "c1", "c1-a", "Found A", "continued"),
        turn("continued", "c1", true),
        turn("continued", "c2", false),
        ...cutOff("continued", "c2", "Found B\nDetails follow."),
        // Continued, and its second turn writes nothing.
        turn("silent", "s1", false),
        ...buildAssistantMessage(id, "s1", "s1-a", "Found A", "silent"),
        turn("silent", "s1", true),
        turn("silent", "s2", false),
        // Its only turn never completes.
        turn("unfinished", "u1", false),
        ...cutOff("unfinished", "u1", "Found B"),
      ]);
      await waitForSubagent(arranged, id, "unfinished", (one) => one.activity === "Writing");
      reportEvent(arranged.wire, seq, {
        ...buildBase(id),
        _tag: "session.exited",
        reason: "stopped",
      });
      await waitForSession(arranged, id, (one) => one.status === "exited");
      const results = Object.fromEntries(
        (await listSubagents(arranged, id)).items.map((one) => [
          one.id,
          `${one.status}: ${one.result ?? ""}`,
        ]),
      );
      expect(results).toEqual({
        continued: "stopped: Found B",
        silent: "stopped: Found A",
        unfinished: "stopped: Found B",
      });
    });
  });
});

describe("transcript.read of one agent", () => {
  it("reads the session's own transcript or one subagent's, and keeps their cursors apart", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      const id = session.id;
      reportEvents(arranged, 2, [
        { ...buildBase(id), _tag: "turn.started", turnId: "t1" },
        { ...buildBase(id), _tag: "subagent.started", subagentId: "a1" },
        { ...buildBase(id, "a1"), _tag: "turn.started", turnId: "s1" },
        ...buildAssistantMessage(id, "s1", "sub-text", "Sub.", "a1"),
        { ...buildBase(id, "a1"), _tag: "turn.completed", turnId: "s1", state: "completed" },
        ...buildAssistantMessage(id, "t1", "main-text", "Main."),
        { ...buildBase(id), _tag: "turn.completed", turnId: "t1", state: "completed" },
      ]);
      await waitForSession(arranged, id, (one) => one.status === "idle");
      type Page = {
        readonly items: ReadonlyArray<{ readonly event: ProviderEvent }>;
        readonly nextCursor?: string;
      };
      const readPage = async (query: string): Promise<Page> => {
        const response = await readTranscript(arranged, id, query);
        expect(response.status, await response.clone().text()).toBe(200);
        return (await response.json()) as Page;
      };

      const main = await readPage("");
      expect(main.items.map((row) => row.event._tag)).toEqual([
        "session.started",
        "turn.started",
        "subagent.started",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ]);
      expect(
        main.items.filter(
          (row) => row.event._tag !== "subagent.started" && "subagentId" in row.event,
        ),
      ).toEqual([]);

      const sub = await readPage("?subagentId=a1");
      expect(sub.items.map((row) => row.event._tag)).toEqual([
        "turn.started",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ]);
      expect(
        sub.items.every((row) => "subagentId" in row.event && row.event.subagentId === "a1"),
      ).toBe(true);

      const firstMain = await readPage("?limit=1");
      const crossed = await readTranscript(
        arranged,
        id,
        `?subagentId=a1&cursor=${encodeURIComponent(firstMain.nextCursor!)}`,
      );
      expect(crossed.status, await crossed.clone().text()).toBe(400);
      const firstSub = await readPage("?subagentId=a1&limit=1");
      const crossedBack = await readTranscript(
        arranged,
        id,
        `?cursor=${encodeURIComponent(firstSub.nextCursor!)}`,
      );
      expect(crossedBack.status, await crossedBack.clone().text()).toBe(400);

      const unknown = await readTranscript(arranged, id, "?subagentId=nobody");
      expect(unknown.status, await unknown.clone().text()).toBe(404);
    });
  });
});

describe("Token Usage across a resume", () => {
  it("adds the resumed process's usage to the session's and to a subagent's, and resumes the subagent", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      const id = session.id;
      reportEvents(arranged, 2, [
        {
          ...buildBase(id),
          _tag: "session.usage.updated",
          usage: { inputTokens: 10, outputTokens: 1 },
        },
        { ...buildBase(id), _tag: "subagent.started", subagentId: "a1", itemId: "call-1" },
        {
          ...buildBase(id, "a1"),
          _tag: "session.usage.updated",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      ]);
      await waitForSubagent(arranged, id, "a1", (one) => one.usage !== undefined);
      arranged.wire.send({
        _tag: "sessionsReport",
        sessions: [
          {
            sessionId: id,
            nativeSessionId: "native-1",
            instanceId: findInstanceId(arranged, "full-provider"),
          },
        ],
      });
      await waitForSession(arranged, id, (one) => one.nativeSessionId !== null);
      reportEvent(arranged.wire, 5, {
        ...buildBase(id),
        _tag: "session.exited",
        reason: "stopped",
      });
      await waitForSession(arranged, id, (one) => one.status === "exited");
      expect((await waitForSubagent(arranged, id, "a1", () => true)).status).toBe("stopped");

      const input = await post(
        arranged.harness.base,
        `/api/v1/sessions/${id}/input`,
        { text: "go on" },
        arranged.token,
      );
      expect(input.status, await input.clone().text()).toBe(200);
      const starts = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(starts[1]!.spec.continue).toEqual({
        nativeSessionId: "native-1",
        mode: "resume",
        subagents: [{ subagentId: "a1", itemId: "call-1" }],
      });

      // The new process counts from zero again.
      reportEvents(arranged, 6, [
        { ...buildBase(id), _tag: "session.started" },
        {
          ...buildBase(id),
          _tag: "session.usage.updated",
          usage: { inputTokens: 5, outputTokens: 1 },
        },
        {
          ...buildBase(id, "a1"),
          _tag: "session.usage.updated",
          usage: { inputTokens: 20, outputTokens: 2 },
        },
      ]);
      const resumed = await waitForSession(arranged, id, (one) => one.usage?.inputTokens === 15);
      expect(resumed.usage).toEqual({ inputTokens: 15, outputTokens: 2 });
      const subagent = await waitForSubagent(
        arranged,
        id,
        "a1",
        (one) => one.usage?.inputTokens === 120,
      );
      expect(subagent.usage).toEqual({ inputTokens: 120, outputTokens: 12 });
    });
  });
});
