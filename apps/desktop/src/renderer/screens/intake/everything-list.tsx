/**
 * Everything's list: Intake's events, virtualized, two lines per row, each
 * cut with an ellipsis (spec 17 §Everything). A row has no controls and no
 * counts: it is only read and opened.
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { EventWithFacts } from "@hercule/contract";
import {
  buildHandlingLabels,
  cutHandlingLabels,
  describeEventSystem,
  describeEventTitle,
  formatClock,
  type EventDaySection,
  type PluginIdentity,
} from "@hercule/client-core";
import { SourceMark } from "./source-mark";

/** One drawn line of the list: a day's heading or an event's row. */
type ListItem =
  | { readonly kind: "section"; readonly key: string; readonly section: EventDaySection }
  | { readonly kind: "row"; readonly key: string; readonly event: EventWithFacts };

/**
 * Returns the height of a line, in pixels: a heading is 40px, and a row is
 * 52px with the 2px gap under it, which is 54px in all. The list never
 * measures a row, because a row's two lines never wrap. Drawn rows take their
 * own height; the estimate only sizes the spacers that stand in for undrawn
 * rows.
 */
const estimateItemHeight = (item: ListItem): number => (item.kind === "section" ? 40 : 54);

/** How many lines past each edge of the visible part stay drawn, so a fast scroll shows no gap. */
const OVERSCAN = 8;

/** Returns the days' headings and rows as one list, in the order they are drawn. */
const flattenSections = (sections: ReadonlyArray<EventDaySection>): ReadonlyArray<ListItem> =>
  sections.flatMap((section) => [
    { kind: "section" as const, key: `section:${section.key}`, section },
    ...section.events.map((event) => ({
      kind: "row" as const,
      key: String(event.id),
      event,
    })),
  ]);

/**
 * Renders the list of `sections`, each day under its heading, with the row of
 * `selectedId` selected. A click on a row calls `onSelect` with its event's
 * id. Each row's handlings are worked out as of `now` in `timezone`.
 *
 * - `onNearEnd` is called while the last rows are drawn, so the listing
 *   reads its next page before the user reaches the end.
 * - `empty` shows in place of the rows when there are none, and `foot` shows
 *   under the rows, inside the scrolling list.
 *
 * Only the rows in view, and a few past each edge, are drawn, so a list of
 * thousands of events costs as little as a short one. The selected row is
 * always drawn, so it keeps its place in the tab order while it is scrolled
 * out of view.
 *
 * When the selection moves, the list scrolls the new row into view. When a
 * row had the focus, as when `J` and `K` move the selection, or when
 * `focusSelectedRow` asks for it, the focus moves to the new row, so the
 * next key acts from there.
 */
