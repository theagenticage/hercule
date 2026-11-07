/**
 * Tests that a move chosen in the open sheet runs exactly once, also when the
 * page goes away while the sheet folds home.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useOpenCard } from "./use-open-card";

describe("useOpenCard", () => {
  it("runs the move chosen in the sheet when the page goes away during the fold", () => {
    const move = vi.fn();
    const { result, unmount } = renderHook(() => useOpenCard());
    act(() => {
      result.current.open({ kind: "card", id: "card-1" }, document.createElement("div"));
    });
    act(() => {
      result.current.closeThen(move);
    });
    expect(move).not.toHaveBeenCalled();

    unmount();

    expect(move).toHaveBeenCalledOnce();
  });

  it("runs the move once the sheet has folded home, and not again when the page goes away", () => {
    const move = vi.fn();
    const { result, unmount } = renderHook(() => useOpenCard());
    act(() => {
      result.current.open({ kind: "card", id: "card-1" }, document.createElement("div"));
    });
    act(() => {
      result.current.closeThen(move);
    });

    act(() => {
      result.current.sheet.finishClose();
    });
    unmount();

    expect(move).toHaveBeenCalledOnce();
  });
});
