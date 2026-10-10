/**
 * PROTOTYPE. The workflow list: the items `buildWorkflowListItems` returns,
 * virtualized, in the `nav` landmark "Workflows". It draws at one of two
 * widths:
 *
 * - `table`: the whole main pane, one row of columns per workflow, under
 *   column heads, while no workflow is open;
 * - `column`: a 340px column beside the open workflow, two lines per
 *   workflow, under the search field.
 *
 * The virtualizer and the focus handling are copied from the sidebar's
 * thread list (shell/sidebar-list.tsx), which explains them in full. The
 * Workflows ticket extracts them into one virtualized list, and the sidebar
 * becomes its first consumer.
 *
 * Only the items in and near the visible part are mounted, so a list of a
 * thousand workflows costs about what a list of forty costs. Every item kind
 * has a fixed height at each width, so the list measures nothing. The head,
 * the column heads or the search field, scrolls with the list and sticks to
 * its top.
 */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type ReactNode,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { WorkflowColumnRow, WorkflowGroupHeader, WorkflowTableRow } from "./workflow-list-rows";
import { pickWorkflowFocusFallback, type WorkflowListItem } from "./workflow-rows";
import "./workflow-list.css";

/** The two widths the list draws at. */
export type WorkflowListLayout = "table" | "column";

/** The sizes the list places its items by, at one width. */
interface ListMetrics {
  /** The height of the head above the first item, which sticks to the list's top. */
  readonly head: number;
  /** The height of each item kind. */
  readonly heights: Readonly<Record<WorkflowListItem["kind"], number>>;
  /** The space above the first group's header, above every other group's header, and above a row. */
  readonly firstHeaderLeading: number;
  readonly headerLeading: number;
  readonly rowLeading: number;
}

/**
 * The room the floating header's pills take at the top of the pane: the
 * book's `.top` sits 10px down, its pills are 36px tall, and 10px more keeps
 * the list's head clear of them.
 */
export const PILL_CLEARANCE = 56;

/**
 * The sizes at each width. The table's rows are dense, 40px with a hairline
 * between them, so a screen holds about twenty workflows. The column's rows
 * have two lines, as the sidebar's thread rows do, with 1px between them.
 */
const METRICS: Readonly<Record<WorkflowListLayout, ListMetrics>> = {
  table: {
    head: PILL_CLEARANCE + 32,
    heights: { "group-header": 24, "workflow-row": 40 },
    firstHeaderLeading: 14,
    headerLeading: 22,
    rowLeading: 0,
  },
  column: {
    head: PILL_CLEARANCE + 32 + 8,
    heights: { "group-header": 24, "workflow-row": 46 },
    firstHeaderLeading: 8,
    headerLeading: 16,
    rowLeading: 1,
  },
};

/** How many items the list mounts beyond each end of the visible part. */
const OVERSCAN = 8;

/** The space below the last item. */
const LIST_END_PADDING = 24;

/** The item that holds keyboard focus. */
interface Focus {
  /** The item's key, or `null` when focus is outside the list. */
  readonly key: string | null;
  /** True when the list picked the item itself, because the focused item left the list. */
  readonly restore: boolean;
}

const NO_FOCUS: Focus = { key: null, restore: false };

/** Returns the `data-key` of the item that contains `element`, or `null` when no item does. */
const findItemKey = (element: Element): string | null =>
  element.closest("[data-key]")?.getAttribute("data-key") ?? null;

/** Returns the space above the item at `index`, at the width `metrics` belongs to. */
const measureLeading = (item: WorkflowListItem, index: number, metrics: ListMetrics): number =>
  item.kind === "workflow-row"
    ? metrics.rowLeading
    : index === 0
      ? metrics.firstHeaderLeading
      : metrics.headerLeading;

/** Returns the element that draws `item`, with `leading` pixels above it. */
const renderItem = (
  item: WorkflowListItem,
  leading: number,
  layout: WorkflowListLayout,
): JSX.Element => {
  const height = METRICS[layout].heights[item.kind];
  if (item.kind === "group-header") {
    return (
      <WorkflowGroupHeader
        key={item.key}
        itemKey={item.key}
        leading={leading}
        height={height}
        title={item.title}
        count={item.count}
        isYou={item.group === "needsYou"}
      />
    );
  }
  const Row = layout === "table" ? WorkflowTableRow : WorkflowColumnRow;
  return <Row key={item.key} itemKey={item.key} leading={leading} height={height} row={item.row} />;
};

