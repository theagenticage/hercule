/**
 * Tests the resizable pane's separator as the user meets it: dragging, the
 * keys and a double click, for a pane on the right and one on the left. jsdom
 * has no layout, so each pane's box is faked at a known place.
 */
import { useRef, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useResizablePane } from "./use-resizable-pane";

const MIN = 300;
const MAX = 600;
const DEFAULT = 420;

/**
 * A pane `width` wide that ends at x = 1000 when it is on the right, and
 * starts at x = 0 when it is on the left, with a separator that resizes it.
 * The drawn width is shown as the pane's text, and each stored width is
 * recorded in `stored`.
 */
function Harness({
  paneSide,
  width,
  stored,
  onOuterKey,
}: {
  readonly paneSide: "left" | "right";
  readonly width: number;
  readonly stored: number[];
  readonly onOuterKey?: (() => void) | undefined;
}): JSX.Element {
  const paneRef = useRef<HTMLDivElement>(null);
  const separator = useResizablePane({
    paneRef,
    paneSide,
    width,
    defaultWidth: DEFAULT,
    min: MIN,
    max: MAX,
    step: 40,
    draw: (next) => {
      paneRef.current!.textContent = String(next);
    },
    onCommit: (next) => stored.push(next),
  });
  return (
    <div onKeyDown={onOuterKey}>
      <div ref={paneRef} data-testid="pane" />
      <div {...separator} aria-label="Resize" />
    </div>
  );
}

const renderPane = (
  paneSide: "left" | "right",
  width = DEFAULT,
  onOuterKey?: () => void,
): number[] => {
  const stored: number[] = [];
  render(<Harness paneSide={paneSide} width={width} stored={stored} onOuterKey={onOuterKey} />);
  const right = paneSide === "right";
  vi.spyOn(screen.getByTestId("pane"), "getBoundingClientRect").mockReturnValue({
    left: right ? 1000 - width : 0,
    right: right ? 1000 : width,
    width,
  } as DOMRect);
  return stored;
};

describe("useResizablePane", () => {
  beforeEach(() => {
    Element.prototype.setPointerCapture = () => undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the width and its limits on the separator", () => {
    renderPane("right", 450);
    const separator = screen.getByRole("separator", { name: "Resize" });
    expect(separator.getAttribute("aria-valuenow")).toBe("450");
    expect(separator.getAttribute("aria-valuemin")).toBe(String(MIN));
    expect(separator.getAttribute("aria-valuemax")).toBe(String(MAX));
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("makes a pane on the right follow the pointer to the left, and stores the width once on release", () => {
    const stored = renderPane("right");
    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 580 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 500 });
    expect(screen.getByTestId("pane").textContent).toBe("500");
    expect(separator.getAttribute("aria-valuenow")).toBe("500");
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 450 });
    expect(screen.getByTestId("pane").textContent).toBe("550");
    expect(stored).toEqual([]);
    fireEvent.pointerUp(separator, { pointerId: 1 });
    expect(stored).toEqual([550]);
  });

  it("makes a pane on the left follow the pointer to the right, within the limits", () => {
    const stored = renderPane("left");
    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 420 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 900 });
    expect(screen.getByTestId("pane").textContent).toBe(String(MAX));
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 10 });
    fireEvent.pointerUp(separator, { pointerId: 1 });
    expect(stored).toEqual([MIN]);
  });

  it("stores nothing for a click that never moves", () => {
    const stored = renderPane("right");
    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 580 });
    fireEvent.pointerUp(separator, { pointerId: 1 });
    expect(stored).toEqual([]);
  });

  it("steps a pane on the right wider with the left arrow and narrower with the right arrow", () => {
    const stored = renderPane("right");
    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(stored).toEqual([460, 380]);
  });

  it("steps a pane on the left wider with the right arrow", () => {
    const stored = renderPane("left");
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(stored).toEqual([460]);
  });

  it("gives the widest width with Home and the narrowest with End", () => {
    const stored = renderPane("right");
    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "Home" });
    fireEvent.keyDown(separator, { key: "End" });
    expect(stored).toEqual([MAX, MIN]);
  });

  it("keeps a key it handled from reaching the screen's own keys, and ignores other keys", () => {
    const onOuterKey = vi.fn();
    renderPane("right", DEFAULT, onOuterKey);
    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onOuterKey).not.toHaveBeenCalled();
    fireEvent.keyDown(separator, { key: "a" });
    expect(onOuterKey).toHaveBeenCalledOnce();
  });

  it("gives the default width on a double click", () => {
    const stored = renderPane("right", 550);
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(screen.getByTestId("pane").textContent).toBe(String(DEFAULT));
    expect(stored).toEqual([DEFAULT]);
  });
});
