/**
 * The parts of an open workflow (spec 17 §Workflows, "The open workflow"):
 * its lead, its tab bar, and the Runs list's, Triggers' and Inputs' rows.
 * Every component here is presentational: it takes values and callbacks, and
 * the route reads and saves.
 */
import { useId, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { TriggerFiresOn } from "@hercule/contract";
import { hasRunMark } from "@hercule/client-core/run-marks";
import {
  describeRunRow,
  formatRunDuration,
  type InputRow,
  type RunRow,
  type TriggerRow,
  type WorkflowChip,
} from "@hercule/client-core/workflow-detail-rows";
import { useListTime } from "./list-time";
import { useDurationText } from "../../app/age-clock";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { Mark } from "../../marks";
import "../session/messages.css";
import "./workflow-detail.css";

/** Renders the clock of a schedule or the bolt of an event, or nothing for null. */
function FiresOnIcon({ firesOn }: { readonly firesOn: TriggerFiresOn | null }): JSX.Element {
  if (firesOn === "schedule") return <ClockIcon size={12} />;
  if (firesOn === "event") return <BoltIcon size={12} />;
  // A run started by an actor has no icon; the gap keeps the names in line.
  return <span className="no-icon" />;
}

/** Renders `text` in a span with `className`, cut short with an ellipsis by its CSS, with the whole text as its tooltip. */
function FittedText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string | undefined;
}): JSX.Element {
  return (
    <span className={className} title={text}>
      {text}
    </span>
  );
}

/**
 * Renders the lead of an open workflow: its name with its switch, what the
 * switch does, its description, and its chips. `error` is why the switch's
 * last save failed, shown under the name as an alert. The name is the page's
 * heading, with the id `headingId`, so the page can take its name from it.
 * The switch is described by the line saying what it does, and by `error`
 * while there is one.
 */
