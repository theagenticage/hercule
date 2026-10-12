/**
 * Intake's list: the signals of one view, virtualized, two lines per row,
 * each cut with an ellipsis (spec 17 §The list on To do, §Views). Each row
 * carries its controls and its checkbox (spec 17 §Row controls and the bulk
 * bar).
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { DONE_ACTION_ID, type Signal, type SignalView } from "@hercule/contract";
import {
  decideSignalRowControls,
  describeDoneRowOutcome,
  describeSignalRow,
  formatClock,
  isBackFromSnooze,
  parsePluginId,
  SIGNAL_MOVE_LABELS,
  type IntakeSection,
  type PluginIdentity,
  type SignalMove,
  type SignalRaiserNames,
} from "@hercule/client-core";
import { assistantsQuery, workflowsQuery } from "../../app/queries";
import { AlarmIcon } from "../../icons/alarm";
import { CheckIcon } from "../../icons/check";
import { AgeLabel } from "../age-label";
import { describeMoveTitle, SIGNAL_MOVE_GLYPHS } from "./move-glyphs";
import { SNOOZE_ANCHOR } from "./snooze-menu";
import { SourceMark } from "./source-mark";
import { useRowMotion } from "./use-row-motion";

/** What a press on a row's own controls asks for: its checkbox, or one of its moves. */
export type SignalRowAction = "check" | SignalMove;

/** How the bulk highlight marks the checked rows while a bulk button has hover or focus. */
export interface BulkHighlight {
  /** The rows the button acts on, which get the accent rule. */
  readonly actedIds: ReadonlySet<string>;
  /** The checked rows the button leaves alone, which fade. */
  readonly keptIds: ReadonlySet<string>;
}

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
 * has no gap. The list never measures a row. A row's two lines never wrap,
 * so these heights are close but not exact: the text's line boxes make a row
 * a fraction of a pixel taller, and the "Back" mark's icon adds 2px more.
 * Drawn rows take their own height, and the rows' box only sets a minimum
 * height, so the error reaches only the spacers that stand in for undrawn
 * rows, never the foot under the list.
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
 * Renders the list of `sections` in `view`, with the row of `selectedId`
 * selected, each section under its heading: Now and Signals on To do, one
 * heading per day on Later and Done. Done's rows are quieter. A click on a row calls `onSelect` with its
 * signal's id, and a press on a row's checkbox or one of its moves calls
 * `onRowAction`. The list reads the workflows and the assistants, whose
 * names label the core signals they raised.
 *
 * - `checkedIds` are the checked rows, which wear the selected tint.
 * - `highlight` marks the checked rows while a bulk button has hover or
 *   focus, and while its move holds them for one beat.
 * - `menuRowId` is the row whose Snooze opened the snooze menu: its
 *   controls stay shown, and anchor the menu.
 * - `timezone` is the user's timezone setting, which the times on Later and
 *   Done rows are read in.
 * - `onNearEnd` is called while the last rows are drawn, so a paged view
 *   reads its next page before the user reaches the end.
 * - `empty` shows in place of the rows when there are none, and `foot`
 *   shows under the rows, inside the scrolling list.
 * - `scope` names the view and the tab shown. A change of rows within one
 *   scope moves, as `useRowMotion` describes; a change of scope draws the
 *   new rows at once.
 * - `onPointerEnter` and `onPointerLeave` are called as the pointer enters
 *   and leaves the rows, the foot included.
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
  view,
  scope,
  sections,
  plugins,
  selectedId,
  checkedIds,
  highlight,
  menuRowId,
  timezone,
  focusSelectedRow,
  empty,
  foot,
  onSelect,
  onRowAction,
  onNearEnd,
  onFocusedSelectedRow,
  onPointerEnter,
  onPointerLeave,
}: {
  readonly view: SignalView;
  readonly scope: string;
  readonly sections: ReadonlyArray<IntakeSection>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly selectedId: string | null;
  readonly checkedIds: ReadonlySet<string>;
  readonly highlight: BulkHighlight | null;
  readonly menuRowId: string | null;
  readonly timezone: string;
  /** Asks the list to put the focus on the selected row, as `J` and `K` do from the pane. */
  readonly focusSelectedRow: boolean;
  readonly empty: ReactNode;
  readonly foot: ReactNode;
  readonly onSelect: (signalId: string) => void;
  readonly onRowAction: (signalId: string, action: SignalRowAction) => void;
  readonly onNearEnd: () => void;
  /** Called once the list has put the focus on the selected row that `focusSelectedRow` asked for. */
  readonly onFocusedSelectedRow: () => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const ghostsRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: workflows } = useSuspenseQuery(workflowsQuery(client));
  const { data: assistants } = useSuspenseQuery(assistantsQuery(client));
  // Each row is memoized, so the names it reads keep their identity between renders.
  const raisers = useMemo<SignalRaiserNames>(
    () => ({ workflows, assistants }),
    [workflows, assistants],
  );
  const listedItems = useMemo(() => flattenSections(sections), [sections]);
  const items = useRowMotion(listedItems, scope, scrollRef, ghostsRef);
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

  const virtualItems = virtualizer.getVirtualItems();
  const lastDrawn = virtualItems.at(-1)?.index;
  useEffect(() => {
    if (lastDrawn !== undefined && lastDrawn >= items.length - 1 - OVERSCAN) onNearEnd();
  }, [lastDrawn, items.length, onNearEnd]);

  // The drawn lines in list order. Before each run of lines that is not
  // drawn, an empty spacer takes up the run's height.
  const drawn: JSX.Element[] = [];
  const visible = virtualizer.range;
  let end = 0;
  for (const { index, key, start, size } of virtualItems) {
    if (start > end) drawn.push(<div key={`gap:${key}`} style={{ height: start - end }} />);
    const item = items[index]!;
    const onScreen = visible !== null && index >= visible.startIndex && index <= visible.endIndex;
    drawn.push(
      item.kind === "section" ? (
        <SectionHeading key={key} itemKey={item.key} section={item.section} />
      ) : (
        <SignalRow
          key={key}
          view={view}
          signal={item.signal}
          lastInSection={item.lastInSection}
          plugins={plugins}
          raisers={raisers}
          selected={item.signal.id === selectedId}
          checked={checkedIds.has(item.signal.id)}
          marked={
            highlight?.actedIds.has(item.signal.id)
              ? "acted"
              : highlight?.keptIds.has(item.signal.id)
                ? "kept"
                : null
          }
          menuOpen={item.signal.id === menuRowId}
          timezone={timezone}
          onScreen={onScreen}
          ageId={`${listId}-${item.signal.id}-age`}
          onSelect={onSelect}
          onRowAction={onRowAction}
        />
      ),
    );
    end = start + size;
  }

  return (
    <div className="asks-frame" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <div ref={scrollRef} className="asks-scroll">
        {items.length === 0 ? (
          empty
        ) : (
          <div
            className={view === "done" ? "asks-rows asks-rows--quiet" : "asks-rows"}
            style={{ minHeight: virtualizer.getTotalSize() }}
          >
            {drawn}
          </div>
        )}
        {foot}
      </div>
      {/* The copies of rows that leave fade here, over the list. On Done the
          layer carries the quiet rows' class, so a copy keeps their look. */}
      <div
        ref={ghostsRef}
        className={view === "done" ? "asks-ghosts asks-rows--quiet" : "asks-ghosts"}
        aria-hidden="true"
        inert
      />
    </div>
  );
});

