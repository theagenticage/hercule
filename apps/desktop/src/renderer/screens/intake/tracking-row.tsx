/**
 * One row of Tracking, the place in Intake where the user follows the work
 * they handed to agents (spec 17 §Tracking).
 */
import { memo, useId, type JSX } from "react";
import { canMarkTrackingStateDone, type TrackingState } from "@hercule/client-core";
import { buildHueStyle, buildLook, Face } from "../../faces";
import { CheckIcon } from "../../icons/check";
import { AgeLabel } from "../age-label";
import { TRACKING_STATE_LOOKS } from "./tracking-states";
import "./tracking.css";

/**
 * What a row of Tracking draws, as plain values: the Task's title, the state
 * of its work, and the line under the title.
 */
export interface TrackingRowFacts {
  /** The Task's id. The row is found by it, and it is what a press on the row or on Mark done passes on. */
  readonly taskId: string;
  readonly title: string;
  readonly state: TrackingState;
  /**
   * The text the colleague's face that leads the row is drawn from: the id of
   * the workflow that has the work, or its name when the run has no workflow
   * (a workflow sent with the request). The same text always gives the same face.
   */
  readonly faceSeed: string;
  /** The workflow's name, which the line draws in the colleague's hue. */
  readonly workflowName: string;
  /** What follows the workflow's name on the line, with its own separator: "failed · reason", "finished", "· stopped". */
  readonly lineText: string;
  /** When the row entered its state, as an ISO time. The time at the row's end shows how long ago that was. */
  readonly since: string;
  /** The ids of the signals the Task was handed off from. A handoff's flight lands on the row of the Task that names its signal. */
  readonly handoffSignalIds: ReadonlyArray<string>;
}

/**
 * Renders one row of Tracking: the face of the agent that has the work, in
 * its state's pose, then the title, and under it the workflow's name in its
 * colleague's hue and `lineText`. At the end is how long the row has been in
 * its state.
 *
 * - Failed and Finished rows wait on the user, so their line and time are
 *   marigold and green, and a Finished row sits on a green wash.
 * - `selected` marks the open row. A press on the row calls `onOpen`.
 * - `onScreen` is whether the row is in view, which keeps its time current.
 * - `lastInGroup` marks the row that ends its group, which has no gap under it.
 *   Each row of opened Tracking carries its own gap, as Intake's rows do, so the
 *   virtual list knows each row's height without measuring it.
 * - A Finished, Failed or Stopped row has a Mark done control beside it, which
 *   shows while the pointer is on the row or the keyboard's focus is on the
 *   control, as Intake's row controls do. It calls `onMarkDone`. A Working row
 *   has none, because marking it done would leave its run going.
 *
 * The row is one button, with its control beside it, so a screen reader reads
 * the title, the line and the time as one name.
 */
export const TrackingRowItem = memo(function TrackingRowItem({
  facts,
  selected,
  onScreen,
  lastInGroup = false,
  onOpen,
  onMarkDone,
}: {
  readonly facts: TrackingRowFacts;
  readonly selected: boolean;
  readonly onScreen: boolean;
  readonly lastInGroup?: boolean;
  readonly onOpen: (taskId: string) => void;
  readonly onMarkDone: (taskId: string) => void;
}): JSX.Element {
  const { taskId, title, state, faceSeed, workflowName, lineText, since } = facts;
  const ageId = useId();
  const look = buildLook(faceSeed);
  const classes = [
    "tr-run-item",
    state === "failed" ? "is-you" : "",
    state === "finished" ? "is-finished" : "",
    selected ? "is-on" : "",
    lastInGroup ? "tr-run-item--last" : "",
  ];
  return (
    <div
      className={classes.filter((each) => each !== "").join(" ")}
      data-item-key={taskId}
      data-state={state}
    >
      <button
        type="button"
        className="tr-run"
        data-task-id={taskId}
        aria-current={selected ? "true" : undefined}
        aria-describedby={ageId}
        onClick={() => {
          onOpen(taskId);
        }}
      >
        <Face look={look} pose={TRACKING_STATE_LOOKS[state].pose} size={22} />
        <span className="tr-run-text">
          <span className="tr-run-title">{title}</span>
          {/* The separator and the line are one string, so the line is shaped as one run of text, as the drawing's is. */}
          <span className="tr-run-sub">
            <span className="tr-run-who" style={buildHueStyle(look.hue)}>
              {workflowName}
            </span>
            {` ${lineText}`}
          </span>
        </span>
        <AgeLabel
          at={since}
          onScreen={onScreen}
          descriptionId={ageId}
          as="span"
          className="tr-run-end"
        />
      </button>
      {canMarkTrackingStateDone(state) && (
        <span className="ask-acts">
          <button
            type="button"
            className="ask-act"
            aria-label="Mark done"
            title="Mark done · Takes it off Tracking. Nothing is sent"
            onClick={() => {
              onMarkDone(taskId);
            }}
          >
            <CheckIcon size={14} />
          </button>
        </span>
      )}
    </div>
  );
});
