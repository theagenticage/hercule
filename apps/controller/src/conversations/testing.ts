/**
 * Test helpers for a conversation with an assistant, over a fleet from
 * `sessions/testing.ts`: the user sends a message over HTTP, and the fake
 * runner on the socket answers the session that message starts.
 *
 * Several suites share them because they all need the same steps: find the
 * default assistant's web conversation, send it a message, find the session
 * that message started, and report a turn from the runner.
 */
import { expect } from "vitest";
import type { ProviderEvent, TurnState } from "@hercule/protocol";
import type { Assistant, Conversation, ConversationMessage, Session } from "@hercule/contract";
import { get, post } from "../http/testing";
import {
  at,
  reportEvent,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  type Arranged,
} from "../sessions/testing";

/** The assistant setup creates, and its web conversation. */
export interface DefaultConversation {
  readonly assistant: Assistant;
  readonly conversation: Conversation;
}

/** One page of a conversation's messages, as `conversation.queryMessages` returns it. */
export interface MessagePage {
  readonly items: ReadonlyArray<ConversationMessage>;
  readonly nextCursor?: string;
}

/**
 * Returns the default assistant `Hercule`, which setup creates, and its web
 * conversation. Fails the test unless both exist.
 */
export const readDefaultConversation = async (arranged: Arranged): Promise<DefaultConversation> => {
  const base = arranged.harness.base;
  const listed = await get(base, "/api/v1/assistants", arranged.token);
  expect(listed.status, await listed.clone().text()).toBe(200);
  const assistant = ((await listed.json()) as { items: ReadonlyArray<Assistant> }).items.find(
    (one) => one.name === "Hercule",
  );
  expect(assistant, "setup creates the default assistant").toBeDefined();
  const conversations = await get(
    base,
    `/api/v1/conversations?assistantId=${assistant!.id}`,
    arranged.token,
  );
  expect(conversations.status, await conversations.clone().text()).toBe(200);
  const conversation = (
    (await conversations.json()) as { items: ReadonlyArray<Conversation> }
  ).items.find((one) => one.channel === "web");
  expect(conversation, "every assistant has a web conversation").toBeDefined();
  return { assistant: assistant!, conversation: conversation! };
};

/** Sends `conversation.send` and returns the raw response, for a test that expects a refusal. */
export const requestSend = (
  arranged: Arranged,
  conversationId: string,
  text: string,
  token: string = arranged.token,
): Promise<Response> =>
  post(arranged.harness.base, `/api/v1/conversations/${conversationId}/messages`, { text }, token);

/** Sends a message as the user and returns the stored message. Fails the test unless the send succeeds. */
export const sendMessage = async (
  arranged: Arranged,
  conversationId: string,
  text: string,
): Promise<ConversationMessage> => {
  const response = await requestSend(arranged, conversationId, text);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ConversationMessage;
};

/**
 * Returns one page of the conversation's messages. `query` is the query string
 * without its `?`, such as `sort=position:asc`.
 */
export const listMessages = async (
  arranged: Arranged,
  conversationId: string,
  query = "",
): Promise<MessagePage> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/conversations/${conversationId}/messages${query === "" ? "" : `?${query}`}`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as MessagePage;
};

/** Returns the sessions of one conversation, newest first, through `session.query`. */
export const listConversationSessions = async (
  arranged: Arranged,
  conversationId: string,
): Promise<ReadonlyArray<Session>> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/sessions?conversationId=${conversationId}`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Session> }).items;
};

/** Waits until the conversation has at least `count` sessions, and returns them, newest first. */
export const waitForConversationSessions = (
  arranged: Arranged,
  conversationId: string,
  count: number,
): Promise<ReadonlyArray<Session>> =>
  waitUntil(`placed ${String(count)} sessions for the conversation`, async () => {
    const found = await listConversationSessions(arranged, conversationId);
    return found.length >= count ? found : undefined;
  });

/** Waits until the conversation holds at least `count` messages, and returns them, oldest first. */
export const waitForMessages = (
  arranged: Arranged,
  conversationId: string,
  count: number,
): Promise<ReadonlyArray<ConversationMessage>> =>
  waitUntil(`stored ${String(count)} messages in the conversation`, async () => {
    const page = await listMessages(arranged, conversationId, "sort=position:asc");
    return page.items.length >= count ? page.items : undefined;
  });

/**
 * Sends the first message of a conversation that has no session, and starts the
 * session it places: the runner receives the start frame and reports
 * `session.started` with `nativeSessionId`. Waits until the runner has
 * answered the message's input, and returns the session, which is then
 * `busy`: the fake runner answers `opened` and reports no turn events, so the
 * message's turn runs until the caller reports its end. The first event the
 * runner reported has sequence number 1, so the caller's next event is 2.
 */
export const startConversationSession = async (
  arranged: Arranged,
  conversationId: string,
  text: string,
  nativeSessionId = "native-1",
): Promise<Session> => {
  await sendMessage(arranged, conversationId, text);
  const [session] = await waitForConversationSessions(arranged, conversationId, 1);
  await waitForStartFrames(arranged, session!.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session!.id,
    at,
    _tag: "session.started",
    providerRefs: { nativeSessionId },
  });
  return await waitForSession(arranged, session!.id, (one) => one.status === "busy");
};

/** How a reported turn ends. */
export interface TurnEnding {
  readonly state: TurnState;
  readonly error?: string;
}

/**
 * Runs one turn on the runner, starting at sequence number `seq`: the turn
 * starts, each of `texts` is started, streamed and completed as its own
 * assistant message, and the turn ends with the state and error in `ending`. Waits until the controller has
 * applied the start and then the end, so whatever the end writes is written
 * when this returns. Returns the next free sequence number.
 */
export const runTurn = async (
  arranged: Arranged,
  sessionId: string,
  seq: number,
  turnId: string,
  texts: ReadonlyArray<string>,
  ending: TurnEnding = { state: "completed" },
): Promise<number> => {
  const base = () => ({ eventId: crypto.randomUUID(), sessionId, at });
  reportEvent(arranged.wire, seq, { ...base(), _tag: "turn.started", turnId });
  await waitForSession(arranged, sessionId, (one) => one.status === "busy");
  const events: Array<ProviderEvent> = [];
  texts.forEach((text, index) => {
    const itemId = `${turnId}-item-${String(index + 1)}`;
    // Every adapter reports an item's start before its text.
    events.push({ ...base(), _tag: "item.started", turnId, itemId, kind: "assistant_message" });
    events.push({
      ...base(),
      _tag: "content.delta",
      turnId,
      itemId,
      streamKind: "assistant_text",
      delta: text,
    });
    events.push({
      ...base(),
      _tag: "item.completed",
      turnId,
      itemId,
      kind: "assistant_message",
      status: "completed",
    });
  });
  events.push({
    ...base(),
    _tag: "turn.completed",
    turnId,
    state: ending.state,
    ...(ending.error === undefined ? {} : { error: ending.error }),
  });
  events.forEach((event, index) => reportEvent(arranged.wire, seq + 1 + index, event));
  await waitForSession(arranged, sessionId, (one) => one.status !== "busy");
  return seq + 1 + events.length;
};
