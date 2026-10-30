/**
 * Tests that the hook stops the typing guard's timer on unmount. The rules of
 * the guard are tested in client-core, and the redraw is tested through the
 * thread composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTypingGuard } from "./use-typing-guard";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTypingGuard", () => {
  it("clears the guard's timer when the composer goes away", () => {
    const { result, unmount } = renderHook(() => useTypingGuard());
    act(() => {
      result.current.holdAfterEdit();
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
