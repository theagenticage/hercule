/**
 * Tests an assistant's conversation screen (`/assistants/$assistantId`)
 * against a stubbed controller. The screen is a messenger: it shows the
 * messages of the assistant's web conversation, reads the conversation's
 * current session for the row under the last message, and sends
 * what the user types with `conversation.send`.
 *
 * The spec defines the screen's text but not how its layout is marked up.
 * These tests assume:
 * - Each message's row carries `data-sender` with the sender's role
 *   (`owner`, `assistant` or `notice`). The tests read who sent a message
 *   from that attribute, not from class names such as `justify-end`, so
 *   restyling a bubble does not break them.
 * - The screen's header row is the parent element of its `Assistants` crumb,
 *   as on the thread screen.
 * - The send control's accessible name contains "send", as in the thread's
 *   composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildApprovalCard, formatStamp } from "@hercule/client-core";
import {
  DEFAULT_PAGE_LIMIT,
  type Assistant,
  type Conversation,
  type ConversationMessage,
  type Session,
  type SessionRequest,
} from "@hercule/contract";
import {
  buildErrorBody,
  expectInDocumentOrder,
  fakeMainScrollGeometry,
  readPageText,
  renderApp,
  stubApi,
  type Answer,
  type Call,
  type FakeScrollGeometry,
  type Handler,
} from "../../../app/testing";

const ZONE = "Europe/Amsterdam";

const ADA: Assistant = {
  id: "01a06d02-a000-7000-8000-000000000001",
  name: "Ada",
  systemPrompt: "You are a helpful assistant.",
  instanceId: "01a06d02-1000-7000-8000-000000000001",
  permissionProfileId: "01a06d02-2000-7000-8000-000000000001",
  accessMode: "approval-required",
  model: null,
  disallowedTools: [],
  unenforced: [],
  heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  mainConversationId: "01a06d02-c000-7000-8000-000000000001",
  createdAt: "2026-09-25T09:00:00.000Z",
  updatedAt: "2026-09-25T09:00:00.000Z",
};

const WEB: Conversation = {
  id: "01a06d02-c000-7000-8000-000000000001",
  assistantId: ADA.id,
  channel: "web",
  containerKey: null,
  createdAt: ADA.createdAt,
};

const SESSION_ID = "01a06d02-b100-7000-8000-000000000001";

/** Builds the session that answers Ada's web conversation. */
const buildConversationSession = (overrides: Partial<Session>): Session => ({
  id: SESSION_ID,
  title: "Answer Ada's conversation",
  status: "idle",
  resumable: true,
  resumeHeld: false,
  permissionProfileId: ADA.permissionProfileId,
  agentId: ADA.id,
  conversationId: WEB.id,
  runId: null,
  stepId: null,
  instanceId: ADA.instanceId,
  runnerId: "01a06d02-3000-7000-8000-000000000001",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: "native-ada",
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  createdAt: "2026-09-25T09:10:00.000Z",
  startedAt: "2026-09-25T09:10:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-25T09:11:00.000Z",
  unenforced: [],
  ...overrides,
});

