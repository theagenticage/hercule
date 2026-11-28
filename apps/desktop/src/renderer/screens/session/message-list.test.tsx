/**
 * Tests the wheel check of `useMessageList`, which brings a list back to
 * following the bottom when a wheel turn would reach it. jsdom lays nothing
 * out, so the test sets the scrolling element's sizes and position itself.
 */
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HOLDS_PLACE_PROPS, useMessageList } from "./message-list";

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
        <button type="button" {...HOLDS_PLACE_PROPS}>
          Fold
        </button>
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

/** A scrolling element whose content height a test sets, so a click can grow or shrink it. */
const layout = { contentHeight: 0, scrollTop: 0 };

/** Calls the callback of the list's resize observer, as the browser does after a layout. */
let reportResize: () => void = () => {};

/** Renders a list whose button changes the content height, as a fold opening does. */
function FoldList({
  onBottomChange,
  heightAfterClick,
}: {
  readonly onBottomChange: (atBottom: boolean) => void;
  readonly heightAfterClick: number;
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
        <button
          type="button"
          {...HOLDS_PLACE_PROPS}
          onClick={() => {
            layout.contentHeight = heightAfterClick;
          }}
        >
          Fold
        </button>
        <button type="button">Other</button>
      </div>
    </section>
  );
}

/** Waits for the two frames the list lets a toggle settle in. */
const waitForSettle = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });

const renderFoldList = (contentHeight: number, heightAfterClick: number) => {
  layout.contentHeight = contentHeight;
  layout.scrollTop = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: unknown[]) => void) {
        reportResize = () => {
          callback([]);
        };
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  const onBottomChange = vi.fn();
  render(<FoldList onBottomChange={onBottomChange} heightAfterClick={heightAfterClick} />);
  const list = screen.getByLabelText("List");
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: () => Math.max(layout.contentHeight, CLIENT_HEIGHT) },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => layout.scrollTop,
      set: (value: number) => {
        layout.scrollTop = Math.min(
          value,
          Math.max(layout.contentHeight, CLIENT_HEIGHT) - CLIENT_HEIGHT,
        );
      },
    },
  });
  return { list, onBottomChange };
};

describe("useMessageList content that opens in place", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows again when the opened content still fits, so later growth follows", async () => {
    const { list, onBottomChange } = renderFoldList(300, 500);

    fireEvent.click(screen.getByRole("button", { name: "Fold" }));
    expect(onBottomChange).toHaveBeenLastCalledWith(false);
    await waitForSettle();
    expect(onBottomChange).toHaveBeenLastCalledWith(true);

    layout.contentHeight = 1500;
    reportResize();
    expect(list.scrollTop).toBe(1500 - CLIENT_HEIGHT);
  });

  it("keeps the reader in place when the opened content grows past the view", async () => {
    const { list, onBottomChange } = renderFoldList(700, 1500);

    fireEvent.click(screen.getByRole("button", { name: "Fold" }));
    await waitForSettle();
    expect(onBottomChange).toHaveBeenLastCalledWith(false);

    reportResize();
    expect(list.scrollTop).toBe(0);
  });

  it("keeps following when something else in the list is clicked", async () => {
    const { onBottomChange } = renderFoldList(300, 500);

    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await waitForSettle();

    expect(onBottomChange).not.toHaveBeenCalled();
  });
});
