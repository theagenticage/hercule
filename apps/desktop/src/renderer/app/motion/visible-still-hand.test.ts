/**
 * Tests that `waitForVisibleStillHand` ends with its caller's signal: an
 * aborted signal starts nothing, and an abort during the wait leaves no timer
 * behind, even for a user who is still dragging.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForVisibleStillHand } from "./visible-still-hand";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  vi.useRealTimers();
});

/** Hides or shows the window the way the browser does. */
const setVisibility = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("waitForVisibleStillHand", () => {
  it.each(["visible", "hidden"] as const)(
    "resolves false at once, and starts nothing, for a signal that has already aborted in a %s window",
    async (state) => {
      setVisibility(state);
      const controller = new AbortController();
      controller.abort();

      const isStill = await waitForVisibleStillHand({
        targets: () => [],
        isDragging: () => true,
        signal: controller.signal,
      });

      expect(isStill).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stops polling when the signal aborts during a drag that never ends", async () => {
    const controller = new AbortController();
    const result = { value: null as boolean | null };
    void waitForVisibleStillHand({
      targets: () => [],
      isDragging: () => true,
      signal: controller.signal,
    }).then((isStill) => {
      result.value = isStill;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result.value).toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting for the window when the signal aborts while it is hidden", async () => {
    setVisibility("hidden");
    const controller = new AbortController();
    const result = { value: null as boolean | null };
    void waitForVisibleStillHand({
      targets: () => [],
      isDragging: () => false,
      signal: controller.signal,
    }).then((isStill) => {
      result.value = isStill;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.value).toBeNull();

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toBe(false);
    // Showing the window now must not start a wait for a caller that is gone.
    setVisibility("visible");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("goes ahead at once when the window is visible and the hand is still", async () => {
    const isStill = await waitForVisibleStillHand({
      targets: () => [],
      isDragging: () => false,
    });

    expect(isStill).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
