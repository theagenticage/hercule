/**
 * The sidebar's thread list: the items `buildSidebar` returns, in the
 * `nav` landmark "Threads", virtualized.
 *
 * Only the items in and near the visible part of the list are mounted, so a
 * list of a thousand threads costs about what a list of forty costs. Every
 * item kind has a fixed height (`ITEM_HEIGHTS`), so the list measures
 * nothing: an item's place follows from the items above it.
 *
 * The mounted items are stacked in normal flow, and an empty spacer stands in
 * for each run of items that is not mounted. No item takes its position as a
 * prop, so when an item arrives, the items below it move down without
 * drawing again.
 *
 * The focused item is always mounted, even when it scrolls far out of view,
 * so keyboard focus is never lost to the page. When the focused item leaves
 * the list, focus moves to the item `pickFocusFallback` picks.
 *
 * While the pointer rests on a thread row, one card beside the sidebar shows
 * the thread's details (`useThreadHover`).
 */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import {
  ITEM_HEIGHTS,
  pickFocusFallback,
  type SectionKey,
  type SidebarItem,
} from "./sidebar-items";
import {
  DraftRow,
  MoreRow,
  ProjectHeader,
  ThreadRow,
  WaitingAssistantRow,
  WaitingHeader,
  WaitingThreadRow,
} from "./sidebar-rows";
import { ThreadHoverCard } from "./thread-hover-card";
import { useThreadHover } from "./use-thread-hover";

/**
 * How many items the list mounts beyond each end of the visible part, so a
 * short scroll shows no empty space before React draws the new items.
 */
const OVERSCAN = 8;

/** The space below the last item: the book's `.side-scroll { padding-bottom: 12px }`. */
const LIST_END_PADDING = 12;

/** The item that holds keyboard focus. */
interface Focus {
  /** The item's key, or `null` when focus is outside the list. */
  readonly key: string | null;
  /**
   * True when the list picked the item itself, because the focused item left
   * the list. The item is focused as soon as it is mounted.
   */
  readonly restore: boolean;
}

const NO_FOCUS: Focus = { key: null, restore: false };

/** Returns the `data-key` of the item that contains `element`, or `null` when no item does. */
const findItemKey = (element: Element): string | null =>
  element.closest("[data-key]")?.getAttribute("data-key") ?? null;

/**
 * Returns the element that draws `item`. While `officeOpen` is true, the row
 * of a thread with a colleague in the Office opens the thread in the
 * Office's drawer.
 */
const renderItem = (
  item: SidebarItem,
  onScreen: boolean,
  officeOpen: boolean,
  onExpand: (section: SectionKey) => void,
): JSX.Element => {
  switch (item.kind) {
    case "waiting-header":
      return (
        <WaitingHeader
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          count={item.count}
        />
      );
    case "waiting-thread-row":
      return (
        <WaitingThreadRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          sessionId={item.sessionId}
          title={item.title}
          question={item.question}
          officeOpen={officeOpen}
        />
      );
    case "waiting-assistant-row":
      return (
        <WaitingAssistantRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          assistantId={item.assistantId}
          name={item.name}
          question={item.question}
        />
      );
    case "project-header":
      return (
        <ProjectHeader
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          projectId={item.projectId}
          name={item.name}
          tint={item.tint}
        />
      );
    case "thread-row":
      return (
        <ThreadRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          sessionId={item.sessionId}
          title={item.title}
          secondLine={item.secondLine}
          pose={item.pose}
          end={item.end}
          activityAt={item.activityAt}
          workspaceClip={item.workspaceClip}
          workspaceKeep={item.workspaceKeep}
          placeDescription={item.placeDescription}
          unsent={item.unsent}
          onScreen={onScreen}
          officeOpen={officeOpen}
        />
      );
    case "draft-row":
      return (
        <DraftRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          model={item.model}
          workspaceClip={item.workspaceClip}
          workspaceKeep={item.workspaceKeep}
        />
      );
    case "more":
      return (
        <MoreRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          section={item.section}
          label={item.label}
          onExpand={onExpand}
        />
      );
  }
};

