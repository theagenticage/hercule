/**
 * Tests the age clock: one timer for the earliest label change, ages and
 * durations alike, none when nothing is watched or the window is hidden, and
 * a fresh read of the time on show and on focus. Timers and the date are
 * faked, so each test says exactly when the clock wakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { findNextAgeChange, findNextDurationChange, formatAge } from "@hercule/client-core";
import {
  createAgeClock,
  useAgeLabel,
  useAgeWords,
  useDurationText,
  type AgeClock,
} from "./age-clock";
import { setVisibility } from "./testing";

const NOW = new Date("2026-09-10T09:00:00.000Z");
/** Reads "now" until 09:00:30, when it turns into "1m". */
const HALF_A_MINUTE_AGO = "2026-09-10T08:59:30.000Z";
/** Reads "1h" until 10:00:00, when it turns into "2h". */
const AN_HOUR_AGO = "2026-09-10T08:00:00.000Z";
/** A duration from here reads "12s" until 09:00:00.500, when it turns into "13s". */
const TWELVE_SECONDS_AGO = "2026-09-10T08:59:48.000Z";

/**
 * The labels the current test watches, removed after it. A clock listens on
 * the page while it watches anything, so a label left behind would make the
 * next test's clocks set timers too.
 */
const unwatches: Array<() => void> = [];

/**
 * Watches the age of `at` on `clock`, or with `findNextChange` another kind of
 * label that counts from `at`, and removes the label after the test. Returns
 * what `watch` returns.
 */
