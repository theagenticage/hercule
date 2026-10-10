/**
 * PROTOTYPE. The parts of an open workflow's page, top to bottom:
 *
 * - its lead: the name with the switch that turns the workflow on or off,
 *   the description, and chips that say what starts it and what its steps
 *   run;
 * - its tabs, and the table each one shows: the runs, the triggers, the
 *   inputs, or the source.
 *
 * Every part takes values and callbacks and reads nothing. Changing the
 * workflow itself comes with the ticket on creating and editing workflows.
 */
import { Fragment, type JSX, type RefObject } from "react";
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
export function SourceIcon({
  source,
}: {
  readonly source: TriggerSource | undefined;
}): JSX.Element | null {
  if (source === undefined) return null;
  return source === "schedule" ? <ClockIcon size={12} /> : <BoltIcon size={12} />;
}

/**
 * Explains the workflow's switch: turning a workflow off stops its triggers,
 * and nothing else (spec 07 §1).
 */
const ENABLED_HINT = "When off, its triggers start no runs. You can still run it yourself.";

/**
 * Renders the workflow's name with its switch, its description, and its
 * chips. Pressing the switch calls `onToggleEnabled`. `error`, when given,
 * says why the switch's last save failed, under the name.
 */
export function WorkflowLead({
  name,
  description,
  chips,
  enabled,
  onToggleEnabled,
  error,
}: {
  readonly name: string;
  readonly description: string | undefined;
  readonly chips: ReadonlyArray<WorkflowChip>;
  readonly enabled: boolean;
  readonly onToggleEnabled: () => void;
  readonly error: string | null;
}): JSX.Element {
  return (
    <header className="wfd-lead">
      <div className="wfd-name">
        <h1>{name}</h1>
        <label className="wfd-switch" title={ENABLED_HINT}>
          Enabled
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={enabled}
            onClick={onToggleEnabled}
          />
        </label>
      </div>
      {error === null ? null : (
        <p className="wfd-err" role="alert">
          {error}
        </p>
      )}
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
 * Renders the Runs tab's rows, newest first. Picking a row opens its run's
 * page. `endRef` is put after the last row, so the tab can read the next
 * page when it scrolls into view.
 */
export function RunTable({
  rows,
  onOpenRun,
  endRef,
}: {
  readonly rows: ReadonlyArray<RunRow>;
  readonly onOpenRun: (runId: string) => void;
  readonly endRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  if (rows.length === 0) return <p className="wl-empty">No runs yet</p>;
  return (
    <div className="wfd-rows">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className="wfd-runs wl-trow"
          aria-label={describeRunRow(row)}
          onClick={() => onOpenRun(row.id)}
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
      <span />
    </div>
  );
}

/**
 * Renders the Triggers tab's rows, in the order the workflow declares its
 * triggers. A start trigger's row ends in its switch, and pressing it calls
 * `onToggleTrigger` with the trigger's id. A signal trigger cannot be
 * paused, so its row has none. `error`, when given, says why the last save
 * of a trigger's switch failed, under that trigger's row.
 */
export function TriggerTable({
  rows,
  onToggleTrigger,
  error,
}: {
  readonly rows: ReadonlyArray<TriggerRow>;
  readonly onToggleTrigger: (triggerId: string) => void;
  readonly error: { readonly triggerId: string; readonly text: string } | null;
}): JSX.Element {
  if (rows.length === 0) {
    return <p className="wl-empty">No triggers. Only you, an agent or another run start it.</p>;
  }
  return (
    <div className="wfd-rows">
      {rows.map((row) => (
        <Fragment key={row.id}>
          <div className="wfd-triggers wl-trow">
            <span className="wl-mark wfd-icon">
              <SourceIcon source={row.source} />
            </span>
            <span className="wl-name">{row.id}</span>
            <span className="wfd-quiet wfd-does">{row.roleText}</span>
            <span className="wfd-quiet">{row.firesOnText}</span>
            <span className={`wl-status wl-status--${row.status.tone}`}>{row.status.text}</span>
            {row.isActive === undefined ? (
              <span />
            ) : (
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={row.isActive}
                aria-label={`${row.id} starts runs`}
                onClick={() => onToggleTrigger(row.id)}
              />
            )}
          </div>
          {error?.triggerId === row.id ? (
            <p className="wfd-err" role="alert">
              {error.text}
            </p>
          ) : null}
        </Fragment>
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