/**
 * Renders the thread list, or "No threads yet" when `items` is empty.
 *
 * - While `officeOpen` is true, the row of a thread with a colleague in the
 *   Office opens the thread in the Office's drawer instead of on its own
 *   screen. Opening or leaving the Office draws every mounted row again,
 *   once.
 * - `onExpand` is called with a section's key when its "more" row is
 *   pressed. It must keep its identity across renders, or every "more" row
 *   draws again on each render.
 */
export function SidebarList({
  items,
  officeOpen,
  onExpand,
}: {
  readonly items: readonly SidebarItem[];
  readonly officeOpen: boolean;
  readonly onExpand: (section: SectionKey) => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const [focus, setFocus] = useState<Focus>(NO_FOCUS);
  const { listHandlers, placement, details } = useThreadHover(items, scrollRef);

  // When the focused item leaves the list, the next item to focus is picked
  // while rendering the new list, not in an effect after it, so the item is
  // mounted in the same commit and focus never falls to the page between.
  const [shownItems, setShownItems] = useState(items);
  if (shownItems !== items) {
    setShownItems(items);
    if (focus.key !== null && !items.some((item) => item.key === focus.key)) {
      setFocus({ key: pickFocusFallback(focus.key, shownItems, items), restore: true });
    }
  }

  const focusedIndex = useMemo(
    () => (focus.key === null ? -1 : items.findIndex((item) => item.key === focus.key)),
    [items, focus.key],
  );

  // The React Compiler does not memoize this component, because it cannot
  // see into the virtualizer (see below). These callbacks are memoized by
  // hand: the virtualizer measures the items again whenever `getItemKey`
  // changes, and draws the list again whenever `rangeExtractor` changes.
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = defaultRangeExtractor(range);
      if (focusedIndex < 0 || indexes.includes(focusedIndex)) return indexes;
      // In list order, so the focused item keeps its place in the tab order.
      return [...indexes, focusedIndex].sort((a, b) => a - b);
    },
    [focusedIndex],
  );
  // The virtualizer asks only for indexes below `count`, which is `items.length`.
  const getItemKey = useCallback((index: number) => items[index]!.key, [items]);
  const estimateSize = useCallback(
    (index: number) => {
      const item = items[index]!;
      return item.leading + ITEM_HEIGHTS[item.kind];
    },
    [items],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this component alone. The callbacks above and the memoized rows keep the renders cheap instead.
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: OVERSCAN,
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
      // Focus moved to another element. Inside the list, `noteFocus` notes
      // the new item.
      if (!event.currentTarget.contains(next)) setFocus(NO_FOCUS);
      return;
    }
    // Focus moved to no element, for one of two reasons:
    // - the window lost focus, and focus comes back to the same item when the
    //   window is active again;
    // - the user clicked something that takes no focus, and focus left the
    //   list.
    // The window's focus is read once the blur has been handled, so the check
    // does not depend on whether the browser marks the window inactive before
    // or after it sends the blur.
    // React sends no blur for an item it removes, because it ignores events
    // while it commits; the list picks the next item while rendering instead.
    const key = findItemKey(event.target);
    queueMicrotask(() => {
      if (document.hasFocus()) {
        setFocus((current) => (current.key === key ? NO_FOCUS : current));
      }
    });
  };

  // The mounted items in list order. Before each run of items that is not
  // mounted, an empty spacer takes up the run's height.
  const drawn: JSX.Element[] = [];
  const virtualItems = virtualizer.getVirtualItems();
  // The visible part of the list, without the overscan. Read after
  // `getVirtualItems`, which computes it.
  const visible = virtualizer.range;
  let end = 0;
  for (const { index, key, start, size } of virtualItems) {
    if (start > end) drawn.push(<div key={`gap:${key}`} style={{ height: start - end }} />);
    const onScreen = visible !== null && index >= visible.startIndex && index <= visible.endIndex;
    drawn.push(renderItem(items[index]!, onScreen, officeOpen, onExpand));
    end = start + size;
  }

  return (
    <>
      <nav
        ref={scrollRef}
        className="side-scroll"
        aria-label="Threads"
        onFocus={noteFocus}
        onBlur={noteBlur}
        {...listHandlers}
      >
        {items.length === 0 ? (
          <p className="side-meta side-empty">No threads yet</p>
        ) : (
          <div className="side-list" style={{ height: virtualizer.getTotalSize() }}>
            {drawn}
          </div>
        )}
      </nav>
      <ThreadHoverCard placement={placement} details={details} />
    </>
  );
}
