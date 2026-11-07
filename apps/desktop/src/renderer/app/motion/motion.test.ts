/**
 * Tests the motion kernel through its boundary, on a clock the test drives:
 * springs reach their goals and let the clock go, a change of mind keeps the
 * speed, Reduce motion jumps, and a flip starts from what is on screen.
 *
 * jsdom has no layout, so `placeOnScreen` gives an element a rectangle the
 * way a browser would: where the layout put it plus the offset its body shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  animateValue,
  flipElements,
  ghostElement,
  staggerDelay,
  trackBody,
  type PartialChannelValues,
} from "./index";

/** One frame of a 60 Hz display, in milliseconds. */
const FRAME = 16;

/** Lets the page's motion play out: far longer than the slowest spring takes. */
const SETTLE_TIME = 4000;

const setReduced = (reduced: boolean): void => {
  document.documentElement.style.setProperty("--dur-2", reduced ? "0s" : "200ms");
};

/** Lets `ms` milliseconds of frames pass. */
const play = (ms: number): void => {
  vi.advanceTimersByTime(ms);
};

const makeElement = (): HTMLElement => {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
};

/** Where the layout puts each element, in pixels from the window's top. */
const layoutTop = new Map<HTMLElement, number>();

/** Gives `element` a layout position and makes it report a rectangle like a browser's: layout plus the body's offset. */
const placeOnScreen = (element: HTMLElement, top: number): void => {
  layoutTop.set(element, top);
  element.getBoundingClientRect = () => {
    const shown = layoutTop.get(element)! + trackBody(element).values.y;
    return new DOMRect(10, shown, 100, 50);
  };
};

/** Returns where the user sees the top of `element`. */
const seenTop = (element: HTMLElement): number => element.getBoundingClientRect().top;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  setReduced(false);
});

afterEach(() => {
  // Every test ends with the clock idle, or the next test would find a frame still asked for.
  play(SETTLE_TIME);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  document.documentElement.style.removeProperty("--dur-2");
  document.body.replaceChildren();
  layoutTop.clear();
});