export const EverythingList = memo(function EverythingList({
  sections,
  plugins,
  selectedId,
  now,
  timezone,
  focusSelectedRow,
  empty,
  foot,
  onSelect,
  onNearEnd,
  onFocusedSelectedRow,
}: {
  readonly sections: ReadonlyArray<EventDaySection>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly selectedId: number | null;
  readonly now: Date;
  readonly timezone: string;
  /** Asks the list to put the focus on the selected row, as `J` and `K` do from the pane. */
  readonly focusSelectedRow: boolean;
  readonly empty: ReactNode;
  readonly foot: ReactNode;
  readonly onSelect: (eventId: number) => void;
  readonly onNearEnd: () => void;
  /** Called once the list has put the focus on the selected row that `focusSelectedRow` asked for. */
  readonly onFocusedSelectedRow: () => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => flattenSections(sections), [sections]);
  const selectedKey = selectedId === null ? null : String(selectedId);
  const selectedIndex = useMemo(
    () => items.findIndex((item) => item.key === selectedKey),
    [items, selectedKey],
  );

  // The React Compiler leaves this component alone, because it cannot see
  // into the virtualizer (see below), so these callbacks are memoized by
  // hand: the virtualizer measures again whenever `getItemKey` changes.
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = defaultRangeExtractor(range);
      if (selectedIndex < 0 || indexes.includes(selectedIndex)) return indexes;
      return [...indexes, selectedIndex].sort((a, b) => a - b);
    },
    [selectedIndex],
  );
  const getItemKey = useCallback((index: number) => items[index]!.key, [items]);
  const estimateSize = useCallback((index: number) => estimateItemHeight(items[index]!), [items]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: OVERSCAN,
  });

  useEffect(() => {
    if (selectedIndex < 0) return;
    const scroll = scrollRef.current!;
    const focused = document.activeElement;
    virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    const focusInList = focused instanceof HTMLElement && scroll.contains(focused);
    if (!focusInList && !focusSelectedRow) return;
    scroll.querySelector<HTMLElement>(`[data-event-id="${selectedKey!}"]`)?.focus();
    if (focusSelectedRow) onFocusedSelectedRow();
  }, [virtualizer, selectedIndex, selectedKey, focusSelectedRow, onFocusedSelectedRow]);

  const virtualItems = virtualizer.getVirtualItems();
  const lastDrawn = virtualItems.at(-1)?.index;
  useEffect(() => {
    if (lastDrawn !== undefined && lastDrawn >= items.length - 1 - OVERSCAN) onNearEnd();
  }, [lastDrawn, items.length, onNearEnd]);

  // The drawn lines in list order. Before each run of lines that is not
  // drawn, an empty spacer takes up the run's height.
  const drawn: JSX.Element[] = [];
  let end = 0;
  for (const { index, key, start, size } of virtualItems) {
    if (start > end) drawn.push(<div key={`gap:${key}`} style={{ height: start - end }} />);
    const item = items[index]!;
    drawn.push(
      item.kind === "section" ? (
        <h2 key={key} className="section-h asks-sec">
          {item.section.label}
        </h2>
      ) : (
        <EventRow
          key={key}
          event={item.event}
          plugins={plugins}
          selected={item.event.id === selectedId}
          now={now}
          timezone={timezone}
          onSelect={onSelect}
        />
      ),
    );
    end = start + size;
  }

  return (
    <div ref={scrollRef} className="asks-scroll">
      {items.length === 0 ? (
        empty
      ) : (
        <div
          className="asks-rows asks-rows--quiet"
          style={{ minHeight: virtualizer.getTotalSize() }}
        >
          {drawn}
        </div>
      )}
      {foot}
    </div>
  );
});

/**
 * Renders one event's row: its system's mark, its title, the line under it,
 * and at its end the clock time it was received. The line is the author, then
 * the first two handlings as the pane's "What came of it" lists them, then
 * "+N" for the rest.
 */
const EventRow = memo(function EventRow({
  event,
  plugins,
  selected,
  now,
  timezone,
  onSelect,
}: {
  readonly event: EventWithFacts;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly selected: boolean;
  readonly now: Date;
  readonly timezone: string;
  readonly onSelect: (eventId: number) => void;
}): JSX.Element {
  const { shown, more } = cutHandlingLabels(buildHandlingLabels(event, now, timezone));
  const system = describeEventSystem(event, plugins);
  return (
    <div className="ask-item">
      <button
        type="button"
        className={selected ? "ask-row is-on" : "ask-row"}
        data-event-id={event.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => {
          onSelect(event.id);
        }}
      >
        <span className="ask-mark">
          <SourceMark pluginId={system.pluginId} plugins={plugins} size={16} />
        </span>
        <span className="ask-text">
          <span className={event.title === null ? "ask-title mono" : "ask-title"}>
            {describeEventTitle(event)}
          </span>
          <span className="ask-sub">
            {event.author !== null && `${event.author} · `}
            {shown.map((label, index) => (
              <Fragment key={label.key}>
                {index > 0 && " · "}
                <span className="ev-stamp">{label.lead}</span>
                {label.detail !== null && ` · ${label.detail}`}
              </Fragment>
            ))}
            {more > 0 && (
              <>
                {" · "}
                <span className="ev-more">{`+${String(more)}`}</span>
              </>
            )}
          </span>
        </span>
        <span className="ask-end">
          <time className="ask-age" dateTime={event.receivedAt}>
            {formatClock(new Date(event.receivedAt), timezone)}
          </time>
        </span>
      </button>
    </div>
  );
});
