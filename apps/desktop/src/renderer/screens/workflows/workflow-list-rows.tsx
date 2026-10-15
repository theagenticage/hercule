/**
 * The items of the workflow list: a group's heading, and a workflow's row at
 * each of the list's two widths, with the table's column heads (spec 17
 * §Workflows, "The list").
 *
 * Each item draws itself at its fixed height, with the space above it as its
 * top margin, as the sidebar's items do. Every item's root carries
 * `data-key`, by which the list keeps the focused item mounted. Rows are
 * links; a heading takes focus only from code, when the list moves focus to
 * it.
 *
 * The items are memoized and take only strings, numbers, booleans and null,
 * and a row also arrays of them, which its memo compares element by element.
 * So when a push builds the rows again, only the rows whose values changed
 * draw again.
 *
 * A mark whose state changed while the list is open pops in, and a run that
 * joins a strip steps the older marks left (spec 17, "Workflows' motion",
 * item 3). A row drawn when the list opens, or scrolled into view, stays
 * still, and so does a row that is off screen when its marks change.
 */
import {
  Fragment,
  memo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type JSX,
  type RefObject,
} from "react";
import { Link } from "@tanstack/react-router";
import type { TriggerFiresOn } from "@hercule/contract";
import { hasRunMark, type RunMarkState } from "@hercule/client-core/run-marks";
import type { WorkflowRowMark, WorkflowStatusTone } from "@hercule/client-core/workflow-rows";
import { useListTime } from "./list-time";
import { isAnimationPlaying, isMotionReduced } from "./change-motion";
import { STRIP_RUN_LIMIT } from "../../app/queries";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { Mark } from "../../marks";
import {
  COLUMN_ROW_HEIGHT,
  COLUMN_ROW_LEADING,
  GROUP_HEADING_HEIGHT,
} from "../list-pane/list-row-sizes";
import { SELECTED_LINK_PROPS } from "../selected-link-props";

declare module "react" {
  interface CSSProperties {
    /** How many runs joined a strip's right end, which the older marks step left by. */
    "--joined-runs"?: number;
  }
}

/** The size of a run's mark in the strip, so twenty of them fit in the strip's column. */
const STRIP_MARK_SIZE = 10;

/**
 * Renders the column heads, in the rows' grid. They are hidden from
 * assistive technology: the rows are links, not table rows, and each row's
 * name and description already say what its cells show.
 */
export function WorkflowTableHeads(): JSX.Element {
  return (
    <div className="table-heads" aria-hidden="true">
      <span />
      <span>Workflow</span>
      <span className="col-starts">Starts on</span>
      <span className="table-num col-strip">Last {STRIP_RUN_LIMIT} runs</span>
      <span className="table-num col-success">Success</span>
      <span>Last run</span>
      <span />
      <span className="table-num">Next</span>
    </div>
  );
}

/** Renders a group's heading, with how many of its rows are shown right after its name. */
export const WorkflowGroupHeading = memo(function WorkflowGroupHeading({
  itemKey,
  leading,
  title,
  count,
  isNeedsYou,
}: {
  readonly itemKey: string;
  /** The space above the heading, in CSS pixels. */
  readonly leading: number;
  readonly title: string;
  readonly count: number;
  /** Whether the heading is Needs you's, whose count is drawn in marigold. */
  readonly isNeedsYou: boolean;
}): JSX.Element {
  return (
    <h2
      className="group-h"
      data-key={itemKey}
      tabIndex={-1}
      style={{ marginTop: leading, height: GROUP_HEADING_HEIGHT }}
    >
      {/* The space keeps the heading's name "Failing 2", not "Failing2". The
          heading is a flex box, which draws no space between its items. */}
      <span>{title}</span> <b className={isNeedsYou ? "count count--you" : "count"}>{count}</b>
    </h2>
  );
});

/**
 * Renders a time in the list, such as "10:31", "Sun" or "Fri 14:00", kept
 * current by the age clock while `onScreen` is true.
 */
