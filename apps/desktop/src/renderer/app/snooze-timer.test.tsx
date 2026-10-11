/**
 * Tests `useSnoozeTimer`: when it reads Intake's lists again so a snoozed
 * signal comes back to To do. The controller sends no push when a snooze
 * runs out, so this timer is the only thing that brings the signal back
 * while the app runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Signal } from "@hercule/contract";
import { signalsLaterQuery } from "./queries";
import { useSnoozeTimer } from "./snooze-timer";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * Renders the hook over a cache whose Later list holds one signal snoozed
 * until `until`, or nothing when `until` is undefined. Returns how many times
 * the lists were read since.
 */
const renderSnoozeTimer = (until: string | undefined) => {
  const reads = { count: 0 };
  const items = until === undefined ? [] : [{ snooze: { until } } as unknown as Signal];
  const client = {
    signal: {
      query: () => {
        reads.count += 1;
        return Promise.resolve({ items });
      },
    },
  } as unknown as HerculeClient;
  const queryClient = new QueryClient();
  queryClient.setQueryData(signalsLaterQuery(client).queryKey, {
    pages: [{ items }],
    pageParams: [undefined],
  });
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(
    () => {
      useSnoozeTimer(client, queryClient);
    },
    { wrapper },
  );
  return reads;
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSnoozeTimer", () => {
  it("reads the lists again one second after the soonest snooze runs out, not before", async () => {
    const reads = renderSnoozeTimer(new Date(NOW + FIVE_MINUTES_MS).toISOString());

    await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS));
    expect(reads.count).toBe(0);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(reads.count).toBe(1);
  });

  it("reads nothing while nothing is snoozed", async () => {
    const reads = renderSnoozeTimer(undefined);

    await act(() => vi.advanceTimersByTimeAsync(24 * 60 * 60_000));
    expect(reads.count).toBe(0);
  });

  it("reads the lists again when the window gets focus after a snooze ran out while the Mac slept", async () => {
    const reads = renderSnoozeTimer(new Date(NOW + FIVE_MINUTES_MS).toISOString());

    // Moving the clock without running timers stands for the Mac sleeping.
    vi.setSystemTime(NOW + 2 * FIVE_MINUTES_MS);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads.count).toBe(1);
  });

  it("does not read on focus before the snooze runs out", async () => {
    const reads = renderSnoozeTimer(new Date(NOW + FIVE_MINUTES_MS).toISOString());

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads.count).toBe(0);
  });
});
