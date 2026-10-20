/**
 * Tests when a Tracking row's line fades in anew: when its state changes, once,
 * and never under Reduce motion. jsdom has no Web Animations API, so the test
 * stands in for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { TrackingState } from "@hercule/client-core";
import { useLineFade } from "./use-line-fade";

const animate = vi.fn();

/** Draws a root with one row, as Tracking's rows are marked, and returns it with the row's line. */
const drawRoot = () => {
  const root = document.body.appendChild(document.createElement("div"));
  const row = root.appendChild(document.createElement("div"));
  row.dataset.itemKey = "task-1";
  const line = row.appendChild(document.createElement("span"));
  line.className = "tr-run-sub";
  return { root, line };
};

beforeEach(() => {
  Object.defineProperty(Element.prototype, "animate", { value: animate, configurable: true });
  document.documentElement.style.setProperty("--dur-2", "200ms");
});

afterEach(() => {
  animate.mockClear();
  document.body.replaceChildren();
});

const draw = (state: TrackingState) => [{ taskId: "task-1", state }];

describe("useLineFade", () => {
  it("fades the line in once when the row's state changes, and not when the row is first drawn", () => {
    const { root, line } = drawRoot();
    const { rerender } = renderHook(({ state }) => useLineFade(draw(state), { current: root }), {
      initialProps: { state: "working" as TrackingState },
    });
    expect(animate).not.toHaveBeenCalled();
    rerender({ state: "finished" });
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(line);
    rerender({ state: "finished" });
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("plays nothing under Reduce motion, which sets the durations to 0", () => {
    document.documentElement.style.setProperty("--dur-2", "0s");
    const { root } = drawRoot();
    const { rerender } = renderHook(({ state }) => useLineFade(draw(state), { current: root }), {
      initialProps: { state: "working" as TrackingState },
    });
    rerender({ state: "finished" });
    expect(animate).not.toHaveBeenCalled();
  });
});
