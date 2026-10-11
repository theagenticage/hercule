/**
 * The Timeline view of a run's steps (spec 17 §Workflows, "A run's page"):
 * one row per step record, then one per plan step the run has not reached,
 * on a time axis shared by every row, with how long each step took.
 *
 * It comes in two parts because the Bureau book puts them in two places:
 * the axis sits in the page's sticky band under the tab bar, where a table's
 * column heads sit, and the rows scroll under it. `useStepTimeline` builds
 * the timeline both parts draw, and only while the timeline is shown.
 *
 * While the run is live, the axis changes only when its tick labels change,
 * so it ends at a tick past now. Between, a tick of the age clock changes the
 * "now" pill's text and moves the pill, the now line and the live bars' ends
 * by `transform`, and nothing else.
 */
import { useCallback, useState, type JSX, type RefCallback } from "react";
import type { Run, Session } from "@hercule/contract";
import {
  findNextDurationChange,
  formatDuration,
  isRunLive,
  readTimestamps,
} from "@hercule/client-core";
import { describeNodeRunStatus } from "@hercule/client-core/node-details";
import {
  buildStepTimeline,
  computeStepTimelineEnd,
  type StepTimeline,
  type StepTimelineRow,
} from "@hercule/client-core/run-page-rows";
import { useClockValue, useDurationText } from "../../app/age-clock";
import { Mark } from "../../marks";
import { formatPlace } from "./axis-place";
import { decideNodeRunTone, findNodeRunMark } from "./node-run-mark";
import { useStepDuration } from "./step-duration";
import "./workflow-list.css";
import "./run-timeline.css";
import "./step-timeline.css";

/** A run's step timeline, measured to its axis, as both parts draw it. */
export interface MeasuredStepTimeline {
  readonly timeline: StepTimeline;
  readonly isLive: boolean;
  /** Goes on the axis's track, which the timeline measures its width from. */
  readonly axisRef: RefCallback<HTMLElement>;
}

/**
 * Measures how many whole characters of the axis's labels fit across the
 * axis, so its ticks sit as close as their labels allow. Returns the ref to
 * put on the axis's track, and the width, 0 until the track is measured. The
 * width is rounded down, so resizing the window draws the timeline again
 * only when a whole character more or less fits. A hidden probe
 * in the track holds one digit of the labels' type: the digits are
 * even-width, so one of them is the unit.
 */
