import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type RefObject,
} from "react";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, resolveDisplayTimezone } from "@hercule/client-core";
import {
  describeEmptyMachineActivity,
  describeMachineActivity,
  type MachineActivityDay,
  type MachineActivityDetail,
  type MachineActivityEntry,
  type MachineActivityFilter,
} from "@hercule/client-core/machine-activity";
import {
  machineActivityQuery,
  providerAccountsQuery,
  settingsQuery,
} from "../../../../app/queries";
import { readLengths, useMeasuredAtTextSize } from "../../../../app/text-size";
import { MachineActivityHead } from "../../../../screens/fleet/machine-activity-head";
import { MachineActivityNote } from "../../../../screens/fleet/machine-activity-note";
import {
  MachineActivityDayHeading,
  MachineActivityDetailRow,
  MachineActivityRow,
} from "../../../../screens/fleet/machine-activity-row";
import { useFleetToday } from "../../../../screens/fleet/use-fleet-today";
import { useOpenEntries } from "../../../../screens/fleet/use-open-entries";
import { useVirtualLines } from "../../../../screens/use-virtual-lines";
import "../../../../screens/fleet/machine-activity.css";

/**
 * How many pages the history reads on its own that add no log entry matching
 * the current filter before it stops and offers "Read older". Five pages are
 * 500 log entries. Without the bound, a filter that matches nothing would read
 * the whole log.
 */
const MAX_PAGES_WITHOUT_GAIN = 5;

/**
 * Where the automatic reading under a filter stands: the pages loaded and
 * the log entries that match the filter, when the filter was picked or a
 * matching log entry last appeared. Log entries are counted, not the entries
 * the list shows, because many log entries fold into one shown entry (700
 * sessions spawned in one minute are one entry), and each page of them is a
 * gain.
 */
interface ReadingGain {
  readonly filter: MachineActivityFilter;
  readonly pageCount: number;
  readonly matchCount: number;
}

/**
 * Renders the history of the machine `runnerId` in the Fleet scroll area
 * `scrollRef`: the heading and filters, the days of entries, and a line under
 * them or in their place (spec 17 §Fleet, Activity). It reads the machine's
 * audit log a page at a time, keeps the chosen filter and which entries are
 * unfolded, and draws only the lines near the view.
 *
 * - Each day's heading, each entry and each detail of an unfolded entry is a
 *   line of a height known beforehand (spec 17 §Rules, rule 1). Unfolding a
 *   fold of a hundred log entries draws no more than the few that are in view.
 * - The entry that holds the keyboard focus stays drawn when it scrolls out of
 *   view, so its Show or Hide button keeps the focus.
 * - The filters apply to the pages read so far. A page holds entries of every
 *   category, so a filter may leave the list short or empty while older pages
 *   remain. The next page is read whenever the last line is drawn, which
 *   includes a list with no lines, so reading goes on until the filtered
 *   entries fill the view or the log ends. The user is never left looking at
 *   an empty list that hides further entries.
 * - That reading is bounded: after `MAX_PAGES_WITHOUT_GAIN` pages that add no
 *   log entry matching the filter, it stops with a line and a "Read older"
 *   button, which allows as many pages again.
 * - A failed page is not asked for again by scrolling, because the list would
 *   still be at its end and that would loop. Its line has a Retry.
 */
