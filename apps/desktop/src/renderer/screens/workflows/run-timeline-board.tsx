/**
 * PROTOTYPE. The Runs tab's timeline: one day of a workflow's runs, drawn as
 * bars across the day's hours, beside the list that shows the same runs as
 * rows. Its parts:
 *
 * - the switch between the list and the timeline, and the day stepper, in
 *   the tab bar's row;
 * - the axis, in the sticky band where the list's column heads are;
 * - the board: the hour lines, the now line, the bars, and the fires still
 *   to come today.
 *
 * Every part takes values and callbacks and reads nothing. A place across
 * the day is drawn as a percentage of the board's width, so the axis and the
 * board line up as long as both are as wide as the page's content.
 */
import { useState, type JSX } from "react";
import { ChevronLeftIcon } from "../../icons/chevron-left";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { Mark } from "../../marks/mark";
import type { TimelineAxis, TimelineBar, TimelineFire } from "./run-timeline";
import { describeRunRow } from "./workflow-detail-rows";
import "./run-timeline.css";

declare module "react" {
  interface CSSProperties {
    /** Where a line, a label or a bar starts across the day, as a percentage. */
    "--rt-at"?: string;
    /** How much of the day a bar covers, as a percentage. */
    "--rt-span"?: string;
    /** The track a bar is drawn on, 0 for the top one. */
    "--rt-track"?: string;
    /** How many tracks the board is tall. */
    "--rt-tracks"?: string;
    /** A bar's place in the order the bars arrive in, 0 for the first. */
    "--rt-order"?: string;
  }
}

/** The two ways the Runs tab shows a workflow's runs. */
export type RunsView = "list" | "timeline";

/** Returns a place across the day, from 0 to 1, as a CSS percentage. */
const formatPlace = (place: number): string => `${String(place * 100)}%`;

/** Renders the switch between the Runs tab's list and its timeline. */
export function RunsViewPicker({
  view,
  onPickView,
}: {
  readonly view: RunsView;
  readonly onPickView: (view: RunsView) => void;
}): JSX.Element {
  return (
    <div className="seg" role="group" aria-label="Show the runs as">
      <button type="button" aria-pressed={view === "list"} onClick={() => onPickView("list")}>
        List
      </button>
      <button
        type="button"
        aria-pressed={view === "timeline"}
        onClick={() => onPickView("timeline")}
      >
        Timeline
      </button>
    </div>
  );
}

/**
 * Renders the timeline's day stepper: the day it draws between a step back
 * and a step on. A day before today offers a way back to today, as the Mac's
 * Calendar does, and has no step past today.
 */
export function TimelineDayStepper({
  dayText,
  isToday,
  onStepBack,
  onStepOn,
  onShowToday,
}: {
  readonly dayText: string;
  readonly isToday: boolean;
  readonly onStepBack: () => void;
  readonly onStepOn: () => void;
  readonly onShowToday: () => void;
}): JSX.Element {
  return (
    <div className="rt-stepper" role="group" aria-label="Day">
      {isToday ? null : (
        <button type="button" className="btn btn--quiet btn--sm" onClick={onShowToday}>
          Today
        </button>
      )}
      <button
        type="button"
        className="icon-btn"
        aria-label="Show the day before"
        onClick={onStepBack}
      >
        <ChevronLeftIcon size={14} />
      </button>
      <span className="rt-day" aria-live="polite">
        {dayText}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Show the day after"
        disabled={isToday}
        onClick={onStepOn}
      >
        <ChevronRightIcon size={14} />
      </button>
    </div>
  );
}

/**
 * Renders the timeline's axis: a label at every hour line that has one, and
 * the time now in a pill over its line. A narrow page labels only every
 * third hour (run-timeline.css).
 */
export function TimelineAxisRow({ axis }: { readonly axis: TimelineAxis }): JSX.Element {
  // The axis repeats what the bars' labels say in words.
  return (
    <div className="rt-axis" aria-hidden="true">
      {axis.hours.map((hour) =>
        hour.label === undefined ? null : (
          <span
            key={hour.at}
            className={hour.isMajor ? "rt-tick is-major" : "rt-tick"}
            style={{ "--rt-at": formatPlace(hour.at) }}
          >
            {hour.label}
          </span>
        ),
      )}
      {axis.now === undefined ? null : (
        <b className="rt-now-pill" style={{ "--rt-at": formatPlace(axis.now.at) }}>
          {axis.now.text}
        </b>
      )}
    </div>
  );
}

