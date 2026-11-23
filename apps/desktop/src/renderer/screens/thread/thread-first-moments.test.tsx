/**
 * Tests the Thread's first moments as the start-thread dialog draws them:
 * the user's message and the agent's words from the stubbed controller's
 * records, a line the agent streams in over the stubbed live connection, and
 * the layout that differs from the thread page's.
 */
import { Suspense, useEffect, type JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { buildSessionStreamTopic, buildSessionTapTopic } from "@hercule/contract";
import {
  buildNextRows,
  RUNNING_ITEM_ID,
  stubElementSize,
  THREAD_FIXTURES,
} from "../../app/testing";
import { connectionsQuery, mcpServersQuery, pluginsQuery } from "../../app/queries";
import { buildMcpWorld } from "../settings/mcp-servers/mcp-world.testing";
import {
  OFFERING_PLUGINS,
  SENTRY_WORK,
  SENTRY_WORK_ID,
} from "../settings/mcp-servers/mcp-servers.testing";
import { ThreadFirstMoments } from "./thread-first-moments";
import { holdAnimationFrames, renderThreadPart, type HeldFrames } from "./testing";

/** The animation frames, held until a test runs them. The paragraph being written is painted in one. */
let frames: HeldFrames;

beforeEach(() => {
  vi.stubEnv("TZ", "Europe/Amsterdam");
  frames = holdAnimationFrames();
  stubElementSize(800, 800);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Draws the first moments with the live connection started, which the app's shell does in the app. */
function ConnectedFirstMoments({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { live } = useRouteContext({ from: "/_connected" }).controller;
  useEffect(() => {
    live.start();
    return () => {
      void live.stop();
    };
  }, [live]);
  return <ThreadFirstMoments sessionId={sessionId} />;
}

/** Mounts the first moments of `thread` under Suspense, as the dialog does, once its live topics are subscribed. */
const openFirstMoments = async (
  thread: (typeof THREAD_FIXTURES)["running"],
  handlers: Parameters<typeof renderThreadPart>[1]["handlers"] = {},
) => {
  const sessionId = thread.session.id;
  // The Inbox draws these first moments outside any thread's page, so there is no thread's servers.
  const rendered = await renderThreadPart(
    ({ sessionId: id }) => (
      <Suspense fallback={null}>
        <ConnectedFirstMoments key={id} sessionId={id} />
      </Suspense>
    ),
    { thread, handlers, withoutServers: true },
  );
  await waitFor(() => {
    expect(rendered.live.readTopics()).toEqual(
      expect.arrayContaining([buildSessionStreamTopic(sessionId), buildSessionTapTopic(sessionId)]),
    );
  });
  act(() => {
    rendered.live.pushEmptyReplay(sessionId);
  });
  return rendered;
};

describe("the Thread's first moments", () => {
  it("shows the user's message and the agent's words, read-only, in a column that fills its box", async () => {
    await openFirstMoments(THREAD_FIXTURES.running);
    const transcript = await screen.findByRole("region", { name: "Transcript" });

    expect(
      within(transcript).getByText(/The webhook tests fail about one run in five/),
    ).toBeTruthy();
    expect(within(transcript).getByText(/The three failures share one cause:/)).toBeTruthy();
    // Read-only: no composer, no header.
    expect(document.querySelector(".composer")).toBeNull();
    expect(document.querySelector(".top")).toBeNull();
    // Laid out for a box of its own, not under a floating header.
    expect(transcript.querySelector(".column")!.classList).toContain("tx-embedded");
  });

  it("marks the user's first message, for the dialog's motion to find", async () => {
    await openFirstMoments(THREAD_FIXTURES.running);
    const transcript = await screen.findByRole("region", { name: "Transcript" });

    const marked = transcript.querySelectorAll("[data-first-message]");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toMatch(/The webhook tests fail about one run in five/);
  });

  it("paints the words the agent streams in after the Thread opened", async () => {
    const thread = THREAD_FIXTURES.running;
    const sessionId = thread.session.id;
    const [finishOpen, startNext] = buildNextRows(
      sessionId,
      thread.transcript,
      {
        _tag: "item.completed",
        turnId: "turn-1",
        itemId: RUNNING_ITEM_ID,
        kind: "assistant_message",
        status: "completed",
      },
      { _tag: "item.started", turnId: "turn-1", itemId: "turn-1-next", kind: "assistant_message" },
    );
    const { live } = await openFirstMoments(thread);
    const transcript = await screen.findByRole("region", { name: "Transcript" });

    act(() => {
      live.pushStreamRows(sessionId, [finishOpen!, startNext!]);
    });
    await waitFor(() => {
      expect(transcript.querySelector(".streaming")).not.toBeNull();
    });
    act(() => {
      live.pushTaps(sessionId, [
        {
          turnId: "turn-1",
          itemId: "turn-1-next",
          streamKind: "assistant_text",
          delta: "Reading the issue first.",
        },
      ]);
    });
    await waitFor(() => {
      frames.run();
      expect(transcript.querySelector(".streaming")?.textContent).toBe("Reading the issue first.");
    });
  });

  it("draws the fix buttons of a start warning from the servers the cache holds, and reads none itself", async () => {
    const thread = THREAD_FIXTURES.running;
    const { session } = thread;
    const transcript = [
      ...thread.transcript,
      ...buildNextRows(session.id, thread.transcript, {
        _tag: "runtime.warning",
        message: "Sentry needs you to sign in.",
        mcpServers: [{ mcpServerId: SENTRY_WORK_ID, reason: "needs-sign-in" }],
      }),
    ];
    const { handlers } = buildMcpWorld({ servers: [{ ...SENTRY_WORK, status: "needs-sign-in" }] });
    const { queryClient, client, calls } = await openFirstMoments(
      { ...thread, transcript },
      { ...handlers, "GET /api/v1/plugins": { body: OFFERING_PLUGINS } },
    );
    const note = await screen.findByText("Sentry needs you to sign in.");
    expect(within(note.closest("div")!).queryByRole("button")).toBeNull();

    // The catalogue is warm now, as it is when the user has been in Settings.
    await act(async () => {
      await Promise.all([
        queryClient.fetchQuery(mcpServersQuery(client)),
        queryClient.fetchQuery(connectionsQuery(client)),
        queryClient.fetchQuery(pluginsQuery(client)),
      ]);
    });

    expect(await screen.findByRole("button", { name: "Reconnect Sentry · work" })).toBeTruthy();
    // Only the fetches above: the transcript read the servers from the cache.
    expect(calls.filter((call) => call.path === "/api/v1/mcp-servers")).toHaveLength(1);
  });
});
