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
 */
import { Fragment, memo, useId, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { TriggerFiresOn } from "@hercule/contract";
import type {
  StripRunState,
  WorkflowRowMark,
  WorkflowStatusTone,
} from "@hercule/client-core/workflow-rows";
import { useListTime } from "./list-time";
import { STRIP_RUN_LIMIT } from "../../app/queries";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { Mark } from "../../marks";
import { SELECTED_LINK_PROPS } from "../selected-link-props";

/** The height of a group's heading, in CSS pixels, without the space above it. */
export const GROUP_HEADING_HEIGHT = 24;

/** The height of a workflow's row in the table, in CSS pixels. */
export const WORKFLOW_ROW_HEIGHT = 40;

/** The height of a workflow's row in the column, in CSS pixels, without the 1px above it. */
export const WORKFLOW_COLUMN_ROW_HEIGHT = 46;

/** The space above each of the column's rows, in CSS pixels, as between the sidebar's rows. */
export const WORKFLOW_COLUMN_ROW_LEADING = 1;

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

/**
 * Renders the strip: a mark per run, oldest first. A cancelled run, and a
 * run that has not started, has no mark, so it is a faint dot named with its
 * state.
 */
function RunStrip({ strip }: { readonly strip: ReadonlyArray<StripRunState> }): JSX.Element {
  return (
    <span className="strip col-strip">
      {strip.map((state, index) =>
        state === "cancelled" || state === "starting" ? (
          <span
            key={index}
            className="dot"
            role="img"
            aria-label={state === "cancelled" ? "Cancelled" : "Starting"}
          />
        ) : (
          <Mark key={index} state={state} size={STRIP_MARK_SIZE} />
        ),
      )}
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
  readonly strip: ReadonlyArray<StripRunState>;
  readonly successText: string;
  readonly statusText: string;
  readonly statusTone: WorkflowStatusTone;
  readonly lastRunAt: string | null;
  readonly nextText: string;
  readonly nextFireAt: string | null;
  /** The time zone the times are shown in. */
  readonly timezone: string;
  /** Whether the row is in the visible part of the list, which keeps its times current. */
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
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId }}
      className={isOff ? "table-row is-off" : "table-row"}
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      aria-label={name}
      aria-describedby={statusId}
    >
      <span className="table-mark">
        <Mark state={mark} />
      </span>
      <span className="table-name">{name}</span>
      <span className="table-quiet col-starts">
        {startsOnFiresOn === "event" ? <BoltIcon size={12} /> : null}
        {startsOnFiresOn === "schedule" ? <ClockIcon size={12} /> : null}
        <StartsOnText texts={startsOnTexts} isCode={startsOnIsCode} />
      </span>
      <RunStrip strip={strip} />
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
  /** Whether the row is in the visible part of the list, which keeps its time current. */
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
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId }}
      className={isOff ? "column-row is-off" : "column-row"}
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      style={{ marginTop: WORKFLOW_COLUMN_ROW_LEADING, height: WORKFLOW_COLUMN_ROW_HEIGHT }}
      aria-label={name}
      aria-describedby={statusId}
    >
      <span className="column-mark">
        <Mark state={mark} />
      </span>
      <span className="column-text">
        <span className="column-name">{name}</span>
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
