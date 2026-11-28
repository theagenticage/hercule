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
import {
  invalidateForPush,
  listenForInboxPushes,
  useSubagentsLive,
  type InboxPushChange,
} from "./live";

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

describe("invalidateForPush for the Inbox's keys", () => {
  it("cancels a read that is running and reads again, so the read starts after the push", async () => {
    const queryClient = new QueryClient();
    let version = 0;
    let holdReads = false;
    const startedWith: number[] = [];
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.inbox(),
      queryFn: ({ signal }) => {
        const seen = version;
        startedWith.push(seen);
        // While reads are held, a read ends only when it is cancelled.
        return holdReads
          ? new Promise<number>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("cancelled")));
            })
          : Promise.resolve(seen);
      },
    });
    observers.push(observer.subscribe(() => {}));
    await waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.inbox())).toBe(0);
    });

    // A push starts a read that does not answer.
    holdReads = true;
    invalidateForPush(queryClient, "signal", [queryKeys.inbox()], {
      ids: ["s-1"],
      kind: "updated",
      derived: false,
    });
    await waitFor(() => {
      expect(startedWith).toEqual([0, 0]);
    });

    // A change is committed while that read runs, then its push arrives.
    version = 1;
    holdReads = false;
    invalidateForPush(queryClient, "signal", [queryKeys.inbox()], {
      ids: ["s-2"],
      kind: "updated",
      derived: false,
    });

    await waitFor(() => {
      expect(startedWith).toEqual([0, 0, 1]);
      expect(queryClient.getQueryData(queryKeys.inbox())).toBe(1);
    });
  });
});

/** Waits longer than the window in which pushes that name a shared read are gathered. */
const waitPastPushWindow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

describe("invalidateForPush for pushes of one change on several topics", () => {
  const push = { ids: ["e-1"], kind: "updated", derived: false } as const;

  /** Returns a client whose Inbox page, outline, count and entity reads are counted by key. */
  const buildCountedInboxReads = async () => {
    const queryClient = new QueryClient();
    const reads = new Map<string, number>();
    const keys = [
      queryKeys.inbox({ list: "all" }),
      queryKeys.inboxOutline(),
      queryKeys.inboxCount(),
      queryKeys.externalEntity("e-1"),
    ];
    for (const queryKey of keys) {
      const observer = new QueryObserver(queryClient, {
        queryKey,
        queryFn: () => {
          const name = JSON.stringify(queryKey);
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return Promise.resolve(null);
        },
      });
      observers.push(observer.subscribe(() => {}));
    }
    await waitPastPushWindow();
    reads.clear();
    return { queryClient, reads };
  };

  it("reads each key once for the pushes of five topics that arrive together, as a reload's first pushes do", async () => {
    const { queryClient, reads } = await buildCountedInboxReads();
    let visitPushes = 0;
    listenForInboxPushes(queryClient, () => {
      visitPushes += 1;
    });

    for (const topic of ["signal", "task", "connection", "plugin", "externalEntity"] as const) {
      invalidateForPush(queryClient, topic, buildQueryKeys(topic, []), {
        ids: [],
        kind: "updated",
        derived: false,
      });
    }
    await waitPastPushWindow();

    expect([...reads.values()]).toEqual([1, 1, 1, 1]);
    expect(visitPushes).toBe(1);
  });

  it("reads each key once for a signal push followed by an externalEntity push", async () => {
    const { queryClient, reads } = await buildCountedInboxReads();

    invalidateForPush(queryClient, "signal", buildQueryKeys("signal", ["s-1"]), push);
    invalidateForPush(
      queryClient,
      "externalEntity",
      buildQueryKeys("externalEntity", ["e-1"]),
      push,
    );
    await waitPastPushWindow();

    expect([...reads.values()]).toEqual([1, 1, 1, 1]);
  });

  it("reads again for a push that arrives after the window, which may report a later change", async () => {
    const { queryClient, reads } = await buildCountedInboxReads();

    invalidateForPush(queryClient, "signal", buildQueryKeys("signal", ["s-1"]), push);
    await waitPastPushWindow();
    invalidateForPush(
      queryClient,
      "externalEntity",
      buildQueryKeys("externalEntity", ["e-1"]),
      push,
    );
    await waitPastPushWindow();

    expect([...reads.values()]).toEqual([2, 2, 2, 2]);
  });
});

describe("listenForInboxPushes", () => {
  const push = { ids: ["e-1"], kind: "updated", derived: false } as const;

  it("calls the listener once for the pushes that name the Inbox's keys, however many keys and topics", async () => {
    const queryClient = new QueryClient();
    let calls = 0;
    const stop = listenForInboxPushes(queryClient, () => {
      calls += 1;
    });

    invalidateForPush(
      queryClient,
      "externalEntity",
      [queryKeys.inbox(), queryKeys.inboxOutline(), queryKeys.inboxCount()],
      push,
    );
    invalidateForPush(queryClient, "signal", [queryKeys.inbox()], push);
    await waitPastPushWindow();

    expect(calls).toBe(1);
    stop();
  });

  it("ignores a push that names no Inbox key, and another client's push", async () => {
    const queryClient = new QueryClient();
    let calls = 0;
    const stop = listenForInboxPushes(queryClient, () => {
      calls += 1;
    });

    invalidateForPush(queryClient, "task", [queryKeys.tasks()], push);
    invalidateForPush(new QueryClient(), "externalEntity", [queryKeys.inbox()], push);
    await waitPastPushWindow();

    expect(calls).toBe(0);
    stop();
  });

  it("stops calling the listener once it is stopped", async () => {
    const queryClient = new QueryClient();
    let calls = 0;
    listenForInboxPushes(queryClient, () => {
      calls += 1;
    })();

    invalidateForPush(queryClient, "externalEntity", [queryKeys.inbox()], push);
    await waitPastPushWindow();

    expect(calls).toBe(0);
  });
});
describe("listenForInboxPushes with derived task pushes", () => {
  const derived = { ids: ["t-1", "t-2"], kind: "updated", derived: true } as const;
  const keysOf = (push: { readonly ids: readonly string[]; readonly derived: boolean }) =>
    buildQueryKeys("task", push.ids, undefined, push.derived ? true : undefined);

  it("names the Tasks of the derived pushes of one window, once", async () => {
    const queryClient = new QueryClient();
    const changes: InboxPushChange[] = [];
    const stop = listenForInboxPushes(queryClient, (change) => {
      changes.push(change);
    });

    invalidateForPush(queryClient, "task", keysOf(derived), derived);
    const later = { ids: ["t-3"], kind: "updated", derived: true } as const;
    invalidateForPush(queryClient, "task", keysOf(later), later);
    await waitPastPushWindow();
    stop();

    expect(changes).toEqual([{ kind: "tasks", taskIds: ["t-1", "t-2", "t-3"] }]);
  });

  it("says the whole Inbox changed when a push in the same window named its keys", async () => {
    const queryClient = new QueryClient();
    const changes: InboxPushChange[] = [];
    const stop = listenForInboxPushes(queryClient, (change) => {
      changes.push(change);
    });

    invalidateForPush(queryClient, "task", keysOf(derived), derived);
    const plain = { ids: ["t-1"], kind: "updated", derived: false } as const;
    invalidateForPush(queryClient, "task", keysOf(plain), plain);
    await waitPastPushWindow();
    stop();

    expect(changes).toEqual([{ kind: "inbox" }]);
  });
});
