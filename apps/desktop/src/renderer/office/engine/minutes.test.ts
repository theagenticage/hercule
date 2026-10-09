/**
 * Tests the minute watch behind the Secretariat's clock: one call at once,
 * one at the start of every minute, none while the window is hidden (even
 * when it starts hidden), and one when the window shows again. Timers and
 * the date are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchMinutes } from "./minutes";

/** 20 seconds into a minute, so the first timer is due in 40 seconds. */
const NOW = new Date("2026-10-09T09:00:20.000Z");

/** Sets what `document.hidden` reads and fires `visibilitychange`. */
const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

/** Returns the times `onMinute` was called with, as ISO strings. */
const readCalls = (onMinute: ReturnType<typeof vi.fn>): string[] =>
  onMinute.mock.calls.map(([now]) => (now as Date).toISOString());

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

describe("watchMinutes", () => {
  it("calls at once, then at the start of every minute", () => {
    const onMinute = vi.fn();
    const stop = watchMinutes(onMinute);
    vi.advanceTimersByTime(40_000 + 60_000);
    stop();
    expect(readCalls(onMinute)).toEqual([
      "2026-10-09T09:00:20.000Z",
      "2026-10-09T09:01:00.000Z",
      "2026-10-09T09:02:00.000Z",
    ]);
  });

  it("sets no timer while the window is hidden, and calls again on show", () => {
    const onMinute = vi.fn();
    const stop = watchMinutes(onMinute);
    setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * 60_000);
    expect(onMinute).toHaveBeenCalledTimes(1);
    setHidden(false);
    stop();
    expect(readCalls(onMinute)).toEqual(["2026-10-09T09:00:20.000Z", "2026-10-09T09:05:20.000Z"]);
  });

  it("does not call and sets no timer when the window starts hidden", () => {
    setHidden(true);
    const onMinute = vi.fn();
    const stop = watchMinutes(onMinute);
    expect(onMinute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("stops calling once stopped", () => {
    const onMinute = vi.fn();
    watchMinutes(onMinute)();
    setHidden(true);
    setHidden(false);
    vi.advanceTimersByTime(5 * 60_000);
    expect(onMinute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