/** Builds a message of Ada's web conversation at `position`. */
const buildMessage = (
  position: number,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage => ({
  id: `01a06d02-d000-7000-8000-${String(position).padStart(12, "0")}`,
  conversationId: WEB.id,
  containerKey: null,
  position,
  senderRole: "owner",
  senderLabel: "You",
  text: `message ${String(position)}`,
  sessionId: null,
  turnId: null,
  actor: "user",
  createdAt: new Date(Date.parse("2026-09-25T10:00:00.000Z") + position * 1000).toISOString(),
  ...overrides,
});

/** Builds `count` owner messages, `message 1` the oldest. */
const buildMessages = (count: number): ConversationMessage[] =>
  Array.from({ length: count }, (_, index) => buildMessage(index + 1));

/**
 * Returns one page of `messages` the way `conversation.queryMessages` does:
 * sorted by the `sort` parameter (ascending unless it asks for
 * `position:desc`), `limit` items long, and with a `nextCursor` while items
 * are left. The cursor is the offset of the next page.
 */
const pageMessages = (messages: readonly ConversationMessage[], call: Call) => {
  const params = new URLSearchParams(call.search);
  const descending = params.get("sort") === "position:desc";
  const limit = Number(params.get("limit") ?? DEFAULT_PAGE_LIMIT);
  const offset = Number(params.get("cursor") ?? 0);
  const sorted = [...messages].sort((a, b) =>
    descending ? b.position - a.position : a.position - b.position,
  );
  const items = sorted.slice(offset, offset + limit);
  const next = offset + limit < sorted.length ? String(offset + limit) : undefined;
  return { body: next === undefined ? { items } : { items, nextCursor: next } };
};

/**
 * The controller as the conversation screen sees it. Each field can be replaced while a test
 * runs, and the next read returns the new value:
 * - `messages` is what the web conversation holds; a send appends to it.
 * - `current` is the conversation's current session: what `session.query`
 *   returns when it is filtered by the conversation.
 * - `sessions` is the unfiltered session list the sidebar reads.
 */
interface World {
  messages: ConversationMessage[];
  current: Session | null;
  sessions: readonly Session[];
}

const buildController = (
  world: World,
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone", "assistant"], timezone: ZONE },
    },
  },
  "GET /api/v1/assistants": { body: { items: [ADA] } },
  [`GET /api/v1/assistants/${ADA.id}`]: { body: ADA },
  "GET /api/v1/conversations": (call) => {
    const assistantId = new URLSearchParams(call.search).get("assistantId");
    return { body: { items: assistantId === null || assistantId === ADA.id ? [WEB] : [] } };
  },
  [`GET /api/v1/conversations/${WEB.id}`]: { body: WEB },
  [`GET /api/v1/conversations/${WEB.id}/messages`]: (call) => pageMessages(world.messages, call),
  [`POST /api/v1/conversations/${WEB.id}/messages`]: (call) => {
    const sent = buildMessage(world.messages.length + 1, {
      text: (call.body as { text: string }).text,
    });
    world.messages = [...world.messages, sent];
    return { body: sent };
  },
  "GET /api/v1/sessions": (call) => {
    const conversationId = new URLSearchParams(call.search).get("conversationId");
    if (conversationId === null) return { body: { items: world.sessions } };
    return {
      body: { items: conversationId === WEB.id && world.current !== null ? [world.current] : [] },
    };
  },
  ...extra,
});

/** Opens Ada's conversation screen on a controller holding `world`. */
const openConversation = async (
  world: Partial<World> = {},
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const held: World = { messages: [], current: null, sessions: [], ...world };
  const api = stubApi(buildController(held, extra));
  const app = await renderApp({ path: `/assistants/${ADA.id}`, api: api.fetch, token: "held" });
  return { ...app, api, world: held };
};

/** Returns the composer's text box, the one labelled with the assistant's name. */
const findComposer = (): Promise<HTMLTextAreaElement> =>
  screen.findByPlaceholderText<HTMLTextAreaElement>("Message Ada");

/** Returns the elements outside the sidebar whose own text is exactly `text`. */
const getAllOnScreen = (text: string): HTMLElement[] =>
  screen.getAllByText(text).filter((element) => element.closest("nav") === null);

/** Waits for the one element outside the sidebar whose text is `text`, and returns it. */
const findOnScreen = (text: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = getAllOnScreen(text);
    expect(found).toHaveLength(1);
    return found[0]!;
  });

/** Returns the sender role of the message row that holds `element`, or null outside a row. */
const readSender = (element: HTMLElement): string | null =>
  element.closest<HTMLElement>("[data-sender]")?.dataset["sender"] ?? null;

/** Returns the sender role of every message row on screen, in document order. */
const readSenders = (): string[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>("[data-sender]"),
    (row) => row.dataset["sender"] ?? "",
  );

/**
 * Lets pending promises and the re-renders they cause run, without waiting
 * on a timer.
 */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

