/**
 * Tests the hook that holds Tracking's rows: an own handoff is acknowledged by
 * the first read that started after it committed, and the row it adds shows,
 * whatever order the read and the confirmation arrive in. Changes the user did
 * not make wait while holding, also those that come from a Request.
 */
import { useMemo } from "react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  buildTrackingRows,
  type HerculeClient,
  type TrackingState,
  type WaitingRunSession,
} from "@hercule/client-core";
import type { TrackingTask } from "@hercule/contract";
import { trackingQuery } from "../../app/queries";
import { useHeldTrackingRows } from "./use-held-tracking-rows";

const AT = "2026-10-20T10:00:00.000Z";

/** Builds the Task `taskId` with one run, `status`, whose last handoff is from the signal `signalId`. */
const buildTask = (
  taskId: string,
  status: "completed" | "running",
  signalId: string,
): TrackingTask => {
  const run = {
    id: `run-${signalId}`,
    workflowId: null,
    workflowName: "Implement",
    status,
    createdAt: AT,
    ...(status === "completed" ? { finishedAt: AT } : {}),
    awaitedSignalIds: [],
  } as const;
  return {
    taskId,
    title: `Fix ${taskId}`,
    handoffs: [{ signalId, runId: run.id, at: AT }],
    latestRun: run,
    ...(status === "running" ? { latestLiveRun: run } : {}),
    liveRunIds: status === "running" ? [run.id] : [],
  };
};

/** Builds the open Request of the session of `runId`. */
const buildRequest = (runId: string): WaitingRunSession => ({
  sessionId: `session-${runId}`,
  runId,
  stepId: "implement",
  title: "Implement · implement",
  question: "Run git push?",
  activityAt: AT,
});

/** Sets up a query cache that already holds a read of `tasks`, and the hook holding the rows built from it. */
const renderHeldRows = async (initialTasks: ReadonlyArray<TrackingTask>) => {
  let tasks = initialTasks;
  const client = {
    task: { queryTracking: () => Promise.resolve({ rows: structuredClone(tasks) }) },
  } as unknown as HerculeClient;
  const queryClient = new QueryClient();
  const options = trackingQuery(client);
  await queryClient.fetchQuery(options);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const draws = { count: 0 };
  const view = renderHook(
    ({ requests }: { requests: ReadonlyArray<WaitingRunSession> }) => {
      draws.count += 1;
      const read = useQuery({ ...options, select: (each) => each.tasks });
      const listed = useMemo(
        () => buildTrackingRows(read.data!, requests, new Map()),
        [read.data, requests],
      );
      return useHeldTrackingRows(listed, true);
    },
    { wrapper, initialProps: { requests: [] as ReadonlyArray<WaitingRunSession> } },
  );
  return {
    ...view,
    queryClient,
    draws,
    /** Changes what the controller answers to the next read. */
    changeControllerTasks: (next: ReadonlyArray<TrackingTask>) => {
      tasks = next;
    },
    /** Stores a read of `next` that started a moment ago, as a push's read does. */
    writePushRead: (next: ReadonlyArray<TrackingTask>) => {
      tasks = next;
      queryClient.setQueryData(options.queryKey, {
        tasks: next,
        readStartedAt: performance.now() - 1,
      });
    },
  };
};

const listStates = (shown: ReadonlyArray<{ task: { taskId: string }; state: TrackingState }>) =>
  shown.map((row) => `${row.task.taskId}:${row.state}`);

describe("useHeldTrackingRows", () => {
  it("does not draw again for a read that changes no Task while no handoff waits for one", async () => {
    const task = buildTask("t", "running", "s0");
    const { queryClient, draws, writePushRead } = await renderHeldRows([task]);
    const before = draws.count;

    await act(async () => {
      writePushRead([structuredClone(task)]);
      await Promise.resolve();
    });

    expect(draws.count).toBe(before);
    queryClient.clear();
  });

  it("lets the read that a confirmed handoff starts acknowledge it, though a push's read and the confirmation come in one batch", async () => {
    const { result, queryClient, writePushRead } = await renderHeldRows([
      buildTask("t", "completed", "s0"),
    ]);
    act(() => {
      result.current.registerHandoff("s1");
    });

    // The commit changed the Task. In one batch, a push's read arrives, which started a moment
    // ago, and the handoff's answer is handled.
    await act(async () => {
      writePushRead([buildTask("t", "running", "s1")]);
      result.current.confirmHandoff("s1");
      await Promise.resolve();
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(listStates(result.current.shown)).toEqual(["t:working"]);
    queryClient.clear();
  });

  it("shows the row a handoff adds when the read that acknowledges it lands while the rows are held", async () => {
    const { result, queryClient, changeControllerTasks } = await renderHeldRows([
      buildTask("a", "completed", "s0"),
    ]);
    act(() => {
      result.current.registerHandoff("s1");
    });

    // The read the confirmation starts lands with the Task the handoff made.
    changeControllerTasks([buildTask("a", "completed", "s0"), buildTask("b", "running", "s1")]);
    await act(async () => {
      result.current.confirmHandoff("s1");
      await Promise.resolve();
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(listStates(result.current.shown)).toEqual(["a:finished", "b:working"]);
    queryClient.clear();
  });

  it("holds a Request that opens while the pointer is on the list, until a read follows the user's handoff", async () => {
    const working = buildTask("w", "running", "s0");
    const { result, queryClient, rerender } = await renderHeldRows([working]);

    rerender({ requests: [buildRequest("run-s0")] });
    expect(listStates(result.current.shown)).toEqual(["w:working"]);

    // A handoff of the user's own: the read after its commit changes no Task.
    act(() => {
      result.current.registerHandoff("s1");
    });
    await act(async () => {
      result.current.confirmHandoff("s1");
      await Promise.resolve();
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(listStates(result.current.shown)).toEqual(["w:needs-you"]);
    queryClient.clear();
  });
});
