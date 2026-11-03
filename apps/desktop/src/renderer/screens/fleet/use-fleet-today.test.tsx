/**
 * Tests `useFleetToday`: the value it returns changes when the local day
 * changes and at no other moment, even while the age clock tells its labels
 * about an unrelated per-second label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { findNextDurationChange } from "@hercule/client-core";
import { ageClock } from "../../app/age-clock";
import { useFleetToday } from "./use-fleet-today";

const TIMEZONE = "UTC";

/** Fakes the timers and the date at 22:00 UTC on 2 Nov 2026, two hours before midnight. */
beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-02T22:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useFleetToday", () => {
  it("returns the start of the local day", () => {
    const { result } = renderHook(() => useFleetToday(TIMEZONE, true));
    expect(result.current.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("keeps its value, and draws nothing, while the age clock wakes for another label in the same day", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useFleetToday(TIMEZONE, true);
    });
    const first = result.current;
    const rendersBefore = renders;
    // A per-second duration label elsewhere on screen, which the clock wakes every second.
    const unwatch = ageClock.watch(
      (now) => findNextDurationChange("2026-11-02T21:59:00.000Z", now),
      () => {},
    );

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    unwatch();

    expect(result.current).toBe(first);
    expect(renders).toBe(rendersBefore);
  });

  it("returns the next day's start when the local day changes", () => {
    const { result } = renderHook(() => useFleetToday(TIMEZONE, true));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(2 * 3_600_000 + 1_000);
    });

    expect(result.current).not.toBe(first);
    expect(result.current.toISOString()).toBe("2026-11-03T00:00:00.000Z");
  });

  it("watches the clock only while the page shows a time", () => {
    const { result } = renderHook(() => useFleetToday(TIMEZONE, false));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(3 * 3_600_000);
    });

    expect(result.current).toBe(first);
  });
});
