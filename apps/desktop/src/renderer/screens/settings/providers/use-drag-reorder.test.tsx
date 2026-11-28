import { describe, expect, it } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useDragReorder } from "./use-drag-reorder";

/** A draggable item holding a button and a menu, the way a section's head holds its pill. */
function Item(): React.JSX.Element {
  const { getSourceProps } = useDragReorder(["a"], () => undefined);
  return (
    <div data-testid="source" {...getSourceProps("a")}>
      <span>name</span>
      <button type="button">pill</button>
      <div role="menu">
        <span>option</span>
      </div>
    </div>
  );
}

/** Fires a `dragstart` at `source` and returns whether the drag was cancelled. */
const startDrag = (source: HTMLElement): boolean => {
  const dataTransfer = { setData: () => undefined, effectAllowed: "" };
  const event = createEvent.dragStart(source, { dataTransfer });
  fireEvent(source, event);
  return event.defaultPrevented;
};

describe("useDragReorder's source props", () => {
  it("lets a drag start where the item itself or its plain text was pressed", () => {
    render(<Item />);
    const source = screen.getByTestId("source");

    fireEvent.pointerDown(screen.getByText("name"));
    expect(startDrag(source)).toBe(false);

    fireEvent.pointerDown(source);
    expect(startDrag(source)).toBe(false);
  });

  it("cancels a drag that starts after a press on a button inside the item", () => {
    render(<Item />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "pill" }));

    expect(startDrag(screen.getByTestId("source"))).toBe(true);
  });

  it("cancels a drag that starts after a press inside a menu inside the item", () => {
    render(<Item />);

    fireEvent.pointerDown(screen.getByText("option"));

    expect(startDrag(screen.getByTestId("source"))).toBe(true);
  });

  it("lets the next drag start once the pointer is pressed on the item again", () => {
    render(<Item />);
    const source = screen.getByTestId("source");

    fireEvent.pointerDown(screen.getByRole("button", { name: "pill" }));
    expect(startDrag(source)).toBe(true);
    fireEvent.pointerDown(screen.getByText("name"));

    expect(startDrag(source)).toBe(false);
  });
});
