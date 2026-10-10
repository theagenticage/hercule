/**
 * PROTOTYPE. The items of the workflow list: a group's header, and a
 * workflow's row at each of the list's two widths, with the table's column
 * heads.
 *
 * Each item draws itself at its fixed height, with the space above it as its
 * top margin, as the sidebar's items do. Every item's root carries
 * `data-key`, by which the list keeps the focused item mounted, and can take
 * focus: rows are links, and headers take focus from code only.
 *
 * A row takes the whole `WorkflowRow`, so every mounted row draws again
 * whenever the rows are built again, about thirty rows at a time. The
 * sidebar's rows take only strings and numbers instead; the Workflows ticket
 * decides whether these rows should too.
 */
import { memo, useId, useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { Mark } from "../../marks/mark";
import { SELECTED_LINK_PROPS } from "../selected-link-props";
import { RECENT_RUN_LIMIT } from "./proposed-contract";
import type { WorkflowRow } from "./workflow-rows";

/** What every item takes from the list: its key, the space above it, and its height. */
interface Placement {
  readonly itemKey: string;
  readonly leading: number;
  readonly height: number;
}

/** The size of each run's mark in the strip, so twenty of them fit in a table row. */
const STRIP_MARK_SIZE = 10;

/** What changed in a workflow's row between two drawings, which its motion shows. */
export interface RowChange {
  /** Whether the workflow's own mark changed, which pops the new mark in. */
  readonly isMarkChanged: boolean;
  /** Whether a run joined the strip's right end, which steps the older marks left. */
  readonly isStripAdvanced: boolean;
  /** The runs in the strip that are new or whose mark changed, which pop in. */
  readonly changedRunIds: ReadonlySet<string>;
}

const NO_CHANGE: RowChange = {
  isMarkChanged: false,
  isStripAdvanced: false,
  changedRunIds: new Set(),
};

/** The parts of a workflow's row that draw marks. */
type RowMarks = Pick<WorkflowRow, "mark" | "strip">;

/**
 * Compares two drawings of one workflow's row and returns what changed in
 * its marks. Returns `NO_CHANGE` itself when no mark changed.
 */
export const detectRowChange = (previous: RowMarks, next: RowMarks): RowChange => {
  const before = new Map(previous.strip.map((run) => [run.runId, run.mark]));
  const changedRunIds = new Set(
    next.strip.filter((run) => before.get(run.runId) !== run.mark).map((run) => run.runId),
  );
  const isMarkChanged = previous.mark !== next.mark;
  if (!isMarkChanged && changedRunIds.size === 0) return NO_CHANGE;
  return {
    isMarkChanged,
    isStripAdvanced: next.strip.at(-1)?.runId !== previous.strip.at(-1)?.runId,
    changedRunIds,
  };
};

/**
 * Returns what changed in `row`'s marks the last time one did, while the row
 * was drawn. A row that has just mounted has no change, so a row that
 * scrolls into view, or is drawn when the list opens, stays still.
 *
 * The change is kept until the next one, not cleared when the rows are
 * built again for another workflow's sake, so an animation is never cut
 * short. Each mark is keyed by its state, so a mark that changes mounts
 * afresh and plays its animation again.
 */
function useRowChange(row: WorkflowRow): RowChange {
  const [previous, setPrevious] = useState(row);
  const [change, setChange] = useState(NO_CHANGE);
  if (previous !== row) {
    const next = detectRowChange(previous, row);
    if (next !== NO_CHANGE) setChange(next);
    setPrevious(row);
  }
  return change;
}

/** Renders a workflow's own mark, which pops in when it has just changed. */
function LeadMark({
  mark,
  isChanged,
}: {
  readonly mark: WorkflowRow["mark"];
  readonly isChanged: boolean;
}): JSX.Element {
  return (
    <span className={isChanged ? "wl-mark is-new" : "wl-mark"}>
      <Mark key={mark} state={mark} />
    </span>
  );
}

/** Renders a group's heading, with the count of its workflows. */
export const WorkflowGroupHeader = memo(function WorkflowGroupHeader({
  itemKey,
  leading,
  height,
  title,
  count,
  isYou,
}: Placement & {
  readonly title: string;
  readonly count: number;
  /** Whether the group's workflows wait on the user, which sets the count in marigold. */
  readonly isYou: boolean;
}): JSX.Element {
  return (
    <h3
      className="wl-group"
      data-key={itemKey}
      tabIndex={-1}
      style={{ marginTop: leading, height }}
    >
      {/* The space keeps the heading's name "Failing 2", not "Failing2". */}
      <span>{title}</span> <b className={isYou ? "count count--you" : "count"}>{count}</b>
    </h3>
  );
});

/** Renders the column heads above the table's rows, in the rows' grid. */
export function WorkflowTableHeads(): JSX.Element {
  // Hidden from assistive technology: the rows are links, not table rows,
  // and each one's name and description say what its cells show.
  return (
    <div className="wl-grid wl-cols" aria-hidden="true">
      <span />
      <span>Workflow</span>
      <span className="wl-starts">Starts on</span>
      <span className="wl-strip">Last {RECENT_RUN_LIMIT} runs</span>
      <span className="wl-num wl-success">Success</span>
      <span>Last run</span>
      <span className="wl-time" />
      <span className="wl-num">Next</span>
    </div>
  );
}

/**
 * Renders the marks of a workflow's recent runs, oldest first. A new run's
 * mark pops in at the right end while the older marks step left, and a run
 * whose state changed pops its new mark in.
 */
function RunStrip({
  strip,
  change,
}: {
  readonly strip: WorkflowRow["strip"];
  readonly change: RowChange;
}): JSX.Element {
  return (
    <span
      // A new newest run mounts the strip afresh, so its older marks step again.
      key={strip.at(-1)?.runId}
      className={change.isStripAdvanced ? "wl-strip is-advanced" : "wl-strip"}
    >
      {strip.map((run) => (
        <Mark
          key={`${run.runId}:${run.mark}`}
          state={run.mark}
          size={STRIP_MARK_SIZE}
          className={change.changedRunIds.has(run.runId) ? "is-new" : undefined}
        />
      ))}
    </span>
  );
}

/**
 * Renders a workflow's row in the table: its mark, its name, what starts it,
 * its recent runs, how many of them succeeded, its last run's status and
 * time, and when it next starts.
 */
export const WorkflowTableRow = memo(function WorkflowTableRow({
  itemKey,
  leading,
  height,
  row,
}: Placement & { readonly row: WorkflowRow }): JSX.Element {
  const statusId = useId();
  const change = useRowChange(row);
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId: row.id }}
      className={row.isOff ? "wl-grid wl-row wl-trow is-off" : "wl-grid wl-row wl-trow"}
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      style={{ marginTop: leading, height }}
      aria-label={row.name}
      aria-describedby={statusId}
    >
      <LeadMark mark={row.mark} isChanged={change.isMarkChanged} />
      <span className="wl-name">{row.name}</span>
      <span className="wl-starts">
        {row.startsOn === undefined ? null : (
          <>
            {row.startsOn.firesOnSchedule ? <ClockIcon size={12} /> : <BoltIcon size={12} />}
            <span className="wl-clip">{row.startsOn.text}</span>
          </>
        )}
      </span>
      <RunStrip strip={row.strip} change={change} />
      <span className="wl-num wl-success">{row.successText}</span>
      <span className={`wl-status wl-status--${row.status.tone}`} id={statusId}>
        {row.status.text}
      </span>
      <span className="wl-num wl-time">{row.timeText}</span>
      <span className="wl-num">{row.nextText}</span>
    </Link>
  );
});

/**
 * Renders a workflow's row in the column beside an open workflow: its mark,
 * its name over its status, and its last run's time.
 */
export const WorkflowColumnRow = memo(function WorkflowColumnRow({
  itemKey,
  leading,
  height,
  row,
}: Placement & { readonly row: WorkflowRow }): JSX.Element {
  const statusId = useId();
  const change = useRowChange(row);
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId: row.id }}
      className={row.isOff ? "wl-row is-off" : "wl-row"}
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      style={{ marginTop: leading, height }}
      aria-label={row.name}
      aria-describedby={statusId}
    >
      <LeadMark mark={row.mark} isChanged={change.isMarkChanged} />
      <span className="wl-text">
        <span className="wl-name">{row.name}</span>
        <span className={`wl-status wl-status--${row.status.tone}`} id={statusId}>
          {row.status.text}
        </span>
      </span>
      <span className="wl-num wl-time">{row.timeText}</span>
    </Link>
  );
});
