/**
 * Tests that the hook that holds Tracking's rows takes the time of an own
 * handoff before it asks for a new read, also when React batches the update.
 */
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { buildTrackingRows, type HerculeClient } from "@hercule/client-core";
import type { TrackingTask } from "@hercule/contract";
import { trackingQuery } from "../../app/queries";
import { useHeldTrackingRows } from "./use-held-tracking-rows";

const AT = "2026-10-20T10:00:00.000Z";

/** Builds the Task with one run, `status`, whose last handoff is from the signal `signalId`. */
const buildTask = (status: "completed" | "running", signalId: string): TrackingTask => {
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
    taskId: "t",
    title: "Fix",
    handoffs: [{ signalId, runId: run.id, at: AT }],
    latestRun: run,
    ...(status === "running" ? { latestLiveRun: run } : {}),
  };
};

describe("useHeldTrackingRows", () => {
  it("lets the read that a confirmed handoff starts acknowledge it, though a push's read and the confirmation come in one batch", async () => {
    let tasks: ReadonlyArray<TrackingTask> = [buildTask("completed", "s0")];
    const client = {
      task: { queryTracking: () => Promise.resolve({ rows: structuredClone(tasks) }) },
    } as unknown as HerculeClient;
    const queryClient = new QueryClient();
    const options = trackingQuery(client);
    await queryClient.fetchQuery(options);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        const read = useQuery({ ...options, select: (each) => each.rows });
        return useHeldTrackingRows(read.data!, true);
      },
      { wrapper },
    );
    act(() => {
      result.current.registerHandoff("s1");
    });

    // The commit changed the Task. In one batch, a push's read arrives, which started a moment
    // ago, and the handoff's answer is handled.
    tasks = [buildTask("running", "s1")];
    await act(async () => {
      queryClient.setQueryData(options.queryKey, {
        rows: buildTrackingRows(tasks),
        readStartedAt: performance.now() - 1,
      });
      result.current.confirmHandoff("s1");
      await Promise.resolve();
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(result.current.shown[0]!.state).toBe("working");
    queryClient.clear();
  });
});