/**
 * Renders the workflow list at `layout`'s width, under `head`, or
 * `emptyText` when `items` is empty.
 */
export function WorkflowList({
  items,
  layout,
  head,
  emptyText,
}: {
  readonly items: ReadonlyArray<WorkflowListItem>;
  readonly layout: WorkflowListLayout;
  readonly head: ReactNode;
  readonly emptyText: string;
}): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const [focus, setFocus] = useState<Focus>(NO_FOCUS);
  const metrics = METRICS[layout];

  // When the focused item leaves the list, the next item to focus is picked
  // while rendering the new list, so it is mounted in the same commit.
  const [shownItems, setShownItems] = useState(items);
  if (shownItems !== items) {
    setShownItems(items);
    if (focus.key !== null && !items.some((item) => item.key === focus.key)) {
      setFocus({ key: pickWorkflowFocusFallback(focus.key, shownItems, items), restore: true });
    }
  }

  const focusedIndex = useMemo(
    () => (focus.key === null ? -1 : items.findIndex((item) => item.key === focus.key)),
    [items, focus.key],
  );

  // The React Compiler does not memoize this component, because it cannot
  // see into the virtualizer, so these callbacks are memoized by hand: the
  // virtualizer measures the items again whenever `getItemKey` changes.
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = defaultRangeExtractor(range);
      if (focusedIndex < 0 || indexes.includes(focusedIndex)) return indexes;
      return [...indexes, focusedIndex].sort((a, b) => a - b);
    },
    [focusedIndex],
  );
  // `layout` is a dependency although the key does not read it. The
  // virtualizer does not watch `estimateSize`, so a new `getItemKey` is how
  // a change of width makes it measure the items again.
  const getItemKey = useCallback(
    (index: number) => items[index]!.key,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- See above: `layout` must renew the callback.
    [items, layout],
  );
  const estimateSize = useCallback(
    (index: number) => {
      const item = items[index]!;
      return measureLeading(item, index, metrics) + metrics.heights[item.kind];
    },
    [items, metrics],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this component alone. The callbacks above and the memoized rows keep the renders cheap instead.
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: OVERSCAN,
    // The head sits in the scrolling element above the items.
    scrollMargin: metrics.head,
    paddingEnd: LIST_END_PADDING,
  });

  useLayoutEffect(() => {
    if (!focus.restore || focus.key === null) return;
    const elements = scrollRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? [];
    [...elements].find((element) => element.dataset.key === focus.key)?.focus();
  }, [focus]);

  const noteFocus = (event: FocusEvent<HTMLElement>): void => {
    setFocus({ key: findItemKey(event.target), restore: false });
  };

  const noteBlur = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget;
    if (next !== null) {
      if (!event.currentTarget.contains(next)) setFocus(NO_FOCUS);
      return;
    }
    // Focus moved to no element: the window lost focus, and focus comes
    // back to the same item, or the user clicked something that takes no
    // focus. The window's focus is read once the blur has been handled.
    const key = findItemKey(event.target);
    queueMicrotask(() => {
      if (document.hasFocus()) {
        setFocus((current) => (current.key === key ? NO_FOCUS : current));
      }
    });
  };

  // The mounted items in list order, with an empty spacer before each run of
  // items that is not mounted. Each item's start counts the head above the
  // list, which the spacers do not.
  const drawn: JSX.Element[] = [];
  let end = metrics.head;
  for (const { index, key, start, size } of virtualizer.getVirtualItems()) {
    if (start > end) drawn.push(<div key={`gap:${key}`} style={{ height: start - end }} />);
    const item = items[index]!;
    drawn.push(renderItem(item, measureLeading(item, index, metrics), layout));
    end = start + size;
  }

  return (
    <nav
      ref={scrollRef}
      className={`wl wl--${layout}`}
      aria-label="Workflows"
      onFocus={noteFocus}
      onBlur={noteBlur}
    >
      <div className="wl-head" style={{ height: metrics.head }}>
        {head}
      </div>
      {items.length === 0 ? (
        <p className="wl-empty">{emptyText}</p>
      ) : (
        <div className="wl-items" style={{ height: virtualizer.getTotalSize() }}>
          {drawn}
        </div>
      )}
    </nav>
  );
}
