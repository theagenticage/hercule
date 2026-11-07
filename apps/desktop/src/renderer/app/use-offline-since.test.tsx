/** Tests that the offline time starts when the connection drops, stays while it is down, and clears when it is back. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Live } from "@hercule/client-core";
import { useOfflineSince } from "./use-offline-since";

/** The states a live connection reports. */
type LiveStatus = Parameters<Parameters<Live["onStatus"]>[0]>[0];

/** Returns a live connection whose status the test sets, and the function that sets it. */
const buildLive = (): { readonly live: Live; readonly setStatus: (status: LiveStatus) => void } => {
  const listeners = new Set<(status: LiveStatus) => void>();
  const live = {
    onStatus: (listener: (status: LiveStatus) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as Live;
  return {
    live,
    setStatus: (status) => {
      for (const listener of listeners) listener(status);
    },
  };
};

describe("useOfflineSince", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T09:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is null while the connection is up, or has not been up yet", () => {
    const { live, setStatus } = buildLive();
    const { result } = renderHook(() => useOfflineSince(live));

    expect(result.current).toBeNull();
    act(() => {
      setStatus("connecting");
    });
    expect(result.current).toBeNull();
    act(() => {
      setStatus("connected");
    });
    expect(result.current).toBeNull();
  });

  it("holds the moment the connection first dropped, and clears when it is back", () => {
    const { live, setStatus } = buildLive();
    const { result } = renderHook(() => useOfflineSince(live));

    act(() => {
      setStatus("disconnected");
    });
    expect(result.current?.toISOString()).toBe("2026-11-07T09:00:00.000Z");
    vi.setSystemTime(new Date("2026-11-07T09:05:00.000Z"));
    act(() => {
      setStatus("disconnected");
    });
    expect(result.current?.toISOString()).toBe("2026-11-07T09:00:00.000Z");

    act(() => {
      setStatus("connected");
    });
    expect(result.current).toBeNull();
  });
});
