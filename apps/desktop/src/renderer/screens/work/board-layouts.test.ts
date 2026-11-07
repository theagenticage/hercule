/**
 * Tests the glide that carries the parts of the board to where a read put
 * them. jsdom has no layout, so each element reports the place a test gives it
 * plus the offset its body shows, as a browser would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackBody } from "../../app/motion";
import { glideFromLayouts, measureBoardLayouts } from "./board-layouts";

const layoutTop = new Map<HTMLElement, number>();

/** Makes the scroller report a rectangle at the origin and its cards report where the layout put them, with the body's offset. */
const buildBoard = (tops: Record<string, number>): HTMLElement => {
  const scroller = document.createElement("div");
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800);
  document.body.append(scroller);
  for (const [id, top] of Object.entries(tops)) addCard(scroller, id, top);
  return scroller;
};

const addCard = (scroller: HTMLElement, id: string, top: number): HTMLElement => {
  const card = document.createElement("div");
  card.dataset["cardId"] = id;
  layoutTop.set(card, top);
  card.getBoundingClientRect = () =>
    new DOMRect(10, layoutTop.get(card)! + trackBody(card).values.y, 100, 50);
  scroller.append(card);
  return card;
};

const find = (scroller: HTMLElement, id: string): HTMLElement =>
  scroller.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  document.documentElement.style.setProperty("--dur-2", "200ms");
});
afterEach(() => {
  vi.advanceTimersByTime(4_000);
  vi.useRealTimers();
  document.documentElement.style.removeProperty("--dur-2");
  document.body.replaceChildren();
  layoutTop.clear();
});

describe("glideFromLayouts", () => {
  it("starts a card where it stood and brings it to its new place", () => {
    const scroller = buildBoard({ a: 100, b: 200 });
    const before = measureBoardLayouts(scroller);
    layoutTop.set(find(scroller, "b"), 400);

    glideFromLayouts(scroller, before, "self");

    expect(find(scroller, "b").getBoundingClientRect().top).toBe(200);
    vi.advanceTimersByTime(4_000);
    expect(find(scroller, "b").getBoundingClientRect().top).toBe(400);
    expect(find(scroller, "b").style.transform).toBe("");
  });

  it("leaves a card alone that the layout did not move, so its own motion goes on", () => {
    const scroller = buildBoard({ a: 100 });
    const card = find(scroller, "a");
    trackBody(card).relocate(0, 30);
    trackBody(card).to({ x: 0, y: 0 }, "hand");
    const before = measureBoardLayouts(scroller);
    const toBefore = vi.spyOn(trackBody(card), "to");

    glideFromLayouts(scroller, before, "self");

    expect(toBefore).not.toHaveBeenCalled();
  });

  it("returns the cards that were not there before, and moves nothing for them", () => {
    const scroller = buildBoard({ a: 100 });
    const before = measureBoardLayouts(scroller);
    const arrived = addCard(scroller, "new", 300);

    const born = glideFromLayouts(scroller, before, "self");

    expect(born).toEqual([arrived]);
    expect(arrived.style.transform).toBe("");
  });

  it("does nothing when the board has another width than when it was measured", () => {
    const scroller = buildBoard({ a: 100 });
    const before = measureBoardLayouts(scroller);
    layoutTop.set(find(scroller, "a"), 500);
    Object.defineProperty(scroller, "clientWidth", { value: 700, configurable: true });

    glideFromLayouts(scroller, before, "self");

    expect(find(scroller, "a").style.transform).toBe("");
  });

  it("leaves the card in the hand to the drag", () => {
    const scroller = buildBoard({ a: 100 });
    find(scroller, "a").dataset["dragged"] = "";

    expect([...measureBoardLayouts(scroller).parts.keys()]).toEqual([]);
  });
});