function ListTime({
  at,
  timezone,
  direction,
  onScreen,
}: {
  readonly at: string;
  readonly timezone: string;
  readonly direction: "past" | "future";
  readonly onScreen: boolean;
}): string {
  return useListTime(at, timezone, direction, onScreen);
}

/** The marks of a workflow's row, which its motion compares between two drawings. */
export interface WorkflowRowMarks {
  readonly mark: WorkflowRowMark;
  /** The strip's run states, oldest first. */
  readonly strip: ReadonlyArray<RunMarkState>;
  /** The id of each run in `strip`, in the same order. */
  readonly stripRunIds: ReadonlyArray<string>;
}

/** What changed in a workflow's marks between two drawings of its row, which its motion shows. */
export interface WorkflowRowChange {
  /** Whether the workflow's own mark changed, which pops the new mark in. */
  readonly isMarkChanged: boolean;
  /**
   * How many runs that were not in the strip before joined its right end.
   * The older marks step left one slot for each.
   */
  readonly joinedRunCount: number;
  /** The runs in the strip that are new or whose state changed, whose marks pop in. */
  readonly changedRunIds: ReadonlySet<string>;
}

/** The change of a row whose marks did not change, which plays no motion. */
const NO_CHANGE: WorkflowRowChange = {
  isMarkChanged: false,
  joinedRunCount: 0,
  changedRunIds: new Set(),
};

/**
 * Compares two drawings of one workflow's row and returns what changed in
 * its marks. Returns the same empty change every time no mark changed, so a
 * caller can tell by identity that there is nothing to play.
 */
export const detectWorkflowRowChange = (
  previous: WorkflowRowMarks,
  next: WorkflowRowMarks,
): WorkflowRowChange => {
  const statesBefore = new Map(
    previous.stripRunIds.map((runId, index) => [runId, previous.strip[index]]),
  );
  const changedRunIds = new Set(
    next.stripRunIds.filter((runId, index) => statesBefore.get(runId) !== next.strip[index]),
  );
  const isMarkChanged = previous.mark !== next.mark;
  if (!isMarkChanged && changedRunIds.size === 0) return NO_CHANGE;
  const runIdsBefore = new Set(previous.stripRunIds);
  // The runs after the newest one that was in the strip before have joined it.
  const newestKeptIndex = next.stripRunIds.findLastIndex((runId) => runIdsBefore.has(runId));
  return {
    isMarkChanged,
    joinedRunCount: next.stripRunIds.length - 1 - newestKeptIndex,
    changedRunIds,
  };
};

/**
 * Adds a change detected while another is still playing to that change, and
 * returns the sum. Two pushes often land a frame apart, for example a run
 * joining the strip and then the workflow's own mark changing, so the second
 * change must not drop the motion the first one started.
 *
 * - The lead mark pops if it changed in either change.
 * - A run that joins the strip draws the strip afresh, because the strip is
 *   keyed by its newest run. So the strip plays the detected change alone:
 *   its marks step left by the runs that just joined, from where they are
 *   drawn now, and only its own changed marks pop.
 * - Otherwise the strip keeps the step it is playing, and the marks that
 *   changed in either change pop.
 */
export const mergeWorkflowRowChanges = (
  playing: WorkflowRowChange,
  detected: WorkflowRowChange,
): WorkflowRowChange => {
  if (playing === NO_CHANGE) return detected;
  const isMarkChanged = playing.isMarkChanged || detected.isMarkChanged;
  return detected.joinedRunCount > 0
    ? { ...detected, isMarkChanged }
    : {
        isMarkChanged,
        joinedRunCount: playing.joinedRunCount,
        changedRunIds: new Set([...playing.changedRunIds, ...detected.changedRunIds]),
      };
};

/** The strip of a row that has none: the column's rows draw no strip. */
const NO_STRIP: ReadonlyArray<never> = [];

