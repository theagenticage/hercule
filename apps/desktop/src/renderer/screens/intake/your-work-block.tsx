/**
 * The blocks of Your work in a signal's pane: one per Task the signal is
 * about, under the signal's blocks (spec 17 §The pane). Your work is not one
 * of the signal's blocks (spec 10 §9.5), so it is drawn apart from them.
 */
import type { JSX } from "react";
import type { YourWorkItem } from "@hercule/client-core";
import { buildLook, Face } from "../../faces";
import { TasksIcon } from "../../icons/tasks";

/**
 * Renders the Tasks of Your work, `items`, one block each, or nothing when
 * there are none. Each tracked Task calls `onShowInTracking` with its id when
 * the user asks to see its row.
 */
export function YourWorkBlocks({
  items,
  onShowInTracking,
}: {
  readonly items: ReadonlyArray<YourWorkItem>;
  readonly onShowInTracking: (taskId: string) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="ad-blocks ad-blocks--work">
      {items.map((item) => (
        <YourWorkBlock key={item.taskId} item={item} onShowInTracking={onShowInTracking} />
      ))}
    </div>
  );
}

/**
 * Renders one Task of Your work as a block.
 *
 * - A Task that is a row of Tracking leads with the face of its agent, then
 *   "Your work", the Task's title, and "In Tracking" with the state of its
 *   row, in bold when the row waits on the user. "Show in Tracking" calls
 *   `onShowInTracking` with the Task's id, to open Tracking on that row.
 * - Any other open Task leads with the Tasks icon, and ends with its status.
 *   It has no button, because there is no row to show.
 */
function YourWorkBlock({
  item,
  onShowInTracking,
}: {
  readonly item: YourWorkItem;
  readonly onShowInTracking: (taskId: string) => void;
}): JSX.Element {
  if (item.kind === "untracked") {
    return (
      <div className="b-work">
        <span className="b-work-mark">
          <TasksIcon size={16} />
        </span>
        <span className="b-work-text">
          <span className="b-work-label">Your work</span>
          <b>{item.title}</b>
          <span>{item.statusWord}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="b-work">
      <Face look={buildLook(item.faceSeed)} pose={item.pose} size={28} />
      <span className="b-work-text">
        <span className="b-work-label">Your work</span>
        <b>{item.title}</b>
        <span>In Tracking · {item.waitsOnYou ? <b>{item.stateWord}</b> : item.stateWord}</span>
      </span>
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => {
          onShowInTracking(item.taskId);
        }}
      >
        Show in Tracking
      </button>
    </div>
  );
}