/**
 * Returns a handler that holds its first answer until `release` is called,
 * and answers every later call at once with `answer`. A test uses it to act
 * while a request is still in flight.
 */
const holdFirstCall = (answer: (call: Call) => Answer) => {
  let release = (): void => {};
  let held = false;
  const handler = (call: Call): Answer | Promise<Answer> => {
    if (held) return answer(call);
    held = true;
    return new Promise((resolve) => {
      release = () => resolve(answer(call));
    });
  };
  return { handler, release: () => release() };
};

/**
 * Checks whether `call` is a `conversation.send` to Ada's web conversation.
 * A test cannot look for any POST, because the live connection POSTs for its
 * ticket on its own.
 */
const isSend = (call: Call): boolean =>
  call.method === "POST" && call.path === `/api/v1/conversations/${WEB.id}/messages`;

describe("Assistant conversation: an empty conversation", () => {
  // The empty conversation has no session yet, so there is no presence to
  // show: "asleep" would promise a session to resume.
  it("shows the Assistants crumb and the assistant's name, with no presence word before the first session", async () => {
    await openConversation();

    const crumb = await waitFor(() => {
      const found = screen
        .getAllByText(/^Assistants/)
        .filter((element) => element.closest("nav") === null)[0];
      if (found === undefined) throw new Error("no Assistants crumb outside the sidebar");
      return found;
    });
    const chrome = readPageText(crumb.parentElement);
    expect(chrome).toMatch(/^Assistants(?: \/)? Ada$/);
  });

  it("explains how to start above the composer, which is addressed to the assistant", async () => {
    await openConversation();

    const hint = await findOnScreen(
      "Send a message to start. Ada falls asleep after a quiet spell and picks up where it left off.",
    );
    expectInDocumentOrder([hint, await findComposer()]);
    expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
  });
});

describe("Assistant conversation: sending", () => {
  it("sends the text to the web conversation, clears the composer, and shows the owner's bubble", async () => {
    const user = userEvent.setup();
    const { api } = await openConversation();

    await user.type(await findComposer(), "hi");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(api.calls.filter(isSend)).toHaveLength(1);
    });
    const sent = api.calls.find(isSend)!;
    expect(sent.body).toEqual({ text: "hi" });
    // The conversation's id came from `conversation.query`, filtered by the assistant.
    const query = api.calls.find(
      (call) => call.method === "GET" && call.path === "/api/v1/conversations",
    );
    expect(new URLSearchParams(query?.search).get("assistantId")).toBe(ADA.id);

    const bubble = await findOnScreen("hi");
    expect((await findComposer()).value).toBe("");
    expect(readSender(bubble)).toBe("owner");
  });

  it("sends on Enter", async () => {
    const user = userEvent.setup();
    const { api } = await openConversation();

    await user.type(await findComposer(), "hi{Enter}");

    await waitFor(() => {
      expect(api.calls.find(isSend)?.body).toEqual({ text: "hi" });
    });
  });

  it("starts a new line on Shift+Enter, and sends nothing", async () => {
    const user = userEvent.setup();
    const { api } = await openConversation();

    const composer = await findComposer();
    await user.type(composer, "first{Shift>}{Enter}{/Shift}second");

    expect(composer.value).toBe("first\nsecond");
    expect(api.calls.some(isSend)).toBe(false);
  });

  it("disables send while the text is empty", async () => {
    await openConversation();

    await findComposer();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /send/i }).disabled).toBe(true);
  });

  // `isPending` reaches the component a tick after `mutate`, so two Enters in
  // one tick could both send.
  it("sends once when Enter is pressed twice before the first send is answered", async () => {
    const user = userEvent.setup();
    const hold = holdFirstCall((call) => ({
      body: buildMessage(1, { text: (call.body as { text: string }).text }),
    }));
    const { api } = await openConversation(
      {},
      { [`POST /api/v1/conversations/${WEB.id}/messages`]: hold.handler },
    );

    const composer = await findComposer();
    await user.type(composer, "hi");
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.keyDown(composer, { key: "Enter" });
    await settle();

    expect(api.calls.filter(isSend)).toHaveLength(1);
    hold.release();
  });

  it("keeps text typed while a send is in flight", async () => {
    const user = userEvent.setup();
    const hold = holdFirstCall((call) => ({
      body: buildMessage(1, { text: (call.body as { text: string }).text }),
    }));
    const { api } = await openConversation(
      {},
      { [`POST /api/v1/conversations/${WEB.id}/messages`]: hold.handler },
    );

    const composer = await findComposer();
    await user.type(composer, "hi{Enter}");
    await waitFor(() => {
      expect(api.calls.filter(isSend)).toHaveLength(1);
    });
    await user.type(composer, "next");
    hold.release();
    await settle();

    expect(composer.value).toBe("hinext");
  });

  it("does not send on the Enter that Safari fires to end an IME composition", async () => {
    const user = userEvent.setup();
    const { api } = await openConversation();

    const composer = await findComposer();
    await user.type(composer, "にほん");
    fireEvent.keyDown(composer, { key: "Enter", keyCode: 229 });
    await settle();

    expect(api.calls.some(isSend)).toBe(false);
    expect(composer.value).toBe("にほん");
  });

  it("shows a refused send above the composer and keeps the text", async () => {
    const user = userEvent.setup();
    await openConversation(
      {},
      {
        [`POST /api/v1/conversations/${WEB.id}/messages`]: {
          status: 404,
          body: buildErrorBody("not_found", "no conversation has that id"),
        },
      },
    );

    const composer = await findComposer();
    await user.type(composer, "hi");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const error = await screen.findByText(/no conversation has that id/);
    expectInDocumentOrder([error, composer]);
    expect(composer.value).toBe("hi");
  });
});

