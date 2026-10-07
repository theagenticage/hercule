/**
 * Tests a subagent's page as the app opens it: the subagent's transcript read
 * and followed over the subagent's own live topics, the move back to the
 * thread's page, what it shows when the thread has no such subagent, and
 * the status card's Stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type Session,
  type Subagent,
  buildSessionStreamTopic,
  buildSessionTapTopic,
  buildSubagentStreamTopic,
  buildSubagentTapTopic,
} from "@hercule/contract";
import {
  buildNextRows,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  FIXTURE_SUBAGENT,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
} from "../../../../../../app/testing";

const THREAD = THREAD_FIXTURES.delegating;
const SESSION_ID = THREAD.session.id;
const SUBAGENT_ID = FIXTURE_SUBAGENT.id;
const THREAD_STREAM = buildSessionStreamTopic(SESSION_ID);
const THREAD_TAP = buildSessionTapTopic(SESSION_ID);
const SUBAGENT_STREAM = buildSubagentStreamTopic(SESSION_ID, SUBAGENT_ID);
const SUBAGENT_TAP = buildSubagentTapTopic(SESSION_ID, SUBAGENT_ID);

/** The words of the subagent's brief, the first message of its transcript. */
const SUBAGENT_BRIEF = "Find which webhook test fails, and why.";

/** The words of the user's message, the first message of the thread's own transcript. */
const THREAD_MESSAGE = "The webhook tests fail about one run in five. Find out why and fix it.";

beforeEach(() => {
  stubElementSize(800, 800);
});

afterEach(() => {
  vi.restoreAllMocks();
  setVisibility("visible");
});

/** Starts the app signed in at `path`, with the delegating thread's reads. */
const openApp = (path: string) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, providers: [FIXTURE_INSTANCE] }),
    ...buildThreadHandlers(THREAD),
  });
  return renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
    path,
  }).then((app) => ({ ...app, calls }));
};

/** Returns the live topics of one agent's transcript the app is subscribed to. */
const readAgentTopics = (topics: readonly string[]): string[] =>
  topics.filter((topic) => topic.endsWith(":stream") || topic.endsWith(":tap"));

describe("the subagent's page", () => {
  it("opens from its URL and follows the subagent's topics instead of the thread's", async () => {
    const { live, calls } = await openApp(`/threads/${SESSION_ID}/subagents/${SUBAGENT_ID}`);

    expect(await screen.findByText(SUBAGENT_BRIEF)).toBeTruthy();
    // The brief is drawn as the brief card, a button that expands it, and
    // not as a message of the transcript.
    expect(screen.getByRole("button", { name: SUBAGENT_BRIEF })).toBeTruthy();
    expect(document.querySelectorAll(".brief-card")).toHaveLength(1);
    expect(screen.queryByText(THREAD_MESSAGE)).toBeNull();
    // A subagent takes no messages, so its page has no composer.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      calls.some(
        (call) =>
          call.path === `/api/v1/sessions/${SESSION_ID}/transcript` &&
          new URLSearchParams(call.search).get("subagentId") === SUBAGENT_ID,
      ),
    ).toBe(true);
    await waitFor(() => {
      expect(readAgentTopics(live.readTopics())).toEqual([SUBAGENT_STREAM, SUBAGENT_TAP]);
    });
    // The thread keeps its subagents current while the page is open.
    const subagentsPath = `/api/v1/sessions/${SESSION_ID}/subagents`;
    const readsBefore = calls.filter((call) => call.path === subagentsPath).length;
    act(() => {
      live.pushInvalidation("subagent", [SESSION_ID]);
    });
    await waitFor(() => {
      expect(calls.filter((call) => call.path === subagentsPath).length).toBe(readsBefore + 1);
    });
  });

  it("swaps back to the thread's topics on the thread's page, which catches up", async () => {
    const { live, router } = await openApp(`/threads/${SESSION_ID}/subagents/${SUBAGENT_ID}`);
    await screen.findByText(SUBAGENT_BRIEF);

    await act(() =>
      router.navigate({ to: "/threads/$sessionId", params: { sessionId: SESSION_ID } }),
    );

    expect(await screen.findByText(THREAD_MESSAGE)).toBeTruthy();
    await waitFor(() => {
      expect(readAgentTopics(live.readTopics())).toEqual([THREAD_STREAM, THREAD_TAP]);
    });
    // The rows the thread's agent wrote while its page was closed arrive as
    // the replay of its stream.
    const [started, text] = buildNextRows(
      THREAD.session.id,
      THREAD.transcript,
      { _tag: "item.started", turnId: "turn-1", itemId: "turn-1-late", kind: "assistant_message" },
      {
        _tag: "content.delta",
        turnId: "turn-1",
        itemId: "turn-1-late",
        streamKind: "assistant_text",
        delta: "Written while away.",
      },
    );
    act(() => {
      live.pushStreamRows(SESSION_ID, [started!, text!]);
    });
    expect(await screen.findByText("Written while away.")).toBeTruthy();
  });

  it("drops the subagent's tap while the window is hidden, and keeps its stream", async () => {
    const { live } = await openApp(`/threads/${SESSION_ID}/subagents/${SUBAGENT_ID}`);
    await waitFor(() => {
      expect(readAgentTopics(live.readTopics())).toEqual([SUBAGENT_STREAM, SUBAGENT_TAP]);
    });

    setVisibility("hidden");
    await waitFor(() => {
      expect(readAgentTopics(live.readTopics())).toEqual([SUBAGENT_STREAM]);
    });

    setVisibility("visible");
    await waitFor(() => {
      expect(readAgentTopics(live.readTopics())).toEqual([SUBAGENT_STREAM, SUBAGENT_TAP]);
    });
  });

  it("says the thread has no such subagent, and links to the thread", async () => {
    const { router } = await openApp(`/threads/${SESSION_ID}/subagents/agent-gone`);

    expect(await screen.findByText("This thread has no subagent with this id.")).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Go to the thread" }));
    expect(router.state.location.pathname).toBe(`/threads/${SESSION_ID}`);
    expect(await screen.findByText(THREAD_MESSAGE)).toBeTruthy();
  });
});

