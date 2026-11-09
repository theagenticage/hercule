/**
 * Tests the click guard a carry leaves (`swallowNextClick`): it swallows the
 * click that follows the drop and only that one, however long the drop's
 * handler takes, it counts its 50 ms from the release when the button was
 * still down, a press ends it, and ending it reads nothing from a page that is
 * gone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { swallowNextClick } from "./swallow-click";

/** Dispatches a click on the window, and returns whether it reached the listeners after the guard. */
const click = (): boolean => {
  const reached = vi.fn();
  window.addEventListener("click", reached);
  window.dispatchEvent(new Event("click", { cancelable: true }));
  window.removeEventListener("click", reached);
  return reached.mock.calls.length > 0;
};

/** Blocks the thread for `ms`, as a handler does that re-renders a large board. */
const blockFor = (ms: number): void => {
  const start = performance.now();
  while (performance.now() - start < ms) {
    // Nothing else can run while this does, timers included.
  }
};

afterEach(() => {
  // A guard that no test used up must not swallow a click of the next test.
  window.dispatchEvent(new Event("pointerdown"));
  vi.useRealTimers();
});

describe("swallowNextClick", () => {
  it("swallows the click that follows a drop, and no later click", () => {
    vi.useFakeTimers();
    swallowNextClick(true);
    vi.advanceTimersByTime(10);

    expect(click()).toBe(false);
    expect(click()).toBe(true);
  });

  it("lets a click through that comes after 50 ms, and ends the guard with it", () => {
    vi.useFakeTimers();
    swallowNextClick(true);
    vi.advanceTimersByTime(50);

    expect(click()).toBe(true);
    expect(click()).toBe(true);
  });

  it("swallows the click right after a drop handler that takes longer than 50 ms", () => {
    // The browser sends the click as soon as the handler returns, and the timer
    // cannot fire before that, so the click is swallowed.
    swallowNextClick(true);
    blockFor(80);

    expect(click()).toBe(false);
  });

  it("swallows the click right after a release handler that takes longer than 50 ms", () => {
    swallowNextClick(false);
    window.addEventListener("pointerup", () => blockFor(80), { once: true });
    window.dispatchEvent(new Event("pointerup"));

    expect(click()).toBe(false);
  });

  it("counts the 50 ms from the release when the button was still down at the drop", () => {
    vi.useFakeTimers();
    swallowNextClick(false);
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(10);

    expect(click()).toBe(false);
  });

  it("ends at the next press, so a release that never came swallows nothing", () => {
    vi.useFakeTimers();
    swallowNextClick(false);
    window.dispatchEvent(new Event("pointerdown"));

    expect(click()).toBe(true);
  });

  it("ends without reading the page's methods, which a torn-down test environment has deleted", () => {
    vi.useFakeTimers();
    swallowNextClick(true);
    // A test environment's teardown deletes the window's methods from the
    // global object, and the timer fires after that.
    const methods = ["addEventListener", "removeEventListener", "dispatchEvent"];
    const kept = Object.fromEntries(methods.map((name) => [name, Reflect.get(window, name)]));
    for (const name of methods) Reflect.deleteProperty(window, name);
    try {
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    } finally {
      Object.assign(window, kept);
    }
    // The guard has ended: a click now is not swallowed.
    expect(click()).toBe(true);
  });
});
