/**
 * Tests the virtualized list's head: the items are placed below it, so the
 * list mounts the items the head leaves room for, not the ones it covers.
 * The sidebar's tests cover the rest of the list through its first consumer.
 */
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
        scrollRef={createRef()}
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

  it("places the items again when the heights change, and keeps the item at the top of the view at the top", () => {
    stubElementSize(300, 200);
    const scrollRef = createRef<HTMLElement>();
    const draw = (height: number) => (
      <VirtualList
        aria-label="Items"
        items={ITEMS}
        computeItemHeight={() => height}
        renderItem={(item) => (
          <p key={item.key} data-key={item.key} style={{ height }}>
            {item.key}
          </p>
        )}
        pickFocusFallback={() => null}
        scrollRef={scrollRef}
      />
    );
    const { rerender } = render(draw(20));
    const nav = screen.getByRole("navigation", { name: "Items" });
    const items = nav.querySelector<HTMLElement>(".virtual-list-items")!;
    expect(items.style.height).toBe("1000px");

    // Scroll to the 21st item, whose top is at 400px and a quarter of the way into the view's first 20px item.
    act(() => {
      nav.scrollTop = 405;
      fireEvent.scroll(nav);
    });
    // The Text size grows: every item is now 40px tall, as a new function says.
    rerender(draw(40));

    expect(items.style.height).toBe("2000px");
    // Item 20 sat 5px above the top edge and now sits 10px above it: the same share of the item.
    expect(nav.scrollTop).toBe(810);
    expect(screen.getByText("item-20")).not.toBeNull();
  });

  it("keeps the top item through a second change of the heights before the scroll event of the first arrives, and through a change back", () => {
    stubElementSize(300, 200);
    const scrollRef = createRef<HTMLElement>();
    const draw = (height: number) => (
      <VirtualList
        aria-label="Items"
        items={ITEMS}
        computeItemHeight={() => height}
        renderItem={(item) => (
          <p key={item.key} data-key={item.key} style={{ height }}>
            {item.key}
          </p>
        )}
        pickFocusFallback={() => null}
        scrollRef={scrollRef}
      />
    );
    const { rerender } = render(draw(50));
    const nav = screen.getByRole("navigation", { name: "Items" });
    // Item 20 starts at 1000px, and the view starts 5px into it.
    act(() => {
      nav.scrollTop = 1005;
      fireEvent.scroll(nav);
    });

    // A browser delivers the scroll event after the commit, so the virtualizer still holds 1005
    // while the heights change again.
    rerender(draw(54));
    expect(nav.scrollTop).toBeCloseTo(1085.4);
    rerender(draw(49));
    expect(nav.scrollTop).toBeCloseTo(984.9);

    // The event arrives, and the heights go back, as when a save fails and the setting returns.
    act(() => {
      fireEvent.scroll(nav);
    });
    rerender(draw(50));
    expect(nav.scrollTop).toBeCloseTo(1005);
  });
});
