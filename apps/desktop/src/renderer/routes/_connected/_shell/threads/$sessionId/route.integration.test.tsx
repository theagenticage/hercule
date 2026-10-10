/**
 * Tests the thread route's loading: the reads it makes before the screen
 * renders, the thread it stores as the last open one, what it shows when
 * the thread does not exist or cannot be read, and the sender it names on a
 * message another session's agent sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import type { TranscriptRow } from "@hercule/contract";
import userEvent from "@testing-library/user-event";
import { queryKeys } from "@hercule/client-core";
import {
  createLaunchHistory,
  readLastThread,
  rememberLastThread,
} from "../../../../../app/last-thread";
import {
  buildErrorBody,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
} from "../../../../../app/testing";

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

  it("stores the thread as the last open one for its controller", async () => {
    const { app } = openApp(`/threads/${sessionId}`);
    await app;
    expect(readLastThread(CONTROLLER_URL)).toBe(sessionId);
    expect(readLastThread("http://another.test")).toBeNull();
  });

  it("shows that a thread is not found, with a link to a new thread, and forgets it", async () => {
    rememberLastThread(CONTROLLER_URL, GONE_ID);
    const { app } = openApp(`/threads/${GONE_ID}`);
    const { router } = await app;

    expect(router.state.location.pathname).toBe(`/threads/${GONE_ID}`);
    const heading = screen.getByRole("heading", { name: "This thread was not found." });
    // The screen fills the main pane, beside the sidebar, not the whole window.
    expect(screen.getByRole("main").contains(heading)).toBe(true);
    expect(readLastThread(CONTROLLER_URL)).toBeNull();

    await userEvent.click(screen.getByRole("link", { name: "Start a new thread" }));
    expect(router.state.location.pathname).toBe("/");
  });

  it("asks for a gone thread once, rather than retrying a 404", async () => {
    const { app, calls } = openApp(`/threads/${GONE_ID}`);
    await app;
    expect(calls.filter((call) => call.path === `/api/v1/sessions/${GONE_ID}`)).toHaveLength(1);
  });

  it("forgets the thread open before a gone one, so the next launch starts at the new-thread screen", async () => {
    const { app } = openApp(`/threads/${sessionId}`);
    const { router } = await app;
    await act(() => router.navigate({ to: "/threads/$sessionId", params: { sessionId: GONE_ID } }));
    expect(screen.getByRole("heading", { name: "This thread was not found." })).toBeTruthy();
    expect(createLaunchHistory(CONTROLLER_URL).location.pathname).toBe("/");
  });

  it("shows the render failure at once for another error, and keeps the thread stored", async () => {
    rememberLastThread(CONTROLLER_URL, sessionId);
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
    expect(readLastThread(CONTROLLER_URL)).toBe(sessionId);
  });

  it("stores the thread the user opens last", async () => {
    const { app } = openApp(`/threads/${sessionId}`, buildThreadHandlers(THREAD_FIXTURES.failed));
    const { router } = await app;
    await act(() =>
      router.navigate({
        to: "/threads/$sessionId",
        params: { sessionId: THREAD_FIXTURES.failed.session.id },
      }),
    );
    expect(readLastThread(CONTROLLER_URL)).toBe(THREAD_FIXTURES.failed.session.id);
  });

  it("forgets the thread when the user leaves it for the new-thread screen", async () => {
    const { app } = openApp(`/threads/${sessionId}`);
    const { router } = await app;
    await act(() => router.navigate({ to: "/" }));
    // The next launch starts where this one quit.
    expect(createLaunchHistory(CONTROLLER_URL).location.pathname).toBe("/");
  });
});

describe("a message another session's agent sent into the thread", () => {
  const thread = THREAD_FIXTURES.finished;
  const sessionId = thread.session.id;
  /** "Write the retry runbook", whose agent sent the thread's first message. */
  const RUNBOOK = SIDEBAR_FIXTURE.threads[0]!;
  const senderPath = `/api/v1/sessions/${RUNBOOK.id}`;

  /**
   * The finished thread's transcript, with its user message sent by the
   * runbook's agent, and a second message from the same agent right after
   * it. The rows are numbered again, so each keeps a position and an event
   * id of its own.
   */
  const transcript: TranscriptRow[] = thread.transcript
    .flatMap((row): TranscriptRow[] => {
      const { event } = row;
      if (event._tag !== "item.started" && event._tag !== "item.completed") return [row];
      if (event.kind !== "user_message") return [row];
      if (event._tag === "item.started") {
        // The fixture's user message detail is an object that holds its text.
        const detail = {
          ...(event.detail as Record<string, unknown>),
          senderSessionId: RUNBOOK.id,
        };
        return [{ ...row, event: { ...event, detail } }];
      }
      const itemId = `${event.itemId}-again`;
      const detail = { text: "Then tag the release.", senderSessionId: RUNBOOK.id };
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

  beforeEach(() => {
    stubElementSize(800, 800);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the sender before the screen renders, and names it in a chip linked to its thread", async () => {
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      ...buildThreadHandlers({ ...thread, transcript }),
      [`GET ${senderPath}`]: { body: RUNBOOK },
    });
    const { context } = await app;

    expect(context.queryClient.getQueryData(queryKeys.sender(RUNBOOK.id))).toEqual(RUNBOOK);
    const [first, second] = await screen.findAllByRole("group", {
      name: `Message from ${RUNBOOK.title}`,
    });
    const chip = within(first!).getByRole("link", { name: RUNBOOK.title });
    expect(chip.getAttribute("href")).toBe(`/threads/${RUNBOOK.id}`);
    expect(within(first!).getByText(/Bump the Bun pin to 1\.3\.2/)).toBeTruthy();
    expect(within(second!).getByText("Then tag the release.")).toBeTruthy();
    // One read for the sender, however many of its messages the thread holds.
    expect(calls.filter((call) => call.path === senderPath)).toHaveLength(1);
  });

  it("opens the thread after one read of a sender that got no answer, rather than retrying it first", async () => {
    const { app, calls } = openApp(`/threads/${sessionId}`, {
      ...buildThreadHandlers({ ...thread, transcript }),
      [`GET ${senderPath}`]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await app;

    // Retries in the loader would hold the thread's first paint for seconds,
    // for a name, and this test would time out. There are two reads: the
    // loader's, and the one the messages make when they mount, because a
    // read that failed is tried again by the next component that shows it.
    // The two messages share that one read.
    expect(
      await screen.findAllByRole("group", { name: "Message from another agent" }),
    ).toHaveLength(2);
    expect(calls.filter((call) => call.path === senderPath)).toHaveLength(2);
  });
});