/**
 * Returns what changed in a row's marks the last time one changed while the
 * row was on screen, the ref for the row's root, and the handler the row's
 * root calls when one of its animations ends.
 *
 * - A row that has just mounted has no change, so a row drawn when the list
 *   opens, or scrolled into view, stays still.
 * - A change made while the row is off screen, or while Reduce motion is
 *   on, clears the change, so the row shows still when it scrolls in, or
 *   when the user turns Reduce motion off.
 * - The change is kept until its motion has ended, not cleared when a push
 *   draws the row again for another reason, so an animation is never cut
 *   short. A change found meanwhile is added to it. Then the handler clears
 *   it, so the row does not play it again when the list moves the row.
 * - A change that starts no animation is cleared as soon as it is drawn.
 *   The strip is hidden in a narrow pane, so a run joining it plays nothing,
 *   and no animation ends to clear the change; kept, the change would play
 *   when the pane widens.
 *
 * Each mark is keyed by its state, so a mark that changes mounts afresh and
 * plays its animation again. A push builds the row's arrays anew, so the
 * marks are compared by value.
 */
function useRowChange(
  mark: WorkflowRowMark,
  strip: ReadonlyArray<RunMarkState>,
  stripRunIds: ReadonlyArray<string>,
  onScreen: boolean,
): {
  readonly change: WorkflowRowChange;
  readonly rowRef: RefObject<HTMLAnchorElement | null>;
  readonly onAnimationEnd: (event: AnimationEvent<Element>) => void;
} {
  const rowRef = useRef<HTMLAnchorElement>(null);
  const [previous, setPrevious] = useState<WorkflowRowMarks>({ mark, strip, stripRunIds });
  const [change, setChange] = useState(NO_CHANGE);
  if (
    previous.mark !== mark ||
    !areArraysEqual(previous.strip, strip) ||
    !areArraysEqual(previous.stripRunIds, stripRunIds)
  ) {
    const next = { mark, strip, stripRunIds };
    const detected = detectWorkflowRowChange(previous, next);
    if (!onScreen || isMotionReduced()) setChange(NO_CHANGE);
    else if (detected !== NO_CHANGE)
      setChange((playing) => mergeWorkflowRowChanges(playing, detected));
    setPrevious(next);
  }
  useLayoutEffect(() => {
    if (change !== NO_CHANGE && !isAnimationPlaying(rowRef.current!)) setChange(NO_CHANGE);
  }, [change]);
  const onAnimationEnd = (event: AnimationEvent<Element>) => {
    if (!isAnimationPlaying(event.currentTarget)) setChange(NO_CHANGE);
  };
  return { change, rowRef, onAnimationEnd };
}

/**
 * Renders a workflow's own mark in `className`'s cell. The mark pops in
 * when `isChanged` is true.
 */
function LeadMark({
  className,
  mark,
  isChanged,
}: {
  readonly className: string;
  readonly mark: WorkflowRowMark;
  readonly isChanged: boolean;
}): JSX.Element {
  return (
    <span className={isChanged ? `${className} is-new` : className}>
      <Mark key={mark} state={mark} />
    </span>
  );
}

/**
 * Renders the strip: a mark per run, oldest first. A cancelled run, and a
 * run that has not started, has no mark, so it is a faint dot named with its
 * state.
 *
 * Each run sits in its own slot, keyed by the run and its state, so a run
 * whose state changed mounts afresh and pops in. The caller keys the strip
 * by its newest run, so a run that joins mounts the strip afresh and the
 * older marks step left again.
 */
