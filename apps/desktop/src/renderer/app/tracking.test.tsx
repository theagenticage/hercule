/**
 * Tests the hooks that read Your work and Tracking's rows: every component
 * that reads them gets the same objects, a row that did not change keeps its
 * identity when another row changes, and a change to To do that touches no
 * signal with a thread ref draws nothing again.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Signal, TrackingRun, TrackingTask } from "@hercule/contract";
import { liveAgentSessionsQuery, signalsToDoQuery, trackingQuery, yourWorkQuery } from "./queries";
import { useTrackingRows, useYourWork } from "./tracking";

const route = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouteContext: () => ({ controller: { client: route.client } }),
}));

const AT = "2026-10-20T10:00:00.000Z";
const THREAD_REF = "github:pr:acme/shop#1";

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

/** Builds the open Task `id` whose provenance names `ref`, as `task.query` returns it. */
const buildTaskNamingRef = (id: string, ref: string) => ({
  id,
  title: `Fix ${id}`,
  status: "open",
  updatedAt: AT,
  provenance: [{ ref, at: AT, actor: "user" }],
});

/** Sets up a query cache that holds the shell's reads, as the shell's loader leaves it. */
const setUp = async (signals: ReadonlyArray<Signal>, tracked: ReadonlyArray<TrackingTask>) => {
  const client = {
    signal: { query: () => Promise.resolve({ items: signals }) },
    task: {
      query: () => Promise.resolve({ items: [buildTaskNamingRef("t1", THREAD_REF)] }),
      queryTracking: () => Promise.resolve({ rows: tracked }),
    },
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
  it("give every component the same Your work and the same rows", async () => {
    const { wrapper } = await setUp(
      [buildSignal("s1", THREAD_REF)],
      [buildTrackingTask("t1"), buildTrackingTask("t2")],
    );

    const first = renderHook(() => [useYourWork(), useTrackingRows()] as const, { wrapper });
    const second = renderHook(() => [useYourWork(), useTrackingRows()] as const, { wrapper });

    expect(first.result.current[0]).toBe(second.result.current[0]);
    expect(first.result.current[1]).toBe(second.result.current[1]);
    expect(first.result.current[0].get("s1")?.tasks.map((task) => task.id)).toEqual(["t1"]);
    expect(first.result.current[1].map((row) => `${row.task.taskId}:${row.state}`)).toEqual([
      "t1:needs-you",
      "t2:finished",
    ]);
  });

  it("keep a row as it was when another row changes", async () => {
    const { wrapper, writeTracking } = await setUp(
      [],
      [buildTrackingTask("t1"), buildTrackingTask("t2")],
    );
    const { result } = renderHook(() => useTrackingRows(), { wrapper });
    const [firstRow, secondRow] = result.current;

    await writeTracking([buildTrackingTask("t1"), buildTrackingTask("t2", "A new title")]);

    expect(result.current[0]).toBe(firstRow);
    expect(result.current[1]).not.toBe(secondRow);
    expect(result.current[1]?.task.title).toBe("A new title");
  });

  it("draw nothing again for a change to To do that touches no signal with a thread ref", async () => {
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

  it("build the rows again when a signal with a thread ref changes", async () => {
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