export function MachineActivityHistory({
  runnerId,
  machineName,
  scrollRef,
}: {
  readonly runnerId: string;
  readonly machineName: string;
  readonly scrollRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const paged = useInfiniteQuery(machineActivityQuery(client, runnerId));
  const [filter, setFilter] = useState<MachineActivityFilter>("all");
  const { openKeys, toggle } = useOpenEntries();
  // The entry whose button holds the focus, which the virtual list keeps drawn.
  const [focusedEntryKey, setFocusedEntryKey] = useState<string | null>(null);

  const timezone = resolveDisplayTimezone(settings.user.timezone);
  // The day headings say "Today" and "Yesterday", so the history watches for midnight.
  const today = useFleetToday(timezone, true);
  const events = useMemo(() => paged.data?.pages.flatMap((page) => page.items) ?? [], [paged.data]);
  const days = describeMachineActivity(events, { filter, timezone, today, accounts });

  const { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage } =
    paged;
  const pageCount = paged.data?.pages.length ?? 0;
  const matchCount = days.reduce(
    (total, day) => day.entries.reduce((dayTotal, entry) => dayTotal + entry.count, total),
    0,
  );
  const [gain, setGain] = useState<ReadingGain>({ filter, pageCount, matchCount: 0 });
  // A new filter, or a matching log entry that appears, starts the count of pages without gain again.
  if (gain.filter !== filter || matchCount > gain.matchCount) {
    setGain({ filter, pageCount, matchCount });
  }
  const isBoundReached =
    gain.filter === filter &&
    matchCount <= gain.matchCount &&
    hasNextPage &&
    pageCount - gain.pageCount >= MAX_PAGES_WITHOUT_GAIN;
  // Nothing is asked for while any read runs, because asking for a page cancels a refresh of the
  // pages already loaded.
  const canReadMore = hasNextPage && !isFetching && !isFetchNextPageError && !isBoundReached;

  const headRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listTop = useListTop(scrollRef, headRef, listRef);
  const heights = useMeasuredAtTextSize(readLineHeights);
  const items = flattenIntoItems(days, openKeys);
  const estimateSize = useCallback(
    (item: ActivityItem) => estimateItemHeight(heights, item),
    [heights],
  );
  const { lines, totalSize, lastDrawnIndex } = useVirtualLines({
    items,
    scrollRef,
    estimateSize,
    focusedKey: focusedEntryKey === null ? null : buildEntryItemKey(focusedEntryKey),
    scrollMargin: listTop,
  });

  // Once the last line is drawn, and again each time the days change while it still is. A list
  // that holds no lines at all is at its end, too.
  const isEndDrawn = items.length === 0 || (lastDrawnIndex ?? -1) >= items.length - 1;
  useEffect(() => {
    if (isEndDrawn && canReadMore) void fetchNextPage();
  }, [isEndDrawn, canReadMore, fetchNextPage, items]);

  // The line under the entries, or in their place when there are none. It never says how far
  // back the log reaches.
  let foot: JSX.Element | null = null;
  if (paged.isError) {
    const retry = isFetchNextPageError ? () => void fetchNextPage() : () => void paged.refetch();
    const failed =
      paged.data === undefined
        ? "Couldn't read the activity."
        : isFetchNextPageError
          ? "Couldn't read older activity."
          : "Couldn't refresh the activity.";
    foot = (
      <MachineActivityNote onRetry={retry}>
        {`${failed} ${readErrorMessage(paged.error)}`}
      </MachineActivityNote>
    );
  } else if (isBoundReached && !isFetchingNextPage) {
    foot = (
      <MachineActivityNote
        onRetry={undefined}
        onReadOlder={() => setGain({ filter, pageCount, matchCount })}
      >
        {describeBoundedActivity(filter, events.length, days.length > 0)}
      </MachineActivityNote>
    );
  } else if (isFetchingNextPage || (days.length === 0 && hasNextPage)) {
    foot = <MachineActivityNote onRetry={undefined}>Reading older activity…</MachineActivityNote>;
  } else if (days.length === 0 && !paged.isPending) {
    foot = (
      <MachineActivityNote onRetry={undefined}>
        {describeEmptyMachineActivity(filter, machineName)}
      </MachineActivityNote>
    );
  }

  return (
    <div className="machine-activity-page">
      <div ref={headRef}>
        <MachineActivityHead machineName={machineName} filter={filter} onPickFilter={setFilter} />
      </div>
      <div
        ref={listRef}
        className="machine-activity"
        style={{ height: totalSize }}
        onFocus={(event: FocusEvent<HTMLElement>) => {
          setFocusedEntryKey(
            event.target.closest<HTMLElement>("[data-entry-key]")?.dataset.entryKey ?? null,
          );
        }}
        onBlur={(event: FocusEvent<HTMLElement>) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedEntryKey(null);
        }}
      >
        {lines.map((line) =>
          line.kind === "gap" ? (
            <div key={line.key} style={{ height: line.height }} aria-hidden="true" />
          ) : (
            <MachineActivityLine key={line.item.key} item={line.item} onToggleEntry={toggle} />
          ),
        )}
      </div>
      {foot}
    </div>
  );
}

/**
 * Returns the line shown when the history stopped reading older pages on its
 * own because `filter` found nothing new in the `loadedCount` log entries read
 * so far. `hasEntries` is whether the list shows any entry. The line does not
 * say how far back the log reaches.
 */
const describeBoundedActivity = (
  filter: MachineActivityFilter,
  loadedCount: number,
  hasEntries: boolean,
): string => {
  const latest = `in the latest ${String(loadedCount)} entries`;
  if (hasEntries) return `Nothing older matched ${latest}.`;
  return filter === "problems" ? `No problems ${latest}.` : `Nothing matched ${latest}.`;
};

/**
 * One line of the list. The list is flat so that it can be virtualized: a
 * day's heading, an entry, and the details of an entry that the user unfolded
 * are each a line of their own.
 */
type ActivityItem =
  | { readonly kind: "day"; readonly key: string; readonly heading: string }
  | {
      readonly kind: "entry";
      readonly key: string;
      readonly entry: MachineActivityEntry;
      /** True when the entry has details and they are listed below it. */
      readonly isOpen: boolean;
      /** True when the line above is an entry or a detail, so the thread that joins the dots runs into this one. */
      readonly joinsAbove: boolean;
    }
  | {
      readonly kind: "detail";
      readonly key: string;
      readonly detail: MachineActivityDetail;
      /** True for the last detail of an unfolded entry, which has room below it before the next entry. */
      readonly isLast: boolean;
    };

