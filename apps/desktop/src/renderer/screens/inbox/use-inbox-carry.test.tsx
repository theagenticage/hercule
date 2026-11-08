/**
 * Tests carrying a card of the Inbox as the user does it: pressing, moving the
 * pointer, letting go, and the ways a carry ends without a drop. The hook runs
 * inside a small page with the real `Rail`. jsdom has no layout, so the cards
 * and the rail's targets are given rectangles, and `elementFromPoint` answers
 * from them. What needs a real browser (how the springs and the copy look) is
 * left to the end-to-end test.
 */
import { useRef, type JSX } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rail, type RailTarget } from "./rail";
import { useInboxCarry } from "./use-inbox-carry";

const TARGETS: readonly RailTarget[] = [
  { kind: "hand", workflowId: "review", name: "Agent review" },
  { kind: "take" },
  { kind: "dismiss" },
  { kind: "more", workflowIds: ["triage", "review"] },
];

/** Where the middle of the rail's target `index` is. The targets lie in a row at the bottom of the window. */
const targetCenter = (index: number): { x: number; y: number } => ({
  x: 150 + 120 * index,
  y: 590,
});

/** The rows of the page, top to bottom, 100px apart. A part lies in the bundle of the row `a`, under it. */
const BANDS = [
  { id: "a", top: 0, bottom: 100 },
  { id: "a-part", top: 100, bottom: 140 },
  { id: "p", top: 140, bottom: 180 },
  { id: "b", top: 200, bottom: 300 },
  { id: "c", top: 300, bottom: 400 },
] as const;

/** The transforms a rail and its target had each time the carry measured a target, to check it measures them at rest. */
let measuredTransforms: { readonly rail: string; readonly target: string }[] = [];

interface HostProps {
  readonly canCarry?: (cardId: string) => boolean;
  readonly disabled?: boolean;
  readonly onDropOnTarget: (cardId: string, target: RailTarget) => void;
  readonly onDropOnCard: (cardId: string, ontoCardId: string) => void;
  readonly onClickCard: () => void;
}

function Host({
  canCarry = () => true,
  disabled = false,
  onDropOnTarget,
  onDropOnCard,
  onClickCard,
}: HostProps): JSX.Element {
  const pageRef = useRef<HTMLDivElement | null>(null);
  const { rail, attachRail, isCarrying } = useInboxCarry({
    pageRef,
    disabled,
    canCarry,
    readRailTargets: () => TARGETS,
    onDropOnTarget,
    onDropOnCard,
  });
  return (
    <div className="inbox-desk">
      <div ref={pageRef} className="inbox-scroll" data-testid="page">
        <div className="inbox-bundle">
          <div className="inbox-row" data-card-id="a" onClick={onClickCard}>
            Reorder oat milk
          </div>
          <div className="inbox-tucked">
            <div className="inbox-part" data-part-ref="quiet" data-testid="a-part">
              A quiet part
            </div>
            <div className="inbox-part" data-card-id="p" data-lead-id="a">
              A part that asks
            </div>
          </div>
        </div>
        <div className="inbox-bundle">
          <div className="inbox-row" data-card-id="b" onClick={onClickCard}>
            <span data-testid="b-words">Refund emails</span>
            <button type="button" data-move="take">
              Take it
            </button>
          </div>
        </div>
        <div className="inbox-bundle">
          <div className="inbox-request" data-card-id="c">
            Gift wrap
          </div>
        </div>
      </div>
      {rail !== null && <Rail ref={attachRail} targets={rail.targets} monogram="R" />}
      <output data-testid="carrying">{String(isCarrying)}</output>
    </div>
  );
}

const callbacks = () => ({
  onDropOnTarget: vi.fn<(cardId: string, target: RailTarget) => void>(),
  onDropOnCard: vi.fn<(cardId: string, ontoCardId: string) => void>(),
  onClickCard: vi.fn<() => void>(),
});

const renderHost = (props: Partial<HostProps> = {}) => {
  const fns = callbacks();
  const view = render(<Host {...fns} {...props} />);
  const query = (selector: string): HTMLElement | null =>
    view.container.querySelector<HTMLElement>(selector);
  const card = (id: string): HTMLElement => query(`[data-card-id="${id}"]`)!;
  return {
    ...fns,
    ...view,
    page: query("[data-testid=page]")!,
    card,
    ghost: (): HTMLElement | null => document.querySelector<HTMLElement>(".inbox-carry-ghost"),
    rail: (): HTMLElement | null => query(".inbox-rail"),
    isCarrying: (): boolean => query("[data-testid=carrying]")!.textContent === "true",
  };
};

type Rendered = ReturnType<typeof renderHost>;