/**
 * Renders a section's heading: Now with its red dot, or any other section,
 * such as Signals or a day on Later and Done, with its count.
 */
function SectionHeading({
  itemKey,
  section,
}: {
  /** The heading's key in the list, which its motion finds it by. */
  readonly itemKey: string;
  readonly section: IntakeSection;
}): JSX.Element {
  const now = section.key === "now";
  return (
    <h2 className="section-h asks-sec" data-item-key={itemKey}>
      {now && <span className="dot dot--fail" />}
      {section.label}
      {!now && <span className="count">{section.signals.length}</span>}
    </h2>
  );
}

/** Returns the text of the Done action's describe line, without its marks, for a tooltip. */
const readDoneLineText = (signal: Signal): string | undefined =>
  signal.actions
    .find((action) => action.id === DONE_ACTION_ID)
    ?.describeLine?.map((part) => part.text)
    .join("");

/**
 * Renders one signal's row: its source's mark, its title, the line under
 * it, and at its end what the view shows of it:
 *
 * - To do: "Back" leads the line when its snooze ran out; the end holds the
 *   age and the marigold mark of a `high` signal.
 * - Later: the end holds the time it comes back, on the day its heading
 *   names.
 * - Done: the line is its outcome, and the end the time it was resolved.
 *
 * Beside the row sit its checkbox and its moves, as `decideSignalRowControls`
 * decides them. They show while the pointer is on the row, or while the
 * keyboard's focus is on one of them; selecting the row with `J` and `K`
 * does not show them, so the list stays quiet while the user reads it.
 */
