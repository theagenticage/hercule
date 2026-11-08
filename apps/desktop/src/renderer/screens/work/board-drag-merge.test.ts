/**
 * Tests the merge gesture through its own interface: the wait for the pointer
 * to rest, the card it chooses and the dock of the card in the hand. What a
 * chosen card shows and when its merge may go ahead belong to the merge intent,
 * tested in `merge-intent.test.ts`; here the intent is a fake that records what
 * the gesture asks of it. The real carry is covered by `use-board-drag.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackBody } from "../../app/motion";
import { createMergeGesture, type MergeGesture } from "./board-drag-merge";
import type { MergeCommit, MergeIntent } from "./merge-intent";

const HOME = { left: 100, top: 100, width: 140, height: 90 };
const START = { x: 120, y: 120 };

let scroller: HTMLElement;
let slot: HTMLElement;
let ghost: HTMLElement;
let target: HTMLElement;

/** An intent that chooses what it is given, until it is left, and records the calls. */
const createFakeIntent = () => {
  let isChosen = false;
  const intent = {
    choose: vi.fn<MergeIntent["choose"]>(() => {
      isChosen = true;
      return true;
    }),
    leave: vi.fn(() => {
      isChosen = false;
    }),
    isWaiting: vi.fn(() => false),
    commit: vi.fn<MergeIntent["commit"]>(() => isChosen),
  };
  return { intent, isChosen: () => isChosen };
};

let fake: ReturnType<typeof createFakeIntent>;

/** Starts a gesture on a board with one card, "delivery-slots". */
const startGesture = (isOptionHeld = false): MergeGesture => {
  ghost = document.createElement("div");
  fake = createFakeIntent();
  return createMergeGesture({
    scroller,
    sourceId: "refund-emails",
    intent: fake.intent,
    slot,
    body: trackBody(ghost),
    home: HOME,
    grab: { x: 10, y: 10 },
    reduced: true,
    pointer: START,
    isOptionHeld,
  });
};

const isMarked = (): boolean => fake.isChosen();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  scroller = document.createElement("div");
  target = document.createElement("div");
  target.dataset["cardId"] = "delivery-slots";
  slot = document.createElement("div");
  scroller.append(target, slot);
  document.body.append(scroller);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("the merge gesture", () => {
  it("chooses a card after one second of rest over its middle, and shuts the slot", () => {
    const merge = startGesture();
    merge.update({ x: 300, y: 200 }, "delivery-slots");

    vi.advanceTimersByTime(999);
    expect(isMarked()).toBe(false);
    vi.advanceTimersByTime(1);

    expect(fake.intent.choose).toHaveBeenCalledExactlyOnceWith({
      sourceId: "refund-emails",
      targetId: "delivery-slots",
      element: target,
    });
    expect(slot.classList.contains("is-shut")).toBe(true);
    expect(merge.handMotion()).toBe("docked");
  });

  it("starts the wait again when the pointer moves more than 6px, not for 6px", () => {
    const merge = startGesture();
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    vi.advanceTimersByTime(600);
    merge.update({ x: 306, y: 200 }, "delivery-slots");
    vi.advanceTimersByTime(400);
    expect(isMarked()).toBe(true);

    merge.cancel();

    const other = startGesture();
    other.update({ x: 300, y: 200 }, "delivery-slots");
    vi.advanceTimersByTime(600);
    other.update({ x: 307, y: 200 }, "delivery-slots");
    vi.advanceTimersByTime(999);
    expect(isMarked()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isMarked()).toBe(true);
  });

  it("chooses at once with Option held, and when Option goes down over a resting pointer", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    expect(fake.intent.choose).toHaveBeenCalledOnce();

    const later = startGesture();
    later.update({ x: 300, y: 200 }, "delivery-slots");
    expect(later.handMotion()).toBe("free");
    later.setOptionHeld(true);
    later.update({ x: 300, y: 200 }, "delivery-slots");
    expect(later.handMotion()).toBe("docked");
  });

  it("keeps the card chosen while the pointer drifts inside its middle", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    merge.update({ x: 301, y: 200 }, "delivery-slots");

    expect(fake.intent.choose).toHaveBeenCalledOnce();
    expect(fake.intent.leave).not.toHaveBeenCalled();
  });

  it("leaves the card at once when the pointer leaves the middle, and the hand glides for 200ms", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");

    merge.update({ x: 300, y: 260 }, null);

    expect(fake.intent.leave).toHaveBeenCalledOnce();
    expect(isMarked()).toBe(false);
    expect(slot.classList.contains("is-shut")).toBe(false);
    expect(merge.handMotion()).toBe("gliding");
    vi.advanceTimersByTime(200);
    expect(merge.handMotion()).toBe("free");
  });

  it("chooses nothing when the intent does not take the card", () => {
    const merge = startGesture(true);
    fake.intent.choose.mockReturnValue(false);

    merge.update({ x: 300, y: 200 }, "delivery-slots");

    expect(slot.classList.contains("is-shut")).toBe(false);
    expect(merge.handMotion()).toBe("free");
  });

  it("commits to the chosen card through the intent, and leaves the marks to cancel", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    const commit: MergeCommit = { onDecision: () => undefined };

    expect(merge.commit(commit)).toBe(true);

    expect(fake.intent.commit).toHaveBeenCalledExactlyOnceWith(commit);
    expect(fake.intent.leave).not.toHaveBeenCalled();
    merge.cancel();
    expect(fake.intent.leave).toHaveBeenCalledOnce();
  });

  it("commits nothing while the wait is still running, and the wait never fires", () => {
    const merge = startGesture();
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    vi.advanceTimersByTime(900);

    expect(merge.commit({ onDecision: () => undefined })).toBe(false);
    vi.advanceTimersByTime(2000);

    expect(fake.intent.choose).not.toHaveBeenCalled();
    expect(fake.intent.commit).not.toHaveBeenCalled();
  });

  it("chooses nothing after cancel, even with Option held, and leaves only once", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    merge.cancel();
    merge.cancel();
    merge.update({ x: 300, y: 200 }, "delivery-slots");

    expect(fake.intent.choose).toHaveBeenCalledOnce();
    expect(fake.intent.leave).toHaveBeenCalledOnce();
    expect(merge.commit({ onDecision: () => undefined })).toBe(false);
  });

  it("leaves the card on refresh when it was replaced by a new element", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    target.remove();

    merge.refresh();

    expect(fake.intent.leave).toHaveBeenCalledOnce();
    expect(merge.handMotion()).toBe("gliding");
    expect(slot.classList.contains("is-shut")).toBe(false);
  });
});
