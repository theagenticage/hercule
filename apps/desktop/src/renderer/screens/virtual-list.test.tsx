/**
 * Tests the virtualized list's head: the items are placed below it, so the
 * list mounts the items the head leaves room for, not the ones it covers.
 * The sidebar's tests cover the rest of the list through its first consumer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { stubElementSize } from "../app/testing";
import { VirtualList } from "./virtual-list";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Fifty items of 20px each. */
const ITEMS = Array.from({ length: 50 }, (_, index) => ({ key: `item-${String(index)}` }));

describe("VirtualList", () => {
  it("places the items below its head, and tells each item whether it is on screen", () => {
    // A 200px tall list whose 100px head leaves room for five items.
    stubElementSize(300, 200);
    render(
      <VirtualList
        aria-label="Items"
        items={ITEMS}
        computeItemHeight={() => 20}
        renderItem={(item, _index, onScreen) => (
          <p key={item.key} data-key={item.key} style={{ height: 20 }}>
            {onScreen ? `${item.key} on screen` : item.key}
          </p>
        )}
        pickFocusFallback={() => null}
        head={{ height: 100, content: <h2>Head</h2> }}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Items" });
    expect(nav.firstElementChild?.textContent).toBe("Head");
    expect(nav.querySelector<HTMLElement>(".virtual-list-items")?.style.height).toBe("1000px");
    expect(screen.getByText("item-4 on screen")).not.toBeNull();
    // The sixth item is mounted beyond the visible part, not on screen. The
    // eight mounted beyond it end at the 13th item.
    expect(screen.getByText("item-5")).not.toBeNull();
    expect(screen.getByText("item-12")).not.toBeNull();
    expect(screen.queryByText("item-13")).toBeNull();
  });
});
