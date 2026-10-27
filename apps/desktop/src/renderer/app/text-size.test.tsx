/**
 * Tests the signal that tells the page its Text size changed: who is told,
 * when, and how often, and how the row heights are read from the page's CSS.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { readLengths, subscribeToTextSize, useMeasuredAtTextSize } from "./text-size";

const root = document.documentElement;

/** Sets the step the way `public/theme-init.js` does, and lets the observer that reports it run. */
const setStep = async (step: string): Promise<void> => {
  await act(async () => {
    root.dataset.textSize = step;
    await Promise.resolve();
  });
};

afterEach(() => {
  delete root.dataset.textSize;
  root.style.removeProperty("--test-height");
});

describe("subscribeToTextSize", () => {
  it("calls the listener once for each change of step, and not for a step it already has", async () => {
    const listener = vi.fn();
    const stop = subscribeToTextSize(listener);

    await setStep("4");
    expect(listener).toHaveBeenCalledTimes(1);

    // theme-init.js skips such a write itself; the signal does not depend on that.
    await setStep("4");
    expect(listener).toHaveBeenCalledTimes(1);

    await setStep("1");
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("calls the listener when the attribute is removed, which is the default step", async () => {
    root.dataset.textSize = "4";
    const listener = vi.fn();
    const stop = subscribeToTextSize(listener);

    await act(async () => {
      delete root.dataset.textSize;
      await Promise.resolve();
    });

    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not treat the default step set by the attribute as a change from no attribute", async () => {
    const listener = vi.fn();
    const stop = subscribeToTextSize(listener);

    await setStep("2");

    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it("stops calling a listener that unsubscribed, and keeps calling the others", async () => {
    const stopped = vi.fn();
    const kept = vi.fn();
    const stop = subscribeToTextSize(stopped);
    const stopKept = subscribeToTextSize(kept);

    stop();
    await setStep("3");

    expect(stopped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
    stopKept();
  });

  it("watches again after every listener left and a new one arrives", async () => {
    subscribeToTextSize(() => {})();
    const listener = vi.fn();
    const stop = subscribeToTextSize(listener);

    await setStep("3");

    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("readLengths", () => {
  it("returns each custom property as a number of pixels under the key it was asked for", () => {
    root.style.setProperty("--test-height", "52.5px");

    expect(readLengths({ row: "--test-height" })).toEqual({ row: 52.5 });
  });

  it("fails, naming the property and what it holds, when it is not a length in pixels", () => {
    // What a browser returns for a custom property that no @property rule registers.
    root.style.setProperty("--test-height", "calc(52px + 2 * var(--text-size-step))");

    expect(() => readLengths({ row: "--test-height" })).toThrow(
      'The custom property --test-height holds "calc(52px + 2 * var(--text-size-step))"',
    );
  });
});

describe("useMeasuredAtTextSize", () => {
  it("measures once on mount, returns the same result across renders, and measures again after a change", async () => {
    root.style.setProperty("--test-height", "52px");
    const measure = vi.fn(() => readLengths({ row: "--test-height" }));
    const { result, rerender } = renderHook(() => useMeasuredAtTextSize(measure));
    const first = result.current;
    expect(first).toEqual({ row: 52 });

    rerender();
    expect(result.current).toBe(first);
    expect(measure).toHaveBeenCalledTimes(1);

    // The new step changes the property, as a browser computes it.
    root.style.setProperty("--test-height", "56px");
    await setStep("4");

    expect(result.current).toEqual({ row: 56 });
    expect(measure).toHaveBeenCalledTimes(2);
  });
});
