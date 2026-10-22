/**
 * Tests the hook that re-runs a Tracking row's newest run: one request per
 * Task at a time, a lock that lasts until Tracking's read shows a newer run,
 * and a refusal that shows only while its run is still the newest.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { TrackingTask } from "@hercule/contract";
import { createQueryClient } from "../../app/query-client";
import { useRerunTracking } from "./use-rerun-tracking";

/** Builds a Tracking row of the Task `taskId` whose newest run is `runId`. */
const buildTask = (taskId: string, runId: string): TrackingTask =>
  ({ taskId, latestRun: { id: runId } }) as TrackingTask;

/** Waits one macrotask, so a request already on its way to `run.rerun` has arrived. */
const letPendingWorkRun = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/**
 * Renders the hook over the app's own query client, with a controller whose
 * `run.rerun` answers only when the test says.
 *
 * Query sends a request, and tells the hook about a changed request, a few
 * ticks after the call that changed it. So the helpers wait for what they
 * need and never for a fixed time:
 * - `press` runs `starts` in one batch, then waits until the hook has drawn.
 * - `accept` and `refuse` wait until the oldest unanswered request has reached
 *   `run.rerun`, answer it, then wait until the hook has drawn the answer.
 */
const renderRerun = () => {
  const waiting: Array<{ accept: () => void; refuse: (message: string) => void }> = [];
  const rerun = vi.fn(
    () =>
      new Promise<unknown>((resolve, reject) => {
        waiting.push({
          accept: () => resolve({ runId: "new" }),
          refuse: (message) => reject(new Error(message)),
        });
      }),
  );
  const client = { run: { rerun } } as unknown as HerculeClient;
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  let draws = 0;
  const { result } = renderHook(
    () => {
      draws += 1;
      return useRerunTracking(client);
    },
    { wrapper },
  );

  const waitForDrawAfter = async (change: () => void | Promise<void>) => {
    const before = draws;
    await act(change);
    await waitFor(() => {
      expect(draws).toBeGreaterThan(before);
    });
  };
  let answered = 0;
  const answerNext = async (answer: (request: (typeof waiting)[number]) => void) => {
    await waitFor(() => {
      expect(waiting.length).toBeGreaterThan(answered);
    });
    const request = waiting[answered]!;
    answered += 1;
    await waitForDrawAfter(() => answer(request));
  };
  return {
    rerun,
    queryClient,
    result,
    press: (starts: () => void) => waitForDrawAfter(starts),
    accept: () => answerNext((request) => request.accept()),
    refuse: (message: string) => answerNext((request) => request.refuse(message)),
  };
};

describe("useRerunTracking", () => {
  it("sends one request for two presses before the screen redraws", async () => {
    const { result, rerun, press } = renderRerun();
    // Both presses are in one batch, so the hook cannot draw between them.
    await press(() => {
      result.current.start("task-a", "run-1");
      result.current.start("task-a", "run-1");
    });
    await waitFor(() => {
      expect(rerun).toHaveBeenCalledTimes(1);
    });
    await letPendingWorkRun();
    expect(rerun).toHaveBeenCalledTimes(1);
  });

  it("locks while the request sends and while the Task's newest run is still the re-run run, and unlocks when the read shows a newer one", async () => {
    const { result, rerun, press, accept } = renderRerun();
    await press(() => {
      result.current.start("task-a", "run-1");
    });
    expect(result.current.isStarting(buildTask("task-a", "run-1"))).toBe(true);

    await accept();
    expect(result.current.isStarting(buildTask("task-a", "run-1"))).toBe(true);
    act(() => {
      result.current.start("task-a", "run-1");
    });
    await letPendingWorkRun();
    expect(rerun).toHaveBeenCalledTimes(1);

    expect(result.current.isStarting(buildTask("task-a", "run-2"))).toBe(false);
  });

  it("keeps a Task locked after the screen moved on to another Task's re-run and a long time passed", async () => {
    const { result, queryClient, press, accept } = renderRerun();
    await press(() => {
      result.current.start("task-a", "run-1");
    });
    await accept();
    await press(() => {
      result.current.start("task-b", "run-1");
    });
    await accept();
    // The app drops a finished request nobody shows after 0 ms. Real timers
    // fire in order of their time, so after this wait that drop has happened.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(queryClient.getMutationCache().getAll()).toHaveLength(2);
    expect(result.current.isStarting(buildTask("task-a", "run-1"))).toBe(true);
  });

  it("shows a refusal only while its run is the Task's newest, and shows the next refusal alone", async () => {
    const { result, queryClient, press, refuse } = renderRerun();
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
    const { result, rerun, press, accept, refuse } = renderRerun();
    await press(() => {
      result.current.start("task-a", "run-1");
      result.current.start("task-b", "run-1");
    });
    await waitFor(() => {
      expect(rerun).toHaveBeenCalledTimes(2);
    });

    await refuse("A was refused");
    await accept();
    expect(result.current.readRefusal(buildTask("task-a", "run-1"))).toBe("A was refused");
    expect(result.current.isStarting(buildTask("task-a", "run-1"))).toBe(false);
    expect(result.current.readRefusal(buildTask("task-b", "run-1"))).toBeNull();
    expect(result.current.isStarting(buildTask("task-b", "run-1"))).toBe(true);
  });
});