/** Returns the key of the line for the entry with the key `entryKey`. */
const buildEntryItemKey = (entryKey: string): string => `entry:${entryKey}`;

/**
 * Returns the lines of `days` in the order they are drawn: each day's heading,
 * then its entries, with the details of every entry whose key is in
 * `openEntryKeys` right after it. Only an entry with details can be open.
 */
const flattenIntoItems = (
  days: ReadonlyArray<MachineActivityDay>,
  openEntryKeys: ReadonlySet<string>,
): ReadonlyArray<ActivityItem> => {
  const items: ActivityItem[] = [];
  for (const day of days) {
    items.push({ kind: "day", key: `day:${day.key}`, heading: day.heading });
    day.entries.forEach((entry, index) => {
      const isOpen = entry.details.length > 0 && openEntryKeys.has(entry.key);
      items.push({
        kind: "entry",
        key: buildEntryItemKey(entry.key),
        entry,
        isOpen,
        joinsAbove: index > 0,
      });
      if (!isOpen) return;
      entry.details.forEach((detail, detailIndex) => {
        items.push({
          kind: "detail",
          key: `detail:${entry.key}:${String(detail.eventId)}`,
          detail,
          isLast: detailIndex === entry.details.length - 1,
        });
      });
    });
  }
  return items;
};

/**
 * The custom property that holds the height of each kind of line, at the
 * default Text size:
 *
 * - `day` is a day's heading with the space around it, 48px;
 * - `entry` is an entry, 35px;
 * - `detail` is a line of an unfolded entry, 19px;
 * - `lastDetail` is the last line of an unfolded entry, which has room below
 *   it, 28px.
 */
const LINE_HEIGHT_PROPERTIES = {
  day: "--fleet-activity-height-day",
  entry: "--fleet-activity-height-entry",
  detail: "--fleet-activity-height-member",
  lastDetail: "--fleet-activity-height-last-member",
} as const;

/** The heights of the list's lines, in CSS pixels. */
type LineHeights = Readonly<Record<keyof typeof LINE_HEIGHT_PROPERTIES, number>>;

/**
 * Reads the heights of the list's lines from the page's CSS, in CSS pixels.
 * The list places its lines by these heights and never measures one, so each
 * line is drawn at exactly its height, and every text in a line is cut with an
 * ellipsis rather than wrapped. The heights follow the Text size, so they come
 * from the custom properties of styles/row-heights.css that the CSS draws the
 * lines at.
 */
const readLineHeights = (): LineHeights => readLengths(LINE_HEIGHT_PROPERTIES);

/** Returns the height of `item` in CSS pixels. */
const estimateItemHeight = (heights: LineHeights, item: ActivityItem): number => {
  switch (item.kind) {
    case "day":
      return heights.day;
    case "entry":
      return heights.entry;
    case "detail":
      return item.isLast ? heights.lastDetail : heights.detail;
  }
};

/**
 * Returns how far below the top of `scrollRef`'s scrolled content the element
 * `listRef` starts, in pixels, and measures it again whenever the element
 * `aboveRef` changes size. `aboveRef` is the part of the content above the
 * list, the heading, so a change in its height, which the Text size and a
 * narrow window cause, moves the list.
 *
 * A virtual list that shares its scroll with something above it needs this to
 * tell which of its lines the scroll position reaches. It is 0 until the
 * elements are measured.
 *
 * The measure runs in an effect, not a layout effect, because the scroll area
 * is usually a parent of the list: React attaches a parent's ref after the
 * layout effects of its children. The first measure always draws the list
 * again, even when the result is 0, which is also what lets the list's
 * virtualizer find a scroll area that was not attached when it first drew.
 */
const useListTop = (
  scrollRef: RefObject<HTMLElement | null>,
  aboveRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
): number => {
  const [top, setTop] = useState<number | undefined>(undefined);
  useEffect(() => {
    const scroll = scrollRef.current;
    const above = aboveRef.current;
    const list = listRef.current;
    if (scroll === null || above === null || list === null) return;
    const measure = (): void => {
      setTop(
        Math.round(
          list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(above);
    return () => {
      observer.disconnect();
    };
  }, [scrollRef, aboveRef, listRef]);
  return top ?? 0;
};

/** Renders the line for `item`; pressing an entry's Show or Hide calls `onToggleEntry` with the entry's key. */
function MachineActivityLine({
  item,
  onToggleEntry,
}: {
  readonly item: ActivityItem;
  readonly onToggleEntry: (entryKey: string) => void;
}): JSX.Element {
  switch (item.kind) {
    case "day":
      return <MachineActivityDayHeading heading={item.heading} />;
    case "entry":
      return (
        <MachineActivityRow
          entry={item.entry}
          dayHeading={undefined}
          joinsAbove={item.joinsAbove}
          isOpen={item.isOpen}
          onToggle={() => onToggleEntry(item.entry.key)}
        />
      );
    case "detail":
      return <MachineActivityDetailRow detail={item.detail} isLast={item.isLast} />;
  }
}
