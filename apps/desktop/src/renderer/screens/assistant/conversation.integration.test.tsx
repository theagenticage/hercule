/**
 * Tests an assistant's Conversation as the app opens it: the messages read a
 * page at a time from the stubbed controller, the reply being written that
 * the current session streams, the hand-over to the stored reply, the
 * composer's send and Stop, the dock, and the pushes on the `conversation`
 * topic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { flattenMessagePages, queryKeys, type MessagePages } from "@hercule/client-core";
import {
  buildSessionStreamTopic,
  buildSessionTapTopic,
  type Assistant,
  type ConversationMessage,
  type OpenRequest,
  type Session,
  type TapItem,
  type TranscriptRow,
} from "@hercule/contract";
import {
  buildConversationHandlers,
  buildErrorBody,
  buildFixtureAssistant,
  buildFixtureAssistantSession,
  buildFixtureMessage,
  buildSidebarHandlers,
  buildThreadHandlers,
  buildTranscript,
  CONTROLLER_URL,
  createFakeBridge,
  NO_SIDEBAR_RECORDS,
  renderApp,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
  type Call,
  type EventBody,
  type Handler,
} from "../../app/testing";
import { buildAssistantDraftKey } from "../../app/pending-submissions";
import { holdAnimationFrames, type HeldFrames } from "../thread/testing";

/** The time the tests run at: 11:25 in Amsterdam on 10 September 2026. */
const NOW = new Date("2026-09-10T09:25:00.000Z");

const ADA = buildFixtureAssistant({
  id: "01a06d02-a000-7000-8000-000000000003",
  name: "Ada",
  mainConversationId: "01a06d02-c000-7000-8000-000000000003",
});

const SESSION_ID = "01a06d02-a100-7000-8000-000000000003";

/** The path of Ada's messages, which both the read and the send go to. */
const MESSAGES_PATH = `/api/v1/conversations/${ADA.mainConversationId}/messages`;

/** Returns the current session of Ada's main conversation, busy unless `over` says otherwise. */
const buildAdaSession = (over: Partial<Session> = {}): Session =>
  buildFixtureAssistantSession(ADA, { id: SESSION_ID, status: "busy", ...over });

/** The owner's first message, at 11:01 today. */
const QUESTION = buildFixtureMessage(ADA, { position: 1, text: "How did last night's backup go?" });

/** The animation frames, held until a test runs them. The paragraph being written is painted in one. */
let frames: HeldFrames;

