/**
 * Tests a subagent's page as the app opens it: the subagent's transcript read
 * and followed over the subagent's own live topics, the move back to the
 * thread's page, and what it shows when the thread has no such subagent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
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
      THREAD,
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
