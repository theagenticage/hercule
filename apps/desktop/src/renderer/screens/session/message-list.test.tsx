/**
 * Tests the wheel check of `useMessageList`, which brings a list back to
 * following the bottom when a wheel turn would reach it. jsdom lays nothing
 * out, so the test sets the scrolling element's sizes and position itself.
 */
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useMessageList } from "./message-list";

const SCROLL_HEIGHT = 5000;
const CLIENT_HEIGHT = 800;
const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT;

const estimateSize = (): number => 0;
const getItemKey = (index: number): string => String(index);

/** Renders an empty list whose scrolling element holds a nested box. */
function List({
  onBottomChange,
}: {
  readonly onBottomChange: (atBottom: boolean) => void;
}): JSX.Element {
  const { scrollRef, columnRef, noteScroll } = useMessageList({
    count: 0,
    estimateSize,
    getItemKey,
    scrollMargin: 0,
    composerStack: null,
    onBottomChange,
  });
  return (
    <section ref={scrollRef} aria-label="List" onScroll={noteScroll}>
      <div ref={columnRef}>
        <div data-testid="nested" />
      </div>
    </section>
  );
}

/**
 * Renders the list, scrolls it to the bottom and then up to `scrollTop`, so
 * it no longer follows the bottom. `onBottomChange` has then been called
 * once, with false.
 */
const renderReadingList = (scrollTop: number) => {
  const onBottomChange = vi.fn();
  render(<List onBottomChange={onBottomChange} />);
  const list = screen.getByLabelText("List");
  let position = 0;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: () => SCROLL_HEIGHT },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value;
      },
    },
  });
  const scrollTo = (next: number): void => {
    position = next;
    fireEvent.scroll(list);
  };
  scrollTo(BOTTOM);
  scrollTo(scrollTop);
  expect(onBottomChange).toHaveBeenCalledExactlyOnceWith(false);
  onBottomChange.mockClear();
  return { list, onBottomChange };
};

describe("useMessageList wheel check", () => {
  it("follows the bottom again when a wheel turn down would reach it, though the scroll stops short", () => {
    const { list, onBottomChange } = renderReadingList(BOTTOM - 100);

    fireEvent.wheel(list, { deltaY: 90 });

    expect(onBottomChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([
    ["it would stop more than 12px short", { deltaY: 60 }],
    ["it turns up", { deltaY: -200 }],
    ["it is in lines", { deltaY: 200, deltaMode: 1 }],
    ["ctrl is held", { deltaY: 200, ctrlKey: true }],
    ["shift is held", { deltaY: 200, shiftKey: true }],
  ])("stays reading when %s", (_name, init) => {
    const { list, onBottomChange } = renderReadingList(BOTTOM - 100);

    fireEvent.wheel(list, init);

    expect(onBottomChange).not.toHaveBeenCalled();
  });

  it("stays reading when the wheel is over a box inside the list that scrolls vertically", () => {
    const { onBottomChange } = renderReadingList(BOTTOM - 100);
    const nested = screen.getByTestId("nested");
    nested.style.overflowY = "auto";
    Object.defineProperty(nested, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(nested, "clientHeight", { configurable: true, value: 200 });

    fireEvent.wheel(nested, { deltaY: 200 });
    expect(onBottomChange).not.toHaveBeenCalled();

    // The same box with nothing to scroll does not take the wheel.
    Object.defineProperty(nested, "scrollHeight", { configurable: true, value: 200 });
    fireEvent.wheel(nested, { deltaY: 200 });
    expect(onBottomChange).toHaveBeenCalledExactlyOnceWith(true);
  });
});
