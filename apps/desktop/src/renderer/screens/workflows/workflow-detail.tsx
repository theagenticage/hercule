/**
 * PROTOTYPE. The parts of an open workflow's page, top to bottom:
 *
 * - its lead: the name, the description, and chips that say what starts it
 *   and what its steps run;
 * - the heading of the run its graph draws;
 * - its tabs, and the table each one shows: the runs, the triggers, the
 *   inputs, or the source.
 *
 * Every part takes values and callbacks and reads nothing. The page is read
 * only: starting a run, turning the workflow off and pausing a trigger come
 * with the Workflows ticket's follow-up, and changing the workflow with the
 * one on creating and editing workflows.
 */
import type { JSX, RefObject } from "react";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { Mark } from "../../marks/mark";
import {
  describeRunRow,
  type InputRow,
  type RunRow,
  type TriggerRow,
  type TriggerSource,
  type WorkflowChip,
} from "./workflow-detail-rows";
import "../session/messages.css";
import "./workflow-detail.css";

/** The page's tabs, in the order the tab bar shows them. */
export const WORKFLOW_TABS = [
  { tab: "runs", label: "Runs" },
  { tab: "triggers", label: "Triggers" },
  { tab: "inputs", label: "Inputs" },
  { tab: "source", label: "Source" },
] as const;

export type WorkflowTab = (typeof WORKFLOW_TABS)[number]["tab"];

/** Renders the clock for a schedule or the bolt for events, or nothing for `undefined`. */
function SourceIcon({
  source,
}: {
  readonly source: TriggerSource | undefined;
}): JSX.Element | null {
  if (source === undefined) return null;
  return source === "schedule" ? <ClockIcon size={12} /> : <BoltIcon size={12} />;
}

/** Renders the workflow's name, its description, and its chips. */
export function WorkflowLead({
  name,
  description,
  chips,
}: {
  readonly name: string;
  readonly description: string | undefined;
  readonly chips: ReadonlyArray<WorkflowChip>;
}): JSX.Element {
  return (
    <header className="wfd-lead">
      <h1>{name}</h1>
      {description === undefined ? null : <p className="wfd-gist">{description}</p>}
      <ul className="wfd-chips" aria-label="About this workflow">
        {chips.map((chip) => (
          <li key={chip.key} className={chip.tone === "fail" ? "chip chip--fail" : "chip"}>
            <SourceIcon source={chip.source} />
            {chip.text}
          </li>
        ))}
      </ul>
    </header>
  );
}

/**
 * Renders the heading over the graph: which run it draws, with the run's
 * mark, status and time, or "No runs yet" for a workflow that has none. A
 * run older than the latest offers a way back to the latest.
 */
export function DrawnRunHeading({
  run,
  isLatest,
  onShowLatest,
}: {
  readonly run: RunRow | undefined;
  readonly isLatest: boolean;
  readonly onShowLatest: () => void;
}): JSX.Element {
  if (run === undefined) {
    return (
      <div className="wfd-drawn">
        <h2 className="section-h">No runs yet</h2>
      </div>
    );
  }
  return (
    <div className="wfd-drawn">
      <h2 className="section-h">{isLatest ? "Latest run" : "Run"}</h2>
      <Mark state={run.mark} />
      <span className={`wl-status wl-status--${run.status.tone}`}>{run.status.text}</span>
      <span className="wfd-drawn-time">
        {[run.timeText, run.durationText].filter(Boolean).join(" · ")}
      </span>
      {isLatest ? null : (
        <button type="button" className="btn btn--quiet btn--sm" onClick={onShowLatest}>
          Show the latest
        </button>
      )}
    </div>
  );
}

/**
 * Renders the tab bar: one tab per entry of `WORKFLOW_TABS`, each with the
 * count `counts` gives it, if any.
 */
export function WorkflowTabBar({
  tab,
  counts,
  onPickTab,
}: {
  readonly tab: WorkflowTab;
  readonly counts: Readonly<Partial<Record<WorkflowTab, number>>>;
  readonly onPickTab: (tab: WorkflowTab) => void;
}): JSX.Element {
  return (
    <nav className="tabs" aria-label="Workflow">
      {WORKFLOW_TABS.map((each) => (
        <button
          key={each.tab}
          type="button"
          className={each.tab === tab ? "tab is-on" : "tab"}
          aria-pressed={each.tab === tab}
          onClick={() => onPickTab(each.tab)}
        >
          {each.label}
          {counts[each.tab] === undefined ? null : <small>{counts[each.tab]}</small>}
        </button>
      ))}
    </nav>
  );
}

