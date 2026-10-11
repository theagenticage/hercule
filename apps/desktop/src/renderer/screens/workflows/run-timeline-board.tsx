/**
 * The Runs tab's timeline: one day of a workflow's runs, drawn as bars
 * across the day's hours (spec 17 §Workflows, "The open workflow"). Its
 * parts:
 *
 * - the switch between the list and the timeline, and the day stepper, at
 *   the tab bar's right end;
 * - the axis, in the sticky band where the list's column heads sit;
 * - the lanes: the hour lines, the now line, the bars, and the fires still
 *   to come today.
 *
 * Every part takes values and callbacks and reads nothing besides whether
 * its bars are on screen. A place across
 * the day is drawn as a percentage of the lanes' width, so the axis and the
 * lanes line up, being as wide as the pane's content.
 */
import { useRef, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import type {
  TimelineBar,
  TimelineFire,
  TimelineHour,
  TimelineNow,
} from "@hercule/client-core/run-timeline";
import {
  describeRunRow,
  formatRunDuration,
  type RunRow,
} from "@hercule/client-core/workflow-detail-rows";
import { isHourLabelCovered } from "@hercule/client-core/run-timeline";
import { hasRunMark } from "@hercule/client-core/run-marks";
import { formatPlace } from "./axis-place";
import { useListTime } from "./list-time";
import { ViewSwitch, type ViewChoice } from "./view-switch";
import { useDurationText } from "../../app/age-clock";
import { useIsOnScreen, useScreenWatcher, type ScreenWatcher } from "../../app/screen-watcher";
import { ChevronLeftIcon } from "../../icons/chevron-left";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { Mark } from "../../marks";
import "./run-timeline.css";

declare module "react" {
  interface CSSProperties {
    /** Where a line, a label or a bar starts across the day, as a percentage. */
    "--at"?: string;
    /** How much of the day a bar covers, as a percentage. */
    "--span"?: string;
    /** The track a bar is drawn on, 0 for the top one. */
    "--track"?: number;
    /** How many tracks the lanes are tall. */
    "--tracks"?: number;
  }
}

/** The two ways the Runs tab shows a workflow's runs. */
export type RunsView = "list" | "timeline";

const VIEWS: readonly [ViewChoice<RunsView>, ViewChoice<RunsView>] = [
  { view: "list", label: "List" },
  { view: "timeline", label: "Timeline" },
];

/** Renders the switch "Show the runs as" between the Runs tab's list and its timeline. */
export function RunsViewPicker({
  view,
  onPick,
}: {
  readonly view: RunsView;
  readonly onPick: (view: RunsView) => void;
}): JSX.Element {
  return <ViewSwitch label="Show the runs as" choices={VIEWS} view={view} onPick={onPick} />;
}

/**
 * Renders the timeline's day stepper: the day it draws, `dayText`, between a
 * step back, which cannot act on the oldest day the timeline shows
 * (`isOldest`), and a step on, which cannot act on today. Away from today, a
 * quiet "Today" button leads it, as in the Mac's Calendar.
 *
 * Focus never falls out of the stepper. Each step is `aria-disabled` rather
 * than `disabled` where it cannot act, so it keeps the focus when it steps
 * onto that day. The "Today" button is gone on today, as the book draws it, so a
 * click on it moves the focus to the step back first.
 */
export function TimelineDayStepper({
  dayText,
  isToday,
  isOldest,
  onStepBack,
  onStepOn,
  onShowToday,
}: {
  readonly dayText: string;
  readonly isToday: boolean;
  readonly isOldest: boolean;
  readonly onStepBack: () => void;
  readonly onStepOn: () => void;
  readonly onShowToday: () => void;
}): JSX.Element {
  const stepBackRef = useRef<HTMLButtonElement>(null);
  return (
    <span className="stepper">
      {isToday ? null : (
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          onClick={() => {
            stepBackRef.current!.focus();
            onShowToday();
          }}
        >
          Today
        </button>
      )}
      <button
        ref={stepBackRef}
        type="button"
        className="icon-btn"
        aria-label="Show the day before"
        title="Show the day before"
        aria-disabled={isOldest || undefined}
        data-unready={isOldest || undefined}
        onClick={() => {
          if (!isOldest) onStepBack();
        }}
      >
        <ChevronLeftIcon size={14} />
      </button>
      <span className="stepper-day" aria-live="polite">
        {dayText}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Show the day after"
        title="Show the day after"
        aria-disabled={isToday || undefined}
        data-unready={isToday || undefined}
        onClick={() => {
          if (!isToday) onStepOn();
        }}
      >
        <ChevronRightIcon size={14} />
      </button>
    </span>
  );
}

/**
 * Renders the timeline's axis: a label at each hour line, and the time now
 * in a pill. An hour whose label the pill would cover has none, and a pane
 * below 900px labels only every third hour (run-timeline.css). It is hidden
 * from assistive technology, because each bar's name says when its run
 * started.
 */
export function TimelineAxis({
  hours,
  now,
}: {
  readonly hours: ReadonlyArray<TimelineHour>;
  readonly now: TimelineNow | null;
}): JSX.Element {
  return (
    <div className="axis" aria-hidden="true">
      {hours.map((hour) =>
        isHourLabelCovered(hour, now) ? null : (
          <span
            key={hour.startsAt}
            className={hour.isMajor ? "axis-tick is-major" : "axis-tick"}
            style={{ "--at": formatPlace(hour.at) }}
          >
            {hour.label}
          </span>
        ),
      )}
      {now === null ? null : (
        <span className="axis-now" style={{ "--at": formatPlace(now.at) }}>
          {now.text}
        </span>
      )}
    </div>
  );
}

/**
 * Renders the lanes of one day: its hour lines, the now line, a bar for each
 * run, and a tick for each fire still to come. `label` names the day for
 * assistive technology, and a day with no runs shows `emptyText`. The times
 * in the bars' names read `timezone`.
 *
 * The bars share one IntersectionObserver, so each bar keeps its times
 * current only while it is on screen.
 */
export function TimelineLanes({
  label,
  hours,
  now,
  bars,
  trackCount,
  fires,
  emptyText,
  timezone,
}: {
  readonly label: string;
  readonly hours: ReadonlyArray<TimelineHour>;
  readonly now: TimelineNow | null;
  readonly bars: ReadonlyArray<TimelineBar>;
  readonly trackCount: number;
  readonly fires: ReadonlyArray<TimelineFire>;
  readonly emptyText: string;
  readonly timezone: string;
}): JSX.Element {
  const watchScreen = useScreenWatcher();
  return (
    <div
      className="lanes"
      role="group"
      aria-label={label}
      style={{ "--tracks": Math.max(trackCount, 1) }}
    >
      {hours.map((hour) => (
        <span key={hour.startsAt} className="hour-line" style={{ "--at": formatPlace(hour.at) }} />
      ))}
      {now === null ? null : <span className="now-line" style={{ "--at": formatPlace(now.at) }} />}
      {fires.map((fire) => (
        <span
          key={fire.triggerId}
          className="fire-tick"
          title={fire.title}
          style={{ "--at": formatPlace(fire.at) }}
        >
          <span>{fire.text}</span>
        </span>
      ))}
      {bars.length === 0 ? <p className="lanes-empty">{emptyText}</p> : null}
      {bars.map((bar) => (
        <RunBar
          key={bar.row.id}
          bar={bar}
          now={now}
          timezone={timezone}
          watchScreen={watchScreen}
        />
      ))}
    </div>
  );
}

/**
 * Renders the mark at a bar's end: the run's mark, or a faint dot for a
 * cancelled run and one that has not started, which have none.
 */
function BarMark({ state }: { readonly state: RunRow["state"] }): JSX.Element {
  return hasRunMark(state) ? <Mark state={state} /> : <span className="dot dot--mark" />;
}

/**
 * Renders one run's bar, a link to the run's page: a line from its start to
 * its end, with its mark at the end. A live run's bar ends at `now`. A bar
 * cut at the day's start or end has a square end there, and a chevron beside
 * it pointing to the day the run went on into; a bar cut at the end has no
 * mark, because the run had not ended there.
 *
 * Its name describes the run, with the times kept current by the age clock
 * while the bar is on screen, as `watchScreen` reports it. Every bar is
 * watched, because even an ended run's start time changes, from "10:31" to
 * "Sun", once its day has passed.
 */
function RunBar({
  bar,
  now,
  timezone,
  watchScreen,
}: {
  readonly bar: TimelineBar;
  readonly now: TimelineNow | null;
  readonly timezone: string;
  readonly watchScreen: ScreenWatcher;
}): JSX.Element {
  const { row } = bar;
  const barRef = useRef<HTMLAnchorElement>(null);
  const onScreen = useIsOnScreen(watchScreen, barRef, true);
  const startedText = useListTime(row.createdAt, timezone, "past", onScreen);
  const tookText = useDurationText(
    row.startedAt ?? row.createdAt,
    row.isLive && row.startedAt !== null && onScreen,
    (nowMs) => formatRunDuration(row, nowMs),
  );
  const label = describeRunRow(row, startedText, tookText);
  // A live bar on today ends at the now line, which is there whenever the
  // day is today; the 1 only covers the minute the day turns.
  const to = bar.to ?? now?.at ?? 1;
  const className = [
    "run-bar",
    row.statusTone === "muted" ? "" : `run-bar--${row.statusTone}`,
    bar.startsBefore ? "is-cut-start" : "",
    bar.endsAfter ? "is-cut-end" : "",
  ]
    .filter((name) => name !== "")
    .join(" ");
  return (
    <Link
      ref={barRef}
      to="/runs/$runId"
      params={{ runId: row.id }}
      className={className}
      aria-label={label}
      title={label}
      style={{
        "--at": formatPlace(bar.from),
        "--span": formatPlace(Math.max(to - bar.from, 0)),
        "--track": bar.track,
      }}
    >
      {bar.startsBefore ? (
        <span className="run-bar-cut run-bar-cut--start">
          <ChevronLeftIcon size={12} />
        </span>
      ) : null}
      <span className="run-bar-line" />
      {bar.endsAfter ? (
        <span className="run-bar-cut run-bar-cut--end">
          <ChevronRightIcon size={12} />
        </span>
      ) : (
        <BarMark state={row.state} />
      )}
    </Link>
  );
}
