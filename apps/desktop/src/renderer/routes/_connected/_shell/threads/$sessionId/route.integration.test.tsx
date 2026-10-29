/**
 * Tests the thread route's loading: the reads it makes before the screen
 * renders, what it shows while a slow thread opens, what it shows when the
 * thread does not exist or cannot be read,
 * and the sender it names on a message another session's agent sent, which
 * it waits for only briefly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { Session, TranscriptRow } from "@hercule/contract";
import userEvent from "@testing-library/user-event";
import { focusManager } from "@tanstack/react-query";
import { isNotFound, queryKeys } from "@hercule/client-core";
import { buildSessionStreamTopic } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  holdAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
} from "../../../../../app/testing";
import { threadAndAgentSessionsQuery } from "../../../../../app/queries";
import { answerTranscriptRead, readTranscriptReads } from "../../../../../app/testing-transcript";
import { saveThreadCopy } from "../../../../../app/testing-thread-copies";

/** A thread id no controller holds. */
const GONE_ID = "01a06d02-7400-7000-8000-0000000000ff";

/** Starts the app signed in at `path`, with the sidebar fixture and the finished thread's reads. */
const openApp = (path: string, handlers: Parameters<typeof stubApi>[0] = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    ...buildThreadHandlers(THREAD_FIXTURES.finished),
    ...handlers,
  });
  const app = renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
    path,
  });
  return { calls, app };
};

describe("the thread route", () => {
  const thread = THREAD_FIXTURES.finished;
  const sessionId = thread.session.id;

  it("reads the session, its subagents, the transcript and the queued inputs before the screen renders", async () => {
    const { app, calls } = openApp(`/threads/${sessionId}`);
    const { router, context } = await app;
    expect(calls.map((call) => call.path)).toContain(`/api/v1/sessions/${sessionId}/subagents`);
    expect(router.state.location.pathname).toBe(`/threads/${sessionId}`);
    const cache = context.queryClient;
    expect(cache.getQueryData(queryKeys.session(sessionId))).toEqual(thread.session);
    expect(cache.getQueryData(queryKeys.transcript(sessionId))).toEqual(thread.transcript);
    expect(cache.getQueryData(queryKeys.inputs(sessionId))).toEqual([]);
  });

  it("reads every page of a transcript that does not fit on one", async () => {
    const transcriptPath = `/api/v1/sessions/${sessionId}/transcript`;
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: (call) =>
        new URLSearchParams(call.search).get("cursor") === "page-2"
          ? { body: { items: thread.transcript.slice(10) } }
          : { body: { items: thread.transcript.slice(0, 10), nextCursor: "page-2" } },
    });
    const { context } = await app;
    expect(context.queryClient.getQueryData(queryKeys.transcript(sessionId))).toEqual(
      thread.transcript,
    );
    expect(
      calls
        .filter((call) => call.path === transcriptPath)
        .map((call) => new URLSearchParams(call.search).get("cursor")),
    ).toEqual([null, "page-2"]);
  });

  it("shows that a thread is not found, with a link to a new thread", async () => {
    const { app } = openApp(`/threads/${GONE_ID}`);
    const { router } = await app;

    expect(router.state.location.pathname).toBe(`/threads/${GONE_ID}`);
    const heading = screen.getByRole("heading", { name: "This thread was not found." });
    // The screen fills the main pane, beside the sidebar, not the whole window.
    expect(screen.getByRole("main").contains(heading)).toBe(true);

    await userEvent.click(screen.getByRole("link", { name: "Start a new thread" }));
    expect(router.state.location.pathname).toBe("/");
  });

  it("asks for a gone thread once, rather than retrying a 404", async () => {
    const { app, calls } = openApp(`/threads/${GONE_ID}`);
    await app;
    expect(calls.filter((call) => call.path === `/api/v1/sessions/${GONE_ID}`)).toHaveLength(1);
  });

  it("shows the render failure at once for another error", async () => {
    const transcriptPath = `/api/v1/sessions/${sessionId}/transcript`;
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: {
        status: 500,
        body: buildErrorBody("internal", "The transcript could not be read."),
      },
    });
    await app;
    expect(screen.getByRole("heading", { name: "This screen did not load" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("The transcript could not be read.");
    // The controller answered, so asking again would get the same answer.
    expect(calls.filter((call) => call.path === transcriptPath)).toHaveLength(1);
  });
});

