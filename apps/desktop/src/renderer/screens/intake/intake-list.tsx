/**
 * Intake's list: the signals on To do in their sections, virtualized, one
 * line per row (spec 17 §The list on To do).
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, type JSX } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { Signal } from "@hercule/contract";
import {
  describeSignalRow,
  isBackFromSnooze,
  parseSignalPluginId,
  type IntakeSection,
  type PluginIdentity,
} from "@hercule/client-core";
import { AlarmIcon } from "../../icons/alarm";
import { AgeLabel } from "../age-label";
import { SourceMark } from "./source-mark";

/** One drawn line of the list: a section's heading or a signal's row. */
type ListItem =
  | { readonly kind: "section"; readonly key: string; readonly section: IntakeSection }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly signal: Signal;
      /** Whether the row ends its section, so no gap follows it. */
      readonly lastInSection: boolean;
    };

/**
 * Returns the height of a line, in pixels: a heading is 40px, and a row is
 * 52px with the 2px gap under it, except the last row of a section, which
 * has no gap. The list never measures a row. A row is one line, so these
 * heights are exact, except that the "Back" mark's icon makes its row 2px
 * taller. Drawn rows take their own height, so that error reaches only the
 * spacers that stand in for undrawn rows.
 */
const estimateItemHeight = (item: ListItem): number =>
  item.kind === "section" ? 40 : item.lastInSection ? 52 : 54;

/** How many lines past each edge of the visible part stay drawn, so a fast scroll shows no gap. */
const OVERSCAN = 8;

/** Returns the sections' headings and rows as one list, in the order they are drawn. */
const flattenSections = (sections: ReadonlyArray<IntakeSection>): ReadonlyArray<ListItem> =>
  sections.flatMap((section) => [
    { kind: "section" as const, key: `section:${section.key}`, section },
    ...section.signals.map((signal, index) => ({
      kind: "row" as const,
      key: signal.id,
      signal,
      lastInSection: index === section.signals.length - 1,
    })),
  ]);

/**
 * Renders the list of `sections`, with the row of `selectedId` selected.
 * A click on a row calls `onSelect` with its signal's id.
 *
 * Only the rows in view, and a few past each edge, are drawn, so a list of
 * hundreds of signals costs as little as a short one. The selected row is
 * always drawn, so it keeps its place in the tab order while it is scrolled
 * out of view.
 *
 * When the selection moves, the list scrolls the new row into view. When a
 * row had the focus, as when `J` and `K` move the selection, or when
 * `focusSelectedRow` asks for it, the focus moves to the new row, so the
 * next key acts from there.
 */
export const IntakeList = memo(function IntakeList({
  sections,
  plugins,
  selectedId,
  focusSelectedRow,
  onSelect,
  onFocusedSelectedRow,
}: {
  readonly sections: ReadonlyArray<IntakeSection>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly selectedId: string | null;
  /** Asks the list to put the focus on the selected row, as `J` and `K` do from the pane. */
  readonly focusSelectedRow: boolean;
  readonly onSelect: (signalId: string) => void;
  /** Called once the list has put the focus on the selected row that `focusSelectedRow` asked for. */
  readonly onFocusedSelectedRow: () => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const items = useMemo(() => flattenSections(sections), [sections]);
  const selectedIndex = useMemo(
    () => items.findIndex((item) => item.key === selectedId),
    [items, selectedId],
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

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this component alone. The callbacks above and the memoized rows keep the renders cheap instead.
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
    scroll.querySelector<HTMLElement>(`[data-signal-id="${CSS.escape(selectedId!)}"]`)?.focus();
    if (focusSelectedRow) onFocusedSelectedRow();
  }, [virtualizer, selectedIndex, selectedId, focusSelectedRow, onFocusedSelectedRow]);

  // The drawn lines in list order. Before each run of lines that is not
  // drawn, an empty spacer takes up the run's height.
  const drawn: JSX.Element[] = [];
  const visible = virtualizer.range;
  let end = 0;
  for (const { index, key, start, size } of virtualizer.getVirtualItems()) {
    if (start > end) drawn.push(<div key={`gap:${key}`} style={{ height: start - end }} />);
    const item = items[index]!;
    const onScreen = visible !== null && index >= visible.startIndex && index <= visible.endIndex;
    drawn.push(
      item.kind === "section" ? (
        <SectionHeading key={key} section={item.section} />
      ) : (
        <SignalRow
          key={key}
          signal={item.signal}
          lastInSection={item.lastInSection}
          plugins={plugins}
          selected={item.signal.id === selectedId}
          onScreen={onScreen}
          ageId={`${listId}-${item.signal.id}-age`}
          onSelect={onSelect}
        />
      ),
    );
    end = start + size;
  }

  return (
    <div ref={scrollRef} className="asks-scroll">
      {items.length === 0 ? (
        <p className="asks-empty">Nothing on your list.</p>
      ) : (
        <div className="asks-rows" style={{ height: virtualizer.getTotalSize() }}>
          {drawn}
        </div>
      )}
    </div>
  );
});

/** Renders a section's heading: Now with its red dot, or Signals with its count. */
function SectionHeading({ section }: { readonly section: IntakeSection }): JSX.Element {
  return (
    <h2 className="section-h asks-sec">
      {section.key === "now" && <span className="dot dot--fail" />}
      {section.label}
      {section.key === "signals" && <span className="count">{section.signals.length}</span>}
    </h2>
  );
}

/**
 * Renders one signal's row: its source's mark, its title, then "Back" when
 * its snooze ran out, who asks, the kind and where, and at its end the age
 * and the marigold mark of a `high` signal.
 */
const SignalRow = memo(function SignalRow({
  signal,
  lastInSection,
  plugins,
  selected,
  onScreen,
  ageId,
  onSelect,
}: {
  readonly signal: Signal;
  readonly lastInSection: boolean;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly selected: boolean;
  readonly onScreen: boolean;
  readonly ageId: string;
  readonly onSelect: (signalId: string) => void;
}): JSX.Element {
  return (
    <div className={lastInSection ? "ask-item ask-item--last" : "ask-item"}>
      <button
        type="button"
        className={selected ? "ask-row is-on" : "ask-row"}
        data-signal-id={signal.id}
        aria-current={selected ? "true" : undefined}
        aria-describedby={ageId}
        onClick={() => {
          onSelect(signal.id);
        }}
      >
        <span className="ask-mark">
          <SourceMark pluginId={parseSignalPluginId(signal.kind)} plugins={plugins} size={16} />
        </span>
        <span className="ask-text">
          <span className="ask-title">{signal.title}</span>
          {/* The separator after "Back" and the row's line are one string, so
              the line is shaped as one run of text, as the drawing's is. */}
          <span className="ask-sub">
            {isBackFromSnooze(signal) ? (
              <>
                <span className="ask-back">
                  <AlarmIcon size={12} />
                  Back
                </span>
                {` · ${describeSignalRow(signal, plugins)}`}
              </>
            ) : (
              describeSignalRow(signal, plugins)
            )}
          </span>
        </span>
        <span className="ask-end">
          <AgeLabel
            at={signal.createdAt}
            onScreen={onScreen}
            descriptionId={ageId}
            as="span"
            className="ask-age"
          />
          {signal.priority === "high" && (
            <span className="ask-high" role="img" aria-label="High priority" />
          )}
        </span>
      </button>
    </div>
  );
});
