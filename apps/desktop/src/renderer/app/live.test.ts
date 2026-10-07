/**
 * Tests `useSubagentsLive`: it holds the `subagent` topic only while it has a
 * thread, and its pushes read the thread's subagent list again. The
 * controller's first push on the subscription names no session, so a list
 * cached before the topic was held does not stay out of date.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { buildQueryKeys, queryKeys, type Live } from "@hercule/client-core";
import { useSubagentsLive } from "./live";

/** What a subscription to a topic like `subagent` is called with on each push. */
type InvalidateHandler = (keys: ReadonlyArray<ReadonlyArray<unknown>>) => void;

/** The query observers the current test made, removed after it. */
const observers: Array<() => void> = [];

afterEach(() => {
  for (const unsubscribe of observers.splice(0)) unsubscribe();
});

/**
 * Returns a live connection that records its subscriptions, with a way to
 * push an invalidation to them. Only `subscribe` is used by the hook.
 */
const buildFakeLive = () => {
  const handlers = new Map<string, InvalidateHandler>();
  const live = {
    subscribe: (topic: string, handler: InvalidateHandler) => {
      handlers.set(topic, handler);
      return () => handlers.delete(topic);
    },
  } as unknown as Live;
  return { live, handlers };
};

/**
 * Returns a query cache holding the subagent list of the session `s-1`, read
 * before, with a screen reading it so an invalidation reads it again. Also
 * returns how many times the list was read since.
 */
const buildCachedSubagents = () => {
  const queryClient = new QueryClient();
  const queryKey = queryKeys.subagents("s-1");
  queryClient.setQueryData(queryKey, []);
  const reads = { count: 0 };
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: () => {
      reads.count += 1;
      return Promise.resolve([]);
    },
    staleTime: Infinity,
  });
  observers.push(observer.subscribe(() => {}));
  return { queryClient, reads };
};

describe("useSubagentsLive", () => {
  it("subscribes to the subagent topic, and reads the thread's cached list again on each push", async () => {
    const { live, handlers } = buildFakeLive();
    const { queryClient, reads } = buildCachedSubagents();

    const { unmount } = renderHook(() => {
      useSubagentsLive(live, queryClient, "s-1");
    });

    expect([...handlers.keys()]).toEqual(["subagent"]);
    expect(reads.count).toBe(0);

    // The controller's first push names no session, and reads the list again.
    handlers.get("subagent")?.(buildQueryKeys("subagent", []));
    await waitFor(() => {
      expect(reads.count).toBe(1);
    });

    // A push naming the thread reads its list again.
    handlers.get("subagent")?.([queryKeys.subagents("s-1")]);
    await waitFor(() => {
      expect(reads.count).toBe(2);
    });

    unmount();
    expect(handlers.size).toBe(0);
  });

  it("holds no topic and reads nothing while it has no thread", () => {
    const { live, handlers } = buildFakeLive();
    const { queryClient, reads } = buildCachedSubagents();

    renderHook(() => {
      useSubagentsLive(live, queryClient, null);
    });

    expect(handlers.size).toBe(0);
    expect(reads.count).toBe(0);
  });
});