/** Renders the column heads of the Runs tab, in its rows' grid. */
export function RunTableHeads(): JSX.Element {
  // The heads of every tab are hidden from assistive technology for the
  // reason WorkflowTableHeads gives.
  return (
    <div className="wfd-runs wl-cols" aria-hidden="true">
      <span />
      <span>Status</span>
      <span className="wfd-by">Started by</span>
      <span className="wl-num">Took</span>
      <span className="wl-num">Started</span>
    </div>
  );
}

/**
 * Renders the Runs tab's rows, newest first. The row of `drawnRunId` is
 * selected, and picking a row draws its run on the graph. `endRef` is put
 * after the last row, so the tab can read the next page when it scrolls into
 * view.
 */
export function RunTable({
  rows,
  drawnRunId,
  onPickRun,
  endRef,
}: {
  readonly rows: ReadonlyArray<RunRow>;
  readonly drawnRunId: string | undefined;
  readonly onPickRun: (runId: string) => void;
  readonly endRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  if (rows.length === 0) return <p className="wl-empty">No runs yet</p>;
  return (
    <div className="wfd-rows">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className={row.id === drawnRunId ? "wfd-runs wl-trow is-on" : "wfd-runs wl-trow"}
          aria-pressed={row.id === drawnRunId}
          aria-label={describeRunRow(row)}
          onClick={() => onPickRun(row.id)}
        >
          <span className="wl-mark">
            <Mark state={row.mark} />
          </span>
          <span className={`wl-status wl-status--${row.status.tone}`}>{row.status.text}</span>
          <span className="wl-starts wfd-by">
            <SourceIcon source={row.startedBy.source} />
            <span className="wl-clip">{row.startedBy.text}</span>
          </span>
          <span className="wl-num">{row.durationText}</span>
          <span className="wl-num">{row.timeText}</span>
        </button>
      ))}
      <div ref={endRef} />
    </div>
  );
}

/** Renders the column heads of the Triggers tab, in its rows' grid. */
export function TriggerTableHeads(): JSX.Element {
  return (
    <div className="wfd-triggers wl-cols" aria-hidden="true">
      <span />
      <span>Trigger</span>
      <span className="wfd-does">Does</span>
      <span>Fires on</span>
      <span>State</span>
    </div>
  );
}

/** Renders the Triggers tab's rows, in the order the workflow declares its triggers. */
export function TriggerTable({ rows }: { readonly rows: ReadonlyArray<TriggerRow> }): JSX.Element {
  if (rows.length === 0) {
    return <p className="wl-empty">No triggers. Only you, an agent or another run start it.</p>;
  }
  return (
    <div className="wfd-rows">
      {rows.map((row) => (
        <div key={row.id} className="wfd-triggers wl-trow">
          <span className="wl-mark wfd-icon">
            <SourceIcon source={row.source} />
          </span>
          <span className="wl-name">{row.id}</span>
          <span className="wfd-quiet wfd-does">{row.roleText}</span>
          <span className="wfd-quiet">{row.firesOnText}</span>
          <span className={`wl-status wl-status--${row.status.tone}`}>{row.status.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Renders the column heads of the Inputs tab, in its rows' grid. */
export function InputTableHeads(): JSX.Element {
  return (
    <div className="wfd-inputs wl-cols" aria-hidden="true">
      <span>Input</span>
      <span>Type</span>
      <span />
      <span>Default</span>
    </div>
  );
}

/** Renders the Inputs tab's rows: one per input a run starts with. */
export function InputTable({ rows }: { readonly rows: ReadonlyArray<InputRow> }): JSX.Element {
  if (rows.length === 0) return <p className="wl-empty">This workflow takes no inputs.</p>;
  return (
    <div className="wfd-rows">
      {rows.map((row) => (
        <div key={row.name} className="wfd-inputs wl-trow">
          <span className="wl-name mono">{row.name}</span>
          <span className="wfd-quiet">{row.typeText}</span>
          <span className="wfd-quiet">{row.requiredText}</span>
          <span className="wfd-quiet mono">{row.defaultText}</span>
        </div>
      ))}
    </div>
  );
}

/** Renders the Source tab: the workflow's YAML, as it is stored, to read and copy. */
export function WorkflowSource({ source }: { readonly source: string }): JSX.Element {
  return <pre className="codeblock wfd-source">{source}</pre>;
}