const press = (element: Element, x: number, y: number): void => {
  fireEvent.pointerDown(element, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
};
const moveTo = (page: Element, x: number, y: number): void => {
  fireEvent.pointerMove(page, { pointerId: 1, isPrimary: true, clientX: x, clientY: y });
};
const release = (page: Element, x: number, y: number): void => {
  fireEvent.pointerUp(page, { pointerId: 1, isPrimary: true, clientX: x, clientY: y });
};

/** Lets `ms` milliseconds of timers and frames pass. */
const play = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

/** Presses the card `id` at its middle and moves 10px, so it is in the hand. Returns where the pointer is. */
const lift = (page: Rendered, id: string): { x: number; y: number } => {
  const band = BANDS.find((each) => each.id === id)!;
  const start = { x: 50, y: (band.top + band.bottom) / 2 };
  press(page.card(id), start.x, start.y);
  moveTo(page.page, start.x, start.y + 10);
  return { x: start.x, y: start.y + 10 };
};

beforeEach(() => {
  measuredTransforms = [];
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
  // The system's Reduce motion is off: the duration token is not zero.
  document.documentElement.style.setProperty("--dur-2", "200ms");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const band = BANDS.find((each) => each.id === this.dataset["cardId"]);
    if (band !== undefined) return new DOMRect(0, band.top, 400, band.bottom - band.top);
    const index = this.dataset["railTarget"];
    if (index !== undefined) {
      measuredTransforms.push({
        rail: this.closest<HTMLElement>(".inbox-rail")!.style.transform,
        target: this.style.transform,
      });
      const { x, y } = targetCenter(Number(index));
      return new DOMRect(x - 50, y - 40, 100, 80);
    }
    return new DOMRect(0, 0, 0, 0);
  });
  document.elementFromPoint = (_x: number, y: number): Element | null => {
    const band = BANDS.find((each) => y >= each.top && y < each.bottom);
    if (band === undefined) return document.body;
    return band.id === "a-part"
      ? document.querySelector("[data-testid=a-part]")
      : document.querySelector(`[data-card-id="${band.id}"]`);
  };
  // jsdom has no pointer capture. A held pointer is what a browser would hold.
  const held = new Set<number>();
  Element.prototype.setPointerCapture = (id: number) => void held.add(id);
  Element.prototype.releasePointerCapture = (id: number) => void held.delete(id);
  Element.prototype.hasPointerCapture = (id: number) => held.has(id);
});

