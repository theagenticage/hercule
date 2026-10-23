/**
 * Tests that `useTabOverflow` settles: the widths it writes (the open tab's
 * limit and the crumb name's limit) never change what it measures next, so
 * the pill does not grow and shrink for ever. jsdom has no layout, so the
 * test draws a small model of one: the pill's parts have the widths
 * below, a limit written to the DOM shortens the part it names, and a fake
 * `ResizeObserver` reports every part whose width changed, as the browser's
 * does.
 */
import { useRef, type JSX } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabOverflow } from "./use-tab-overflow";

/** The width of a crumb apart from its name, and of a tab apart from its label. */
const CHROME_WIDTH = 20;
const OVERFLOW_BUTTON_WIDTH = 48;
const NEW_THREAD_BUTTON_WIDTH = 28;

let roomWidth = 0;
let observers: FakeResizeObserver[] = [];

/** Reads a limit written as an inline `max-width` or `--open-tab-max-width`, in pixels. */
const readLimit = (value: string): number => (value === "" ? Infinity : Number.parseFloat(value));

/** The model of the layout: the width the browser would give `element`. */
function widthOf(element: Element): number {
  const natural = Number((element as HTMLElement).dataset.natural ?? 0);
  if (element.hasAttribute("data-room")) return roomWidth;
  if (element.classList.contains("proj-name")) {
    return Math.min(natural, readLimit((element as HTMLElement).style.maxWidth));
  }
  if (element.classList.contains("pill-crumb")) {
    return CHROME_WIDTH + widthOf(element.querySelector(".proj-name")!);
  }
  if (element.classList.contains("ptab")) {
    const label = element.querySelector<HTMLElement>(".ptab-title")!;
    const limit = element.classList.contains("is-on")
      ? readLimit(
          (element.parentElement as HTMLElement).style.getPropertyValue("--open-tab-max-width"),
        )
      : Infinity;
    return Math.max(CHROME_WIDTH, Math.min(CHROME_WIDTH + Number(label.dataset.natural), limit));
  }
  if (element.classList.contains("ptab-title")) {
    return Math.max(0, widthOf(element.parentElement!) - CHROME_WIDTH);
  }
  if (element.hasAttribute("data-tab-overflow")) return OVERFLOW_BUTTON_WIDTH;
  return NEW_THREAD_BUTTON_WIDTH;
}

/** Reports the elements it watches whose width changed since it last reported them. */
class FakeResizeObserver {
  readonly watched = new Map<Element, number | undefined>();
  readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    observers.push(this);
  }
  observe(element: Element): void {
    this.watched.set(element, undefined);
  }
  unobserve(element: Element): void {
    this.watched.delete(element);
  }
  disconnect(): void {
    this.watched.clear();
  }
  /** Calls the callback, as the browser does, when a watched element has a new width. Returns whether it did. */
  report(): boolean {
    let changed = false;
    for (const [element, reported] of this.watched) {
      const width = widthOf(element);
      if (width !== reported) changed = true;
      this.watched.set(element, width);
    }
    if (changed) this.callback();
    return changed;
  }
}

