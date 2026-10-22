/**
 * Tests the hook that re-runs a Tracking row's newest run: one request per
 * Task at a time, a lock that lasts until Tracking's read shows a newer run,
 * and a refusal that shows only while its run is still the newest.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { TrackingTask } from "@hercule/contract";
import { createQueryClient } from "../../app/query-client";
import { useRerunTracking } from "./use-rerun-tracking";

afterEach(() => {
  vi.useRealTimers();
});

/** Builds a Tracking row of the Task `taskId` whose newest run is `runId`. */
const buildTask = (taskId: string, runId: string): TrackingTask =>
  ({ taskId, latestRun: { id: runId } }) as TrackingTask;

/**
 * Runs `change` and lets the hook redraw. Query tells the screen about a changed
 * request on the next tick, not at once.
 */
const press = (change: () => void) =>
  act(async () => {
    change();
    await (vi.isFakeTimers()
      ? vi.advanceTimersByTimeAsync(0)
      : new Promise((resolve) => setTimeout(resolve, 0)));
  });

/**
 * Renders the hook over the app's own query client, with a controller whose
 * `run.rerun` answers only when the test says. `answerNext` settles the
 * oldest request still waiting.
 */
const renderRerun = () => {
  const waiting: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const rerun = vi.fn(
    () =>
      new Promise<unknown>((resolve, reject) => {
        waiting.push({ resolve: () => resolve({ runId: "new" }), reject });
      }),
  );
  const client = { run: { rerun } } as unknown as HerculeClient;
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useRerunTracking(client), { wrapper });
  return {
    rerun,
    queryClient,
    result: view.result,
    accept: () => press(() => waiting.shift()!.resolve()),
    refuse: (message: string) => press(() => waiting.shift()!.reject(new Error(message))),
  };
};

describe("useRerunTracking", () => {
  it("sends one request for two presses before the screen redraws", async () => {
    const { result, rerun } = renderRerun();
    await press(() => {
      result.current.start("task-a", "run-1");
      result.current.start("task-a", "run-1");
    });
    expect(rerun).toHaveBeenCalledTimes(1);
  });

  it("locks while the request sends and while the Task's newest run is still the re-run run, and unlocks when the read shows a newer one", async () => {
    const { result, accept, rerun } = renderRerun();
    await press(() => {
      result.current.start("task-a", "run-1");
    });
    expect(result.current.isStarting(buildTask("task-a", "run-1"))).toBe(true);

    await accept();
    expect(result.current.isStarting(buildTask("task-a", "run-1"))).toBe(true);
    await press(() => {
      result.current.start("task-a", "run-1");
    });
    expect(rerun).toHaveBeenCalledTimes(1);

    expect(result.current.isStarting(buildTask("task-a", "run-2"))).toBe(false);
  });

  it("keeps a Task locked after the screen moved on to another Task's re-run and a long time passed", async () => {
    // Query drops a finished request with no screen on it after `gcTime`, which the
    // app sets to 0 for mutations. Only the fake clock makes this wait observable.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { result, accept } = renderRerun();
    await press(() => {
      result.current.start("task-a", "run-1");
    });
    await accept();
    await press(() => {
      result.current.start("task-b", "run-1");
    });
    await accept();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });
    expect(result.current.isStarting(buildTask("task-a", "run-1"))).toBe(true);
  });

  it("shows a refusal only while its run is the Task's newest, and shows the next refusal alone", async () => {
    const { result, queryClient, refuse } = renderRerun();
    await press(() => {
      result.current.start("task-a", "run-1");
    });
    await refuse("first refusal");
    expect(result.current.readRefusal(buildTask("task-a", "run-1"))).toBe("first refusal");
    expect(result.current.isStarting(buildTask("task-a", "run-1"))).toBe(false);
    expect(result.current.readRefusal(buildTask("task-a", "run-2"))).toBeNull();

    // A press for the newer run replaces the stale request, so its refusal is the one found.
    await press(() => {
      result.current.start("task-a", "run-2");
    });
    await refuse("second refusal");
    expect(result.current.readRefusal(buildTask("task-a", "run-2"))).toBe("second refusal");
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);
  });

  it("settles two Tasks' re-runs side by side, each on its own", async () => {
    const { result, rerun, accept, refuse } = renderRerun();
    await press(() => {
      result.current.start("task-a", "run-1");
      result.current.start("task-b", "run-1");
    });
    expect(rerun).toHaveBeenCalledTimes(2);

    await refuse("A was refused");
    await accept();
    expect(result.current.readRefusal(buildTask("task-a", "run-1"))).toBe("A was refused");
    expect(result.current.isStarting(buildTask("task-a", "run-1"))).toBe(false);
    expect(result.current.readRefusal(buildTask("task-b", "run-1"))).toBeNull();
    expect(result.current.isStarting(buildTask("task-b", "run-1"))).toBe(true);
  });
});
