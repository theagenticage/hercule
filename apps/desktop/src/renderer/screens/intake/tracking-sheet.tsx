/**
 * Opened Tracking, which covers Intake's whole list column (spec 17
 * §Tracking).
 */
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type ReactNode,
  type Ref,
} from "react";
import { nameTrackingState, type TrackingState } from "@hercule/client-core";
import { ChevronLeftIcon } from "../../icons/chevron-left";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { Mark } from "../../marks";
import { TrackingRowItem, type TrackingRowFacts } from "./tracking-row";
import { describeWaitingOnYou, TRACKING_STATE_LOOKS } from "./tracking-states";
import { useLineFade } from "./use-line-fade";
import { useRowMotion } from "./use-row-motion";
import { useVirtualLines } from "./use-virtual-lines";
import "./tracking.css";

/** The rows of Tracking that are in one state, drawn under the state's mark and word. */
export interface TrackingSheetGroup {
  readonly state: TrackingState;
  readonly rows: ReadonlyArray<TrackingRowFacts>;
}

/** One line of the sheet: a state's heading, or one of its rows. */
type SheetItem =
  | {
      readonly kind: "heading";
      readonly key: string;
      readonly state: TrackingState;
      readonly count: number;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly facts: TrackingRowFacts;
      readonly lastInGroup: boolean;
    };

/** Returns the sheet's headings and rows as one flat list in the order they are drawn, which the motion and the virtual list move. */
const flattenGroups = (groups: ReadonlyArray<TrackingSheetGroup>): ReadonlyArray<SheetItem> =>
  groups.flatMap(({ state, rows }) => [
    { kind: "heading" as const, key: `section:${state}`, state, count: rows.length },
    ...rows.map((facts, index) => ({
      kind: "row" as const,
      key: facts.taskId,
      facts,
      lastInGroup: index === rows.length - 1,
    })),
  ]);

/**
 * Returns the height of a line in pixels, as the stylesheet fixes it: a
 * heading is 40px, and a row is 46px with the 2px gap under it, except the
 * last row of a group, which has no gap.
 */
const estimateLineHeight = (item: SheetItem): number =>
  item.kind === "heading" ? 40 : item.lastInGroup ? 46 : 48;

/**
 * Renders opened Tracking, over the whole list column under the bar's
 * hairline:
 *
 * - At the top, a "Intake" button that goes back, the title "Tracking" with
 *   `total`, and how many rows wait on the user (`waitingCount`).
 * - Then the `groups`, each under its state's mark, word and count. The
 *   groups come in Tracking's order, and no group is empty. `selectedTaskId`
 *   is the open row. With no group, a line says what Tracking is for.
 * - At the foot, the row that sums up the signals: "Signals" with
 *   `signalCount`, `signalMarks`, the marks of the sources the signals come
 *   from, and "Back to Intake".
 *
 * Both ways back call `onClose`. A press on a row calls `onOpenRow`, and on
 * its Mark done control `onMarkDone`. `dock` is drawn at the end of the
 * scrolling rows and sticks to the bottom of them: the toast of the last move,
 * which the list's own dock cannot show while this sheet covers the list.
 *
 * The headings and rows are one flat list, drawn through a virtual list as
 * Intake's is: only the lines in view and a few past its edges are drawn
 * (`useVirtualLines`). A row that changes state stays one element, which moves
 * to its new place under another heading. React puts the focus back on a
 * focused element it moves, as Chromium drops it at the move, so the row
 * keeps the focus. The rows move as Intake's do when
 * they change (`useRowMotion`), with the gap closing over `--dur-3`, and a row
 * whose state changed fades its line in anew. `ref` is the sheet's element.
 *
 * With `leaving` set, the sheet is on its way out, as it drops back over the
 * list: it takes no pointer and no focus, so the list under it is the one the
 * user works with.
 *
 * The sheet takes the focus when it mounts, so Intake's keys keep working
 * after the press or the key that opened it. The keys move the selection, and
 * the focus follows it to the selected row while the focus is in the sheet.
 * When the row that had the focus leaves, the focus goes to the sheet instead
 * of to the page, where no key would reach Intake.
 *
 * The component takes the place of the list column, so the column must be its
 * nearest positioned ancestor.
 */
