/**
 * Tests the hooks that read Your work and Tracking's rows: they match the
 * signals to their Tasks and build the rows, keep their identity while
 * nothing they are built from changes, and a change to To do that touches no
 * signal Your work names draws nothing again.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Signal, TrackingRun, TrackingTask, YourWorkTask } from "@hercule/contract";
import { liveAgentSessionsQuery, signalsToDoQuery, trackingQuery, yourWorkQuery } from "./queries";
import { useTrackingRows, useYourWork } from "./tracking";

const route = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouteContext: () => ({ controller: { client: route.client } }),
}));

const AT = "2026-10-20T10:00:00.000Z";
const THREAD_REF = "github:pr:acme/shop#1";
const YOUR_WORK_TASK: YourWorkTask = {
  id: "t1",
  title: "Fix t1",
  status: "open",
  updatedAt: AT,
  signalIds: ["s1"],
};

const buildSignal = (id: string, threadRef: string): Signal => ({
  id,
  kind: "github/checks-failed",
  origin: { type: "event", eventId: 1, connectionId: "conn", threadRef },
  title: "Checks failed",
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: AT,
});

const buildCoreSignal = (id: string): Signal => ({
  ...buildSignal(id, "unused"),
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
});

/** Builds the Task `taskId` with one finished run. */
const buildTrackingTask = (taskId: string, title = `Fix ${taskId}`): TrackingTask => {
  const run: TrackingRun = {
    id: `run-${taskId}`,
    workflowId: null,
    workflowName: "Implement",
    status: "completed",
    createdAt: AT,
    finishedAt: AT,
    awaitedSignalIds: [],
  };
  return {
    taskId,
    title,
    handoffs: [{ signalId: `signal-${taskId}`, runId: run.id, at: AT }],
    latestRun: run,
    liveRunIds: [],
  };
};

/** Sets up a query cache that holds the shell's reads, as the shell's loader leaves it. */
const setUp = async (signals: ReadonlyArray<Signal>, tracked: ReadonlyArray<TrackingTask>) => {
  const client = {
    signal: {
      query: () => Promise.resolve({ items: signals }),
      queryYourWork: () => Promise.resolve({ tasks: [YOUR_WORK_TASK] }),
    },
    task: { queryTracking: () => Promise.resolve({ rows: tracked }) },
    session: { query: () => Promise.resolve({ items: [] }) },
  } as unknown as HerculeClient;
  route.client = client;
  const queryClient = new QueryClient();
  await Promise.all([
    queryClient.fetchQuery(signalsToDoQuery(client)),
    queryClient.fetchQuery(trackingQuery(client)),
    queryClient.fetchQuery(yourWorkQuery(client)),
    queryClient.fetchQuery(liveAgentSessionsQuery(client)),
  ]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    wrapper,
    /** Stores a new list as To do's. */
    writeToDo: (next: ReadonlyArray<Signal>) =>
      act(async () => {
        queryClient.setQueryData(signalsToDoQuery(client).queryKey, next);
        // Query tells its observers on the next turn of the event loop.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
    /** Stores a new read of Tracking's Tasks. */
    writeTracking: (next: ReadonlyArray<TrackingTask>) =>
      act(async () => {
        queryClient.setQueryData(trackingQuery(client).queryKey, {
          tasks: next,
          readStartedAt: 1,
        });
        // Query tells its observers on the next turn of the event loop.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
  };
};

afterEach(() => {
  route.client = undefined;
});

describe("useYourWork and useTrackingRows", () => {
  it("match each signal to its Tasks and build the rows from them", async () => {
    const { wrapper } = await setUp(
      [buildSignal("s1", THREAD_REF)],
      [buildTrackingTask("t1"), buildTrackingTask("t2")],
    );

    const { result } = renderHook(() => [useYourWork(), useTrackingRows()] as const, { wrapper });

    expect(result.current[0].get("s1")?.tasks.map((task) => task.id)).toEqual(["t1"]);
    expect(result.current[1].map((row) => `${row.task.taskId}:${row.state}`)).toEqual([
      "t1:needs-you",
      "t2:finished",
    ]);
  });

  it("keep the same Your work and rows when drawn again with nothing changed", async () => {
    const { wrapper } = await setUp([buildSignal("s1", THREAD_REF)], [buildTrackingTask("t1")]);
    const { result, rerender } = renderHook(() => [useYourWork(), useTrackingRows()] as const, {
      wrapper,
    });
    const [yourWork, rows] = result.current;

    rerender();

    expect(result.current[0]).toBe(yourWork);
    expect(result.current[1]).toBe(rows);
  });

  it("draw nothing again for a change to To do that touches no signal Your work names", async () => {
    const { wrapper, writeToDo } = await setUp(
      [buildSignal("s1", THREAD_REF)],
      [buildTrackingTask("t1")],
    );
    let draws = 0;
    const { result } = renderHook(
      () => {
        draws += 1;
        return useTrackingRows();
      },
      { wrapper },
    );
    const rows = result.current;
    const before = draws;

    await writeToDo([buildSignal("s1", THREAD_REF), buildCoreSignal("s2")]);

    expect(draws).toBe(before);
    expect(result.current).toBe(rows);
  });

  it("build the rows again when a signal Your work names leaves To do", async () => {
    const { wrapper, writeToDo } = await setUp(
      [buildSignal("s1", THREAD_REF)],
      [buildTrackingTask("t1")],
    );
    const { result } = renderHook(() => useTrackingRows(), { wrapper });
    expect(result.current[0]?.state).toBe("needs-you");

    await writeToDo([]);

    expect(result.current[0]?.state).toBe("finished");
  });
});
