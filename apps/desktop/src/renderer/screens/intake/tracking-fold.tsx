/**
 * Folded Tracking, which lies over the foot of Intake's list (spec 17
 * §Tracking).
 */
import type { JSX } from "react";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { Mark } from "../../marks";
import { TrackingRowItem, type TrackingRowFacts } from "./tracking-row";
import { describeWaitingOnYou } from "./tracking-states";
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
 * The component takes its place over the foot of the list, which must be its
 * nearest positioned ancestor. It does not make room for itself: the list
 * keeps that room under its last row.
 */
export function TrackingFold({
  total,
  waitingCount,
  rows,
  selectedTaskId,
  onOpen,
  onOpenRow,
  onMarkDone,
}: {
  readonly total: number;
  readonly waitingCount: number;
  readonly rows: ReadonlyArray<TrackingRowFacts>;
  readonly selectedTaskId: string | null;
  readonly onOpen: () => void;
  readonly onOpenRow: (taskId: string) => void;
  readonly onMarkDone: (taskId: string) => void;
}): JSX.Element {
  const waiting = describeWaitingOnYou(waitingCount);
  return (
    <section className="tr-tray" aria-label="Tracking">
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
      {total === 0 ? (
        <p className="tr-empty">
          Hand a signal to an agent, and follow it here until you mark it done.
        </p>
      ) : (
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
      )}
    </section>
  );
}