/**
 * Renders the board of one day: its hour lines, the now line, a bar for each
 * run, and a tick for each fire still to come. Picking a bar opens its run's
 * page. A day with no runs says `emptyText`.
 */
export function TimelineBoard({
  label,
  axis,
  bars,
  trackCount,
  fires,
  onOpenRun,
  emptyText,
}: {
  readonly label: string;
  readonly axis: TimelineAxis;
  readonly bars: ReadonlyArray<TimelineBar>;
  readonly trackCount: number;
  readonly fires: ReadonlyArray<TimelineFire>;
  readonly onOpenRun: (runId: string) => void;
  readonly emptyText: string;
}): JSX.Element {
  const lateRunIds = useLateRunIds(bars);
  return (
    <div
      className="rt-board"
      role="group"
      aria-label={label}
      style={{ "--rt-tracks": String(Math.max(trackCount, 1)) }}
    >
      {axis.hours.map((hour) => (
        <i
          key={hour.at}
          className={hour.isMajor ? "rt-line is-major" : "rt-line"}
          style={{ "--rt-at": formatPlace(hour.at) }}
        />
      ))}
      {axis.now === undefined ? null : (
        <i className="rt-now" style={{ "--rt-at": formatPlace(axis.now.at) }} />
      )}
      {fires.map((fire) => (
        <span
          key={fire.triggerId}
          className="rt-fire"
          title={`${fire.triggerId} starts a run at ${fire.text}`}
          style={{ "--rt-at": formatPlace(fire.at) }}
        >
          <span>{fire.text}</span>
        </span>
      ))}
      {bars.length === 0 ? <p className="rt-empty">{emptyText}</p> : null}
      {bars.map((bar, order) => (
        <RunBar
          key={bar.run.id}
          bar={bar}
          order={order}
          isLate={lateRunIds.has(bar.run.id)}
          onOpen={() => onOpenRun(bar.run.id)}
        />
      ))}
    </div>
  );
}

/**
 * Returns the ids of the runs whose bars arrived, or whose marks changed,
 * after the board was first drawn. A run stays in the set once it is in it.
 *
 * The board is drawn afresh for each day, so its first bars arrive because
 * the user opened the timeline or stepped to the day, and they arrive one
 * after another (run-timeline.css). A later bar arrives because a run
 * started or changed, which the user did not do, so it only pops in its mark.
 */
function useLateRunIds(bars: ReadonlyArray<TimelineBar>): ReadonlySet<string> {
  const [firstMarks] = useState(() => new Map(bars.map((bar) => [bar.run.id, bar.run.mark])));
  const [lateRunIds, setLateRunIds] = useState<ReadonlySet<string>>(new Set());
  const newlyLate = bars
    .filter((bar) => !lateRunIds.has(bar.run.id) && firstMarks.get(bar.run.id) !== bar.run.mark)
    .map((bar) => bar.run.id);
  if (newlyLate.length > 0) setLateRunIds(new Set([...lateRunIds, ...newlyLate]));
  return lateRunIds;
}

/**
 * Renders one run's bar, with its mark at the end. A bar cut at the day's
 * start or end has a square end there, and a chevron beside it that points
 * to the day the run went on into. `isLate` is whether the bar arrived or
 * changed after the board was first drawn. The mark is keyed by its state,
 * so a late bar pops in its mark again each time it changes.
 */
function RunBar({
  bar,
  order,
  isLate,
  onOpen,
}: {
  readonly bar: TimelineBar;
  readonly order: number;
  readonly isLate: boolean;
  readonly onOpen: () => void;
}): JSX.Element {
  const label = describeRunRow(bar.run);
  const className = [
    "rt-bar",
    `rt-bar--${bar.run.status.tone}`,
    bar.startsBefore ? "is-cut-start" : "",
    bar.endsAfter ? "is-cut-end" : "",
    isLate ? "is-late" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      onClick={onOpen}
      style={{
        "--rt-at": formatPlace(bar.from),
        "--rt-span": formatPlace(bar.to - bar.from),
        "--rt-track": String(bar.track),
        "--rt-order": String(order),
      }}
    >
      {bar.startsBefore ? (
        <span className="rt-cut rt-cut--start">
          <ChevronLeftIcon size={12} />
        </span>
      ) : null}
      <i className="rt-fill" />
      <Mark key={bar.run.mark} state={bar.run.mark} />
      {bar.endsAfter ? (
        <span className="rt-cut rt-cut--end">
          <ChevronRightIcon size={12} />
        </span>
      ) : null}
    </button>
  );
}