describe("a body", () => {
  it("reaches its goal exactly, runs done once, hands the element back at rest, and lets the clock go", () => {
    const element = makeElement();
    const done = vi.fn();
    const body = trackBody(element);

    body.to({ x: 100, y: -40, o: 0.5, l: 1 }, "hand", { done });
    expect(element.classList.contains("is-moving")).toBe(true);
    play(SETTLE_TIME);

    expect(element.style.transform).toBe(
      "translate3d(100.00px,-40.00px,0) scale(1.0000) rotate(0.000deg)",
    );
    expect(Number(element.style.opacity)).toBe(0.5);
    expect(Number(element.style.getPropertyValue("--lift"))).toBe(1);
    expect(element.classList.contains("is-moving")).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    body.to({ x: 0, y: 0, o: 1, l: 0 });
    play(SETTLE_TIME);
    expect(element.style.transform).toBe("");
    expect(element.style.opacity).toBe("");
  });

  it("keeps its speed when it is sent back halfway, so the position never jumps", () => {
    const element = makeElement();
    const body = trackBody(element);
    body.to({ x: 200 }, "hand");
    play(FRAME * 4);
    const before = body.values.x;
    play(FRAME);
    const stepBefore = body.values.x - before;

    body.to({ x: 0 }, "self");
    play(FRAME);
    const stepAfter = body.values.x - (before + stepBefore);

    // Sent back from rest, the body would move backward at once. With its speed
    // it carries on forward for a moment, no faster than before.
    expect(stepBefore).toBeGreaterThan(0);
    expect(stepAfter).toBeGreaterThan(0);
    expect(stepAfter).toBeLessThanOrEqual(stepBefore);
  });

  it("does not move backward when the first frame's timestamp is earlier than the moment it woke", () => {
    vi.useRealTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    try {
      const body = trackBody(makeElement());
      body.to({ x: 100 }, "hand");
      frames.shift()!(performance.now() - 50);
      expect(body.values.x).toBe(0);

      // Run the body to rest on a clock of its own, so no frame stays asked for.
      for (let time = performance.now(); frames.length > 0; time += FRAME) frames.shift()!(time);
      expect(body.values.x).toBe(100);
    } finally {
      vi.unstubAllGlobals();
      vi.useFakeTimers({
        toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
      });
    }
  });

  it("waits for its delay before it moves", () => {
    const body = trackBody(makeElement());
    body.to({ x: 100 }, "hand", { delay: 100 });
    play(FRAME * 5);
    expect(body.values.x).toBe(0);
    play(FRAME * 4);
    expect(body.values.x).toBeGreaterThan(0);
  });

  it("follows the pointer one to one, with no speed left over", () => {
    const element = makeElement();
    const body = trackBody(element);
    body.follow(30, 12);
    expect(element.style.transform).toContain("translate3d(30.00px,12.00px,0)");
    body.to({ x: 30, y: 12 });
    play(FRAME * 2);
    expect(body.values.x).toBe(30);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes the same body for the same element", () => {
    const element = makeElement();
    expect(trackBody(element)).toBe(trackBody(element));
  });

  describe("under Reduce motion", () => {
    beforeEach(() => setReduced(true));

    it("jumps at once, and calls done at once", () => {
      const element = makeElement();
      const done = vi.fn();
      trackBody(element).to({ x: 50, y: 20, s: 0.5 }, "travel", { delay: 300, done });
      expect(element.style.transform).toBe(
        "translate3d(50.00px,20.00px,0) scale(0.5000) rotate(0.000deg)",
      );
      expect(done).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("fades opacity on travel while everything else jumps", () => {
      const element = makeElement();
      const done = vi.fn();
      const body = trackBody(element);
      body.to({ x: 50, o: 0 }, "hand", { done });
      expect(body.values.x).toBe(50);
      expect(body.values.o).toBe(1);
      play(FRAME * 3);
      expect(body.values.o).toBeLessThan(1);
      expect(body.values.o).toBeGreaterThan(0);
      expect(done).not.toHaveBeenCalled();
      play(SETTLE_TIME);
      expect(body.values.o).toBe(0);
      expect(done).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a value", () => {
  it("moves from 0 to 1 over several frames and ends exactly on 1", () => {
    const seen: number[] = [];
    const value = animateValue(0, (next) => seen.push(next));
    const done = vi.fn();

    value.to(1, "travel", done);
    play(FRAME);
    expect(seen.at(-1)).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeLessThan(1);
    play(SETTLE_TIME);

    expect(seen.at(-1)).toBe(1);
    expect(value.current).toBe(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("jumps under Reduce motion", () => {
    setReduced(true);
    const seen: number[] = [];
    const done = vi.fn();
    animateValue(0, (next) => seen.push(next)).to(1, "travel", done);
    expect(seen).toEqual([1]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("flipping elements", () => {
  it("starts each element from the place it was on screen, then settles it in its new place", () => {
    const element = makeElement();
    placeOnScreen(element, 100);

    flipElements([element], () => layoutTop.set(element, 300));
    expect(seenTop(element)).toBe(100);
    play(FRAME * 3);
    expect(seenTop(element)).toBeGreaterThan(100);
    expect(seenTop(element)).toBeLessThan(300);

    play(SETTLE_TIME);
    expect(seenTop(element)).toBe(300);
    expect(element.style.transform).toBe("");
  });

  it("turns around from where an element is on screen when the page changes again halfway", () => {
    const element = makeElement();
    placeOnScreen(element, 100);
    flipElements([element], () => layoutTop.set(element, 300));
    play(FRAME * 4);
    const seenMidway = seenTop(element);

    flipElements([element], () => layoutTop.set(element, 100), { spring: "self" });
    expect(seenTop(element)).toBeCloseTo(seenMidway, 5);

    // It was heading down, so it carries on down for a moment before it turns.
    play(FRAME);
    expect(seenTop(element)).toBeGreaterThan(seenMidway);

    play(SETTLE_TIME);
    expect(seenTop(element)).toBe(100);
  });

  it("leaves alone an element the change removed, and one that did not move", () => {
    const gone = makeElement();
    const still = makeElement();
    placeOnScreen(gone, 100);
    placeOnScreen(still, 200);

    flipElements([gone, still], () => gone.remove());

    expect(vi.getTimerCount()).toBe(0);
    expect(still.style.transform).toBe("");
  });

  it("puts elements in their places at once under Reduce motion", () => {
    setReduced(true);
    const element = makeElement();
    placeOnScreen(element, 100);
    flipElements([element], () => layoutTop.set(element, 300));
    expect(element.style.transform).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("puts an element in its place at once when it moves more than a screen", () => {
    const element = makeElement();
    placeOnScreen(element, 100);
    flipElements([element], () => layoutTop.set(element, 3000));
    expect(element.style.transform).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a staggered list late, but never later than the cap, however long the list is", () => {
    const elements = Array.from({ length: 100 }, (_, index) => {
      const element = makeElement();
      placeOnScreen(element, index * 60);
      return element;
    });

    flipElements(
      elements,
      () => elements.forEach((element) => layoutTop.set(element, layoutTop.get(element)! + 60)),
      {
        stagger: (_element, index) => index * 16,
      },
    );

    const last = elements.at(-1)!;
    play(120);
    expect(last.style.transform).toContain("translate3d(0.00px,-60.00px");
    play(SETTLE_TIME / 4);
    expect(vi.getTimerCount()).toBe(0);
    expect(last.style.transform).toBe("");
  });
});

describe("staggerDelay", () => {
  it("spaces elements by the gap and stops at the cap", () => {
    expect(staggerDelay(3, 16)).toBe(48);
    expect(staggerDelay(500, 16)).toBe(130);
  });
});

describe("a ghost", () => {
  it("copies an element where the layout has it, with the offset it shows, and without its id", () => {
    const element = makeElement();
    element.id = "card-7";
    element.textContent = "Reorder oat milk";
    placeOnScreen(element, 120);
    const layer = makeElement();
    layer.getBoundingClientRect = () => new DOMRect(0, 20, 800, 600);
    trackBody(element).set({ y: 30 } satisfies PartialChannelValues);

    const ghost = ghostElement(element, layer);

    expect(ghost.parentElement).toBe(layer);
    expect(ghost.id).toBe("");
    expect(ghost.textContent).toBe("Reorder oat milk");
    expect(ghost.classList.contains("is-ghost")).toBe(true);
    expect(ghost.style.top).toBe("100px");
    expect(ghost.style.transform).toContain("translate3d(0.00px,30.00px,0)");
  });
});
