/**
 * Tests the line from a blocked card to its blocker as the user meets it: it
 * appears only after the pointer rests on a blocked card, runs to the card that
 * blocks it and rings it, and is gone when the pointer leaves, presses or the
 * board changes size. jsdom measures nothing, so each card is given a box, and
 * a fake clock and a fake `ResizeObserver` stand in for time and layout.
 */
import { useRef, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { BLOCKER_LINE_DELAY_MS, BlockerLine } from "./blocker-line";

/** The boxes the fake layout gives, by the `data-card-id` of a card. The canvas is at 0, 0. */
const BOXES: Readonly<Record<string, DOMRect>> = {
  waiting: new DOMRect(0, 0, 200, 100),
  holder: new DOMRect(240, 120, 200, 100),
  hidden: new DOMRect(0, 0, 0, 0),
};

const resizeCallbacks: Array<{ target: Element; run: () => void }> = [];

class FakeResizeObserver {
  readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe(target: Element): void {
    resizeCallbacks.push({ target, run: this.callback });
  }
  unobserve(): void {}
  disconnect(): void {
    const kept = resizeCallbacks.filter(({ run }) => run !== this.callback);
    resizeCallbacks.length = 0;
    resizeCallbacks.push(...kept);
  }
}

/** Reports a resize of `target`, as the browser does after the first report. */
const resize = (target: Element): void => {
  for (const each of resizeCallbacks.filter((one) => one.target === target)) each.run();
};

function Board({ blockedBy }: { readonly blockedBy: string }): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={canvasRef} data-testid="canvas">
      <div
        className="desk-card"
        data-card-id="waiting"
        data-state="blocked"
        data-blocked-by={blockedBy}
      >
        <span data-testid="words">Waits on Holder</span>
      </div>
      <div className="desk-card" data-card-id="holder" data-testid="holder" />
      <div className="desk-card" data-card-id="hidden" />
      <div className="desk-card" data-card-id="free" data-testid="free" />
      <BlockerLine canvasRef={canvasRef} />
    </div>
  );
}

const findLine = (canvas: HTMLElement): SVGElement | null =>
  canvas.querySelector<SVGElement>("svg.blocker-line");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return BOXES[this.getAttribute("data-card-id") ?? ""] ?? new DOMRect(0, 0, 1000, 600);
  });
});

