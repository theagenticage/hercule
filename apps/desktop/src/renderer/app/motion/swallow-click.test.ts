/**
 * Tests the click guard a carry leaves (`swallowNextClick`): it swallows the
 * click that follows the drop and only that one, it counts its 50 ms from the
 * release when the button was still down, a press ends it, and it leaves no
 * timer behind that could fire after the page is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { swallowNextClick } from "./swallow-click";

/** Dispatches a click on the window, and returns whether it reached the listeners after the guard. */
const click = (): boolean => {
  const reached = vi.fn();
  window.addEventListener("click", reached);
  window.dispatchEvent(new Event("click", { cancelable: true }));
  window.removeEventListener("click", reached);
  return reached.mock.calls.length > 0;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // A guard that no test used up must not swallow a click of the next test.
  window.dispatchEvent(new Event("pointerdown"));
  vi.useRealTimers();
});

describe("swallowNextClick", () => {
  it("swallows the click that follows a drop, and no later click", () => {
    swallowNextClick(true);
    vi.advanceTimersByTime(10);

    expect(click()).toBe(false);
    expect(click()).toBe(true);
  });

  it("lets a click through that comes after 50 ms, and ends the guard with it", () => {
    swallowNextClick(true);
    vi.advanceTimersByTime(50);

    expect(click()).toBe(true);
    expect(click()).toBe(true);
  });

  it("counts the 50 ms from the release when the button was still down at the drop", () => {
    swallowNextClick(false);
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(10);

    expect(click()).toBe(false);
  });

  it("ends at the next press, so a release that never came swallows nothing", () => {
    swallowNextClick(false);
    window.dispatchEvent(new Event("pointerdown"));

    expect(click()).toBe(true);
  });

  it("leaves no timer, and nothing fires after the page's methods are gone", () => {
    swallowNextClick(true);
    // A test environment's teardown deletes the window's methods from the
    // global object. A timer left behind would call `removeEventListener` then.
    const removeEventListener = window.removeEventListener;
    Reflect.deleteProperty(window, "removeEventListener");
    try {
      expect(vi.getTimerCount()).toBe(0);
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    } finally {
      window.removeEventListener = removeEventListener;
    }
  });
});
