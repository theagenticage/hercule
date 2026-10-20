/**
 * Opened Tracking, which covers Intake's whole list column (spec 17
 * §Tracking).
 */
import {
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useRef,
  type JSX,
  type ReactNode,
  type Ref,
} from "react";
import type { TrackingState } from "@hercule/client-core";
import { ChevronLeftIcon } from "../../icons/chevron-left";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { Mark } from "../../marks";
import { TrackingRowItem, type TrackingRowFacts } from "./tracking-row";
import { describeWaitingOnYou, TRACKING_STATE_LOOKS } from "./tracking-states";
import { useLineFade } from "./use-line-fade";
import { useRowMotion } from "./use-row-motion";
import "./tracking.css";

/** The rows of Tracking that are in one state, drawn under the state's mark and word. */
export interface TrackingSheetGroup {
  readonly state: TrackingState;
  readonly rows: ReadonlyArray<TrackingRowFacts>;
}

/** One drawn line of the sheet: a state's heading or one of its rows. */
type SheetItem =
  | { readonly kind: "heading"; readonly key: string; readonly state: TrackingState }
  | { readonly kind: "row"; readonly key: string; readonly facts: TrackingRowFacts };

/** Returns the sheet's headings and rows as one list in the order they are drawn, which the motion moves. */
const flattenGroups = (groups: ReadonlyArray<TrackingSheetGroup>): ReadonlyArray<SheetItem> =>
  groups.flatMap(({ state, rows }) => [
    { kind: "heading" as const, key: `section:${state}`, state },
    ...rows.map((facts) => ({ kind: "row" as const, key: facts.taskId, facts })),
  ]);

/** Returns `items` in groups again: each state's heading and the rows that follow it. */
const regroupItems = (items: ReadonlyArray<SheetItem>): ReadonlyArray<TrackingSheetGroup> =>
  items.reduce<TrackingSheetGroup[]>((groups, item) => {
    if (item.kind === "heading") return [...groups, { state: item.state, rows: [] }];
    const last = groups.at(-1)!;
    return [...groups.slice(0, -1), { ...last, rows: [...last.rows, item.facts] }];
  }, []);

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
 * The rows move as Intake's do when they change (`useRowMotion`), with the
 * gap closing over `--dur-3`, and a row whose state changed fades its line in
 * anew. `ref` is the sheet's element.
 *
 * The sheet takes the focus when it mounts, so Intake's keys keep working
 * after the press or the key that opened it. The keys move the selection, and
 * the focus follows it to the selected row while the focus is in the sheet.
 * When the row that had the focus leaves, the focus goes to the sheet instead
 * of to the page, where no key would reach Intake.
 *
 * `onRowsSeen` is called with the ids of the Tasks whose rows have come into
 * view in the scrolling rows, which one observer watches. The caller reads
 * for a row only once it is seen.
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
  ref,
  onRowsSeen,
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
  readonly ref?: Ref<HTMLElement>;
  readonly onRowsSeen?: (taskIds: ReadonlyArray<string>) => void;
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
  const drawnGroups = regroupItems(drawn);
  useLineFade(
    drawnGroups.flatMap((group) => group.rows),
    scrollRef,
  );
  // The rows drawn, which lag `groups` while a row that leaves is still drawn.
  const rowCount = drawnGroups.reduce((count, group) => count + group.rows.length, 0);

  useEffect(() => {
    sheetRef.current!.focus({ preventScroll: true });
  }, []);
  // One observer watches every row, and is made again when the rows change.
  const reportSeen = useEffectEvent((taskIds: ReadonlyArray<string>) => {
    onRowsSeen?.(taskIds);
  });
  const rowKey = drawnGroups.flatMap((group) => group.rows.map((row) => row.taskId)).join(" ");
  const watching = onRowsSeen !== undefined;
  useEffect(() => {
    if (!watching) return;
    const scroll = scrollRef.current!;
    const observer = new IntersectionObserver(
      (entries) => {
        const seen = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => (entry.target as HTMLElement).dataset.itemKey!);
        if (seen.length > 0) reportSeen(seen);
      },
      { root: scroll },
    );
    for (const row of scroll.querySelectorAll(".tr-run-item")) observer.observe(row);
    return () => {
      observer.disconnect();
    };
  }, [rowKey, watching]);
  useEffect(() => {
    if (selectedTaskId === null) return;
    const sheet = sheetRef.current!;
    const row = sheet.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(selectedTaskId)}"]`);
    if (row === null) return;
    row.scrollIntoView({ block: "nearest" });
    const focused = document.activeElement;
    if (focused === document.body || sheet.contains(focused)) row.focus({ preventScroll: true });
  }, [selectedTaskId]);
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
          {drawnGroups.map(({ state, rows }) => (
            <section key={state} aria-labelledby={`${id}-${state}`}>
              <h3
                className="section-h asks-sec tr-sec"
                id={`${id}-${state}`}
                data-item-key={`section:${state}`}
              >
                <Mark state={TRACKING_STATE_LOOKS[state].mark} size={14} />
                {TRACKING_STATE_LOOKS[state].word}
                <span className="count">{rows.length}</span>
              </h3>
              <div className="tr-runs">
                {rows.map((facts) => (
                  <TrackingRowItem
                    key={facts.taskId}
                    facts={facts}
                    selected={facts.taskId === selectedTaskId}
                    onOpen={onOpenRow}
                    onMarkDone={onMarkDone}
                  />
                ))}
              </div>
            </section>
          ))}
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