function RunStrip({
  strip,
  stripRunIds,
  change,
}: {
  readonly strip: ReadonlyArray<RunMarkState>;
  readonly stripRunIds: ReadonlyArray<string>;
  readonly change: WorkflowRowChange;
}): JSX.Element {
  return (
    <span
      className={change.joinedRunCount > 0 ? "strip col-strip is-advanced" : "strip col-strip"}
      style={change.joinedRunCount > 0 ? { "--joined-runs": change.joinedRunCount } : undefined}
    >
      {strip.map((state, index) => {
        // `stripRunIds` holds an id for every state in `strip`.
        const runId = stripRunIds[index]!;
        return (
          <span
            key={`${runId}:${state}`}
            className={change.changedRunIds.has(runId) ? "strip-run is-new" : "strip-run"}
          >
            {hasRunMark(state) ? (
              <Mark state={state} size={STRIP_MARK_SIZE} />
            ) : (
              <span
                className="dot"
                role="img"
                aria-label={state === "cancelled" ? "Cancelled" : "Starting"}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Renders what starts a workflow: its start triggers' texts joined with
 * " · ", each cron expression with no words shown as code.
 */
function StartsOnText({
  texts,
  isCode,
}: {
  readonly texts: ReadonlyArray<string>;
  readonly isCode: ReadonlyArray<boolean>;
}): JSX.Element {
  // Text split across several nodes is shaped differently at the joins, so
  // text with no code in it stays one string, as the book draws it.
  if (!isCode.includes(true)) return <span>{texts.join(" · ")}</span>;
  return (
    <span>
      {texts.map((text, index) => (
        <Fragment key={index}>
          {index > 0 ? " · " : null}
          {isCode[index] === true ? <code>{text}</code> : text}
        </Fragment>
      ))}
    </span>
  );
}

/** The values a workflow's row draws. */
interface WorkflowTableRowProps {
  readonly itemKey: string;
  readonly workflowId: string;
  readonly name: string;
  readonly mark: WorkflowRowMark;
  readonly isOff: boolean;
  /** What starts the workflow, one text per start trigger. */
  readonly startsOnTexts: ReadonlyArray<string>;
  readonly startsOnFiresOn: TriggerFiresOn | null;
  /** For each text of `startsOnTexts`, whether it is shown as code. */
  readonly startsOnIsCode: ReadonlyArray<boolean>;
  /** The strip's run states, oldest first. */
  readonly strip: ReadonlyArray<RunMarkState>;
  /** The id of each run in `strip`, in the same order. */
  readonly stripRunIds: ReadonlyArray<string>;
  readonly successText: string;
  readonly statusText: string;
  readonly statusTone: WorkflowStatusTone;
  readonly lastRunAt: string | null;
  readonly nextText: string;
  readonly nextFireAt: string | null;
  /** The time zone the times are shown in. */
  readonly timezone: string;
  /**
   * Whether the row is in the visible part of the list, which keeps its
   * times current and lets its marks move.
   */
  readonly onScreen: boolean;
}

/** Checks whether two arrays hold the same values in the same order. */
const areArraysEqual = <Value,>(a: ReadonlyArray<Value>, b: ReadonlyArray<Value>): boolean =>
  a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/**
 * Checks whether a row's props are equal: each array element by element, and
 * every other value by `Object.is`. A push builds every row's arrays anew, so
 * comparing them by identity would draw every row again.
 */
const areWorkflowRowPropsEqual = <Props extends object>(a: Props, b: Props): boolean =>
  (Object.keys(a) as Array<keyof Props>).every((key) => {
    const valueOfA = a[key];
    const valueOfB = b[key];
    return Array.isArray(valueOfA) && Array.isArray(valueOfB)
      ? areArraysEqual<unknown>(valueOfA, valueOfB)
      : Object.is(valueOfA, valueOfB);
  });

/**
 * Renders a workflow's row in the table: a link to the workflow. Its cells are the workflow's mark, its name, what
 * starts it, the strip of its newest runs, how many of them succeeded, its
 * last run's status and time, and when it next starts.
 */
export const WorkflowTableRow = memo(function WorkflowTableRow({
  itemKey,
  workflowId,
  name,
  mark,
  isOff,
  startsOnTexts,
  startsOnFiresOn,
  startsOnIsCode,
  strip,
  stripRunIds,
  successText,
  statusText,
  statusTone,
  lastRunAt,
  nextText,
  nextFireAt,
  timezone,
  onScreen,
}: WorkflowTableRowProps): JSX.Element {
  const statusId = useId();
  const { change, rowRef, onAnimationEnd } = useRowChange(mark, strip, stripRunIds, onScreen);
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId }}
      className={isOff ? "table-row is-off" : "table-row"}
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      aria-label={name}
      aria-describedby={statusId}
      ref={rowRef}
      onAnimationEnd={onAnimationEnd}
    >
      <LeadMark className="table-mark" mark={mark} isChanged={change.isMarkChanged} />
      <span className="table-name">{name}</span>
      <span className="table-quiet col-starts">
        {startsOnFiresOn === "event" ? <BoltIcon size={12} /> : null}
        {startsOnFiresOn === "schedule" ? <ClockIcon size={12} /> : null}
        <StartsOnText texts={startsOnTexts} isCode={startsOnIsCode} />
      </span>
      <RunStrip key={stripRunIds.at(-1)} strip={strip} stripRunIds={stripRunIds} change={change} />
      <span className="table-num col-success">{successText}</span>
      <span
        className={
          statusTone === "muted" ? "status-text" : `status-text status-text--${statusTone}`
        }
        id={statusId}
      >
        {statusText}
      </span>
      <span className="table-num">
        {lastRunAt === null ? null : (
          <ListTime at={lastRunAt} timezone={timezone} direction="past" onScreen={onScreen} />
        )}
      </span>
      <span className="table-num">
        {nextFireAt === null ? (
          nextText
        ) : (
          <ListTime at={nextFireAt} timezone={timezone} direction="future" onScreen={onScreen} />
        )}
      </span>
    </Link>
  );
}, areWorkflowRowPropsEqual);

/** The values a workflow's row in the column draws. */
interface WorkflowColumnRowProps {
  readonly itemKey: string;
  readonly workflowId: string;
  readonly name: string;
  readonly mark: WorkflowRowMark;
  readonly isOff: boolean;
  readonly statusText: string;
  readonly statusTone: WorkflowStatusTone;
  readonly lastRunAt: string | null;
  /** The time zone the time is shown in. */
  readonly timezone: string;
  /**
   * Whether the row is in the visible part of the list, which keeps its
   * time current and lets its mark move.
   */
  readonly onScreen: boolean;
}

/**
 * Renders a workflow's row in the column beside the open workflow: a link
 * to the workflow, which is selected while the workflow is open, drawn as
 * the sidebar's two-line row. Its parts are the workflow's mark, its name
 * over its last run's status, and when that run started.
 */
export const WorkflowColumnRow = memo(function WorkflowColumnRow({
  itemKey,
  workflowId,
  name,
  mark,
  isOff,
  statusText,
  statusTone,
  lastRunAt,
  timezone,
  onScreen,
}: WorkflowColumnRowProps): JSX.Element {
  const statusId = useId();
  const { change, rowRef, onAnimationEnd } = useRowChange(mark, NO_STRIP, NO_STRIP, onScreen);
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId }}
      className={isOff ? "column-row is-off" : "column-row"}
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      style={{ marginTop: COLUMN_ROW_LEADING, height: COLUMN_ROW_HEIGHT }}
      aria-label={name}
      aria-describedby={statusId}
      ref={rowRef}
      onAnimationEnd={onAnimationEnd}
    >
      <LeadMark className="column-mark" mark={mark} isChanged={change.isMarkChanged} />
      <span className="column-text">
        {/* The column is narrow, so a long name ends in an ellipsis; the
            title shows the whole name on hover. */}
        <span className="column-name" title={name}>
          {name}
        </span>
        <span
          className={
            statusTone === "muted"
              ? "column-status status-text"
              : `column-status status-text status-text--${statusTone}`
          }
          id={statusId}
        >
          {statusText}
        </span>
      </span>
      <span className="column-time">
        {lastRunAt === null ? null : (
          <ListTime at={lastRunAt} timezone={timezone} direction="past" onScreen={onScreen} />
        )}
      </span>
    </Link>
  );
}, areWorkflowRowPropsEqual);
