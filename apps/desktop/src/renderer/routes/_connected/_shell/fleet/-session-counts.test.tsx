/**
 * Tests `useRunnerSessionCounts` with a cached session list: that a change
 * which moves no count draws nothing again, and that a change which moves one
 * does.
 */
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { fleetSessionsQuery } from "../../../../app/queries";
import { createQueryClient } from "../../../../app/query-client";
import { useRunnerSessionCounts } from "./-session-counts";

/** Returns a session on runner `atlas`; only what the counts read is set. */
const buildSession = (id: string, status: Session["status"], toolCalls = 0): Session =>
  ({ id, runnerId: "atlas", kind: "thread", status, toolCalls }) as Session;

/**
 * Renders the hook over a cache that holds `sessions`, so no request is made.
 * Returns the cache, the key of the list, and what the hook returned on each
 * render.
 */
const renderCounts = (sessions: readonly Session[]) => {
  const queryClient = createQueryClient();
  // The query is never read from the network, so the client is not called.
  const { queryKey } = fleetSessionsQuery({} as HerculeClient);
  queryClient.setQueryData(queryKey, sessions);
  const renders: ReturnType<typeof useRunnerSessionCounts>[] = [];
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(() => renders.push(useRunnerSessionCounts({} as HerculeClient)), { wrapper });
  return { queryClient, queryKey, renders: () => renders };
};

/** Replaces the cached sessions, and waits for the notification Query sends on a timer. */
const replaceSessions = async (
  { queryClient, queryKey }: ReturnType<typeof renderCounts>,
  sessions: readonly Session[],
): Promise<void> => {
  await act(async () => {
    queryClient.setQueryData(queryKey, sessions);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("useRunnerSessionCounts", () => {
  it("returns the counts of the cached sessions", () => {
    const { renders } = renderCounts([buildSession("s1", "busy"), buildSession("s2", "queued")]);

    expect(renders().at(-1)).toEqual({
      atlas: { running: 1, waiting: 1, waitingThreads: 1, openThreads: 2 },
    });
  });

  it("draws nothing again when the sessions change but no count does", async () => {
    const rendered = renderCounts([buildSession("s1", "busy")]);
    const before = rendered.renders().length;
    const counts = rendered.renders().at(-1);

    // The same session, with more tool calls: a usage-only push.
    await replaceSessions(rendered, [buildSession("s1", "busy", 5)]);

    expect(rendered.renders()).toHaveLength(before);
    expect(rendered.renders().at(-1)).toBe(counts);
  });

  it("draws again when a session starts waiting", async () => {
    const rendered = renderCounts([buildSession("s1", "busy")]);

    await replaceSessions(rendered, [buildSession("s1", "busy"), buildSession("s2", "queued")]);

    expect(rendered.renders().at(-1)?.["atlas"]).toMatchObject({ running: 1, waiting: 1 });
  });
});
