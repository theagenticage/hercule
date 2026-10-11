/**
 * Tests that `useShowsClassicScrollbar` follows the scroll bar of the element
 * it watches. jsdom lays nothing out, so the test sets the element's widths
 * itself, and resizes it through a stand-in for `ResizeObserver`.
 */
import { useRef, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { stubResizeObserver } from "../../app/testing";
import { useShowsClassicScrollbar } from "./classic-scrollbar";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Renders a scrolling view whose text says whether it shows a classic scroll bar. */
function View(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const shows = useShowsClassicScrollbar(ref);
  return <div ref={ref}>{shows ? "scroll bar" : "no scroll bar"}</div>;
}

/**
 * Sets `element` to be 600px wide with `scrollbar` pixels of it taken by a
 * scroll bar.
 */
const setWidths = (element: Element, scrollbar: number): void => {
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: 600 });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: 600 - scrollbar });
};

describe("useShowsClassicScrollbar", () => {
  it("follows a classic scroll bar as it comes and goes", () => {
    const resize = stubResizeObserver();
    const { container } = render(<View />);
    const view = container.firstElementChild!;
    expect(screen.getByText("no scroll bar")).toBeTruthy();

    setWidths(view, 15);
    act(resize);
    expect(screen.getByText("scroll bar")).toBeTruthy();

    setWidths(view, 0);
    act(resize);
    expect(screen.getByText("no scroll bar")).toBeTruthy();
  });
});