afterEach(() => {
  // The motion clock asks for one frame at a time, so it is played out before the clock is given back.
  play(4000);
  vi.useRealTimers();
  document.documentElement.style.removeProperty("--dur-2");
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("pressing a card", () => {
  it("stays a click up to 6px of travel: nothing lifts and the card still opens", () => {
    const host = renderHost();
    press(host.card("b"), 50, 250);
    moveTo(host.page, 56, 250);
    release(host.page, 56, 250);
    fireEvent.click(host.card("b"));

    expect(host.ghost()).toBeNull();
    expect(host.rail()).toBeNull();
    expect(host.isCarrying()).toBe(false);
    expect(host.onClickCard).toHaveBeenCalledOnce();
  });

  it("lifts past 6px: a copy follows, the card's place stays open and the rail rises with every target", () => {
    const host = renderHost();
    lift(host, "b");

    expect(host.isCarrying()).toBe(true);
    expect(host.ghost()?.textContent).toContain("Refund emails");
    // The copy is not a second card for the keyboard, the screen reader or a lookup by id.
    expect(host.ghost()?.hasAttribute("data-card-id")).toBe(false);
    expect(host.card("b").hasAttribute("data-carried")).toBe(true);
    expect(
      [...host.rail()!.querySelectorAll("[data-rail-target]")].map((each) => each.textContent),
    ).toEqual(["Agent review", "RTake it", "Dismiss", "Hand to…"]);
  });

  it.each([
    ["a button in the card", () => document.querySelector("button")!],
    ["a card the page refuses", () => document.querySelector("[data-card-id=c]")!],
  ])("starts no carry on %s", (_name, find) => {
    const host = renderHost({ canCarry: (cardId) => cardId !== "c" });
    const element = find();
    press(element, 50, 250);
    moveTo(host.page, 50, 300);

    expect(host.isCarrying()).toBe(false);
    expect(host.ghost()).toBeNull();
  });

  it("starts no carry while the page is disabled", () => {
    const host = renderHost({ disabled: true });
    lift(host, "b");
    expect(host.isCarrying()).toBe(false);
  });
});

describe("letting go", () => {
  it("over another card lights its edge, and links the two on release, at once", () => {
    const host = renderHost();
    const hand = lift(host, "b");
    moveTo(host.page, hand.x, 350);

    expect(host.card("c").hasAttribute("data-link-target")).toBe(true);
    release(host.page, hand.x, 350);

    expect(host.onDropOnCard).toHaveBeenCalledExactlyOnceWith("b", "c");
    expect(host.onDropOnTarget).not.toHaveBeenCalled();
    expect(host.card("c").hasAttribute("data-link-target")).toBe(false);
    expect(host.card("b").hasAttribute("data-carried")).toBe(false);
    play(4000);
    expect(host.ghost()).toBeNull();
    expect(host.rail()).toBeNull();
  });

  it("over a part under a card counts as over that card, and over its own bundle counts as nowhere", () => {
    const host = renderHost();
    // The part `p` rides on the row `a`, so carrying it over `a` links nothing.
    const hand = lift(host, "p");
    moveTo(host.page, hand.x, 50);
    expect(host.card("a").hasAttribute("data-link-target")).toBe(false);
    moveTo(host.page, hand.x, 250);
    expect(host.card("b").hasAttribute("data-link-target")).toBe(true);
    release(host.page, hand.x, 250);

    expect(host.onDropOnCard).toHaveBeenCalledExactlyOnceWith("p", "b");
  });

  it("near a target calls for that target 200ms into the landing, and not before", () => {
    const host = renderHost();
    lift(host, "b");
    const { x, y } = targetCenter(0);
    moveTo(host.page, x + 30, y - 20);
    expect(host.rail()?.querySelector("[data-near]")?.textContent).toBe("Agent review");
    release(host.page, x + 30, y - 20);

    expect(host.isCarrying()).toBe(false);
    play(150);
    expect(host.onDropOnTarget).not.toHaveBeenCalled();
    play(60);
    expect(host.onDropOnTarget).toHaveBeenCalledExactlyOnceWith("b", TARGETS[0]);
    expect(host.onDropOnCard).not.toHaveBeenCalled();
    // The rail holds a moment so the choice is seen to land, and then leaves.
    expect(host.rail()).not.toBeNull();
    play(4000);
    expect(host.rail()).toBeNull();
    expect(host.ghost()).toBeNull();
    expect(host.card("b").hasAttribute("data-carried")).toBe(false);
  });

  it("two drops on targets within the landing delay both reach the page, each with its own card", () => {
    const host = renderHost();
    lift(host, "b");
    const first = targetCenter(0);
    moveTo(host.page, first.x, first.y);
    release(host.page, first.x, first.y);
    play(50);
    lift(host, "c");
    const second = targetCenter(1);
    moveTo(host.page, second.x, second.y);
    release(host.page, second.x, second.y);
    play(4000);

    expect(host.onDropOnTarget.mock.calls).toEqual([
      ["b", TARGETS[0]],
      ["c", TARGETS[1]],
    ]);
    expect(host.ghost()).toBeNull();
    expect(host.card("b").hasAttribute("data-carried")).toBe(false);
    expect(host.card("c").hasAttribute("data-carried")).toBe(false);
  });

  it("on unmount with two drops waiting still sends both", () => {
    const host = renderHost();
    lift(host, "b");
    const first = targetCenter(0);
    moveTo(host.page, first.x, first.y);
    release(host.page, first.x, first.y);
    play(50);
    lift(host, "c");
    const second = targetCenter(1);
    moveTo(host.page, second.x, second.y);
    release(host.page, second.x, second.y);
    host.unmount();

    expect(host.onDropOnTarget.mock.calls).toEqual([
      ["b", TARGETS[0]],
      ["c", TARGETS[1]],
    ]);
    play(4000);
    expect(host.onDropOnTarget).toHaveBeenCalledTimes(2);
  });

  it("measures the targets where they rest, even while the rail of the last drop is still leaving", () => {
    const host = renderHost();
    lift(host, "b");
    const { x, y } = targetCenter(1);
    moveTo(host.page, x, y);
    release(host.page, x, y);
    // The rail has held for its 340ms and is part of the way out.
    play(400);
    expect(host.rail()!.style.transform).not.toBe("");
    measuredTransforms = [];
    lift(host, "c");

    expect(measuredTransforms).toHaveLength(TARGETS.length);
    expect(measuredTransforms.every((each) => each.rail === "" && each.target === "")).toBe(true);
  });

  it("on the target for the workflows the rail has no room for calls for it 200ms into the landing", () => {
    const host = renderHost();
    lift(host, "b");
    const { x, y } = targetCenter(3);
    moveTo(host.page, x, y);
    release(host.page, x, y);
    play(210);

    expect(host.onDropOnTarget).toHaveBeenCalledExactlyOnceWith("b", TARGETS[3]);
  });

  it("on Dismiss calls for it at once, and the card is back in the page for it to leave from", () => {
    const host = renderHost();
    lift(host, "b");
    const { x, y } = targetCenter(2);
    moveTo(host.page, x, y);
    release(host.page, x, y);

    expect(host.onDropOnTarget).toHaveBeenCalledExactlyOnceWith("b", TARGETS[2]);
    expect(host.card("b").hasAttribute("data-carried")).toBe(false);
  });

  it("anywhere else sends the card home and calls for nothing", () => {
    const host = renderHost();
    lift(host, "b");
    moveTo(host.page, 300, 450);
    release(host.page, 300, 450);
    play(4000);

    expect(host.onDropOnTarget).not.toHaveBeenCalled();
    expect(host.onDropOnCard).not.toHaveBeenCalled();
    expect(host.ghost()).toBeNull();
    expect(host.rail()).toBeNull();
    expect(host.card("b").hasAttribute("data-carried")).toBe(false);
  });

  it("swallows the click that ends a carry, and the next click is the user's again", () => {
    const host = renderHost();
    const hand = lift(host, "b");
    release(host.page, hand.x, hand.y);
    fireEvent.click(host.card("b"));
    expect(host.onClickCard).not.toHaveBeenCalled();

    play(100);
    fireEvent.click(host.card("b"));
    expect(host.onClickCard).toHaveBeenCalledOnce();
  });
});

describe("cancelling", () => {
  it("on Esc sends the card home, calls for nothing and keeps the key from the page", () => {
    const host = renderHost();
    const hand = lift(host, "b");
    const reachedPage = vi.fn();
    document.addEventListener("keydown", reachedPage);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.removeEventListener("keydown", reachedPage);

    expect(host.isCarrying()).toBe(false);
    expect(reachedPage).not.toHaveBeenCalled();
    play(4000);
    expect(host.ghost()).toBeNull();
    expect(host.rail()).toBeNull();
    expect(host.card("b").hasAttribute("data-carried")).toBe(false);
    expect(host.onDropOnCard).not.toHaveBeenCalled();
    expect(host.onDropOnTarget).not.toHaveBeenCalled();

    // The button is still down: letting go now sends nothing and the click it makes is swallowed.
    release(host.page, hand.x, hand.y);
    fireEvent.click(host.card("b"));
    expect(host.onClickCard).not.toHaveBeenCalled();
    expect(host.onDropOnCard).not.toHaveBeenCalled();
  });

  it("when the system cancels the pointer", () => {
    const host = renderHost();
    lift(host, "b");
    fireEvent.pointerCancel(host.page, { pointerId: 1, isPrimary: true });
    play(4000);

    expect(host.isCarrying()).toBe(false);
    expect(host.ghost()).toBeNull();
    expect(host.onDropOnTarget).not.toHaveBeenCalled();
  });

  it("on unmount takes the copy, the marks and the grab off the page", () => {
    const host = renderHost();
    const hand = lift(host, "b");
    moveTo(host.page, hand.x, 350);
    const card = host.card("b");
    host.unmount();

    expect(document.querySelector(".inbox-carry-ghost")).toBeNull();
    expect(document.querySelector("[data-carrying]")).toBeNull();
    expect(card.hasAttribute("data-carried")).toBe(false);
    expect(document.querySelector("[data-link-target]")).toBeNull();
    expect(host.onDropOnCard).not.toHaveBeenCalled();
  });

  it("on unmount between the drop and the landing still sends the move the user chose", () => {
    const host = renderHost();
    lift(host, "b");
    const { x, y } = targetCenter(1);
    moveTo(host.page, x, y);
    release(host.page, x, y);
    host.unmount();

    expect(host.onDropOnTarget).toHaveBeenCalledExactlyOnceWith("b", TARGETS[1]);
    play(4000);
    expect(host.onDropOnTarget).toHaveBeenCalledOnce();
  });
});

describe("the copy in the hand", () => {
  /** Returns the tilt of the copy, in degrees, after the pointer swept sideways quickly. */
  const leanAfterSweep = (): number => {
    const host = renderHost();
    lift(host, "b");
    for (let step = 1; step <= 6; step++) {
      play(16);
      moveTo(host.page, 50 + step * 30, 260);
    }
    return Number(/rotate\((-?[\d.]+)deg\)/.exec(host.ghost()!.style.transform)?.[1]);
  };

  it("leans into the pointer's sideways speed, and not at all under Reduce motion", () => {
    expect(Math.abs(leanAfterSweep())).toBeGreaterThan(0.5);
    cleanup();
    document.documentElement.style.setProperty("--dur-2", "0s");
    expect(leanAfterSweep()).toBe(0);
  });
});