afterEach(() => {
  resizeCallbacks.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Rests the pointer on the element and waits as long as the line takes to appear. */
const rest = (element: Element): void => {
  fireEvent.pointerOver(element, { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(BLOCKER_LINE_DELAY_MS);
  });
};

describe("the line to a blocker", () => {
  it("is drawn after the pointer rests on a blocked card, and rings the blocker", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    const canvas = getByTestId("canvas");
    fireEvent.pointerOver(getByTestId("words"), { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(BLOCKER_LINE_DELAY_MS - 1);
    });
    expect(findLine(canvas)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const line = findLine(canvas);
    expect(line).not.toBeNull();
    // Down from the middle of the blocked card, along the gap, up the gutter, in at the blocker's
    // left side. The SVG is only as large as that route, so its points are counted from its corner:
    // the route's own (100, 100) is (4, 4) in the SVG.
    expect(line?.querySelector("path")?.getAttribute("d")).toMatch(/^M4 4L4 /);
    expect(line?.querySelector("circle")?.getAttribute("cx")).toBe("144");
    expect(line?.querySelector("circle")?.getAttribute("cy")).toBe("74");
    const { left, top, width, height } = (line as SVGElement).style;
    expect({ left, top, width, height }).toEqual({
      left: "96px",
      top: "96px",
      width: "148px",
      height: "78px",
    });
    expect(getByTestId("holder").classList.contains("is-blocker")).toBe(true);
  });

  it("is never drawn on a card that is not blocked", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    rest(getByTestId("free"));
    expect(findLine(getByTestId("canvas"))).toBeNull();
  });

  it("draws nothing when the blocker is not on the board", () => {
    const { getByTestId } = render(<Board blockedBy="elsewhere" />);
    rest(getByTestId("words"));
    expect(findLine(getByTestId("canvas"))).toBeNull();
  });

  it("draws nothing when the blocker's card has no size, as in a folded lane", () => {
    const { getByTestId } = render(<Board blockedBy="hidden" />);
    rest(getByTestId("words"));
    expect(findLine(getByTestId("canvas"))).toBeNull();
  });

  it("goes, and the blocker's ring with it, when the pointer leaves", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    const canvas = getByTestId("canvas");
    rest(getByTestId("words"));
    fireEvent.pointerLeave(canvas);
    expect(findLine(canvas)).toBeNull();
    expect(getByTestId("holder").classList.contains("is-blocker")).toBe(false);
  });

  it("goes when the pointer moves to a card that is not blocked", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    rest(getByTestId("words"));
    fireEvent.pointerOver(getByTestId("free"), { pointerType: "mouse" });
    expect(findLine(getByTestId("canvas"))).toBeNull();
  });

  it("stays while the pointer moves inside the blocked card", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    rest(getByTestId("words"));
    fireEvent.pointerOver(getByTestId("words"), { pointerType: "mouse" });
    fireEvent.pointerOver(getByTestId("canvas").querySelector("[data-card-id=waiting]")!, {
      pointerType: "mouse",
    });
    expect(findLine(getByTestId("canvas"))).not.toBeNull();
  });

  it("goes when the pointer presses, as a drag starts", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    rest(getByTestId("words"));
    fireEvent.pointerDown(getByTestId("words"));
    expect(findLine(getByTestId("canvas"))).toBeNull();
  });

  it("goes when the board changes size, because the cards moved", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    const canvas = getByTestId("canvas");
    rest(getByTestId("words"));
    // The first report is the observer starting.
    act(() => {
      resize(canvas);
    });
    expect(findLine(canvas)).not.toBeNull();
    act(() => {
      resize(canvas);
    });
    expect(findLine(canvas)).toBeNull();
  });

  it("goes, and so does its ring, when a card leaves the board", async () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    const canvas = getByTestId("canvas");
    rest(getByTestId("words"));
    expect(findLine(canvas)).not.toBeNull();

    // The observer reports in a microtask, so the act waits for one.
    await act(async () => {
      getByTestId("free").remove();
      await Promise.resolve();
    });

    expect(findLine(canvas)).toBeNull();
    expect(getByTestId("holder").classList.contains("is-blocker")).toBe(false);
  });

  it("stays when only its own SVG is added to the board", async () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    const canvas = getByTestId("canvas");
    rest(getByTestId("words"));

    // The SVG is committed after the observer starts; the observer must not take it for a change.
    await act(async () => {
      await Promise.resolve();
    });

    expect(findLine(canvas)).not.toBeNull();
  });

  it("is not drawn when the blocked card left the board while the pointer rested", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    fireEvent.pointerOver(getByTestId("words"), { pointerType: "mouse" });
    const waiting = getByTestId("canvas").querySelector("[data-card-id=waiting]")!;
    waiting.remove();
    act(() => {
      vi.advanceTimersByTime(BLOCKER_LINE_DELAY_MS);
    });
    expect(findLine(getByTestId("canvas"))).toBeNull();
  });

  it("finds the blocker by its id among cards whose ids look alike", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    const lookAlike = document.createElement("div");
    lookAlike.setAttribute("data-card-id", 'holder"]');
    getByTestId("canvas").append(lookAlike);

    rest(getByTestId("words"));

    expect(getByTestId("holder").classList.contains("is-blocker")).toBe(true);
    expect(lookAlike.classList.contains("is-blocker")).toBe(false);
  });

  it("is not drawn for a touch, which cannot rest", () => {
    const { getByTestId } = render(<Board blockedBy="holder" />);
    fireEvent.pointerOver(getByTestId("words"), { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(BLOCKER_LINE_DELAY_MS);
    });
    expect(findLine(getByTestId("canvas"))).toBeNull();
  });

  it("starts no timer while nothing is pointed at", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    render(<Board blockedBy="holder" />);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