beforeEach(() => {
  // Times are drawn in the system time zone, which differs between machines.
  vi.stubEnv("TZ", "Europe/Amsterdam");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  frames = holdAnimationFrames();
  stubElementSize(800, 800);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** What `openConversation` starts the app with. */
interface ConversationSetup {
  readonly assistant?: Assistant;
  /** The current session, as each read finds it. `null` when none has started. */
  readonly readSession?: () => Session | null;
  /** The messages, oldest first. The stubbed send adds to the end. */
  readonly messages?: ConversationMessage[];
  /** The current session's transcript, oldest first. */
  readonly transcript?: readonly TranscriptRow[];
  readonly handlers?: Readonly<Record<string, Handler>>;
}

/**
 * Opens the app signed in at the assistant's page, and waits until the page
 * is subscribed to the `conversation` topic and, when a session has started,
 * to its stream, which then sends an empty replay, so the rows a test pushes
 * are live rows.
 */
const openConversation = async ({
  assistant = ADA,
  readSession = () => null,
  messages = [],
  transcript = [],
  handlers = {},
}: ConversationSetup = {}) => {
  const session = readSession();
  const calls = stubApi({
    ...buildSidebarHandlers({ ...NO_SIDEBAR_RECORDS, assistants: [{ assistant, session }] }),
    // Answers the read of the current session with the session as it is at
    // each read, so a test can change it, and the thread list with none.
    "GET /api/v1/sessions": (call) => {
      const current = readSession();
      return {
        body: { items: call.search.includes("conversationId") && current ? [current] : [] },
      };
    },
    ...buildConversationHandlers({ assistant, session, messages, transcript }),
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: `/assistants/${assistant.id}` },
  );
  await waitFor(() => {
    expect(app.live.readTopics()).toContain("conversation");
  });
  // The live connection's first socket tells every subscriber that it may
  // have missed pushes, so the page reads the newest messages a second time.
  await waitFor(() => {
    expect(findPageReads(calls)).toHaveLength(2);
  });
  if (session !== null) {
    await waitFor(() => {
      expect(app.live.readTopics()).toContain(buildSessionStreamTopic(session.id));
    });
    act(() => {
      app.live.pushEmptyReplay(session.id);
    });
  }
  return { ...app, calls };
};

/** Returns the Conversation's region. */
const findConversation = (): HTMLElement => screen.getByRole("region", { name: "Conversation" });

/** Returns the text of each block the Conversation draws, in order. */
const readBlocks = (): string[] =>
  [...findConversation().querySelectorAll(".atx-item")].map((item) => item.textContent);

/** Returns the reads of a page of Ada's messages, oldest first. */
const findPageReads = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((call) => call.method === "GET" && call.path === MESSAGES_PATH);

/** Returns the paragraph the assistant is writing. Fails when the Conversation shows none. */
const findOpenParagraph = (): Element => {
  const paragraph = findConversation().querySelector(".streaming");
  if (paragraph === null) throw new Error("the Conversation shows no paragraph being written");
  return paragraph;
};

/**
 * Waits until the paragraph being written shows `text`, running the animation
 * frames it is painted in.
 */
const expectOpenParagraphToShow = (text: string): Promise<void> =>
  waitFor(() => {
    frames.run();
    expect(findOpenParagraph().textContent).toBe(text);
  });

/** Returns the transcript rows of `bodies` for Ada's session, from 11:20, one second apart. */
const buildAdaTranscript = (...bodies: readonly EventBody[]): TranscriptRow[] =>
  buildTranscript(
    SESSION_ID,
    "2026-09-10T09:20:00.000Z",
    bodies.map((body, index) => [index, body] as const),
  );

/** Returns the rows that follow `rows`, one per body, as the session's stream delivers them. */
const buildRowsAfter = (
  rows: readonly TranscriptRow[],
  ...bodies: readonly EventBody[]
): TranscriptRow[] => {
  const last = rows.at(-1)!;
  return bodies.map((body, index) => {
    const position = last.position + index + 1;
    return {
      position,
      at: last.at,
      event: { ...body, eventId: `event-${position}`, sessionId: SESSION_ID, at: last.at },
    };
  });
};

const TURN_STARTED: EventBody = {
  _tag: "turn.started",
  turnId: "turn-1",
  model: "claude-sonnet-5",
};

/** Returns the events of the assistant message `itemId`: its start, and its text when given. */
const startAnswer = (itemId: string, text?: string): EventBody[] => [
  { _tag: "item.started", turnId: "turn-1", itemId, kind: "assistant_message" },
  ...(text === undefined
    ? []
    : [
        {
          _tag: "content.delta",
          turnId: "turn-1",
          itemId,
          streamKind: "assistant_text",
          delta: text,
        } as const,
      ]),
];

/** Returns the event that completes the assistant message `itemId`. */
const completeAnswer = (itemId: string): EventBody => ({
  _tag: "item.completed",
  turnId: "turn-1",
  itemId,
  kind: "assistant_message",
  status: "completed",
});

/** Returns the taps of the assistant message `itemId`, one per delta. */
const buildTaps = (itemId: string, ...deltas: readonly string[]): TapItem[] =>
  deltas.map((delta) => ({ turnId: "turn-1", itemId, streamKind: "assistant_text", delta }));

/** Returns Ada's reply at `position`, which the turn `turn-1` of her session wrote. */
const buildReply = (position: number, text: string): ConversationMessage =>
  buildFixtureMessage(ADA, {
    position,
    text,
    senderRole: "assistant",
    sessionId: SESSION_ID,
    turnId: "turn-1",
    actor: `session:${SESSION_ID}`,
  });

describe("an assistant's Conversation", () => {
  it("reads the newest page of messages, and draws its day stamps, messages, replies and notices", async () => {
    const { calls } = await openConversation({
      messages: [
        buildFixtureMessage(ADA, {
          position: 1,
          text: "Set up the nightly backup.",
          createdAt: "2026-09-09T16:00:00.000Z",
        }),
        {
          ...buildReply(2, "Done. It runs at **03:00**."),
          createdAt: "2026-09-09T16:02:00.000Z",
        },
        buildFixtureMessage(ADA, { position: 3, text: "How did last night's backup go?" }),
        buildFixtureMessage(ADA, {
          position: 4,
          text: "Ada could not answer: the runner is offline.",
          senderRole: "notice",
        }),
      ],
    });

    expect(readBlocks()).toEqual([
      "Yesterday",
      "Set up the nightly backup.9 Sep 18:00",
      "Ada 9 Sep 18:02Done. It runs at 03:00.",
      "Today",
      "How did last night's backup go?11:03",
      "Ada could not answer: the runner is offline.11:04",
    ]);
    const conversation = findConversation();
    expect(conversation.getAttribute("aria-live")).toBeNull();
    expect(within(conversation).getByText("03:00").tagName).toBe("STRONG");
    // A stored reply's face rests; a notice's face shows the failure, still.
    expect(conversation.querySelector(".msg .cr")?.getAttribute("class")).toBe("cr cr--idle");
    expect(within(conversation).getByRole("status").querySelector(".cr")?.classList).toContain(
      "cr--failed",
    );
    expect(conversation.querySelector(".cr--animated")).toBeNull();
    // The newest page, newest first, and no other.
    const reads = findPageReads(calls);
    expect(new Set(reads.map((read) => read.search)).size).toBe(1);
    const search = new URLSearchParams(reads[0]!.search);
    expect(search.get("limit")).toBe("50");
    expect(search.get("cursor")).toBeNull();
    expect(search.get("sort")).toContain("desc");
  });

  it("streams the reply being written, then hands it over to the stored reply when the turn ends", async () => {
    let session: Session = buildAdaSession();
    const messages = [QUESTION];
    const transcript = buildAdaTranscript(TURN_STARTED);
    const { live } = await openConversation({ readSession: () => session, messages, transcript });

    // The turn has no text yet, so the reply being written is its working
    // face and the caret alone.
    expect(readBlocks()).toEqual([
      "Today",
      "How did last night's backup go?11:01",
      "Ada thinking…",
    ]);
    expect(findOpenParagraph().textContent).toBe("");
    const animated = [...findConversation().querySelectorAll(".cr--animated")];
    expect(animated.map((face) => face.closest(".atx-item"))).toEqual([
      findOpenParagraph().closest(".atx-item"),
    ]);

    const [started] = buildRowsAfter(transcript, ...startAnswer("answer"));
    act(() => {
      live.pushStreamRows(SESSION_ID, [started!]);
    });
    act(() => {
      live.pushTaps(SESSION_ID, buildTaps("answer", "It ran at 03:00 ", "and took 4 minutes."));
    });
    await expectOpenParagraphToShow("It ran at 03:00 and took 4 minutes.");
    expect(readBlocks().at(-1)).toBe("Ada answering…It ran at 03:00 and took 4 minutes.");

    // The turn ends. In turn-end mode its last text is stored as the reply,
    // and the session goes idle.
    const ended = buildRowsAfter(
      [started!],
      {
        _tag: "content.delta",
        turnId: "turn-1",
        itemId: "answer",
        streamKind: "assistant_text",
        delta: "It ran at 03:00 and took 4 minutes.",
      },
      completeAnswer("answer"),
      { _tag: "turn.completed", turnId: "turn-1", state: "completed" },
    );
    act(() => {
      live.pushStreamRows(SESSION_ID, ended);
    });
    messages.push(buildReply(2, "It ran at 03:00 and took 4 minutes."));
    session = buildAdaSession({ status: "idle" });
    act(() => {
      live.pushInvalidation("conversation", [ADA.mainConversationId]);
    });

    await waitFor(() => {
      expect(readBlocks()).toEqual([
        "Today",
        "How did last night's backup go?11:01",
        "Ada 11:02It ran at 03:00 and took 4 minutes.",
      ]);
    });
    expect(findConversation().querySelector(".streaming")).toBeNull();
    expect(findConversation().querySelector(".cr--animated")).toBeNull();
  });

  it("shows only the text not stored yet while a reply in segments is written", async () => {
    const assistant: Assistant = { ...ADA, reply: "segments" };
    const messages = [QUESTION, buildReply(2, "First, the backup ran.")];
    const transcript = buildAdaTranscript(
      TURN_STARTED,
      ...startAnswer("first", "First, the backup ran."),
      completeAnswer("first"),
      ...startAnswer("second", "Then it was "),
    );
    const { live } = await openConversation({
      assistant,
      readSession: buildAdaSession,
      messages,
      transcript,
    });

    // The first text is stored as a reply, so the reply being written holds
    // only the second.
    expect(readBlocks()).toEqual([
      "Today",
      "How did last night's backup go?11:01",
      "Ada 11:02First, the backup ran.",
      "Ada answering…Then it was ",
    ]);
    expect(findOpenParagraph().textContent).toBe("Then it was ");

    act(() => {
      live.pushStreamRows(
        SESSION_ID,
        buildRowsAfter(
          transcript,
          {
            _tag: "content.delta",
            turnId: "turn-1",
            itemId: "second",
            streamKind: "assistant_text",
            delta: "checked.",
          },
          completeAnswer("second"),
        ),
      );
    });
    messages.push(buildReply(3, "Then it was checked."));
    act(() => {
      live.pushInvalidation("conversation", [ADA.mainConversationId]);
    });

    // The second text is stored too. The turn still runs, so the reply being
    // written is back to the caret alone.
    await waitFor(() => {
      expect(readBlocks()).toEqual([
        "Today",
        "How did last night's backup go?11:01",
        "Ada 11:02First, the backup ran.",
        "Ada 11:03Then it was checked.",
        "Ada thinking…",
      ]);
    });
    expect(findOpenParagraph().textContent).toBe("");
  });

  it("sends a message, shows it once the controller has stored it, and clears the field", async () => {
    const user = userEvent.setup();
    const messages = [QUESTION];
    const { calls, context } = await openConversation({ messages });
    const field = screen.getByRole("textbox", { name: "Message" });
    expect(field.getAttribute("placeholder")).toBe("Message Ada…");

    await user.type(field, "Check it again tonight.{Enter}");

    await waitFor(() => {
      expect(readBlocks().at(-1)).toBe("Check it again tonight.11:02");
    });
    expect((field as HTMLTextAreaElement).value).toBe("");
    const sends = calls.filter((call) => call.method === "POST" && call.path === MESSAGES_PATH);
    expect(sends.map((call) => call.body)).toEqual([{ text: "Check it again tonight." }]);
    // The sent message came right after the newest one held, so it was merged
    // without reading the page again.
    expect(findPageReads(calls)).toHaveLength(2);
    expect(
      context.controller!.pendingSubmissions.read(buildAssistantDraftKey(ADA.id)).message.text,
    ).toBe("");
  });

  it("keeps the text, and shows why, when the send fails", async () => {
    const user = userEvent.setup();
    await openConversation({
      messages: [QUESTION],
      handlers: {
        [`POST ${MESSAGES_PATH}`]: {
          status: 404,
          body: buildErrorBody("not_found", "Ada's conversation was not found."),
        },
      },
    });
    const field = screen.getByRole("textbox", { name: "Message" });

    await user.type(field, "Check it again tonight.{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Ada's conversation was not found.",
    );
    expect((field as HTMLTextAreaElement).value).toBe("Check it again tonight.");
    expect(readBlocks()).toEqual(["Today", "How did last night's backup go?11:01"]);
  });

  it("stops the current session's turn", async () => {
    const user = userEvent.setup();
    const interrupt = `/api/v1/sessions/${SESSION_ID}/interrupt`;
    const { calls } = await openConversation({
      readSession: buildAdaSession,
      messages: [QUESTION],
      transcript: buildAdaTranscript(TURN_STARTED),
      handlers: { [`POST ${interrupt}`]: { body: buildAdaSession() } },
    });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(calls.filter((call) => call.path === interrupt)).toHaveLength(1);
    });
  });

  it("answers the current session's Request in the dock, drawn with the assistant's waiting face", async () => {
    const user = userEvent.setup();
    const request: OpenRequest = {
      requestId: "req-1",
      itemId: "tool-1",
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command: "tail -n 200 /var/log/pg-backup.log" },
    };
    const respond = `/api/v1/sessions/${SESSION_ID}/respond-to-approval-request`;
    const { calls } = await openConversation({
      readSession: () => buildAdaSession({ openRequests: [request] }),
      messages: [QUESTION],
      transcript: buildAdaTranscript(TURN_STARTED),
      handlers: { [`POST ${respond}`]: { body: buildAdaSession() } },
    });
    // The reply being written waits on the user, so its face is still.
    expect(readBlocks().at(-1)).toBe("Ada waiting on you");
    expect(findConversation().querySelector(".cr--animated")).toBeNull();

    await user.click(
      within(screen.getByRole("group", { name: "Run this command?" })).getByRole("button", {
        name: "Allow",
      }),
    );

    await waitFor(() => {
      expect(calls.filter((call) => call.path === respond).map((call) => call.body)).toMatchObject([
        { requestId: "req-1", decision: "allow" },
      ]);
    });
  });
});

