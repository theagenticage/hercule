import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { TYPING_PAUSE_MS } from "@hercule/client-core";
import { useTypingGuard } from "./use-typing-guard";

// The rules of the guard are tested in client-core. These tests cover what the
// hook adds: drawing `holding`, and stopping the timer on unmount.
describe("useTypingGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-renders when the hold starts and when it ends", () => {
    const { result } = renderHook(() => useTypingGuard());
    expect(result.current.holding).toBe(false);

    act(() => {
      result.current.holdAfterEdit();
    });
    expect(result.current.holding).toBe(true);

    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });
    expect(result.current.holding).toBe(false);
  });

  it("stops its timer when the component unmounts", () => {
    const { result, unmount } = renderHook(() => useTypingGuard());
    act(() => {
      result.current.holdAfterEdit();
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