export function TrackingSheet({
  total,
  waitingCount,
  groups,
  selectedTaskId,
  signalCount,
  signalMarks,
  dock,
  leaving = false,
  ref,
  onClose,
  onOpenRow,
  onMarkDone,
}: {
  readonly total: number;
  readonly waitingCount: number;
  readonly groups: ReadonlyArray<TrackingSheetGroup>;
  readonly selectedTaskId: string | null;
  readonly signalCount: number;
  readonly signalMarks: ReactNode;
  readonly dock?: ReactNode;
  readonly leaving?: boolean;
  readonly ref?: Ref<HTMLElement>;
  readonly onClose: () => void;
  readonly onOpenRow: (taskId: string) => void;
  readonly onMarkDone: (taskId: string) => void;
}): JSX.Element {
  const id = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ghostsRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => sheetRef.current!, []);
  const drawn = useRowMotion(flattenGroups(groups), "sheet", scrollRef, ghostsRef, {
    slide: "--dur-3",
  });
  // The row that holds the focus, which the virtual list keeps drawn, as it does the selected row.
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const { lines, totalSize, scrollToSelected } = useVirtualLines(
    drawn,
    scrollRef,
    estimateLineHeight,
    selectedTaskId,
    focusedTaskId,
  );
  useLineFade(
    drawn.flatMap((item) => (item.kind === "row" ? [item.facts] : [])),
    scrollRef,
  );
  // The rows drawn, which lag `groups` while a row that leaves is still drawn.
  const rowCount = drawn.filter((item) => item.kind === "row").length;

  // The sheet takes the focus when it mounts, and again when it turns active after it was
  // dropping: the list held the focus meanwhile, and Intake's keys must reach the sheet.
  useEffect(() => {
    if (!leaving) sheetRef.current!.focus({ preventScroll: true });
  }, [leaving]);
  useEffect(() => {
    if (selectedTaskId === null) return;
    scrollToSelected();
    const sheet = sheetRef.current!;
    // The virtual list always draws the selected row, so it is there to take the focus.
    const row = sheet.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(selectedTaskId)}"]`);
    if (row === null) return;
    // The focus may be on the page's body, in the sheet, or on the list, which holds it while the sheet is away.
    const focused = document.activeElement;
    if (focused === document.body || sheet.contains(focused) || focused === sheet.parentElement) {
      row.focus({ preventScroll: true });
    }
  }, [selectedTaskId, scrollToSelected]);
  useEffect(() => {
    if (document.activeElement === document.body) sheetRef.current!.focus({ preventScroll: true });
  }, [rowCount]);

  const waiting = describeWaitingOnYou(waitingCount);
  const waitingLine = waiting !== null && (
    <span className="tr-wait">
      <Mark state="waiting" size={12} />
      {waiting}
    </span>
  );
  return (
    <section
      ref={sheetRef}
      className="tr-tray is-open"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      inert={leaving}
      onFocus={(event: FocusEvent<HTMLElement>) => {
        setFocusedTaskId(
          event.target.closest<HTMLElement>(".tr-run-item")?.dataset.itemKey ?? null,
        );
      }}
      onBlur={(event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedTaskId(null);
      }}
    >
      <header className="tr-head">
        <button
          type="button"
          className="btn btn--quiet btn--sm tr-back"
          title="Back to Intake  T"
          onClick={onClose}
        >
          <ChevronLeftIcon size={14} />
          Intake
        </button>
        <h2 className="tr-title" id={`${id}-title`}>
          Tracking
          <span className="count">{total}</span>
        </h2>
        {waitingLine}
      </header>
      <div className="tr-body">
        <div ref={scrollRef} className="tr-scroll">
          {groups.length === 0 && (
            <p className="tr-empty">
              Hand a signal to an agent, and follow it here until you mark it done.
            </p>
          )}
          <div className="tr-rows" style={{ minHeight: totalSize }}>
            {lines.map((line) => {
              if (line.kind === "gap") {
                return <div key={line.key} style={{ height: line.height }} />;
              }
              const { item, onScreen } = line;
              return item.kind === "heading" ? (
                <h3 key={item.key} className="section-h asks-sec tr-sec" data-item-key={item.key}>
                  <Mark state={TRACKING_STATE_LOOKS[item.state].mark} size={14} />
                  {nameTrackingState(item.state)}
                  <span className="count">{item.count}</span>
                </h3>
              ) : (
                <TrackingRowItem
                  key={item.key}
                  facts={item.facts}
                  selected={item.key === selectedTaskId}
                  onScreen={onScreen}
                  lastInGroup={item.lastInGroup}
                  onOpen={onOpenRow}
                  onMarkDone={onMarkDone}
                />
              );
            })}
          </div>
          {dock}
        </div>
        {/* The copies of rows that leave fade here, over the rows. */}
        <div ref={ghostsRef} className="tr-ghosts" aria-hidden="true" inert />
      </div>
      <h2 className="tr-bar tr-bar--back">
        <button
          type="button"
          className="tr-bar-btn"
          title="Back to the signals  T"
          onClick={onClose}
        >
          <span className="tr-label">
            <span>Signals</span>
            <span className="count">{signalCount}</span>
          </span>
          <span className="tr-marks">{signalMarks}</span>
          <span className="tr-all">
            Back to Intake
            <span className="tr-chev">
              <ChevronRightIcon size={12} />
            </span>
          </span>
        </button>
      </h2>
    </section>
  );
}
