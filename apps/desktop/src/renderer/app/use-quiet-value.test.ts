import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuietValue } from "./use-quiet-value";

describe("useQuietValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the old value until the new one has stood still for the quiet", () => {
    const { result, rerender } = renderHook(({ value }) => useQuietValue(value, 200), {
      initialProps: { value: "a" },
    });

    rerender({ value: "ab" });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    rerender({ value: "abc" });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe("a");

    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(result.current).toBe("abc");
  });

  it("sets no timer while the value does not change", () => {
    renderHook(() => useQuietValue("a", 200));

    expect(vi.getTimerCount()).toBe(0);
  });
});
