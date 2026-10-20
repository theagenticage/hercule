/**
 * Tests the "Syncing…" marker of a header: it shows only after syncing has
 * lasted 400 ms, and goes at once when syncing ends.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncMarker } from "./sync-marker";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe("the syncing marker", () => {
  it("has an empty status element from the start", () => {
    render(<SyncMarker syncing={false} />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("shows its word once syncing has lasted 400 ms, and drops it at once when syncing ends", () => {
    const { rerender } = render(<SyncMarker syncing />);
    advance(399);
    expect(screen.getByRole("status").textContent).toBe("");
    advance(1);
    expect(screen.getByRole("status").textContent).toBe("Syncing…");

    rerender(<SyncMarker syncing={false} />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("never shows its word for a sync that ends at 300 ms, and times a later sync from its own start", () => {
    const { rerender } = render(<SyncMarker syncing />);
    advance(300);
    rerender(<SyncMarker syncing={false} />);
    advance(1000);
    expect(screen.getByRole("status").textContent).toBe("");

    rerender(<SyncMarker syncing />);
    advance(399);
    expect(screen.getByRole("status").textContent).toBe("");
    advance(1);
    expect(screen.getByRole("status").textContent).toBe("Syncing…");
  });
});