describe("the subagent's status card", () => {
  it("stops the subagent alone, and drops its Stop and its Request once the pushes say so", async () => {
    // The main agent is idle and the subagent waits on the user, so Stop is
    // how the user turns the subagent's question down.
    let session: Session = {
      ...THREAD.session,
      status: "idle",
      openRequests: [
        {
          requestId: "req-9",
          itemId: "tool-9",
          subagentId: SUBAGENT_ID,
          kind: "command_approval",
          decisions: ["allow", "deny"],
          detail: { command: "pnpm test" },
        },
      ],
    };
    let subagents: readonly Subagent[] = [FIXTURE_SUBAGENT];
    const interrupt = `/api/v1/sessions/${SESSION_ID}/interrupt`;
    const calls = stubApi({
      ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, providers: [FIXTURE_INSTANCE] }),
      ...buildThreadHandlers(THREAD),
      [`GET /api/v1/sessions/${SESSION_ID}`]: () => ({ body: session }),
      [`GET /api/v1/sessions/${SESSION_ID}/subagents`]: () => ({ body: { items: subagents } }),
      [`POST ${interrupt}`]: () => ({ body: session }),
    });
    const { live } = await renderApp(
      createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
      { path: `/threads/${SESSION_ID}/subagents/${SUBAGENT_ID}` },
    );

    // The sidebar has a "Waiting on you" heading too, so the card's headline
    // is found by its place.
    await waitFor(() => {
      expect(document.querySelector(".status-card-text b")?.textContent).toBe("Waiting on you");
    });
    // The subagent's question is docked above its status card.
    expect(document.querySelector(".dock")).not.toBeNull();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(calls.filter((call) => call.path === interrupt).map((call) => call.body)).toEqual([
        { subagentId: SUBAGENT_ID },
      ]);
    });

    // The controller stops the subagent and cancels the Request it asked.
    session = { ...session, openRequests: [] };
    subagents = [{ ...FIXTURE_SUBAGENT, status: "stopped", endedAt: "2026-09-10T09:05:00.000Z" }];
    act(() => {
      live.pushInvalidation("session", [SESSION_ID]);
      live.pushInvalidation("subagent", [SESSION_ID]);
    });

    expect(await screen.findByText("Stopped after 1m 20s")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(document.querySelector(".dock")).toBeNull();
  });
});
