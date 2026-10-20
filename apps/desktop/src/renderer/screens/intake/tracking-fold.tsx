/**
 * Folded Tracking, which lies over the foot of Intake's list (spec 17
 * §Tracking).
 */
import { useLayoutEffect, useRef, type JSX, type Ref } from "react";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { Mark } from "../../marks";
import type { HandoffFlights } from "./handoff-flight";
import { TrackingRowItem, type TrackingRowFacts } from "./tracking-row";
import { describeWaitingOnYou } from "./tracking-states";
import { useLineFade } from "./use-line-fade";
import { useRowMotion } from "./use-row-motion";
import "./tracking.css";

/**
 * Renders folded Tracking: its head, which reads "Tracking 7", how many rows
 * wait on the user, and "Show all", over the rows that changed state last.
 * A press on the head calls `onOpen`, which opens Tracking over the whole list.
 *
 * - `total` is how many rows Tracking holds. `rows` are the few folded
 *   Tracking shows, newest first, and `selectedTaskId` is the open row, if it
 *   is one of them.
 * - `waitingCount` is how many rows wait on the user.
 * - With no row at all, the head stands alone, over a line that says what
 *   Tracking is for.
 *
 * The rows move as Intake's do when they change (`useRowMotion`), with the
 * gap closing over `--dur-3`. `flights` lands a handoff's flight on the first
 * row once the row is drawn. `ref` is the element of the whole fold.
 *
 * The component takes its place over the foot of the list, which must be its
 * nearest positioned ancestor. It does not make room for itself: the list
 * keeps that room under its last row.
 */
export function TrackingFold({
  total,
  waitingCount,
  rows,
  selectedTaskId,
  flights,
  ref,
  onOpen,
  onOpenRow,
  onMarkDone,
}: {
  readonly total: number;
  readonly waitingCount: number;
  readonly rows: ReadonlyArray<TrackingRowFacts>;
  readonly selectedTaskId: string | null;
  readonly flights?: HandoffFlights;
  readonly ref?: Ref<HTMLElement>;
  readonly onOpen: () => void;
  readonly onOpenRow: (taskId: string) => void;
  readonly onMarkDone: (taskId: string) => void;
}): JSX.Element {
  const runsRef = useRef<HTMLDivElement>(null);
  const ghostsRef = useRef<HTMLDivElement>(null);
  const drawn = useRowMotion(
    rows.map((facts) => ({ key: facts.taskId, facts })),
    "folded",
    runsRef,
    ghostsRef,
    { slide: "--dur-3" },
  );
  const drawnRows = drawn.map((item) => item.facts);
  useLineFade(drawnRows, runsRef);
  // A handoff's flight lands on the first row, which names the signal it came from.
  useLayoutEffect(() => {
    flights?.land(drawnRows[0]?.handoffSignalIds ?? [], runsRef.current);
  });
  const waiting = describeWaitingOnYou(waitingCount);
  return (
    <section ref={ref} className="tr-tray" aria-label="Tracking">
      <h2 className="tr-bar">
        <button
          type="button"
          className="tr-bar-btn"
          title="Show all of Tracking  T"
          onClick={onOpen}
        >
          <span className="tr-label">
            <span>Tracking</span>
            {total > 0 && <span className="count">{total}</span>}
          </span>
          {waiting !== null && (
            <span className="tr-wait">
              <Mark state="waiting" size={12} />
              {waiting}
            </span>
          )}
          {total > 0 && (
            <span className="tr-all">
              Show all
              <span className="tr-chev tr-chev--up">
                <ChevronRightIcon size={12} />
              </span>
            </span>
          )}
        </button>
      </h2>
      {total === 0 && (
        <p className="tr-empty">
          Hand a signal to an agent, and follow it here until you mark it done.
        </p>
      )}
      {/* Drawn even with no row, so the motion has a place to bring the first one into. */}
      <div ref={runsRef} className="tr-runs">
        {drawnRows.map((facts) => (
          <TrackingRowItem
            key={facts.taskId}
            facts={facts}
            selected={facts.taskId === selectedTaskId}
            onOpen={onOpenRow}
            onMarkDone={onMarkDone}
          />
        ))}
        <div ref={ghostsRef} className="tr-ghosts" aria-hidden="true" inert />
      </div>
    </section>
  );
}