/** Reports size changes until none is left, and returns how many reports it took. Fails if there is no end. */
function settle(): number {
  for (let reports = 0; reports < 20; reports += 1) {
    let changed = false;
    act(() => {
      changed = observers.map((observer) => observer.report()).some(Boolean);
    });
    if (!changed) return reports;
  }
  throw new Error("The pill still changed size after 20 reports: it does not settle.");
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const width = widthOf(this);
    return { width, left: 0, right: width, top: 0, bottom: 0, height: 0, x: 0, y: 0 } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return Number(this.dataset.natural ?? 0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Draws a pill with a crumb whose name is 54 px, then the tabs `[key, label width]`, "+n" and "+". */
function Pill({
  openKey,
  tabs,
}: {
  readonly openKey: string;
  readonly tabs: ReadonlyArray<readonly [string, number]>;
}): JSX.Element {
  const roomRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const hidden = useTabOverflow({ roomRef, navRef, openKey, waitingKeys: [] });
  return (
    <div ref={roomRef} data-room="">
      <nav ref={navRef}>
        <span className="pill-crumb">
          <span className="proj">
            <span className="proj-name" data-natural="54">
              payments
            </span>
          </span>
        </span>
        {tabs.map(([key, labelWidth]) => (
          <a
            key={key}
            data-tab={key}
            className={[
              "ptab",
              key === openKey ? "is-on" : "",
              hidden.has(key) ? "is-hidden" : "",
            ].join(" ")}
          >
            <span className="ptab-title" data-natural={labelWidth}>
              {key}
            </span>
          </a>
        ))}
        <button type="button" data-tab-overflow="">
          +{hidden.size}
        </button>
        <a className="icon-btn" href="#new" />
      </nav>
    </div>
  );
}

describe("the pill settles", () => {
  it("limits the open tab and the crumb's name once, with no work's name and no hidden tab", () => {
    // The open tab is 20 + 158 = 178 px. With the crumb's 20 px of chrome and the room of 180,
    // the buttons' 28 px do not fit, so the crumb's name goes and the tab shortens.
    roomWidth = 180;
    const { container } = render(<Pill openKey="a" tabs={[["a", 158]]} />);
    const reports = settle();
    const nav = container.querySelector("nav")!;
    // The room leaves 180 - 20 (crumb) - 28 (the "+") = 132 for the open tab.
    expect(nav.style.getPropertyValue("--open-tab-max-width")).toBe("132px");
    expect(container.querySelector<HTMLElement>(".proj-name")!.style.maxWidth).toBe("0px");
    expect(reports).toBeLessThanOrEqual(3);
  });

  it("writes nothing when it measures again", () => {
    roomWidth = 180;
    const { container } = render(<Pill openKey="a" tabs={[["a", 158]]} />);
    settle();
    const before = container.innerHTML;
    const write = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
    const remove = vi.spyOn(CSSStyleDeclaration.prototype, "removeProperty");
    for (let times = 0; times < 10; times += 1) {
      // Report as if every part had a new width, which makes the hook measure again.
      act(() => {
        for (const observer of observers) {
          for (const element of observer.watched.keys()) observer.watched.set(element, -1);
        }
        observers.map((observer) => observer.report());
      });
    }
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe(before);
  });

  it("hides tabs first, and removes every limit when the room grows back", () => {
    // Fixed: 20 (crumb) + 28 ("+"). Tabs: 78 each, the open one first.
    roomWidth = 300;
    const tabs = [
      ["a", 58],
      ["b", 58],
      ["c", 58],
      ["d", 58],
    ] as const;
    const { container, rerender } = render(<Pill openKey="a" tabs={tabs} />);
    settle();
    const nav = container.querySelector("nav")!;
    const hiddenTabs = (): string[] =>
      [...container.querySelectorAll<HTMLElement>(".is-hidden")].map((tab) => tab.dataset.tab!);
    // 300 - 20 - 28 - 48 ("+n") = 204 for the crumb's 54 px name and the tabs: the open tab (78)
    // and one more would need 54 + 156 = 210.
    expect(hiddenTabs()).toEqual(["b", "c", "d"]);
    expect(container.querySelector<HTMLElement>(".proj-name")!.style.maxWidth).toBe("");

    roomWidth = 120;
    rerender(<Pill openKey="a" tabs={tabs} />);
    settle();
    expect(hiddenTabs()).toEqual(["b", "c", "d"]);
    expect(nav.style.getPropertyValue("--open-tab-max-width")).not.toBe("");

    roomWidth = 600;
    rerender(<Pill openKey="a" tabs={tabs} />);
    settle();
    expect(hiddenTabs()).toEqual([]);
    expect(nav.style.getPropertyValue("--open-tab-max-width")).toBe("");
    expect(container.querySelector<HTMLElement>(".proj-name")!.style.maxWidth).toBe("");
  });
});
