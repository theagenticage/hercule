/**
 * Tests the merge gesture through its own interface: the wait, the card
 * chosen, the dock, and how it ends. The real carry is covered by
 * `use-board-drag.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeCheckResult } from "@hercule/client-core/work";
import { buildCard } from "@hercule/client-core/work/testing";
import { trackBody } from "../../app/motion";
import { createMergeGesture, type MergeGesture } from "./board-drag-merge";

const HOME = { left: 100, top: 100, width: 140, height: 90 };
const START = { x: 120, y: 120 };

let scroller: HTMLElement;
let slot: HTMLElement;
let ghost: HTMLElement;
let target: HTMLElement;

/** Starts a gesture on a board with one card, "delivery-slots", whose merge check allows it unless `checkMerge` says otherwise. */
const startGesture = (
  isOptionHeld = false,
  checkMerge: (sourceId: string, targetId: string) => Promise<MergeCheckResult> = () =>
    Promise.resolve({ kind: "allowed" }),
): MergeGesture => {
  ghost = document.createElement("div");
  return createMergeGesture({
    scroller,
    readCards: () => [
      buildCard("delivery-slots", { title: "Delivery slots", initiativeId: "checkout" }),
      buildCard("refund-emails", { title: "Refund emails", initiativeId: "billing" }),
    ],
    readInitiatives: () => [{ id: "checkout", name: "Checkout", hue: 245 }],
    sourceId: "refund-emails",
    checkMerge,
    slot,
    body: trackBody(ghost),
    home: HOME,
    grab: { x: 10, y: 10 },
    reduced: true,
    pointer: START,
    isOptionHeld,
  });
};

const isMarked = (): boolean => target.hasAttribute("data-merge-target");

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

    expect(isMarked()).toBe(true);
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
    expect(merge.commit()?.cardId).toBe("delivery-slots");

    const later = startGesture();
    later.update({ x: 300, y: 200 }, "delivery-slots");
    expect(later.handMotion()).toBe("free");
    later.setOptionHeld(true);
    later.update({ x: 300, y: 200 }, "delivery-slots");
    expect(later.handMotion()).toBe("docked");
  });

  it("undoes the merge at once when the pointer leaves the middle, and the hand glides for 200ms", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");

    merge.update({ x: 300, y: 260 }, null);

    expect(isMarked()).toBe(false);
    expect(slot.classList.contains("is-shut")).toBe(false);
    expect(merge.handMotion()).toBe("gliding");
    vi.advanceTimersByTime(200);
    expect(merge.handMotion()).toBe("free");
  });

  it("returns the chosen card on commit, leaves the marks, and stops the wait", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");

    const choice = merge.commit();
    expect(choice).toMatchObject({
      cardId: "delivery-slots",
      element: target,
      check: { kind: "checking" },
    });
    expect(choice?.result).toBeInstanceOf(Promise);
    expect(isMarked()).toBe(true);
    merge.cancel();
    expect(isMarked()).toBe(false);
  });

  it("returns none on commit while the wait is still running, and the wait never fires", () => {
    const merge = startGesture();
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    vi.advanceTimersByTime(900);

    expect(merge.commit()).toBeNull();
    vi.advanceTimersByTime(2000);

    expect(isMarked()).toBe(false);
  });

  it("chooses nothing after cancel, even with Option held", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    merge.cancel();
    merge.update({ x: 300, y: 200 }, "delivery-slots");

    expect(isMarked()).toBe(false);
    expect(merge.commit()).toBeNull();
  });

  it("undoes the merge on refresh when the chosen card was replaced by a new element", () => {
    const merge = startGesture(true);
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    target.remove();

    merge.refresh();

    expect(merge.handMotion()).toBe("gliding");
    expect(slot.classList.contains("is-shut")).toBe(false);
  });
});

describe("the merge check of the gesture", () => {
  it("asks once for the pair chosen, and says what stays with the initiative of the card merged into", async () => {
    const ask = vi.fn(() => Promise.resolve({ kind: "allowed" } as const));
    const merge = startGesture(true, ask);
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    merge.update({ x: 301, y: 200 }, "delivery-slots");

    expect(ask).toHaveBeenCalledExactlyOnceWith("refund-emails", "delivery-slots");
    await Promise.resolve();
    expect(target.dataset["mergeKeeps"]).toBe(
      "Keeps its title, stage, place and initiative Checkout",
    );
    expect(merge.commit()?.check).toEqual({ kind: "allowed" });
  });

  it("commits a refused choice with its refusal", async () => {
    const merge = startGesture(true, () =>
      Promise.resolve({ kind: "refused", refusal: "A loop." } as const),
    );
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    await Promise.resolve();

    expect(merge.commit()?.check).toEqual({ kind: "refused", refusal: "A loop." });
    expect(target.dataset["mergeLabel"]).toBe("Cannot merge: A loop");
  });

  it("ignores an answer that comes after the drop", async () => {
    let answer: (result: MergeCheckResult) => void = () => undefined;
    const merge = startGesture(true, () => new Promise((resolve) => (answer = resolve)));
    merge.update({ x: 300, y: 200 }, "delivery-slots");
    merge.commit();

    answer({ kind: "refused", refusal: "A loop." });
    await Promise.resolve();

    expect(target.dataset["mergeCheck"]).toBe("checking");
  });
});
