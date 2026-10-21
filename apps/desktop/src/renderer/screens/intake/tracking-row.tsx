/**
 * One row of Tracking, the place in Intake where the user follows the work
 * they handed to agents (spec 17 §Tracking).
 */
import { memo, useId, useLayoutEffect, useRef, type JSX } from "react";
import { decideTrackingStatePose, type TrackingState } from "@hercule/client-core";
import { buildHueStyle, buildLook, Face } from "../../faces";
import { CheckIcon } from "../../icons/check";
import { AgeLabel } from "../age-label";
import "./tracking.css";

/**
 * What a row of Tracking draws, as plain values: the Task's title, the state
 * of its work, and the line under the title. Every field is a string, so a row
 * given the same facts again can be told from one given changed facts by
 * comparing its props one by one.
 */
export interface TrackingRowFacts {
  /** The Task's id. The row is found by it, and it is what a press on the row or on Mark done passes on. */
  readonly taskId: string;
  readonly title: string;
  readonly state: TrackingState;
  /** Whether the row has a Mark done control: no run of its Task is live and it waits on no Request (`canMarkTrackingRowDone`). */
  readonly canMarkDone: boolean;
  /**
   * The text the colleague's face that leads the row is drawn from: the id of
   * the workflow that has the work, or its name when the run has no workflow
   * (a workflow sent with the request). The same text always gives the same face.
   */
  readonly faceSeed: string;
  /** The workflow's name, which the line draws in the colleague's hue, or null on a line that says what waits. */
  readonly workflowName: string | null;
  /** What follows the workflow's name on the line, with its own separator: "failed · reason", "finished", "· stopped". With no workflow name it is the whole line. */
  readonly lineText: string;
  /** When the row entered its state, as an ISO time. The time at the row's end shows how long ago that was. */
  readonly since: string;
}

/**
 * Renders one row of Tracking: the face of the agent that has the work, in
 * its state's pose, then the title, and under it the workflow's name in its
 * colleague's hue and `lineText`. At the end is how long the row has been in
 * its state.
 *
 * - Needs you, Failed and Finished rows wait on the user. A Needs you or Failed
 *   row draws its line and time in marigold. A Finished row draws them in green
 *   and sits on a green wash. A Needs you row's line says what waits and has no
 *   workflow name.
 * - `selected` marks the open row. A press on the row calls `onOpen`.
 * - `onScreen` is whether the row is in view, which keeps its time current.
 * - `lastInGroup` marks the row that ends its group, which has no gap under it.
 *   Each row of opened Tracking carries its own gap, as Intake's rows do, so the
 *   virtual list knows each row's height without measuring it.
 * - A row with `canMarkDone` has a Mark done control beside it, which shows
 *   while the pointer is on the row or the keyboard's focus is on the control,
 *   as Intake's row controls do. It calls `onMarkDone`. A row whose Task has a
 *   run going, or that waits on a Request, has none, because marking it done
 *   could leave a run going.
 *
 * The row is one button, with its control beside it, so a screen reader reads
 * the title, the line and the time as one name. The props are the row's facts,
 * spread, and the row is memoized, so a list that is built again redraws only
 * the rows whose facts changed.
 *
 * When the element that holds the focus is removed from the row while the row
 * stays, as Mark done is when a re-run turns the row Working, the row's button
 * takes the focus. Otherwise the focus would drop to the page's body, where
 * none of Intake's keys reach. A row that goes itself hands the focus to what
 * holds the rows, and one that only moves keeps it.
 */
export const TrackingRowItem = memo(function TrackingRowItem({
  taskId,
  title,
  state,
  canMarkDone,
  faceSeed,
  workflowName,
  lineText,
  since,
  selected,
  onScreen,
  lastInGroup = false,
  onOpen,
  onMarkDone,
}: TrackingRowFacts & {
  readonly selected: boolean;
  readonly onScreen: boolean;
  readonly lastInGroup?: boolean;
  readonly onOpen: (taskId: string) => void;
  readonly onMarkDone: (taskId: string) => void;
}): JSX.Element {
  const ageId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  // The element of the row that has the focus, until it loses it to something else.
  const focusedRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const focused = focusedRef.current;
    if (focused === null || focused.isConnected) return;
    focusedRef.current = null;
    if (document.activeElement === document.body) {
      rowRef.current!.querySelector<HTMLElement>(".tr-run")?.focus({ preventScroll: true });
    }
  });
  // A row that goes while it holds the focus, such as one pushed out of folded Tracking, hands
  // the focus to what holds the rows: the sheet, or the list while Tracking is folded.
  useLayoutEffect(() => {
    const row = rowRef.current!;
    return () => {
      const holder = row.closest<HTMLElement>(".tr-tray.is-open, .asks-list");
      if (!row.contains(document.activeElement) || holder === null) return;
      queueMicrotask(() => {
        if (document.activeElement === document.body) holder.focus({ preventScroll: true });
      });
    };
  }, []);
  const look = buildLook(faceSeed);
  const classes = [
    "tr-run-item",
    state === "failed" || state === "needs-you" ? "is-you" : "",
    state === "finished" ? "is-finished" : "",
    selected ? "is-on" : "",
    lastInGroup ? "tr-run-item--last" : "",
  ];
  return (
    <div
      ref={rowRef}
      className={classes.filter((each) => each !== "").join(" ")}
      data-item-key={taskId}
      data-state={state}
      onFocus={(event) => {
        focusedRef.current = event.target;
      }}
      onBlur={(event) => {
        // A blur comes before the removal of a focused element too. The element is gone by
        // the microtask, which is how a removal differs from the focus moving on.
        const lost = event.target;
        queueMicrotask(() => {
          if (focusedRef.current === lost && lost.isConnected) focusedRef.current = null;
        });
      }}
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
        <Face look={look} pose={decideTrackingStatePose(state)} size={22} />
        <span className="tr-run-text">
          <span className="tr-run-title">{title}</span>
          {/* The separator and the line are one string, so the line is shaped as one run of text, as the drawing's is. */}
          <span className="tr-run-sub">
            {workflowName !== null && (
              <span className="tr-run-who" style={buildHueStyle(look.hue)}>
                {workflowName}
              </span>
            )}
            {workflowName === null ? lineText : ` ${lineText}`}
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
      {canMarkDone && (
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
