/**
 * The block of Your work in a signal's pane: one line per Task the signal is
 * about, under the signal's blocks (spec 17 §The pane).
 */
import type { JSX } from "react";
import type { YourWorkItem } from "@hercule/client-core";
import { buildLook, Face } from "../../faces";
import { TasksIcon } from "../../icons/tasks";
import { TRACKING_STATE_LOOKS } from "./tracking-states";

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
export function YourWorkBlock({
  item,
  onShowInTracking,
}: {
  readonly item: YourWorkItem;
  readonly onShowInTracking: (taskId: string) => void;
}): JSX.Element {
  if (item.kind === "untracked") {
    return (
      <div className="b-work">
        <TasksIcon size={16} />
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
      <Face
        look={buildLook(item.faceSeed)}
        pose={item.settledPose ?? TRACKING_STATE_LOOKS[item.state].pose}
        size={28}
      />
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
