/**
 * Tests `useSubagentsLive`: it holds the `subagent` topic only while it has a
 * thread, and its pushes read the thread's subagent list again. The
 * controller's first push on the subscription names no session, so a list
 * cached before the topic was held does not stay out of date.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { buildQueryKeys, queryKeys, type Live, type TrackingRead } from "@hercule/client-core";
import type { TrackingRun } from "@hercule/contract";
import { invalidateForPush, useSubagentsLive } from "./live";

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

/** Builds a run that is live, or ended, created at a fixed time. */
const buildTrackingRun = (id: string, status: TrackingRun["status"]): TrackingRun => ({
  id,
  workflowId: null,
  workflowName: "Implement",
  status,
  createdAt: "2026-10-20T09:00:00.000Z",
  awaitedSignalIds: [],
});

/**
 * Returns a query client whose cache holds Tracking with two Tasks (`t-1`,
 * newest run `r-new`, live; `t-2`, newest run `r-two`, live), and the detail
 * of each and of a Task Tracking does not hold, all fresh. Tracking is read
 * before the details, as the app does.
 */
const buildCachedTracking = () => {
  const queryClient = new QueryClient();
  const read: TrackingRead = {
    readStartedAt: 0,
    tasks: [
      {
        taskId: "t-1",
        title: "Task t-1",
        handoffs: [],
        latestRun: buildTrackingRun("r-new", "running"),
        latestLiveRun: buildTrackingRun("r-new", "running"),
        liveRunIds: ["r-new"],
      },
      {
        taskId: "t-2",
        title: "Task t-2",
        handoffs: [],
        latestRun: buildTrackingRun("r-two", "running"),
        latestLiveRun: buildTrackingRun("r-two", "running"),
        liveRunIds: ["r-two"],
      },
    ],
  };
  queryClient.setQueryData(queryKeys.tracking(), read);
  queryClient.setQueryData(queryKeys.trackingDetail("t-1"), {});
  queryClient.setQueryData(queryKeys.trackingDetail("t-2"), {});
  queryClient.setQueryData(queryKeys.trackingDetail("t-untracked"), {});
  const isStale = (queryKey: ReadonlyArray<unknown>): boolean =>
    queryClient.getQueryState(queryKey)?.isInvalidated === true;
  return { queryClient, isStale };
};

describe("invalidateForPush", () => {
  it("marks Tracking and the detail of the Task whose run a push names out of date, and no other detail", () => {
    const { queryClient, isStale } = buildCachedTracking();
    invalidateForPush(queryClient, "run", [], { ids: ["r-new"], kind: "updated" });
    expect(isStale(queryKeys.tracking())).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-1"))).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-2"))).toBe(false);
    expect(isStale(queryKeys.trackingDetail("t-untracked"))).toBe(false);
  });

  it("marks the details of every Task a push names a run of", () => {
    const { queryClient, isStale } = buildCachedTracking();
    invalidateForPush(queryClient, "run", [], { ids: ["r-new", "r-two"], kind: "updated" });
    expect(isStale(queryKeys.trackingDetail("t-1"))).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-2"))).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-untracked"))).toBe(false);
  });

  it("marks Tracking and every detail out of date for a run that was created, which a re-run is", () => {
    const { queryClient, isStale } = buildCachedTracking();
    invalidateForPush(queryClient, "run", [], { ids: ["r-other"], kind: "created" });
    expect(isStale(queryKeys.tracking())).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-1"))).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-2"))).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-untracked"))).toBe(true);
  });

  it("marks Tracking and every detail out of date for a push that names no ids", () => {
    const { queryClient, isStale } = buildCachedTracking();
    invalidateForPush(queryClient, "run", [], { ids: [], kind: "updated" });
    expect(isStale(queryKeys.tracking())).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-1"))).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-2"))).toBe(true);
  });

  it("leaves Tracking and its details alone for a run of no tracked Task", () => {
    const { queryClient, isStale } = buildCachedTracking();
    invalidateForPush(queryClient, "run", [], { ids: ["r-cron"], kind: "updated" });
    expect(isStale(queryKeys.tracking())).toBe(false);
    expect(isStale(queryKeys.trackingDetail("t-1"))).toBe(false);
    expect(isStale(queryKeys.trackingDetail("t-2"))).toBe(false);
  });

  it("marks only the detail of the Task a task push names out of date", () => {
    const { queryClient, isStale } = buildCachedTracking();
    invalidateForPush(queryClient, "task", buildQueryKeys("task", ["t-1"]), {
      ids: ["t-1"],
      kind: "updated",
    });
    expect(isStale(queryKeys.trackingDetail("t-1"))).toBe(true);
    expect(isStale(queryKeys.trackingDetail("t-2"))).toBe(false);
  });
});
