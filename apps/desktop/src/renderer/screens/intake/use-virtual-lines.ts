/**
 * The virtual list Tracking's opened sheet draws its lines in, built as
 * Intake's list is (`intake-list.tsx`): only the lines in view and a few past
 * each edge are drawn, each at its estimated place, with an empty spacer
 * before each run of lines that are not drawn (spec 17 §Rules, rule 1).
 */
import { useCallback, useMemo, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";

/** How many lines past each edge of the visible part stay drawn, so a fast scroll shows no gap. */
export const VIRTUAL_OVERSCAN = 8;

/** One line to draw: an item, or the empty spacer that stands in for a run of lines not drawn. */
export type VirtualLine<Item> =
  | { readonly kind: "item"; readonly item: Item; readonly onScreen: boolean }
  | { readonly kind: "gap"; readonly key: string; readonly height: number };

/** What `useVirtualLines` returns. */
export interface VirtualLines<Item> {
  /** The lines to draw, in order: the items in view and near it, and the spacers between them. */
  readonly lines: ReadonlyArray<VirtualLine<Item>>;
  /** The height of all the lines, drawn or not, in pixels. The lines' container is at least this tall. */
  readonly totalSize: number;
  /** The index in `items` of the last item drawn, or `undefined` when none is. */
  readonly lastDrawnIndex: number | undefined;
  /** The index in `items` of the selected item, or -1 when `selectedKey` names none. */
  readonly selectedIndex: number;
  /** Scrolls the selected item into view, if it is not in view. Does nothing when none is selected. */
  readonly scrollToSelected: () => void;
}

/**
 * Returns the lines to draw for `items`, which scroll inside `scrollRef`.
 * `estimateSize` gives the height of an item in pixels: the list never
 * measures a line, so the heights must be fixed by the lines' styles.
 *
 * The item with the key `selectedKey` is always drawn, so it keeps its place
 * in the tab order while it is scrolled out of view. The caller scrolls it into
 * view with `scrollToSelected`, when it decides to.
 */
export const useVirtualLines = <Item extends { readonly key: string }>(
  items: ReadonlyArray<Item>,
  scrollRef: RefObject<HTMLElement | null>,
  estimateSize: (item: Item) => number,
  selectedKey: string | null,
): VirtualLines<Item> => {
  const selectedIndex = useMemo(
    () => items.findIndex((item) => item.key === selectedKey),
    [items, selectedKey],
  );
  // The React Compiler leaves this component alone, because it cannot see
  // into the virtualizer, so these callbacks are memoized by hand: the
  // virtualizer measures again whenever `getItemKey` changes.
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = defaultRangeExtractor(range);
      if (selectedIndex < 0 || indexes.includes(selectedIndex)) return indexes;
      return [...indexes, selectedIndex].sort((a, b) => a - b);
    },
    [selectedIndex],
  );
  const getItemKey = useCallback((index: number) => items[index]!.key, [items]);
  const estimateIndexSize = useCallback(
    (index: number) => estimateSize(items[index]!),
    [items, estimateSize],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this hook's caller alone. The callbacks above keep the renders cheap instead.
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateIndexSize,
    getItemKey,
    rangeExtractor,
    overscan: VIRTUAL_OVERSCAN,
    // Before the scroll element is measured, the list is taken to be as tall as the window. The
    // sheet's first render then draws its rows, which the motion that opens it needs to find.
    initialRect: { width: 0, height: window.innerHeight },
  });

  const scrollToSelected = useCallback((): void => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [virtualizer, selectedIndex]);

  const lines: VirtualLine<Item>[] = [];
  const visible = virtualizer.range;
  let end = 0;
  let lastDrawnIndex: number | undefined;
  for (const { index, key, start, size } of virtualizer.getVirtualItems()) {
    if (start > end) lines.push({ kind: "gap", key: `gap:${key}`, height: start - end });
    const onScreen = visible !== null && index >= visible.startIndex && index <= visible.endIndex;
    lines.push({ kind: "item", item: items[index]!, onScreen });
    end = start + size;
    lastDrawnIndex = index;
  }
  return {
    lines,
    totalSize: virtualizer.getTotalSize(),
    lastDrawnIndex,
    selectedIndex,
    scrollToSelected,
  };
};