describe("the Conversation's pages", () => {
  /** Returns the whole numbers from `first` to `last`. */
  const range = (first: number, last: number): number[] =>
    Array.from({ length: last - first + 1 }, (_, index) => first + index);

  /**
   * Returns the positions of the messages the cache holds for Ada's
   * Conversation, oldest first. Only the blocks near the bottom are drawn,
   * so the pages read are checked in the cache.
   */
  const readHeldPositions = (queryClient: QueryClient): number[] =>
    flattenMessagePages(
      queryClient.getQueryData<MessagePages>(queryKeys.conversationMessages(ADA.mainConversationId))
        ?.pages ?? [],
    ).map((message) => message.position);

  /** Sixty messages: the newest fifty are the first page, and the other ten the next. */
  const buildSixtyMessages = (): ConversationMessage[] =>
    Array.from({ length: 60 }, (_, index) =>
      buildFixtureMessage(ADA, { position: index + 1, text: `Message ${String(index + 1)}` }),
    );

  /**
   * Gives the Conversation a size, since jsdom lays nothing out: `height`
   * pixels of content in 800, scrolled to `top`. Returns a function that
   * scrolls it to another place, as the user would.
   */
  const sizeConversation = (height: number, top: number): ((top: number) => void) => {
    const conversation = findConversation();
    let scrollTop = top;
    Object.defineProperties(conversation, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => 800 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    return (next) => {
      scrollTop = next;
      fireEvent.scroll(conversation);
    };
  };

  it("reads the page of earlier messages when the reader scrolls within one screen of the top", async () => {
    const { calls, context } = await openConversation({ messages: buildSixtyMessages() });
    expect(readHeldPositions(context.queryClient)).toEqual(range(11, 60));
    const scrollTo = sizeConversation(4000, 3200);

    scrollTo(1000);
    expect(findPageReads(calls)).toHaveLength(2);
    scrollTo(700);

    await waitFor(() => {
      expect(readHeldPositions(context.queryClient)).toEqual(range(1, 60));
    });
    const reads = findPageReads(calls);
    expect(reads).toHaveLength(3);
    expect(new URLSearchParams(reads[2]!.search).get("cursor")).toBe("11");
    // Every page is read, so scrolling to the top again reads nothing.
    scrollTo(0);
    expect(findPageReads(calls)).toHaveLength(3);
  });

  it("reads only the newest page on a push, however many pages are held, also on a push that names no conversation", async () => {
    const messages = buildSixtyMessages();
    const { calls, live, context } = await openConversation({ messages });
    sizeConversation(4000, 3200)(0);
    await waitFor(() => {
      expect(readHeldPositions(context.queryClient)).toEqual(range(1, 60));
    });
    const before = findPageReads(calls).length;

    messages.push(buildReply(61, "Message 61"));
    act(() => {
      live.pushInvalidation("conversation", [ADA.mainConversationId]);
    });
    await waitFor(() => {
      expect(readBlocks().at(-1)).toBe("Ada 12:01Message 61");
    });
    // The page with no cursor is the newest page; the earlier pages are kept.
    const afterPush = findPageReads(calls).slice(before);
    expect(afterPush.map((call) => new URLSearchParams(call.search).get("cursor"))).toEqual([null]);
    expect(readHeldPositions(context.queryClient)).toEqual(range(1, 61));

    // The push after a reconnect names no conversation, so it reaches every
    // one, this one too.
    messages.push(buildReply(62, "Message 62"));
    act(() => {
      live.pushInvalidation("conversation");
    });
    await waitFor(() => {
      expect(readBlocks().at(-1)).toBe("Ada 12:02Message 62");
    });
    expect(findPageReads(calls).slice(before)).toHaveLength(2);
    expect(readHeldPositions(context.queryClient)).toEqual(range(1, 62));
  });

  it("ignores a push about another conversation", async () => {
    const { calls, live } = await openConversation({ messages: [QUESTION] });

    act(() => {
      live.pushInvalidation("conversation", ["01a06d02-c000-7000-8000-0000000000ff"]);
    });

    // Pushes are handed on in order, so once a push about this conversation
    // has been read, the one before it would have been read too.
    act(() => {
      live.pushInvalidation("conversation", [ADA.mainConversationId]);
    });
    await waitFor(() => {
      expect(findPageReads(calls)).toHaveLength(3);
    });
    await act(() => Promise.resolve());
    expect(findPageReads(calls)).toHaveLength(3);
  });
});

describe("the Conversation's live topics", () => {
  it("follows a new current session to its own stream", async () => {
    const NEXT_ID = "01a06d02-a100-7000-8000-000000000004";
    let session: Session = buildAdaSession();
    const { live } = await openConversation({
      readSession: () => session,
      messages: [QUESTION],
      transcript: buildAdaTranscript(TURN_STARTED),
      handlers: { [`GET /api/v1/sessions/${NEXT_ID}/transcript`]: { body: { items: [] } } },
    });

    session = buildAdaSession({ id: NEXT_ID });
    act(() => {
      live.pushInvalidation("session", [NEXT_ID], { [NEXT_ID]: ADA.mainConversationId });
    });

    await waitFor(() => {
      expect(live.readTopics()).toContain(buildSessionStreamTopic(NEXT_ID));
    });
    expect(live.readTopics()).toContain(buildSessionTapTopic(NEXT_ID));
    expect(live.readTopics()).not.toContain(buildSessionStreamTopic(SESSION_ID));
    expect(live.readTopics()).not.toContain(buildSessionTapTopic(SESSION_ID));
  });

  it("leaves the conversation topic, and drops the messages, when the user leaves the Conversation", async () => {
    const thread = THREAD_FIXTURES.finished;
    const { live, router, context } = await openConversation({
      readSession: buildAdaSession,
      messages: [QUESTION],
      transcript: buildAdaTranscript(TURN_STARTED),
      handlers: buildThreadHandlers(thread),
    });

    await act(() =>
      router.navigate({ to: "/threads/$sessionId", params: { sessionId: thread.session.id } }),
    );

    await waitFor(() => {
      expect(live.readTopics()).not.toContain("conversation");
    });
    expect(live.readTopics()).not.toContain(buildSessionStreamTopic(SESSION_ID));
    const { queryClient } = context;
    expect(queryClient.getQueryData(queryKeys.conversationMessages(ADA.mainConversationId))).toBe(
      undefined,
    );
    expect(queryClient.getQueryData(queryKeys.runningTurn(SESSION_ID))).toBe(undefined);
  });
});