describe("Assistant conversation: messages", () => {
  const NOTICE = "Ada was interrupted: its session was stopped";

  const MESSAGES = [
    buildMessage(1, { senderRole: "owner", text: "a" }),
    buildMessage(2, {
      senderRole: "assistant",
      senderLabel: "Ada",
      text: "b",
      sessionId: SESSION_ID,
      turnId: "t1",
      actor: `session:${SESSION_ID}`,
    }),
    buildMessage(3, {
      senderRole: "notice",
      senderLabel: "Ada",
      text: NOTICE,
      sessionId: SESSION_ID,
      turnId: "t2",
      actor: "system",
    }),
  ];

  it("renders the owner's, the assistant's and the notice's messages oldest first", async () => {
    await openConversation({ messages: MESSAGES });

    const owner = await findOnScreen("a");
    expectInDocumentOrder([owner, await findOnScreen("b"), await findOnScreen(NOTICE)]);
    expect(readSenders()).toEqual(["owner", "assistant", "notice"]);
  });

  it("marks each message with its sender, and puts the assistant's label in the reply's row, before its text", async () => {
    await openConversation({ messages: MESSAGES });

    const owner = await findOnScreen("a");
    const reply = await findOnScreen("b");
    const notice = await findOnScreen(NOTICE);

    expect(readSender(owner)).toBe("owner");
    expect(readSender(reply)).toBe("assistant");
    expect(readSender(notice)).toBe("notice");
    const label = getAllOnScreen("Ada").find((element) => readSender(element) === "assistant");
    expect(label, "no Ada label in the reply's row").toBeDefined();
    expectInDocumentOrder([owner, label!, reply]);
  });

  // jsdom computes no layout, so the test reads the classes that place each
  // row. The row element with `data-sender` owns them, except the owner's
  // bubble, which sits in a row of its own under the timestamp.
  it("puts the owner's bubble on the right, the assistant's prose on the left, and the notice centred and muted", async () => {
    await openConversation({ messages: MESSAGES });

    await findOnScreen(NOTICE);
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-sender]"));
    const readClasses = (sender: string): string[] =>
      rows.find((row) => row.dataset["sender"] === sender)?.className.split(/\s+/) ?? [];

    const bubble = await findOnScreen("a");
    expect(bubble.closest(".justify-end"), "the owner's bubble is not on the right").not.toBeNull();
    expect(readClasses("assistant")).toEqual(
      expect.arrayContaining(["flex", "flex-col", "items-start"]),
    );
    expect(readClasses("notice")).toEqual(
      expect.arrayContaining(["justify-center", "text-center", "text-muted"]),
    );
  });

  it("stamps the owner's messages in mono, once per minute, and never the replies or notices", async () => {
    await openConversation({
      messages: [
        buildMessage(1, { text: "first", createdAt: "2026-09-25T10:00:05.000Z" }),
        // Sent in the same minute as "first": it shares that stamp.
        buildMessage(2, { text: "second", createdAt: "2026-09-25T10:00:40.000Z" }),
        buildMessage(3, {
          senderRole: "assistant",
          senderLabel: "Ada",
          text: "reply",
          sessionId: SESSION_ID,
          createdAt: "2026-09-25T10:03:00.000Z",
        }),
        buildMessage(4, { text: "third", createdAt: "2026-09-25T10:07:00.000Z" }),
      ],
    });

    await findOnScreen("third");
    const early = formatStamp(new Date("2026-09-25T10:00:05.000Z"), ZONE)!;
    const late = formatStamp(new Date("2026-09-25T10:07:00.000Z"), ZONE)!;
    const reply = formatStamp(new Date("2026-09-25T10:03:00.000Z"), ZONE)!;
    const stamps = screen.getAllByText(new RegExp(`^(${early}|${late}|${reply})$`));
    expect(stamps.map((stamp) => stamp.textContent)).toEqual([early, late]);
    expect(stamps[0]!.className).toMatch(/\bfont-mono\b/);
    expectInDocumentOrder([
      stamps[0]!,
      await findOnScreen("first"),
      stamps[1]!,
      await findOnScreen("third"),
    ]);
  });

  it("links the assistant's reply and the notice to the session's work", async () => {
    await openConversation({ messages: MESSAGES });

    const reply = await findOnScreen("b");
    const notice = await findOnScreen(NOTICE);
    const links = screen.getAllByRole("link", { name: "Show work" });

    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/threads/${SESSION_ID}`,
      `/threads/${SESSION_ID}`,
    ]);
    // One link belongs to the reply, the other to the notice.
    expectInDocumentOrder([reply, links[0]!, notice, links[1]!]);
  });

  it("adds the assistant's new message without a reload when a conversation nudge arrives", async () => {
    const { live, world } = await openConversation({ messages: [MESSAGES[0]!] });

    await findOnScreen("a");
    await waitFor(() => {
      expect(live.topics()).toContain("conversation");
    });
    world.messages = [MESSAGES[0]!, MESSAGES[1]!];
    act(() => {
      live.push("conversation", { _tag: "invalidate", ids: [WEB.id], kind: "updated" });
    });

    expect(await findOnScreen("b")).toBeDefined();
  });
});

describe("Assistant conversation: earlier messages", () => {
  /** Checks whether `call` reads a page of earlier messages, the one kind of read with a cursor. */
  const isEarlierPage = (call: Call): boolean =>
    call.path === `/api/v1/conversations/${WEB.id}/messages` &&
    new URLSearchParams(call.search).get("cursor") !== null;

  it("shows the newest 50 of 60 messages, and loads the other 10 above them on Show earlier messages", async () => {
    const user = userEvent.setup();
    await openConversation({ messages: buildMessages(60) });

    await findOnScreen("message 60");
    expect(getAllOnScreen("message 11")).toHaveLength(1);
    expect(screen.queryByText("message 10")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show earlier messages" }));

    const oldest = await findOnScreen("message 1");
    expectInDocumentOrder([
      oldest,
      await findOnScreen("message 10"),
      await findOnScreen("message 11"),
    ]);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
    });
  });

  // A nudge never cancels a running read. The earlier page's load finishes,
  // and the list is read again after it for the nudge's change, so the
  // screen never has to ask for the earlier page twice.
  it("keeps loading the earlier messages when a conversation nudge arrives, and shows the nudge's message after them", async () => {
    const user = userEvent.setup();
    let messages = buildMessages(60);
    const held: (() => void)[] = [];
    const { api, live } = await openConversation(
      { messages },
      {
        [`GET /api/v1/conversations/${WEB.id}/messages`]: (call) => {
          // Each read answers with the messages as they were when it arrived.
          const answer = pageMessages(messages, call);
          if (!isEarlierPage(call) || held.length > 0) return answer;
          return new Promise((resolve) => {
            held.push(() => resolve(answer));
          });
        },
      },
    );
    await findOnScreen("message 60");
    await waitFor(() => {
      expect(live.topics()).toContain("conversation");
    });

    await user.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await waitFor(() => {
      expect(held).toHaveLength(1);
    });
    messages = [...messages, buildMessage(61)];
    act(() => {
      live.push("conversation", { _tag: "invalidate", ids: [WEB.id], kind: "updated" });
    });
    await settle();
    expect(api.calls.filter(isEarlierPage)).toHaveLength(1);

    held[0]!();
    expect(await findOnScreen("message 1")).toBeDefined();
    expect(await findOnScreen("message 61")).toBeDefined();
  });

  // Unlike a nudge, a send does cancel the load: the composer re-reads the
  // messages already shown, and that re-read cancels the earlier page's load.
  // The earlier messages must still arrive.
  it("still loads the earlier messages when a send re-reads the list while they load", async () => {
    const user = userEvent.setup();
    let messages = buildMessages(60);
    const hold = holdFirstCall((call) => pageMessages(messages, call));
    const { api } = await openConversation(
      {},
      {
        [`GET /api/v1/conversations/${WEB.id}/messages`]: (call) =>
          isEarlierPage(call) ? hold.handler(call) : pageMessages(messages, call),
        [`POST /api/v1/conversations/${WEB.id}/messages`]: (call) => {
          const sent = buildMessage(61, { text: (call.body as { text: string }).text });
          messages = [...messages, sent];
          return { body: sent };
        },
      },
    );
    await findOnScreen("message 60");

    await user.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await user.type(await findComposer(), "hi");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(await findOnScreen("hi")).toBeDefined();
    expect(await findOnScreen("message 1")).toBeDefined();
    expect(api.calls.filter(isEarlierPage)).toHaveLength(2);
    hold.release();
  });

  it("shows why the earlier messages failed to load beside the button, and does not ask again on its own", async () => {
    const user = userEvent.setup();
    const messages = buildMessages(60);
    const { api } = await openConversation(
      { messages },
      {
        [`GET /api/v1/conversations/${WEB.id}/messages`]: (call) =>
          isEarlierPage(call)
            ? { status: 500, body: buildErrorBody("internal", "the database is locked") }
            : pageMessages(messages, call),
      },
    );
    await findOnScreen("message 60");

    const button = screen.getByRole("button", { name: "Show earlier messages" });
    await user.click(button);

    const error = await screen.findByRole("alert");
    expect(error.textContent).toMatch(/the database is locked/);
    expect(error.parentElement).toBe(button.parentElement);
    await settle();
    expect(api.calls.filter(isEarlierPage)).toHaveLength(1);
    expect(screen.queryByText("message 10")).toBeNull();
  });

  it("offers no Show earlier messages when every message fits on one page", async () => {
    await openConversation({ messages: buildMessages(50) });

    await findOnScreen("message 50");
    expect(getAllOnScreen("message 1")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
  });
});

describe("Assistant conversation: the row under the last bubble", () => {
  const REQUEST: SessionRequest = {
    requestId: "req-ada",
    itemId: "tool-ada",
    kind: "command_approval",
    decisions: ["allow", "deny"],
    detail: { command: "ls -la" },
  };

  const LAST = buildMessage(1, { text: "hi" });

  it("reads the conversation's current session from the server, newest first, one item", async () => {
    const { api } = await openConversation({ messages: [LAST] });

    await findOnScreen("hi");
    await waitFor(() => {
      const read = api.calls.find(
        (call) =>
          call.path === "/api/v1/sessions" &&
          new URLSearchParams(call.search).get("conversationId") !== null,
      );
      expect(read, "the current session was never read").toBeDefined();
      const params = new URLSearchParams(read!.search);
      expect(params.get("conversationId")).toBe(WEB.id);
      expect(params.get("sort")).toBe("createdAt:desc");
      expect(params.get("limit")).toBe("1");
    });
  });

  // The ellipsis is the one character "…", matching the WorkingMark row the
  // thread screen shows.
  it("shows that the assistant is working below the last bubble, and removes it without a reload once the session is idle", async () => {
    const { live, world } = await openConversation({
      messages: [LAST],
      current: buildConversationSession({ status: "busy" }),
    });

    const working = await findOnScreen("Ada is working…");
    expectInDocumentOrder([await findOnScreen("hi"), working]);
    // The work behind the row is one click away, as it is from a reply.
    const showWork = screen.getByRole("link", { name: "Show work" });
    expect(showWork.getAttribute("href")).toBe(`/threads/${SESSION_ID}`);
    expectInDocumentOrder([working, showWork]);

    world.current = buildConversationSession({ status: "idle" });
    await waitFor(() => {
      expect(live.topics()).toContain("session");
    });
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [SESSION_ID], kind: "updated" });
    });

    await waitFor(() => {
      expect(screen.queryByText("Ada is working…")).toBeNull();
    });
  });

  // The session list holds at most one page, and a long-lived conversation
  // session can fall off it once enough newer sessions exist. The header reads
  // the same session as the row, so it says working too.
  it("shows the presence word working in the header while the row shows working, even when the session list does not hold the session", async () => {
    await openConversation({
      messages: [LAST],
      current: buildConversationSession({ status: "busy" }),
      sessions: [],
    });

    await findOnScreen("Ada is working…");
    const name = screen
      .getAllByText("Ada")
      .find((element) => element.closest("nav") === null && element.closest("main") !== null);
    expect(readPageText(name?.parentElement)).toContain("working");
    expect(readPageText(name?.parentElement)).not.toContain("asleep");
  });

  it("links to the session when it waits for an approval, and shows no permission card", async () => {
    await openConversation({
      messages: [LAST],
      current: buildConversationSession({ status: "busy", openRequests: [REQUEST] }),
    });

    const row = await screen.findByRole("link", { name: /Ada needs your approval/ });
    expect(row.getAttribute("href")).toBe(`/threads/${SESSION_ID}`);
    // Underlined, so the row reads as a link rather than a status line.
    expect(screen.getByText("Ada needs your approval").className).toMatch(/\bunderline\b/);
    expect(screen.queryByText("Ada is working…")).toBeNull();
    for (const each of buildApprovalCard(REQUEST).rows) {
      const describeLine = each.describeLine.map((part) => part.text).join("");
      expect(
        screen.queryByRole("button", {
          name: (name) => name.includes(each.label) && name.includes(describeLine),
        }),
      ).toBeNull();
    }
  });
});

/**
 * jsdom computes no layout, so these tests set by hand the scroll geometry
 * that `useStickToBottom` reads, on the shell's `main`: the screen has no
 * scroll region of its own and scrolls with `main`.
 */
describe("Assistant conversation: scrolling", () => {
  let geometry: FakeScrollGeometry;

  beforeEach(() => {
    geometry = fakeMainScrollGeometry();
  });

  afterEach(() => {
    geometry.restore();
    vi.restoreAllMocks();
  });

  // Guards against the screen opening at the top of the conversation, on its
  // oldest message.
  it("opens on the newest message", async () => {
    geometry.set({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });

    await openConversation({ messages: buildMessages(3) });

    await findOnScreen("message 3");
    await waitFor(() => {
      expect(geometry.readScrollTop()).toBe(1000 - 100);
    });
  });

  // The first page holds the newest 50 messages, so a new message keeps the
  // count at 50; the screen must follow the newest message's id, not the
  // count.
  it("follows a new message at the bottom even when the page stays 50 messages long", async () => {
    const { live, world } = await openConversation({ messages: buildMessages(50) });
    await findOnScreen("message 50");
    await waitFor(() => {
      expect(live.topics()).toContain("conversation");
    });

    geometry.set({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
    geometry.scroll();
    await settle();

    geometry.set({ scrollTop: 900, scrollHeight: 1200, clientHeight: 100 });
    world.messages = buildMessages(51);
    act(() => {
      live.push("conversation", { _tag: "invalidate", ids: [WEB.id], kind: "updated" });
    });

    await findOnScreen("message 51");
    await waitFor(() => {
      expect(geometry.readScrollTop()).toBe(1200 - 100);
    });
  });

  // jsdom has no layout, so each message row is given a top of 100px per row
  // above it, less the scroll offset, which is how a real page would place it.
  it("keeps the reader on the same message when earlier messages load above it", async () => {
    const user = userEvent.setup();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const rows = Array.from(document.querySelectorAll("[data-message-id]"));
      const index = rows.indexOf(this);
      const top = index < 0 ? 0 : index * 100 - geometry.readScrollTop();
      return DOMRect.fromRect({ x: 0, y: top, width: 800, height: 100 });
    });
    await openConversation({ messages: buildMessages(60) });
    await findOnScreen("message 60");
    geometry.set({ scrollTop: 0, scrollHeight: 6000, clientHeight: 1000 });
    geometry.scroll();
    await settle();

    await user.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await findOnScreen("message 1");

    // "message 11" was the first row, at the top of the viewport. Ten rows
    // loaded above it, so the page scrolled down by ten rows to keep it there.
    await waitFor(() => {
      expect(geometry.readScrollTop()).toBe(1000);
    });
  });

  // Guards against the scroll correction moving a reader who scrolled on
  // while the earlier messages loaded.
  it("leaves the page where the reader scrolled it while the earlier messages loaded", async () => {
    const user = userEvent.setup();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const rows = Array.from(document.querySelectorAll("[data-message-id]"));
      const index = rows.indexOf(this);
      const top = index < 0 ? 0 : index * 100 - geometry.readScrollTop();
      return DOMRect.fromRect({ x: 0, y: top, width: 800, height: 100 });
    });
    const messages = buildMessages(60);
    const hold = holdFirstCall((call) => pageMessages(messages, call));
    await openConversation(
      { messages },
      {
        [`GET /api/v1/conversations/${WEB.id}/messages`]: (call) =>
          new URLSearchParams(call.search).get("cursor") === null
            ? pageMessages(messages, call)
            : hold.handler(call),
      },
    );
    await findOnScreen("message 60");
    geometry.set({ scrollTop: 0, scrollHeight: 6000, clientHeight: 1000 });
    geometry.scroll();
    await settle();

    await user.click(screen.getByRole("button", { name: "Show earlier messages" }));
    geometry.set({ scrollTop: 300, scrollHeight: 6000, clientHeight: 1000 });
    geometry.scroll();
    hold.release();
    await findOnScreen("message 1");
    await settle();

    expect(geometry.readScrollTop()).toBe(300);
  });
});

describe("Assistant conversation: an unknown assistant", () => {
  it("renders the not-found state", async () => {
    const unknown = "01a06d02-a000-7000-8000-0000000000ff";
    const api = stubApi(
      buildController(
        { messages: [], current: null, sessions: [] },
        {
          [`GET /api/v1/assistants/${unknown}`]: {
            status: 404,
            body: buildErrorBody("not_found", "No assistant has that id."),
          },
        },
      ),
    );
    await renderApp({ path: `/assistants/${unknown}`, api: api.fetch, token: "held" });

    expect(await screen.findByText("No screen here")).toBeDefined();
    expect(screen.queryByPlaceholderText(/^Message /)).toBeNull();
  });
});
