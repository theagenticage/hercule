/**
 * The items of the workflow list's table: a group's heading and a
 * workflow's row, and the column heads above them (spec 17 §Workflows, "The
 * list").
 *
 * Each item draws itself at its fixed height, with the space above it as its
 * top margin, as the sidebar's items do. Every item's root carries
 * `data-key`, by which the list keeps the focused item mounted. Rows are
 * links; a heading takes focus only from code, when the list moves focus to
 * it.
 *
 * The items are memoized and take only strings, numbers, booleans and null,
 * so when a push builds the rows again, only the rows whose values changed
 * draw again.
 */
import { memo, useId, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { TriggerFiresOn } from "@hercule/contract";
import {
  STRIP_RUN_LIMIT,
  type StripRunState,
  type WorkflowRowMark,
  type WorkflowStatusTone,
} from "@hercule/client-core";
import { useListTime } from "../../app/age-clock";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { Mark } from "../../marks";
import { SELECTED_LINK_PROPS } from "../selected-link-props";

/** The height of a group's heading, in CSS pixels, without the space above it. */
export const GROUP_HEADING_HEIGHT = 24;

/** The height of a workflow's row, in CSS pixels. */
export const WORKFLOW_ROW_HEIGHT = 40;

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
function RunStrip({ strip }: { readonly strip: string }): JSX.Element {
  // The row takes the strip as one string, so its memo compares it by value.
  const runs = strip === "" ? [] : (strip.split(" ") as StripRunState[]);
  return (
    <span className="strip col-strip">
      {runs.map((state, index) =>
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
 * Renders a workflow's row: a link to the workflow, which is selected while
 * the workflow is open. Its cells are the workflow's mark, its name, what
 * starts it, the strip of its newest runs, how many of them succeeded, its
 * last run's status and time, and when it next starts.
 */
export const WorkflowTableRow = memo(function WorkflowTableRow({
  itemKey,
  workflowId,
  name,
  mark,
  isOff,
  startsOnText,
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
}: {
  readonly itemKey: string;
  readonly workflowId: string;
  readonly name: string;
  readonly mark: WorkflowRowMark;
  readonly isOff: boolean;
  readonly startsOnText: string;
  readonly startsOnFiresOn: TriggerFiresOn | null;
  readonly startsOnIsCode: boolean;
  /** The strip's run states, oldest first, joined with spaces. */
  readonly strip: string;
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
}): JSX.Element {
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
        <span>{startsOnIsCode ? <code>{startsOnText}</code> : startsOnText}</span>
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
});