describe("a thread that is slow to open", () => {
  const sessionId = THREAD_FIXTURES.finished.session.id;

  beforeEach(() => {
    // The transcript draws only the rows that fit its box, which jsdom
    // measures as empty.
    stubElementSize(800, 800);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the clicked thread while its transcript is still being read, then shows the transcript", async () => {
    const slow = THREAD_FIXTURES.failed;
    let answer = (): void => {};
    const { app } = openApp(`/threads/${sessionId}`, {
      ...buildThreadHandlers(slow),
      [`GET /api/v1/sessions/${slow.session.id}/transcript`]: () =>
        new Promise((resolve) => {
          answer = () => resolve({ body: { items: slow.transcript } });
        }),
    });
    const { router } = await app;
    expect(
      await screen.findByText("Bump the Bun pin to 1.3.2 and make sure CI still passes."),
    ).toBeTruthy();

    const sidebar = screen.getByRole("navigation", { name: "Threads" });
    await userEvent.click(
      within(sidebar).getByRole("link", { name: new RegExp(`^${slow.session.title}`) }),
    );

    // The previous thread leaves the screen, and the header names the
    // clicked thread, from the sidebar's list. React keeps the previous
    // thread mounted but hidden until the new one renders, so the queries
    // by role, which skip hidden elements, tell what is on screen.
    expect(await screen.findByText("Opening the thread…")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Transcript" })).toBeNull();
    const tabs = screen.getByRole("navigation", { name: "Sessions in this workspace" });
    expect(
      within(tabs)
        .getByRole("link", { name: new RegExp(`^${slow.session.title}`) })
        .getAttribute("aria-current"),
    ).toBe("page");

    answer();
    expect(await screen.findByRole("region", { name: "Transcript" })).toBeTruthy();
    expect(screen.queryByText("Opening the thread…")).toBeNull();
    expect(
      screen.queryByText("Bump the Bun pin to 1.3.2 and make sure CI still passes."),
    ).toBeNull();
    expect(router.state.location.pathname).toBe(`/threads/${slow.session.id}`);
  });
});

describe("a thread that is slow to open, marked Done from the sidebar", () => {
  beforeEach(() => {
    stubElementSize(800, 800);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens once its read is answered, without cancelling that read", async () => {
    const slow = THREAD_FIXTURES.failed;
    const heldSession = holdAnswer();
    const { app } = openApp(`/threads/${THREAD_FIXTURES.finished.session.id}`, {
      ...buildThreadHandlers(slow),
      [`GET /api/v1/sessions/${slow.session.id}`]: heldSession.handler,
      "POST /api/v1/sessions/mark-done": {
        body: [{ ...slow.session, done: { at: "2026-09-10T09:30:00.000Z", by: "user" } }],
      },
    });
    await app;
    const sidebar = screen.getByRole("navigation", { name: "Threads" });
    const link = within(sidebar).getByRole("link", { name: new RegExp(`^${slow.session.title}`) });
    await userEvent.click(link);
    expect(await screen.findByText("Opening the thread…")).toBeTruthy();

    await userEvent.click(
      within(link.closest<HTMLElement>(".side-item")!).getByRole("button", { name: "Mark done" }),
    );
    heldSession.answer({ body: slow.session });

    expect(await screen.findByRole("region", { name: "Transcript" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This screen did not load" })).toBeNull();
  });
});

describe("a message another session's agent sent into the thread", () => {
  const thread = THREAD_FIXTURES.finished;
  const sessionId = thread.session.id;
  /**
   * A session the sidebar's lists do not hold, as an archived or another
   * user's would be, so naming it takes a read of its own.
   */
  const RUNBOOK: Session = {
    ...SIDEBAR_FIXTURE.threads[0]!,
    id: "01a06d02-7400-7000-8000-0000000000b1",
    title: "Archive the old runbook",
  };
  const senderPath = `/api/v1/sessions/${RUNBOOK.id}`;

  /**
   * Returns the finished thread's transcript, with its user message sent by
   * the agent of session `senderId`, and a second message from the same
   * agent right after it. The rows are numbered again, so each keeps a
   * position and an event id of its own.
   */
  const buildTranscript = (senderId: string): TranscriptRow[] =>
    thread.transcript
      .flatMap((row): TranscriptRow[] => {
        const { event } = row;
        if (event._tag !== "item.started" && event._tag !== "item.completed") return [row];
        if (event.kind !== "user_message") return [row];
        if (event._tag === "item.started") {
          // The fixture's user message detail is an object that holds its text.
          const detail = {
            ...(event.detail as Record<string, unknown>),
            senderSessionId: senderId,
          };
          return [{ ...row, event: { ...event, detail } }];
        }
        const itemId = `${event.itemId}-again`;
        const detail = { text: "Then tag the release.", senderSessionId: senderId };
        const { turnId, kind, eventId, sessionId, at } = event;
        return [
          row,
          {
            ...row,
            event: { _tag: "item.started", turnId, itemId, kind, detail, eventId, sessionId, at },
          },
          { ...row, event: { ...event, itemId, detail } },
        ];
      })
      .map((row, index) => ({
        ...row,
        position: index + 1,
        event: { ...row.event, eventId: `event-${String(index + 1)}` },
      }));
  const transcript = buildTranscript(RUNBOOK.id);

  beforeEach(() => {
    stubElementSize(800, 800);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the sender before the screen renders, and names it in a chip linked to its thread", async () => {
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      ...buildThreadHandlers({ ...thread, transcript }),
      // The sender answers after the thread's own reads, but well inside the
      // loader's wait.
      [`GET ${senderPath}`]: () =>
        new Promise((resolve) => setTimeout(() => resolve({ body: RUNBOOK }), 50)),
    });
    const { context } = await app;

    expect(context.queryClient.getQueryData(queryKeys.sender(RUNBOOK.id))).toEqual(RUNBOOK);
    // Nothing is awaited here: the loader waited for the sender, so the
    // first paint already names it.
    const [first, second] = screen.getAllByRole("group", {
      name: `Message from ${RUNBOOK.title}`,
    });
    const chip = within(first!).getByRole("link", { name: RUNBOOK.title });
    expect(chip.getAttribute("href")).toBe(`/threads/${RUNBOOK.id}`);
    expect(within(first!).getByText(/Bump the Bun pin to 1\.3\.2/)).toBeTruthy();
    expect(within(second!).getByText("Then tag the release.")).toBeTruthy();
    // One read for the sender, however many of its messages the thread holds.
    expect(calls.filter((call) => call.path === senderPath)).toHaveLength(1);
  });

  it("names a sender the sidebar's lists hold from them, without a read, and follows its title", async () => {
    const listed = SIDEBAR_FIXTURE.threads[0]!;
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      ...buildThreadHandlers({ ...thread, transcript: buildTranscript(listed.id) }),
    });
    const { context } = await app;

    expect(screen.getAllByRole("group", { name: `Message from ${listed.title}` })).toHaveLength(2);
    expect(calls.filter((call) => call.path === `/api/v1/sessions/${listed.id}`)).toHaveLength(0);

    // A push renames the session in the lists, and the messages follow.
    const key = threadAndAgentSessionsQuery(context.controller!.client).queryKey;
    const threads = context.queryClient.getQueryData<readonly Session[]>(key)!;
    act(() => {
      context.queryClient.setQueryData(
        key,
        threads.map((each) =>
          each.id === listed.id ? { ...each, title: "Ship the runbook" } : each,
        ),
      );
    });
    expect(
      await screen.findAllByRole("group", { name: "Message from Ship the runbook" }),
    ).toHaveLength(2);
    expect(calls.filter((call) => call.path === `/api/v1/sessions/${listed.id}`)).toHaveLength(0);
  });

  it("opens the thread while the sender's read gets no answer, and names the sender once it answers", async () => {
    let answer = (): void => {};
    const { app } = openApp(`/threads/${sessionId}`, {
      ...buildThreadHandlers({ ...thread, transcript }),
      [`GET ${senderPath}`]: () =>
        new Promise((resolve) => {
          answer = () => resolve({ body: RUNBOOK });
        }),
    });
    // The loader waits for the sender for at most a second, then the app's
    // loaders resolve and the transcript shows while the read is still
    // unanswered.
    await app;
    expect(await screen.findByText("Then tag the release.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: /^Message from/ })).toBeNull();

    answer();
    expect(
      await screen.findAllByRole("group", { name: `Message from ${RUNBOOK.title}` }),
    ).toHaveLength(2);
  });

  it("reads a sender whose read failed only once, however often its messages mount or the window is focused", async () => {
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      ...buildThreadHandlers({ ...thread, transcript }),
      [`GET ${senderPath}`]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const { router } = await app;
    expect(
      await screen.findAllByRole("group", { name: "Message from another agent" }),
    ).toHaveLength(2);

    // Leaving the thread and opening it again runs its loader again and
    // mounts its messages again.
    for (let visit = 0; visit < 3; visit += 1) {
      await act(() => router.navigate({ to: "/" }));
      await act(() => router.navigate({ to: "/threads/$sessionId", params: { sessionId } }));
      expect(
        await screen.findAllByRole("group", { name: "Message from another agent" }),
      ).toHaveLength(2);
    }
    // Focusing the window again does not read it either. A read focus started
    // would be sent within the wait.
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    focusManager.setFocused(undefined);
    expect(calls.filter((call) => call.path === senderPath)).toHaveLength(1);
  });
});

describe("a thread opened from its saved copy", () => {
  const thread = THREAD_FIXTURES.finished;
  const sessionId = thread.session.id;
  const transcriptPath = `/api/v1/sessions/${sessionId}/transcript`;
  const stream = buildSessionStreamTopic(sessionId);
  // The copy was saved before the agent's last answer.
  const copiedRows = thread.transcript.slice(0, -4);
  const lastCopiedPosition = copiedRows.at(-1)!.position;
  const lastPosition = thread.transcript.at(-1)!.position;
  const ANSWER = /The pin is now/;

  beforeEach(() => {
    stubElementSize(800, 800);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the copy at once, reads only the rows after it, and subscribes the stream from the newest row after that", async () => {
    await saveThreadCopy(thread, { transcript: copiedRows });
    const transcriptRead = holdAnswer();
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: transcriptRead.handler,
    });
    const { context, live } = await app;

    // The app opened while the read of the newer rows is still out.
    expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy();
    expect(
      screen.getByText("Bump the Bun pin to 1.3.2 and make sure CI still passes."),
    ).toBeTruthy();
    expect(screen.queryByText(ANSWER)).toBeNull();
    // The read starts at the last row of the copy, to check it is still there.
    expect(readTranscriptReads(calls, sessionId)).toEqual([
      { after: String(copiedRows.at(-2)!.position), subagentId: null },
    ]);
    expect(live.readTopics()).not.toContain(stream);
    // The session, the subagents and the queued inputs are read again.
    await waitFor(() => {
      expect(calls.filter((call) => call.path === `/api/v1/sessions/${sessionId}`)).toHaveLength(1);
    });

    const subscribe = vi.spyOn(context.controller!.live, "subscribe");
    transcriptRead.answer({
      body: { items: thread.transcript.filter((row) => row.position >= lastCopiedPosition) },
    });

    expect(await screen.findByText(ANSWER)).toBeTruthy();
    await waitFor(() => {
      expect(live.readTopics()).toContain(stream);
    });
    expect(subscribe).toHaveBeenCalledWith(stream, expect.any(Function), String(lastPosition));
    expect(context.queryClient.getQueryData(queryKeys.transcript(sessionId))).toEqual(
      thread.transcript,
    );
    // The whole transcript was never read.
    expect(readTranscriptReads(calls, sessionId)).toHaveLength(1);
  });

  it("subscribes the stream from the copy's newest row when the read of the newer rows fails, and logs the failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await saveThreadCopy(thread, { transcript: copiedRows });
    const transcriptRead = holdAnswer();
    const { app } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: transcriptRead.handler,
    });
    const { context, live } = await app;
    expect(live.readTopics()).not.toContain(stream);
    const subscribe = vi.spyOn(context.controller!.live, "subscribe");
    transcriptRead.answer({
      status: 500,
      body: buildErrorBody("internal", "The transcript could not be read."),
    });

    await waitFor(() => {
      expect(live.readTopics()).toContain(stream);
    });
    expect(subscribe).toHaveBeenCalledWith(
      stream,
      expect.any(Function),
      String(lastCopiedPosition),
    );
    expect(screen.queryByText(ANSWER)).toBeNull();
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("up to date"), expect.anything());
  });

  it("shows that the thread was not found, and deletes the copy, when the read of the newer rows says it is gone", async () => {
    await saveThreadCopy(thread, { transcript: copiedRows });
    const gone = {
      status: 404,
      body: buildErrorBody("not_found", "no such session"),
    };
    const { app } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: gone,
      [`GET /api/v1/sessions/${sessionId}`]: gone,
    });
    const { context } = await app;

    expect(await screen.findByRole("heading", { name: "This thread was not found." })).toBeTruthy();
    await waitFor(async () => {
      expect(await context.controller!.threadCopies.read(sessionId)).toBeUndefined();
    });
  });

  it("deletes the copy and reads the session again when the stream says the thread is gone", async () => {
    await saveThreadCopy(thread);
    const gone = { status: 404, body: buildErrorBody("not_found", "no such session") };
    let isGone = false;
    const transcriptRead = holdAnswer();
    const { app } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: transcriptRead.handler,
      [`GET /api/v1/sessions/${sessionId}`]: () => (isGone ? gone : { body: thread.session }),
    });
    const { context } = await app;
    // The page subscribes once the read of the newer rows has ended; catch the stream's handler then.
    const { live } = context.controller!;
    const handlers = new Map<string, Parameters<typeof live.subscribe>[1]>();
    const subscribe = live.subscribe.bind(live);
    vi.spyOn(live, "subscribe").mockImplementation((topic, handler, cursor) => {
      handlers.set(topic, handler);
      return subscribe(topic, handler, cursor);
    });
    transcriptRead.answer({ body: { items: thread.transcript.slice(-1) } });
    await waitFor(() => {
      expect(handlers.has(stream)).toBe(true);
    });

    isGone = true;
    act(() => {
      handlers.get(stream)!({
        cursor: null,
        items: [],
        reset: false,
        replay: false,
        gone: true,
        unreadable: false,
      });
    });

    await waitFor(async () => {
      expect(await context.controller!.threadCopies.read(sessionId)).toBeUndefined();
    });
    await waitFor(() => {
      expect(
        isNotFound(context.queryClient.getQueryState(queryKeys.session(sessionId))?.error),
      ).toBe(true);
    });
  });

  it("keeps no copy when the page closes while the session is read again after a gone stream", async () => {
    await saveThreadCopy(thread);
    const gone = { status: 404, body: buildErrorBody("not_found", "no such session") };
    let isGone = false;
    let releaseSession: () => void = () => undefined;
    const sessionReleased = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const transcriptRead = holdAnswer();
    const { app } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: transcriptRead.handler,
      [`GET /api/v1/sessions/${sessionId}`]: async () => {
        if (!isGone) return { body: thread.session };
        await sessionReleased;
        return gone;
      },
    });
    const { context, router } = await app;
    const { live, threadCopies } = context.controller!;
    const handlers = new Map<string, Parameters<typeof live.subscribe>[1]>();
    const subscribe = live.subscribe.bind(live);
    vi.spyOn(live, "subscribe").mockImplementation((topic, handler, cursor) => {
      handlers.set(topic, handler);
      return subscribe(topic, handler, cursor);
    });
    const save = vi.spyOn(threadCopies, "save");
    transcriptRead.answer({ body: { items: thread.transcript.slice(-1) } });
    await waitFor(() => {
      expect(handlers.has(stream)).toBe(true);
    });

    isGone = true;
    act(() => {
      handlers.get(stream)!({
        cursor: null,
        items: [],
        reset: false,
        replay: false,
        gone: true,
        unreadable: false,
      });
    });
    // The session read is out and has not said the thread is gone yet: the
    // user leaves the page, and closing it saves the copy.
    await act(() => router.navigate({ to: "/" }));
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
    releaseSession();

    await waitFor(() => {
      expect(
        isNotFound(context.queryClient.getQueryState(queryKeys.session(sessionId))?.error),
      ).toBe(true);
    });
    // The save that closing the page made has been written or dropped by now.
    await Promise.all(save.mock.results.map((result) => result.value as Promise<void>));
    expect(await threadCopies.read(sessionId)).toBeUndefined();
  });

  it("shows Syncing… in the header while the read of the newer rows runs past 400 ms, and not after it ends", async () => {
    await saveThreadCopy(thread, { transcript: copiedRows });
    const transcriptRead = holdAnswer();
    const { app } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: transcriptRead.handler,
    });
    await app;

    expect(await screen.findByText("Syncing…", {}, { timeout: 3000 })).toBeTruthy();

    transcriptRead.answer({
      body: { items: thread.transcript.filter((row) => row.position >= lastCopiedPosition) },
    });
    await waitFor(() => {
      expect(screen.queryByText("Syncing…")).toBeNull();
    });
    expect(await screen.findByText(ANSWER)).toBeTruthy();
  });

  it("goes to the new-thread screen when the app opened the gone thread at launch", async () => {
    localStorage.setItem(`last-screen:${CONTROLLER_URL}`, `/threads/${sessionId}`);
    await saveThreadCopy(thread, { transcript: copiedRows });
    const gone = {
      status: 404,
      body: buildErrorBody("not_found", "no such session"),
    };
    stubApi({
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
      ...buildThreadHandlers(thread),
      [`GET ${transcriptPath}`]: gone,
      [`GET /api/v1/sessions/${sessionId}`]: gone,
    });
    const { router } = await renderApp(
      createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
  });

  it("opens the thread without a copy as it always did: reads all of it and subscribes at once", async () => {
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: answerTranscriptRead(thread),
    });
    const { context, live } = await app;

    expect(readTranscriptReads(calls, sessionId)).toEqual([{ after: null, subagentId: null }]);
    // The transcript is not being read, so nothing waits to subscribe.
    expect(context.queryClient.isFetching({ queryKey: queryKeys.transcript(sessionId) })).toBe(0);
    await waitFor(() => {
      expect(live.readTopics()).toContain(stream);
    });
    expect(readTranscriptReads(calls, sessionId)).toHaveLength(1);
  });

  it("ignores the copy when the transcript is already cached", async () => {
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      [`GET ${transcriptPath}`]: answerTranscriptRead(thread),
    });
    const { router } = await app;
    await act(() => router.navigate({ to: "/" }));
    // The first visit saved a copy; make it older than the cache.
    await saveThreadCopy(thread, { transcript: copiedRows });
    await act(() => router.navigate({ to: "/threads/$sessionId", params: { sessionId } }));

    expect(await screen.findByText(ANSWER)).toBeTruthy();
    // Only the first visit read the transcript.
    expect(readTranscriptReads(calls, sessionId)).toEqual([{ after: null, subagentId: null }]);
  });
});
