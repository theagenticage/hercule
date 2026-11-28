/**
 * Tests when the typing guard holds and when it lets go: a pause in the
 * edits, a send, the field losing the focus, and an IME composition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TYPING_PAUSE_MS } from "./question-composer";
import { createTypingGuard } from "./typing-guard";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the typing guard", () => {
  it("holds nothing until the user edits", () => {
    const guard = createTypingGuard();

    vi.advanceTimersByTime(TYPING_PAUSE_MS * 10);

    expect(guard.isHolding()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds after an edit, and lets go once a pause as long as the limit passes", () => {
    const guard = createTypingGuard();

    guard.holdAfterEdit();
    expect(guard.isHolding()).toBe(true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS - 1);
    expect(guard.isHolding()).toBe(true);
    vi.advanceTimersByTime(1);

    expect(guard.isHolding()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts the pause from the last edit, so keys within the limit keep holding", () => {
    const guard = createTypingGuard();

    for (let key = 0; key < 4; key += 1) {
      guard.holdAfterEdit();
      vi.advanceTimersByTime(TYPING_PAUSE_MS - 100);
      expect(guard.isHolding()).toBe(true);
    }
    vi.advanceTimersByTime(100);

    expect(guard.isHolding()).toBe(false);
  });

  it("lets go at once on release, which a send and a blur call", () => {
    const guard = createTypingGuard();
    guard.holdAfterEdit();

    guard.release();

    expect(guard.isHolding()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds from the start of a composition, before its first edit", () => {
    const guard = createTypingGuard();

    guard.reportComposing(true);

    expect(guard.isHolding()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps holding while a composition is open, however long and however it is released", () => {
    const guard = createTypingGuard();
    guard.reportComposing(true);
    guard.holdAfterEdit();

    vi.advanceTimersByTime(TYPING_PAUSE_MS * 3);
    expect(guard.isHolding()).toBe(true);
    guard.release();

    expect(guard.isHolding()).toBe(true);
  });

  it("lets go one pause after the composition ends, also when it left no edit", () => {
    const guard = createTypingGuard();
    guard.reportComposing(true);
    guard.holdAfterEdit();
    vi.advanceTimersByTime(TYPING_PAUSE_MS * 3);

    guard.reportComposing(false);
    expect(guard.isHolding()).toBe(true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    expect(guard.isHolding()).toBe(false);
  });

  it("starts no timer when a composition ends without a hold", () => {
    const guard = createTypingGuard();

    guard.reportComposing(true);
    guard.release();
    guard.reportComposing(false);
    guard.release();
    guard.reportComposing(true);
    guard.reportComposing(false);
    guard.release();

    expect(guard.isHolding()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tells listeners only when holding changes, until they unsubscribe", () => {
    const guard = createTypingGuard();
    const listener = vi.fn();
    const unsubscribe = guard.subscribe(listener);

    guard.holdAfterEdit();
    guard.holdAfterEdit();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    expect(listener).toHaveBeenCalledTimes(2);
    guard.release();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    guard.holdAfterEdit();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clears its timer when the composer goes away", () => {
    const guard = createTypingGuard();
    guard.holdAfterEdit();

    guard.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });
});