const useAxisWidth = (): {
  readonly axisRef: RefCallback<HTMLElement>;
  readonly widthInCharacters: number;
} => {
  const [widthInCharacters, setWidthInCharacters] = useState(0);
  const axisRef = useCallback((track: HTMLElement) => {
    const probe = track.querySelector<HTMLElement>(".axis-probe");
    const measure = (): void => {
      const character = probe?.getBoundingClientRect().width ?? 0;
      setWidthInCharacters(
        character === 0 ? 0 : Math.floor(track.getBoundingClientRect().width / character),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { axisRef, widthInCharacters };
};

/**
 * Builds `run`'s step timeline for the axis the head measures, with
 * `sessions`, the run's sessions, while `isShown` is true. Returns
 * `undefined`, and builds nothing, while the timeline is not shown.
 *
 * While the run is live and the timeline is shown, the age clock reads where
 * the axis ends (`computeStepTimelineEnd`) once a second, which is the only
 * work a tick costs. The timeline is built at that instant, so it is built
 * again, and the calling component drawn again, only when the axis changes:
 * when now passes the axis's end or the axis is resized. The parts count the
 * rest on the age clock themselves.
 */
export const useStepTimeline = (
  run: Run,
  sessions: ReadonlyArray<Session>,
  isShown: boolean,
): MeasuredStepTimeline | undefined => {
  const isLive = isRunLive(run.status);
  const { axisRef, widthInCharacters } = useAxisWidth();
  // The axis's length changes only at a whole second of the run's duration,
  // so the clock checks then.
  const axisEndAt = useClockValue(
    readTimestamps(run).startedAt ?? run.createdAt,
    isLive && isShown,
    findNextDurationChange,
    (now) => computeStepTimelineEnd(run, now.getTime(), widthInCharacters),
  );
  if (!isShown) return undefined;
  const timeline = buildStepTimeline(run, sessions, axisEndAt, widthInCharacters);
  return { timeline, isLive, axisRef };
};

/**
 * Returns where now is on a live run's axis, from 0 at its start to 1 at its
 * end. The age clock reads it again at each moment a duration since the
 * run's start changes, so the now pill, the now line and the live bars' ends,
 * which all read it, always meet.
 */
const useNowPlace = (timeline: StepTimeline): number => {
  const origin = Date.parse(timeline.originAt);
  return useClockValue(timeline.originAt, true, findNextDurationChange, (now) =>
    Math.min(1, Math.max(0, (now.getTime() - origin) / timeline.spanMs)),
  );
};

/** Returns a `transform` that moves a layer the width of the axis to now on a live run's axis. */
const useNowTransform = (timeline: StepTimeline): string =>
  `translateX(${formatPlace(useNowPlace(timeline))})`;

/** Renders the "now" pill at now on the axis: how long the run has run, such as "now 29m 12s". */
function NowPill({ timeline }: { readonly timeline: StepTimeline }): JSX.Element {
  const { originAt } = timeline;
  const text = useDurationText(
    originAt,
    true,
    (now) => `now ${formatDuration(now - Date.parse(originAt))}`,
  );
  return (
    <span className="now-at" style={{ transform: useNowTransform(timeline) }}>
      <span className="axis-now">{text}</span>
    </span>
  );
}

/** Renders the line down a row's track at now on the axis. */
function NowLine({ timeline }: { readonly timeline: StepTimeline }): JSX.Element {
  return (
    <span className="now-at" style={{ transform: useNowTransform(timeline) }}>
      <span className="now-line" />
    </span>
  );
}

/**
 * Renders the timeline's column heads: Step, the time axis with a label at
 * each tick, and Took. While the run is live, the "now" pill sits at now on
 * the axis. It belongs in the page's sticky band under the tab bar. The heads
 * repeat what each row says, so assistive technology skips them.
 */
export function StepTimelineHead({ steps }: { readonly steps: MeasuredStepTimeline }): JSX.Element {
  const { timeline, isLive, axisRef } = steps;
  return (
    <div className="table-heads tbl-steps" aria-hidden="true">
      <span />
      <span>Step</span>
      <span ref={axisRef} className="track">
        <span className="axis-probe">0</span>
        {timeline.ticks.map((tick) => (
          <span
            key={tick.position}
            className="axis-tick"
            style={{ "--at": formatPlace(tick.position) }}
          >
            {tick.label}
          </span>
        ))}
        {isLive ? <NowPill timeline={timeline} /> : null}
      </span>
      <span className="table-num">Took</span>
    </div>
  );
}

/**
 * Renders the timeline's rows, one per row of `steps`. A row whose step
 * drives a session is a button that calls `onOpenSession` with it.
 */
export function StepTimelineRows({
  steps,
  onOpenSession,
}: {
  readonly steps: MeasuredStepTimeline;
  readonly onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const { timeline, isLive } = steps;
  return (
    <div className="table-rows">
      {timeline.rows.map((row) => (
        <StepRow
          key={row.key}
          row={row}
          timeline={timeline}
          isLive={isLive}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}

/** Renders a row's mark: the state's mark, or a faint dot for a step that started and has none, such as a cancelled one. */
function StepMark({ row }: { readonly row: StepTimelineRow }): JSX.Element {
  const mark = findNodeRunMark(row.state);
  return mark === undefined ? <span className="dot dot--mark" /> : <Mark state={mark} />;
}

/** Renders how long the step of a row took, or has run so far. */
function StepTook({
  startedAt,
  finishedAt,
}: {
  readonly startedAt: string;
  readonly finishedAt: string | undefined;
}): JSX.Element {
  return <>{useStepDuration(startedAt, finishedAt)}</>;
}

/**
 * Renders the bar of a running step, which starts at `start` on the axis and
 * has room up to the axis's end, with its line and its mark drawn as far as
 * now. The age clock moves the end once a second, by `transform` alone, so
 * the bar never lays the row out again.
 */
function LiveBarEnd({
  row,
  start,
  timeline,
}: {
  readonly row: StepTimelineRow;
  readonly start: number;
  readonly timeline: StepTimeline;
}): JSX.Element {
  const nowPlace = useNowPlace(timeline);
  // How much of the bar's room, from its start to the axis's end, it fills by
  // now. A step that started at the axis's very end has no room, and is full.
  const reach = start >= 1 ? 1 : Math.min(1, Math.max(0, (nowPlace - start) / (1 - start)));
  return (
    <>
      <span className="run-bar-line is-live" style={{ transform: `scaleX(${String(reach)})` }} />
      <span
        className="run-bar-end"
        style={{ transform: `translateX(${String((reach - 1) * 100)}%)` }}
      >
        <StepMark row={row} />
      </span>
    </>
  );
}

/** Renders one row of the timeline: its mark, its step and why it failed, its track, and how long it took. */
function StepRow({
  row,
  timeline,
  isLive,
  onOpenSession,
}: {
  readonly row: StepTimelineRow;
  readonly timeline: StepTimeline;
  readonly isLive: boolean;
  readonly onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const { bar, note } = row;
  const tone = decideNodeRunTone(row.state);
  const barClass = tone === undefined ? "run-bar" : `run-bar run-bar--${tone}`;
  const name =
    row.iterationLabel === undefined ? row.stepId : `${row.stepId} ${row.iterationLabel}`;
  const cells = (
    <>
      <span className="table-mark">{bar === undefined ? null : <StepMark row={row} />}</span>
      <span className="record">
        <span className={bar === undefined ? "record-name is-quiet" : "record-name"}>
          {row.stepId}
          {row.iterationLabel === undefined ? null : <small>{row.iterationLabel}</small>}
        </span>
        {row.errorText === undefined ? null : <span className="record-err">{row.errorText}</span>}
      </span>
      <span className="track">
        {timeline.ticks.map((tick) => (
          <span
            key={tick.position}
            className="hour-line"
            style={{ "--at": formatPlace(tick.position) }}
          />
        ))}
        {isLive ? <NowLine timeline={timeline} /> : null}
        {bar === undefined ? null : bar.end === undefined ? (
          <span
            className={barClass}
            style={{ "--at": formatPlace(bar.start), "--span": formatPlace(1 - bar.start) }}
          >
            <LiveBarEnd row={row} start={bar.start} timeline={timeline} />
          </span>
        ) : (
          <span
            className={barClass}
            style={{ "--at": formatPlace(bar.start), "--span": formatPlace(bar.end - bar.start) }}
          >
            <span className="run-bar-line" />
            <StepMark row={row} />
          </span>
        )}
        {note === undefined ? null : <span className="track-note">{note}</span>}
      </span>
      <span className="table-num">
        {row.startedAt === undefined ? null : (
          <StepTook startedAt={row.startedAt} finishedAt={row.finishedAt} />
        )}
      </span>
    </>
  );
  const label = `${name}, ${describeNodeRunStatus(row.state, row.kind)}`;
  const { sessionId } = row;
  return sessionId === undefined ? (
    <div className="table-row tbl-steps" role="group" aria-label={label}>
      {cells}
    </div>
  ) : (
    <button
      type="button"
      className="table-row tbl-steps"
      aria-label={label}
      title={`Open ${name}’s thread`}
      onClick={() => {
        onOpenSession(sessionId);
      }}
    >
      {cells}
    </button>
  );
}
