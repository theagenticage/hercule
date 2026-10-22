/**
 * Tests `useSubagentsLive`: it holds the `subagent` topic only while it has a
 * thread, and its pushes read the thread's subagent list again. The
 * controller's first push on the subscription names no session, so a list
 * cached before the topic was held does not stay out of date.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  buildQueryKeys,
  queryKeys,
  type HerculeClient,
  type Live,
  type TrackingRead,
} from "@hercule/client-core";
import type { HandoffLeg, TrackingRun } from "@hercule/contract";
import { invalidateForPush, useSubagentsLive } from "./live";
import {
  handoffLegQuery,
  signalsClearedTodayQuery,
  signalsDoneQuery,
  type DoneSignalPage,
} from "./queries";

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

/**
 * Returns a client whose `signal.query` answers one handed-off signal and whose
 * `task.queryLegs` answers `answerLegs()`. The reads are counted in `reads`,
 * and `holdNextLegRead` makes the next leg read wait until the returned
 * function is called.
 */
const buildFakeDoneClient = (answerLegs: () => ReadonlyArray<HandoffLeg>) => {
  const reads = { signals: 0, legs: 0 };
  let release: (() => void) | undefined;
  let hold = false;
  const client = {
    signal: {
      query: () => {
        reads.signals += 1;
        return Promise.resolve({ items: [{ id: "s-1", resolution: { runId: "r-first" } }] });
      },
    },
    task: {
      queryLegs: async () => {
        reads.legs += 1;
        const legs = answerLegs();
        if (hold) {
          hold = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { legs };
      },
    },
  } as unknown as HerculeClient;
  return {
    client,
    reads,
    holdNextLegRead: () => {
      hold = true;
    },
    releaseHeldLegRead: () => release?.(),
  };
};

/** The leg `s-1` of the Task `t-1` has, with a live newest run `r-new` and a live run `r-live`. */
const HELD_LEG: HandoffLeg = {
  runId: "r-first",
  signalId: "s-1",
  taskId: "t-1",
  taskStatus: "in-progress",
  workflowId: null,
  workflowName: "Implement",
  rerunCount: 2,
  latestRun: { id: "r-new", status: "running" },
  liveRunIds: ["r-live"],
};

/**
 * Returns a query client holding two Done lists, the "all" tab with one leg
 * (newest run `r-new`, live run `r-live`) and the tab of the plugin "github"
 * with none, the cleared-today list, and the leg of the run `r-solo` a pane
 * read on its own. All are fresh.
 */
const buildCachedDoneLists = () => {
  const queryClient = new QueryClient();
  const client = {} as HerculeClient;
  const setPages = (queryKey: ReadonlyArray<unknown>, legs: ReadonlyArray<HandoffLeg>) => {
    queryClient.setQueryData(queryKey, {
      pages: [{ items: [], legs } satisfies DoneSignalPage],
      pageParams: [undefined],
    });
  };
  const all = signalsDoneQuery(client).queryKey;
  const github = signalsDoneQuery(client, "github").queryKey;
  const clearedToday = signalsClearedTodayQuery(client).queryKey;
  const solo = handoffLegQuery(client, "r-solo").queryKey;
  setPages(all, [HELD_LEG]);
  setPages(github, []);
  queryClient.setQueryData(clearedToday, { pages: [{ items: [] }], pageParams: [undefined] });
  queryClient.setQueryData(solo, null);
  const isStale = (queryKey: ReadonlyArray<unknown>): boolean =>
    queryClient.getQueryState(queryKey)?.isInvalidated === true;
  return { queryClient, isStale, all, github, clearedToday, solo };
};

describe("invalidateForPush for Intake's Done lists", () => {
  it("marks every Done list out of date for a task push naming a held leg's Task, and not the cleared-today list", () => {
    const { queryClient, isStale, all, github, clearedToday } = buildCachedDoneLists();
    invalidateForPush(queryClient, "task", buildQueryKeys("task", ["t-1"]), {
      ids: ["t-1"],
      kind: "updated",
    });
    expect(isStale(all)).toBe(true);
    expect(isStale(github)).toBe(true);
    expect(isStale(clearedToday)).toBe(false);
  });

  it("leaves the Done lists alone for a task push naming an unrelated Task", () => {
    const { queryClient, isStale, all, github } = buildCachedDoneLists();
    invalidateForPush(queryClient, "task", buildQueryKeys("task", ["t-other"]), {
      ids: ["t-other"],
      kind: "updated",
    });
    expect(isStale(all)).toBe(false);
    expect(isStale(github)).toBe(false);
  });

  it("leaves the Done lists alone for a run push that names an unrelated run", () => {
    const { queryClient, isStale, all, github } = buildCachedDoneLists();
    invalidateForPush(queryClient, "run", [], { ids: ["r-cron"], kind: "updated" });
    expect(isStale(all)).toBe(false);
    expect(isStale(github)).toBe(false);
  });

  it.each([["r-new"], ["r-live"]])(
    "marks every Done list out of date for a run push that names the held leg's run %s",
    (runId) => {
      const { queryClient, isStale, all, github, clearedToday } = buildCachedDoneLists();
      invalidateForPush(queryClient, "run", [], { ids: [runId], kind: "updated" });
      expect(isStale(all)).toBe(true);
      expect(isStale(github)).toBe(true);
      expect(isStale(clearedToday)).toBe(false);
    },
  );

  it("marks the Done lists out of date for a run that was created", () => {
    const { queryClient, isStale, all } = buildCachedDoneLists();
    invalidateForPush(queryClient, "run", [], { ids: ["r-other"], kind: "created" });
    expect(isStale(all)).toBe(true);
  });

  it("looks at the legs of every held Done list, not only the visible tab", () => {
    const { queryClient, isStale, all, github } = buildCachedDoneLists();
    // Only the "github" tab holds the leg this time.
    const held = queryClient.getQueryData(all);
    queryClient.setQueryData(github, held);
    queryClient.setQueryData(all, { pages: [{ items: [], legs: [] }], pageParams: [undefined] });
    invalidateForPush(queryClient, "run", [], { ids: ["r-live"], kind: "updated" });
    expect(isStale(all)).toBe(true);
    expect(isStale(github)).toBe(true);
  });

  it("never takes the cleared-today read for a Done list, even when its legs would be affected", () => {
    const { queryClient, isStale, clearedToday } = buildCachedDoneLists();
    // A push that names no ids affects any leg. The cleared-today pages hold
    // no `legs`; reading them as a Done list's would throw.
    expect(() => {
      invalidateForPush(queryClient, "run", [], { ids: [], kind: "updated" });
    }).not.toThrow();
    expect(isStale(clearedToday)).toBe(false);
  });

  it("marks the leg a pane read on its own out of date for a run push naming its run", () => {
    const { queryClient, isStale, solo } = buildCachedDoneLists();
    queryClient.setQueryData<HandoffLeg>(solo, {
      ...HELD_LEG,
      runId: "r-solo",
      liveRunIds: ["r-solo-live"],
    });
    invalidateForPush(queryClient, "run", [], { ids: ["r-solo-live"], kind: "updated" });
    expect(isStale(solo)).toBe(true);
  });

  it("reads a Done list again when a task push arrives during its first read, whatever the push names", async () => {
    let status: HandoffLeg["taskStatus"] = "in-progress";
    const fake = buildFakeDoneClient(() => [{ ...HELD_LEG, taskStatus: status }]);
    const queryClient = new QueryClient();
    const options = signalsDoneQuery(fake.client);
    fake.holdNextLegRead();
    observers.push(new InfiniteQueryObserver(queryClient, options).subscribe(() => {}));
    await waitFor(() => {
      expect(fake.reads.legs).toBe(1);
    });

    // The Task closes after the first read was answered, before it was stored.
    status = "done";
    invalidateForPush(queryClient, "task", buildQueryKeys("task", ["t-other"]), {
      ids: ["t-other"],
      kind: "updated",
    });
    fake.releaseHeldLegRead();

    await waitFor(() => {
      expect(fake.reads.legs).toBe(2);
      expect(
        queryClient.getQueryData<InfiniteData<DoneSignalPage>>(options.queryKey),
      ).toMatchObject({
        pages: [{ legs: [{ taskStatus: "done" }] }],
      });
    });
  });
});
