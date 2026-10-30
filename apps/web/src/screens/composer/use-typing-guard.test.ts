import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { TYPING_PAUSE_MS } from "@hercule/client-core";
import { useTypingGuard } from "./use-typing-guard";

describe("useTypingGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds from an edit until the pause has passed with no further edit", () => {
    const { result } = renderHook(() => useTypingGuard());
    expect(result.current.holding).toBe(false);

    act(() => {
      result.current.holdAfterEdit();
    });
    expect(result.current.holding).toBe(true);

    // Another edit starts the pause again.
    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS - 1);
      result.current.holdAfterEdit();
      vi.advanceTimersByTime(TYPING_PAUSE_MS - 1);
    });
    expect(result.current.holding).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.holding).toBe(false);
  });

  it("releases at once when asked to", () => {
    const { result } = renderHook(() => useTypingGuard());

    act(() => {
      result.current.holdAfterEdit();
      result.current.release();
    });
    expect(result.current.holding).toBe(false);
  });

  it("does not release during an IME composition, however long it takes, and starts the pause when it ends", () => {
    const { result } = renderHook(() => useTypingGuard());

    act(() => {
      result.current.reportComposing(true);
      result.current.holdAfterEdit();
      vi.advanceTimersByTime(10 * TYPING_PAUSE_MS);
      result.current.release();
    });
    expect(result.current.holding).toBe(true);

    act(() => {
      result.current.reportComposing(false);
      vi.advanceTimersByTime(TYPING_PAUSE_MS - 1);
    });
    expect(result.current.holding).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.holding).toBe(false);
  });

  it("runs no timer while the user is not typing", () => {
    const { result } = renderHook(() => useTypingGuard());

    act(() => {
      result.current.reportComposing(true);
      result.current.reportComposing(false);
    });
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      result.current.holdAfterEdit();
      result.current.release();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