const watchLabel = (
  clock: AgeClock,
  at: string,
  onChange: () => void,
  findNextChange: (since: string, now: Date) => Date = findNextAgeChange,
): (() => void) => {
  const unwatch = clock.watch((now) => findNextChange(at, now), onChange);
  unwatches.push(unwatch);
  return unwatch;
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  for (const unwatch of unwatches.splice(0)) unwatch();
  setVisibility("visible");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the age clock", () => {
  it("sets no timer while no label is watched", () => {
    createAgeClock();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one timer, set for the earliest change among the watched labels", () => {
    const clock = createAgeClock();
    const onHourChange = vi.fn();
    const onMinuteChange = vi.fn();
    watchLabel(clock, AN_HOUR_AGO, onHourChange);
    watchLabel(clock, HALF_A_MINUTE_AGO, onMinuteChange);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(29_999);
    expect(onMinuteChange).not.toHaveBeenCalled();

    // Every label is told, and each compares its own text: only the
    // half-a-minute label's changed.
    vi.advanceTimersByTime(1);
    expect(onMinuteChange).toHaveBeenCalledOnce();
    expect(onHourChange).toHaveBeenCalledOnce();
    expect(formatAge(HALF_A_MINUTE_AGO, clock.readNow())).toBe("1m");
    expect(formatAge(AN_HOUR_AGO, clock.readNow())).toBe("1h");
    // The next change is "1m" turning into "2m", still one timer.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps the same one timer for an age and a duration", () => {
    const clock = createAgeClock();
    const onAgeChange = vi.fn();
    const onDurationChange = vi.fn();
    watchLabel(clock, HALF_A_MINUTE_AGO, onAgeChange);
    watchLabel(clock, TWELVE_SECONDS_AGO, onDurationChange, findNextDurationChange);
    expect(vi.getTimerCount()).toBe(1);

    // The duration changes first, every second.
    vi.advanceTimersByTime(499);
    expect(onDurationChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDurationChange).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(onDurationChange).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("marks each fire for the performance script", () => {
    const mark = vi.spyOn(performance, "mark");
    const clock = createAgeClock();
    watchLabel(clock, HALF_A_MINUTE_AGO, () => {});

    vi.advanceTimersByTime(30_000 + 60_000);
    expect(mark.mock.calls.filter(([name]) => name === "age-clock-fire")).toHaveLength(2);
  });

  it("removes the timer when the last label stops watching", () => {
    const clock = createAgeClock();
    const unwatchFirst = watchLabel(clock, AN_HOUR_AGO, () => {});
    const unwatchSecond = watchLabel(clock, HALF_A_MINUTE_AGO, () => {});

    unwatchFirst();
    expect(vi.getTimerCount()).toBe(1);
    unwatchSecond();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer while the window is hidden, and reads the time again when it is shown", () => {
    const clock = createAgeClock();
    const onChange = vi.fn();
    watchLabel(clock, HALF_A_MINUTE_AGO, onChange);

    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);

    // Time passes while the window is hidden, and nothing wakes the clock.
    vi.setSystemTime(new Date("2026-09-10T09:05:00.000Z"));
    expect(onChange).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(onChange).toHaveBeenCalledOnce();
    expect(formatAge(HALF_A_MINUTE_AGO, clock.readNow())).toBe("5m");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reads the time again when the window gets focus", () => {
    const clock = createAgeClock();
    const onChange = vi.fn();
    watchLabel(clock, HALF_A_MINUTE_AGO, onChange);

    // A timer may not count the time the Mac slept: the clock moves on
    // without the timer firing.
    vi.setSystemTime(new Date("2026-09-10T09:02:00.000Z"));
    window.dispatchEvent(new Event("focus"));

    expect(onChange).toHaveBeenCalledOnce();
    expect(formatAge(HALF_A_MINUTE_AGO, clock.readNow())).toBe("2m");
  });

  it("does not tell the labels anything when the time is read again and no text changed", () => {
    const clock = createAgeClock();
    const onChange = vi.fn();
    watchLabel(clock, AN_HOUR_AGO, onChange);

    vi.setSystemTime(new Date("2026-09-10T09:30:00.000Z"));
    clock.refresh();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("waits no longer than setTimeout allows for a label 30 days in the future, and does not fire in a loop", () => {
    const mark = vi.spyOn(performance, "mark");
    const clock = createAgeClock();
    const onChange = vi.fn();
    // The controller's clock is 30 days ahead: the label reads "now" until
    // one minute after `at`.
    watchLabel(clock, new Date(NOW.getTime() + 30 * 24 * 60 * 60_000).toISOString(), onChange);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(mark).not.toHaveBeenCalled();

    // The longest delay setTimeout keeps, 2,147,483,647 ms, is about 24.8
    // days. The clock fires once then, finds no change, and waits again.
    vi.advanceTimersByTime(2_147_483_647 - 60_000);
    expect(mark).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("useAgeLabel, useAgeWords and useDurationText", () => {
  it("watch the clock only while the label is on screen", () => {
    const { rerender } = renderHook(
      ({ onScreen }: { onScreen: boolean }) => useAgeLabel(HALF_A_MINUTE_AGO, onScreen),
      { initialProps: { onScreen: false } },
    );
    expect(vi.getTimerCount()).toBe(0);

    rerender({ onScreen: true });
    expect(vi.getTimerCount()).toBe(1);

    rerender({ onScreen: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("share one timer with a duration, and set none while the window is hidden", () => {
    const { result } = renderHook(() => ({
      age: useAgeLabel(HALF_A_MINUTE_AGO, true),
      duration: useDurationText(
        TWELVE_SECONDS_AGO,
        true,
        (now) => `Working for ${Math.round((now - Date.parse(TWELVE_SECONDS_AGO)) / 1000)}s`,
      ),
    }));
    expect(result.current).toEqual({ age: "now", duration: "Working for 12s" });
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.duration).toBe("Working for 13s");
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      setVisibility("hidden");
    });
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.duration).toBe("Working for 13s");

    act(() => {
      setVisibility("visible");
    });
    expect(result.current.duration).toBe("Working for 18s");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("set no timer for a duration that is not counting", () => {
    const { result } = renderHook(() =>
      useDurationText(TWELVE_SECONDS_AGO, false, () => "Worked for 12s"),
    );
    expect(result.current).toBe("Worked for 12s");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("return the short label and the words, and change them at the same moment", () => {
    const { result } = renderHook(() => ({
      label: useAgeLabel(HALF_A_MINUTE_AGO, true),
      words: useAgeWords(HALF_A_MINUTE_AGO, true),
    }));
    expect(result.current).toEqual({ label: "now", words: "just now" });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toEqual({ label: "1m", words: "1 minute ago" });
  });
});
