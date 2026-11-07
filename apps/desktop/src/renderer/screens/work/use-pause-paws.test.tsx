/**
 * Tests that the board pauses the paws of a working colleague whose card is
 * scrolled out of view, and does no observer work when no card is working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef, type JSX } from "react";
import { usePausePawsOffScreen } from "./use-pause-paws";

/** The observers the page made, so a test can tell each what it sees. */
const observers: FakeObserver[] = [];

class FakeObserver {
  readonly watching = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(element: Element): void {
    this.watching.add(element);
  }
  unobserve(element: Element): void {
    this.watching.delete(element);
  }
  disconnect(): void {
    this.watching.clear();
  }
  /** Reports that `element` is in view, or out of it. */
  report(element: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target: element, isIntersecting } as IntersectionObserverEntry],
      this as never,
    );
  }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function Board({ poses }: { readonly poses: readonly string[] }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  usePausePawsOffScreen(scrollRef);
  return (
    <div ref={scrollRef}>
      {poses.map((pose, index) => (
        <div key={index} className="desk-card" data-testid={`card-${String(index)}`}>
          <span className="card-paws" data-pose={pose} />
        </div>
      ))}
    </div>
  );
}

/** Lets the mutation observer's callback run, which the browser queues after the page changed. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("usePausePawsOffScreen", () => {
  it("makes no observer while no card has a colleague at work", () => {
    render(<Board poses={["waiting", "failed"]} />);

    expect(observers).toEqual([]);
  });

  it("marks a working card that leaves the screen, and unmarks it when it returns", () => {
    const { getByTestId } = render(<Board poses={["working", "waiting"]} />);
    const [observer] = observers;
    const working = getByTestId("card-0");
    expect(observer?.watching).toEqual(new Set([working]));

    observer?.report(working, false);
    expect(working.hasAttribute("data-offscreen")).toBe(true);

    observer?.report(working, true);
    expect(working.hasAttribute("data-offscreen")).toBe(false);
  });

  it("stops watching a card whose colleague stops working", async () => {
    const { rerender, getByTestId } = render(<Board poses={["working"]} />);
    const [observer] = observers;
    const card = getByTestId("card-0");
    observer?.report(card, false);

    rerender(<Board poses={["failed"]} />);
    await settle();

    expect(observer?.watching.size).toBe(0);
    expect(card.hasAttribute("data-offscreen")).toBe(false);
  });

  it("starts watching a card that arrives with a colleague at work", async () => {
    const { rerender, getByTestId } = render(<Board poses={["waiting"]} />);
    expect(observers).toEqual([]);

    rerender(<Board poses={["waiting", "working"]} />);
    await settle();

    expect(observers[0]?.watching).toEqual(new Set([getByTestId("card-1")]));
  });

  it("does not look at the board when a render changes nothing on it", async () => {
    const { rerender } = render(<Board poses={["working"]} />);
    const query = vi.spyOn(Element.prototype, "querySelectorAll");

    rerender(<Board poses={["working"]} />);
    await settle();

    expect(query).not.toHaveBeenCalled();
  });
});