export function WorkflowLead({
  headingId,
  name,
  description,
  isEnabled,
  error,
  chips,
  timezone,
  onToggle,
}: {
  readonly headingId: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly isEnabled: boolean;
  readonly error: string | null;
  readonly chips: ReadonlyArray<WorkflowChip>;
  readonly timezone: string;
  readonly onToggle: () => void;
}): JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <>
      <div className="open-name">
        <h1 id={headingId} title={name}>
          {name}
        </h1>
        <label className="open-switch">
          Enabled
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={isEnabled}
            aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
            onClick={onToggle}
          />
        </label>
      </div>
      {error === null ? null : (
        <p id={errorId} className="open-err" role="alert">
          {error}
        </p>
      )}
      {description === undefined ? null : <p className="open-gist">{description}</p>}
      <p id={hintId} className="open-hint">
        {isEnabled
          ? "When on, its triggers start runs. Runs already going are not touched."
          : "Its triggers start no runs while it is off. Runs already going are not touched."}
      </p>
      <ul className="chip-row" aria-label="About this workflow">
        {chips.map((chip) => (
          <li key={chip.key} className={chip.tone === "fail" ? "chip chip--fail" : "chip"}>
            {chip.firesOn === null ? null : <FiresOnIcon firesOn={chip.firesOn} />}
            {chip.nextFireAt === null ? (
              <FittedText className="chip-text" text={chip.text} />
            ) : (
              <NextFireText
                className="chip-text"
                at={chip.nextFireAt}
                timezone={timezone}
                prefix={`${chip.text} · next `}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Renders `prefix` and when a trigger fires next, as a list shows a time to
 * come, kept current, as `FittedText` with `className`.
 */
function NextFireText({
  at,
  timezone,
  prefix,
  className,
}: {
  readonly at: string;
  readonly timezone: string;
  readonly prefix: string;
  readonly className?: string | undefined;
}): JSX.Element {
  const text = `${prefix}${useListTime(at, timezone, "future", true)}`;
  return <FittedText className={className} text={text} />;
}

/** The open workflow's four tabs. */
export type WorkflowTab = "runs" | "triggers" | "inputs" | "source";

const TABS: ReadonlyArray<{ readonly tab: WorkflowTab; readonly label: string }> = [
  { tab: "runs", label: "Runs" },
  { tab: "triggers", label: "Triggers" },
  { tab: "inputs", label: "Inputs" },
  { tab: "source", label: "Source" },
];

/** Returns the id of the element for `tab` under `baseId`: its tab, or its tab panel. */
export const buildTabElementId = (
  baseId: string,
  tab: WorkflowTab,
  part: "tab" | "panel",
): string => `${baseId}-${part}-${tab}`;

/**
 * Renders the tab bar: the four ARIA tabs, with the Triggers' and Inputs'
 * counts, then `tools` at the bar's right end. Only the open tab is in the
 * tab order. ←/→ move to the previous or next tab and open it, and Home and
 * End to the first and the last.
 */
export function WorkflowTabBar({
  baseId,
  tab,
  triggerCount,
  inputCount,
  tools,
  onSelect,
}: {
  readonly baseId: string;
  readonly tab: WorkflowTab;
  readonly triggerCount: number;
  readonly inputCount: number;
  readonly tools: ReactNode;
  readonly onSelect: (tab: WorkflowTab) => void;
}): JSX.Element {
  const counts: Partial<Record<WorkflowTab, number>> = {
    triggers: triggerCount,
    inputs: inputCount,
  };
  const moveFocus = (event: KeyboardEvent<HTMLElement>): void => {
    const index = TABS.findIndex((each) => each.tab === tab);
    const next =
      event.key === "ArrowLeft"
        ? (index + TABS.length - 1) % TABS.length
        : event.key === "ArrowRight"
          ? (index + 1) % TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? TABS.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const nextTab = TABS[next]!.tab;
    onSelect(nextTab);
    document.getElementById(buildTabElementId(baseId, nextTab, "tab"))?.focus();
  };
  return (
    <div className="tab-bar">
      <div className="tabs" role="tablist" aria-label="Workflow" onKeyDown={moveFocus}>
        {TABS.map(({ tab: each, label }) => {
          const isOn = each === tab;
          const count = counts[each];
          return (
            <button
              key={each}
              type="button"
              className={isOn ? "tab is-on" : "tab"}
              role="tab"
              id={buildTabElementId(baseId, each, "tab")}
              aria-controls={buildTabElementId(baseId, each, "panel")}
              aria-selected={isOn}
              tabIndex={isOn ? 0 : -1}
              onClick={() => {
                onSelect(each);
              }}
            >
              {label}
              {count === undefined ? null : <small>{count}</small>}
            </button>
          );
        })}
      </div>
      {tools === null ? null : <span className="tab-tools">{tools}</span>}
    </div>
  );
}

/**
 * Renders the column heads of the Runs list. They are hidden from assistive
 * technology, because each row's accessible name already describes its cells.
 */
export function RunTableHeads(): JSX.Element {
  return (
    <div className="table-heads tbl-runs" aria-hidden="true">
      <span />
      <span>Status</span>
      <span className="col-by">Started by</span>
      <span className="table-num">Took</span>
      <span className="table-num">Started</span>
    </div>
  );
}

/** Renders the column heads of the Triggers tab, hidden from assistive technology. */
export function TriggerTableHeads(): JSX.Element {
  return (
    <div className="table-heads tbl-triggers" aria-hidden="true">
      <span />
      <span>Trigger</span>
      <span className="col-does">Does</span>
      <span>Fires on</span>
      <span>State</span>
      <span />
    </div>
  );
}

/** Renders the column heads of the Inputs tab, hidden from assistive technology. */
export function InputTableHeads(): JSX.Element {
  return (
    <div className="table-heads tbl-inputs" aria-hidden="true">
      <span>Input</span>
      <span>Type</span>
      <span>Required</span>
      <span>Default</span>
    </div>
  );
}

/**
 * Renders one run's row in the Runs list, a link to the run's page: its mark
 * and status, who started it, how long it took, and when it started, with
 * the times kept current by the age clock. A cancelled run, and one that has
 * not started, has no mark, so its words stand in the mark's column.
 * `onScreen` is whether the row is in view, which keeps its times current.
 * The list item around it is the caller's, because the virtualized list
 * positions each row in a wrapper of its own.
 */
export function RunListRow({
  row,
  timezone,
  onScreen,
}: {
  readonly row: RunRow;
  readonly timezone: string;
  readonly onScreen: boolean;
}): JSX.Element {
  const startedText = useListTime(row.createdAt, timezone, "past", onScreen);
  // A run that has not started a step has no duration to count.
  const tookText = useDurationText(
    row.startedAt ?? row.createdAt,
    row.isLive && row.startedAt !== null && onScreen,
    (now) => formatRunDuration(row, now),
  );
  const statusClass = [
    "status-text",
    row.statusTone === "muted" ? "" : `status-text--${row.statusTone}`,
    hasRunMark(row.state) ? "" : "status-text--no-mark",
  ]
    .filter((name) => name !== "")
    .join(" ");
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: row.id }}
      className="table-row tbl-runs"
      aria-label={describeRunRow(row, startedText, tookText)}
    >
      {hasRunMark(row.state) ? (
        <span className="table-mark">
          <Mark state={row.state} />
        </span>
      ) : null}
      <span className={statusClass}>{row.statusText}</span>
      <span className="table-quiet col-by">
        <FiresOnIcon firesOn={row.startedByFiresOn} />
        <span>{row.startedByText}</span>
      </span>
      <span className="table-num">{tookText}</span>
      <span className="table-num">{startedText}</span>
    </Link>
  );
}

/**
 * Renders the Triggers tab's rows, each start trigger with its pause switch.
 * `errors` maps the id of each trigger whose last save failed to why, shown
 * under its row as an alert, which describes the row's switch. When the
 * workflow has no trigger, shows a line of text instead.
 */
export function TriggerTable({
  rows,
  errors,
  timezone,
  onToggle,
}: {
  readonly rows: ReadonlyArray<TriggerRow>;
  readonly errors: ReadonlyMap<string, string>;
  readonly timezone: string;
  readonly onToggle: (triggerId: string) => void;
}): JSX.Element {
  const id = useId();
  if (rows.length === 0) {
    return <p className="table-empty">No triggers. Only you, an agent or another run start it.</p>;
  }
  return (
    <div role="list">
      {rows.map((row) => {
        const error = errors.get(row.id);
        const errorId = `${id}-error-${row.id}`;
        return (
          <div key={row.id} role="listitem">
            <div className="table-row tbl-triggers">
              <span className="table-quiet">
                <FiresOnIcon firesOn={row.firesOn} />
              </span>
              <FittedText className="table-name" text={row.id} />
              <span className="table-quiet col-does" title={row.doesText}>
                {row.doesText}
              </span>
              <span className="table-quiet">
                <FittedText text={row.firesOnText} />
              </span>
              <span
                className={
                  row.stateTone === "fail" ? "status-text status-text--fail" : "table-quiet"
                }
              >
                {row.nextFireAt === null ? (
                  <FittedText text={row.stateText} />
                ) : (
                  <NextFireText at={row.nextFireAt} timezone={timezone} prefix="Next " />
                )}
              </span>
              {row.switch === null ? (
                <span />
              ) : (
                <button
                  type="button"
                  className="toggle"
                  role="switch"
                  aria-checked={row.switch.isActive}
                  aria-label={row.switch.label}
                  aria-describedby={error === undefined ? undefined : errorId}
                  onClick={() => {
                    onToggle(row.id);
                  }}
                />
              )}
            </div>
            {error === undefined ? null : (
              <p id={errorId} className="open-err open-err--row" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Renders the Inputs tab's rows, or a line saying the workflow takes none. */
export function InputTable({ rows }: { readonly rows: ReadonlyArray<InputRow> }): JSX.Element {
  if (rows.length === 0) return <p className="table-empty">This workflow takes no inputs.</p>;
  return (
    <div role="list">
      {rows.map((row) => (
        <div key={row.name} className="table-row tbl-inputs" role="listitem">
          <FittedText className="table-name" text={row.name} />
          <span className="table-quiet">
            <FittedText text={row.typeText} />
          </span>
          <span className="table-quiet">{row.requiredText}</span>
          <span className="table-quiet table-code">
            <FittedText text={row.defaultText} />
          </span>
        </div>
      ))}
    </div>
  );
}