const SignalRow = memo(function SignalRow({
  view,
  signal,
  lastInSection,
  plugins,
  raisers,
  selected,
  checked,
  marked,
  menuOpen,
  timezone,
  onScreen,
  ageId,
  onSelect,
  onRowAction,
}: {
  readonly view: SignalView;
  readonly signal: Signal;
  readonly lastInSection: boolean;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly raisers: SignalRaiserNames;
  readonly selected: boolean;
  readonly checked: boolean;
  /** How the bulk highlight marks the row, or `null` when it does not. */
  readonly marked: "acted" | "kept" | null;
  readonly menuOpen: boolean;
  readonly timezone: string;
  readonly onScreen: boolean;
  readonly ageId: string;
  readonly onSelect: (signalId: string) => void;
  readonly onRowAction: (signalId: string, action: SignalRowAction) => void;
}): JSX.Element {
  const controls = decideSignalRowControls(signal, view);
  const line = describeSignalRow(signal, plugins, raisers);
  const classes = [
    "ask-item",
    lastInSection ? "ask-item--last" : "",
    checked ? "is-checked" : "",
    menuOpen ? "has-menu" : "",
    marked === null ? "" : `is-${marked}`,
  ];
  return (
    <div className={classes.filter((each) => each !== "").join(" ")} data-item-key={signal.id}>
      {controls.checkable && (
        <button
          type="button"
          className="ask-check"
          role="checkbox"
          aria-checked={checked}
          aria-label={`Select ${signal.title}`}
          title="Select  X"
          onClick={() => {
            onRowAction(signal.id, "check");
          }}
        >
          <span className="ask-box">
            <CheckIcon size={12} />
          </span>
        </button>
      )}
      <button
        type="button"
        className={selected ? "ask-row is-on" : "ask-row"}
        data-signal-id={signal.id}
        aria-current={selected ? "true" : undefined}
        aria-describedby={view === "to-do" ? ageId : undefined}
        onClick={() => {
          onSelect(signal.id);
        }}
      >
        <span className="ask-mark">
          <SourceMark pluginId={parsePluginId(signal.kind)} plugins={plugins} size={16} />
        </span>
        <span className="ask-text">
          <span className="ask-title">{signal.title}</span>
          {/* The separator after "Back" and the row's line are one string, so
              the line is shaped as one run of text, as the drawing's is. */}
          <span className="ask-sub">
            {view === "done" ? (
              describeDoneRowOutcome(signal)
            ) : view === "to-do" && isBackFromSnooze(signal) ? (
              <>
                <span className="ask-back">
                  <AlarmIcon size={12} />
                  Back
                </span>
                {` · ${line}`}
              </>
            ) : (
              line
            )}
          </span>
        </span>
        <span className="ask-end">
          {view === "to-do" && (
            <>
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
            </>
          )}
          {view === "later" && signal.snooze !== undefined && (
            <span className="ask-until">
              <AlarmIcon size={12} />
              <time dateTime={signal.snooze.until}>
                {formatClock(new Date(signal.snooze.until), timezone)}
              </time>
            </span>
          )}
          {view === "done" && signal.resolution !== undefined && (
            <time className="ask-age" dateTime={signal.resolution.at}>
              {formatClock(new Date(signal.resolution.at), timezone)}
            </time>
          )}
        </span>
      </button>
      {controls.slots.length > 0 && (
        <span className="ask-acts" style={menuOpen ? { anchorName: SNOOZE_ANCHOR } : undefined}>
          {controls.slots.map((move, index) =>
            move === null ? (
              <span key={`slot:${String(index)}`} className="ask-act-slot" />
            ) : (
              <RowMove
                key={move}
                move={move}
                doneLine={readDoneLineText(signal)}
                menuOpen={menuOpen}
                onPress={() => {
                  onRowAction(signal.id, move);
                }}
              />
            ),
          )}
        </span>
      )}
    </div>
  );
});

/**
 * Renders one of a row's moves as an icon button. Its tooltip names the
 * move and its key; Done's names what Done does, its describe line
 * `doneLine`, then the key. Snooze opens the snooze menu, so it says
 * whether the menu is open.
 */
function RowMove({
  move,
  doneLine,
  menuOpen,
  onPress,
}: {
  readonly move: SignalMove;
  readonly doneLine: string | undefined;
  readonly menuOpen: boolean;
  readonly onPress: () => void;
}): JSX.Element {
  const opensMenu = move === "snooze";
  return (
    <button
      type="button"
      className="ask-act"
      aria-label={SIGNAL_MOVE_LABELS[move]}
      title={describeMoveTitle(move, move === "done" ? doneLine : undefined)}
      data-opens-snooze={opensMenu || undefined}
      aria-haspopup={opensMenu ? "menu" : undefined}
      aria-expanded={opensMenu ? menuOpen : undefined}
      onClick={onPress}
    >
      {SIGNAL_MOVE_GLYPHS[move].icon}
    </button>
  );
}
