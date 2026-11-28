import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTypingGuard } from "./use-typing-guard";

// The rules of the guard are tested in client-core, and the redraw is tested
// through the thread composer. This test covers stopping the timer on unmount.
describe("useTypingGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
