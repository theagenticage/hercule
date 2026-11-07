/**
 * Tests the rules of `waitForStillHand` with a fake clock: when a change may
 * go ahead, when it must wait, and that nothing runs while nothing waits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForStillHand } from "./still-hand";

/** A target 100 by 100 pixels with its top left at 500, 500. */
const makeTarget = (): HTMLElement => {
  const element = document.createElement("div");
  document.body.append(element);
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 500, 100, 100));
  return element;
};

/** Moves the pointer to `x`, `y`. */
const movePointer = (x: number, y: number): void => {
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
};

/** Every wait a test started, aborted afterwards so one test cannot leave a waiter for the next. */
const running: AbortController[] = [];

/** Starts a wait and records whether it has ended. */
const startWait = (
  target: Element | null,
  { isDragging = () => false }: { isDragging?: () => boolean } = {},
) => {
  const controller = new AbortController();
  running.push(controller);
  const result: { value: boolean | null } = { value: null };
  void waitForStillHand({ target: () => target, isDragging, signal: controller.signal }).then(
    (isStill) => {
      result.value = isStill;
    },
  );
  return { result, controller };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const controller of running.splice(0)) controller.abort();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("waitForStillHand", () => {
  it("goes ahead at once when the pointer is far away", async () => {
    const { result } = startWait(makeTarget());
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits while the pointer rests within 120px of the target, however long it has rested", async () => {
    const dragging = { value: true };
    const { result } = startWait(makeTarget(), { isDragging: () => dragging.value });
    movePointer(450, 550);
    await vi.advanceTimersByTimeAsync(0);
    dragging.value = false;

    await vi.advanceTimersByTimeAsync(7_000);

    expect(result.value).toBeNull();
  });

  it("goes ahead once the pointer rests beyond 120px and has stopped moving", async () => {
    const dragging = { value: true };
    const { result } = startWait(makeTarget(), { isDragging: () => dragging.value });
    movePointer(300, 550);
    dragging.value = false;
    // 200px away: not reading, but still moving for the next 900ms.
    await vi.advanceTimersByTimeAsync(720);
    expect(result.value).toBeNull();

    await vi.advanceTimersByTimeAsync(480);

    expect(result.value).toBe(true);
  });

  it("goes ahead at once for a pointer on the move beyond 280px", async () => {
    const dragging = { value: true };
    const { result } = startWait(makeTarget(), { isDragging: () => dragging.value });
    movePointer(100, 550);
    dragging.value = false;

    await vi.advanceTimersByTimeAsync(240);

    expect(result.value).toBe(true);
  });

  it("waits while the user is dragging, and goes ahead when the drag ends", async () => {
    const dragging = { value: true };
    const { result } = startWait(null, { isDragging: () => dragging.value });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(result.value).toBeNull();

    dragging.value = false;
    await vi.advanceTimersByTimeAsync(240);

    expect(result.value).toBe(true);
  });

  it("never waits longer than 8 seconds for a pointer that rests near the target", async () => {
    const dragging = { value: true };
    const { result } = startWait(makeTarget(), { isDragging: () => dragging.value });
    movePointer(450, 550);
    dragging.value = false;
    await vi.advanceTimersByTimeAsync(7_700);
    expect(result.value).toBeNull();

    await vi.advanceTimersByTimeAsync(500);

    expect(result.value).toBe(true);
  });

  it("does not end while the user is dragging, however long the drag lasts", async () => {
    const dragging = { value: true };
    const { result } = startWait(makeTarget(), { isDragging: () => dragging.value });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(result.value).toBeNull();

    dragging.value = false;
    await vi.advanceTimersByTimeAsync(240);

    expect(result.value).toBe(true);
  });

  it("counts its 8 seconds from the end of a drag, not from the start of the wait", async () => {
    const dragging = { value: true };
    const { result } = startWait(makeTarget(), { isDragging: () => dragging.value });
    movePointer(450, 550);
    await vi.advanceTimersByTimeAsync(20_000);

    dragging.value = false;
    await vi.advanceTimersByTimeAsync(7_500);
    // The pointer rests where the card was dropped, next to the target: someone is reading.
    expect(result.value).toBeNull();

    await vi.advanceTimersByTimeAsync(700);

    expect(result.value).toBe(true);
  });

  it("resolves with false when it is aborted", async () => {
    const { result, controller } = startWait(null, { isDragging: () => true });
    await vi.advanceTimersByTimeAsync(1_000);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toBe(false);
  });

  it("runs no timer and listens to no pointer while nothing waits", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const dragging = { value: true };
    const { result } = startWait(makeTarget(), { isDragging: () => dragging.value });
    movePointer(450, 550);
    dragging.value = false;
    expect(vi.getTimerCount()).toBe(1);
    expect(add).toHaveBeenCalledWith("pointermove", expect.any(Function), { passive: true });

    await vi.advanceTimersByTimeAsync(8_300);

    expect(result.value).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("pointermove", expect.any(Function));
  });
});
