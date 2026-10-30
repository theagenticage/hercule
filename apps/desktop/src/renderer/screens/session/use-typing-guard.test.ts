/**
 * Tests when the typing guard holds and when it lets go: a pause in the
 * edits, a send, the field losing the focus, and an IME composition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { TYPING_PAUSE_MS } from "@hercule/client-core";
import { useTypingGuard } from "./use-typing-guard";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const renderGuard = () => renderHook(() => useTypingGuard());

describe("the typing guard", () => {
  it("holds nothing until the user edits", () => {
    const { result } = renderGuard();

    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS * 10);
    });

    expect(result.current.holding).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds after an edit, and lets go once a pause as long as the limit passes", () => {
    const { result } = renderGuard();

    act(() => {
      result.current.holdAfterEdit();
    });
    expect(result.current.holding).toBe(true);
    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS - 1);
    });
    expect(result.current.holding).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(result.current.holding).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts the pause from the last edit, so keys within the limit keep holding", () => {
    const { result } = renderGuard();

    for (let key = 0; key < 4; key += 1) {
      act(() => {
        result.current.holdAfterEdit();
        vi.advanceTimersByTime(TYPING_PAUSE_MS - 100);
      });
      expect(result.current.holding).toBe(true);
    }
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.holding).toBe(false);
  });

  it("lets go at once on release, which a send and a blur call", () => {
    const { result } = renderGuard();
    act(() => {
      result.current.holdAfterEdit();
    });

    act(() => {
      result.current.release();
    });

    expect(result.current.holding).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps holding while a composition is open, however long and however it is released", () => {
    const { result } = renderGuard();
    act(() => {
      result.current.reportComposing(true);
      result.current.holdAfterEdit();
    });

    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS * 3);
    });
    expect(result.current.holding).toBe(true);
    act(() => {
      result.current.release();
    });

    expect(result.current.holding).toBe(true);
  });

  it("lets go one pause after the composition ends, also when it left no edit", () => {
    const { result } = renderGuard();
    act(() => {
      result.current.reportComposing(true);
      result.current.holdAfterEdit();
      vi.advanceTimersByTime(TYPING_PAUSE_MS * 3);
    });

    act(() => {
      result.current.reportComposing(false);
    });
    expect(result.current.holding).toBe(true);
    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    expect(result.current.holding).toBe(false);
  });

  it("starts no timer when a composition ends without a hold", () => {
    const { result } = renderGuard();

    act(() => {
      result.current.reportComposing(true);
      result.current.reportComposing(false);
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer when the composer goes away", () => {
    const { result, unmount } = renderGuard();
    act(() => {
      result.current.holdAfterEdit();
    });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
