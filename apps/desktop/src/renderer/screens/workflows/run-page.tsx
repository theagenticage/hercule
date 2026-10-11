/**
 * The parts of a run's page (spec 17 §Workflows, "A run's page"), top to
 * bottom:
 *
 * - the header: the crumb from Workflows through the run's workflow to the
 *   run, and the run's actions;
 * - the lead: how the run stands and how long it has run, what it asks the
 *   user or why it failed, who started it, its inputs and its output;
 * - what the web app's run page shows besides: the re-runs, the runner, the
 *   workspace, why the run waits for a runner, and the event that started it;
 * - the band over the steps, with the switch between Graph and Timeline.
 *
 * Every part takes values and callbacks and reads nothing besides the age
 * clock, which keeps its times current.
 */
import { Fragment, type JSX, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  formatDuration,
  formatPreciseStamp,
  formatStamp,
  isWebLink,
  measureElapsed,
  toIdTail,
  type RerunsReading,
} from "@hercule/client-core";
import { hasRunMark, type RunMarkState } from "@hercule/client-core/run-marks";
import type { RunLead } from "@hercule/client-core/run-page-rows";
import type { Runner, TriggerEvent } from "@hercule/contract";
import { useDurationText } from "../../app/age-clock";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { Mark } from "../../marks";
import { useStartTime } from "./list-time";
import { ViewSwitch, type ViewChoice } from "./view-switch";
import "../session/floating-header.css";
import "../thread/thread-header.css";
import "./workflow-list.css";
import "./workflow-detail.css";
import "./run-page.css";

/** The two ways a run's page shows its steps. */
export type StepsView = "graph" | "timeline";

const STEPS_VIEWS: readonly [ViewChoice<StepsView>, ViewChoice<StepsView>] = [
  { view: "graph", label: "Graph" },
  { view: "timeline", label: "Timeline" },
];

/**
 * The workflow a run's crumb leads back to: one the user can open, or the
 * name of one that is gone, with why there is no page to open: "not saved"
 * when the run was started from a workflow that was never saved, or
 * "deleted".
 */
export type RunCrumbWorkflow =
  | { readonly kind: "saved"; readonly workflowId: string; readonly name: string }
  | { readonly kind: "gone"; readonly name: string; readonly reason: "not saved" | "deleted" };

/** One button of the header's action pill, such as "Cancel run…". */
export interface RunAction {
  readonly label: string;
  readonly onPress: () => void;
}

/**
 * Renders the header of a run's page, as the book's run page draws it: the
 * crumb, named "The run's place in Workflows", with Workflows and the run's
 * workflow, each a link back, then the run as the open tab, with its mark and
 * `startedAt`, when it started, in `timezone`: "Today 10:31", "Fri 14:00",
 * then "25 Sep 14:00". A run that has not started passes when it was
 * created. A workflow that is gone shows its name with why it is gone, and
 * no link. `actions` follow in a pill of their own at the far end.
 */
export function RunTop({
  workflow,
  mark,
  startedAt,
  timezone,
  actions,
}: {
  readonly workflow: RunCrumbWorkflow;
  readonly mark: RunMarkState;
  readonly startedAt: string;
  readonly timezone: string;
  readonly actions: ReadonlyArray<RunAction>;
}): JSX.Element {
  const startedText = useStartTime(startedAt, timezone);
  return (
    <header className="top">
      <nav className="pill run-crumbs" aria-label="The run's place in Workflows">
        <span className="pill-crumb">
          <Link to="/workflows">Workflows</Link>
        </span>
        <span className="pill-crumb">
          {workflow.kind === "saved" ? (
            <Link
              to="/workflows/$workflowId"
              params={{ workflowId: workflow.workflowId }}
              title={workflow.name}
            >
              {workflow.name}
            </Link>
          ) : (
            <span title={`${workflow.name}, ${workflow.reason}`}>
              {workflow.name}
              <small>{workflow.reason}</small>
            </span>
          )}
        </span>
        <span className="ptab is-on" aria-current="page">
          {hasRunMark(mark) ? <Mark state={mark} /> : null}
          Run <small>{startedText}</small>
        </span>
      </nav>
      <span className="spacer" />
      <span className="pill">
        {actions.map((action) => (
          <button key={action.label} type="button" className="pill-btn" onClick={action.onPress}>
            {action.label}
          </button>
        ))}
      </span>
    </header>
  );
}

/**
 * Renders the lead of a run's page: its mark and state as the page's
 * heading, with how long it has run or took, kept current while `isLive`;
 * what it asks the user, with Open thread, which calls `onOpenSession`, or
 * why it failed, as an alert; who started it; and its inputs, with its
 * output under them. `startedAt` and `finishedAt` are the run's, and a run
 * that has not started has no duration.
 */
export function RunPageLead({
  headingId,
  lead,
  startedAt,
  finishedAt,
  isLive,
  onOpenSession,
}: {
  readonly headingId: string;
  readonly lead: RunLead;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  readonly isLive: boolean;
  readonly onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const tookText = useDurationText(startedAt ?? "", isLive && startedAt !== undefined, (now) => {
    const elapsed = measureElapsed(startedAt, finishedAt, now);
    return elapsed === undefined ? "" : formatDuration(elapsed);
  });
  const { ask, failure, startedBy, inputs, output } = lead;
  return (
    <>
      <div className="open-name">
        <h1 id={headingId} className="run-state">
          {hasRunMark(lead.mark) ? <Mark state={lead.mark} size={16} /> : null}
          {lead.stateText}
        </h1>
        {tookText === "" ? null : <span className="run-took">{tookText}</span>}
      </div>
      {ask === undefined ? null : (
        <div className="run-gist run-gist--you">
          <p>{ask.question}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onOpenSession(ask.sessionId)}
          >
            Open thread
          </button>
        </div>
      )}
      {failure === undefined ? null : (
        <div className="run-gist run-gist--fail" role="alert">
          <p>{failure}</p>
        </div>
      )}
      <ul className="chip-row" aria-label="About this run">
        <li className="chip">
          {startedBy.firesOn === "schedule" ? <ClockIcon size={12} /> : null}
          {startedBy.firesOn === "event" ? <BoltIcon size={12} /> : null}
          {`Started by ${startedBy.text}`}
        </li>
      </ul>
      {inputs.length === 0 && output === undefined ? null : (
        <dl
          className="run-inputs"
          aria-label={output === undefined ? "Inputs" : "Inputs and output"}
        >
          {inputs.map((input) => (
            <Fact key={input.name} term={input.name} title={input.value}>
              {input.value}
            </Fact>
          ))}
          {output === undefined ? null : (
            <Fact term={output.name} title={output.value}>
              {output.value}
            </Fact>
          )}
        </dl>
      )}
    </>
  );
}

/** Renders a link to the page of the run with `runId`, named by its id's tail: "run 1f3a9c2e". */
function RunLink({ runId }: { readonly runId: string }): JSX.Element {
  return (
    <Link to="/runs/$runId" params={{ runId }} title={runId}>
      {`run ${toIdTail(runId)}`}
    </Link>
  );
}

/** Renders one row of a facts list: `term`, then `children`, in mono when `isCode`. */
function Fact({
  term,
  isCode,
  title,
  children,
}: {
  readonly term: string;
  readonly isCode?: boolean;
  readonly title?: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div>
      <dt>{term}</dt>
      <dd className={isCode === true ? "is-code" : undefined} title={title}>
        {children}
      </dd>
    </div>
  );
}

/**
 * Renders what the web app's run page shows about a run besides its lead, as
 * rows of a facts list, in this order and each only when there is something
 * to show:
 *
 * - "Re-run of", the run this one re-ran, and "Re-run as", the runs that
 *   re-ran it (`describeReruns`), each a link to its page;
 * - the runner the run is pinned to, with whether the controller can reach
 *   it, and when it was last seen while it cannot;
 * - the run's workspace, `workspaceLabel`, with `workspaceNote`, what
 *   happens to it, and Delete workspace…, which calls `onDeleteWorkspace`,
 *   when the workspace can be deleted;
 * - why the run waits for a runner, `runnerWaitText`.
 *
 * Renders nothing when there is no row.
 */
export function RunFacts({
  originalRunId,
  reruns,
  runner,
  workspaceLabel,
  workspaceNote,
  onDeleteWorkspace,
  runnerWaitText,
  timezone,
}: {
  readonly originalRunId: string | undefined;
  readonly reruns: RerunsReading;
  readonly runner: Runner | undefined;
  readonly workspaceLabel: string | undefined;
  readonly workspaceNote: string | undefined;
  readonly onDeleteWorkspace: (() => void) | undefined;
  readonly runnerWaitText: string | undefined;
  readonly timezone: string;
}): JSX.Element | null {
  if (
    originalRunId === undefined &&
    reruns.runIds.length === 0 &&
    runner === undefined &&
    workspaceLabel === undefined &&
    runnerWaitText === undefined
  ) {
    return null;
  }
  const lastSeenAt =
    runner === undefined || runner.connectivity === "online" ? null : runner.lastSeenAt;
  return (
    <dl className="run-inputs run-facts" aria-label="Where the run works">
      {originalRunId === undefined ? null : (
        <Fact term="Re-run of">
          <RunLink runId={originalRunId} />
        </Fact>
      )}
      {reruns.runIds.length === 0 ? null : (
        <Fact term="Re-run as">
          {reruns.runIds.map((runId, index) => (
            <Fragment key={runId}>
              {index === 0 ? null : ", "}
              <RunLink runId={runId} />
            </Fragment>
          ))}
          {reruns.unlinkedCountText === undefined ? null : ` and ${reruns.unlinkedCountText}`}
        </Fact>
      )}
      {runner === undefined ? null : (
        <Fact term="Runner">
          {runner.name}
          <span className="is-faint">
            {` · ${runner.connectivity}`}
            {lastSeenAt === null
              ? null
              : `, last seen ${formatStamp(new Date(lastSeenAt), timezone) ?? lastSeenAt}`}
          </span>
        </Fact>
      )}
      {workspaceLabel === undefined ? null : (
        <Fact
          term="Workspace"
          title={
            workspaceNote === undefined ? workspaceLabel : `${workspaceLabel} · ${workspaceNote}`
          }
        >
          {workspaceLabel}
          {workspaceNote === undefined ? null : (
            <span className="is-faint">{` · ${workspaceNote}`}</span>
          )}
          {onDeleteWorkspace === undefined ? null : (
            <>
              {" "}
              <button type="button" className="fact-action" onClick={onDeleteWorkspace}>
                Delete workspace…
              </button>
            </>
          )}
        </Fact>
      )}
      {runnerWaitText === undefined ? null : (
        <Fact term="Waiting" title={runnerWaitText}>
          {runnerWaitText}
        </Fact>
      )}
    </dl>
  );
}

/**
 * Renders the event that started a run, as the web app's Triggering event
 * card lists it: its title and author when the plugin gave them, its kind,
 * its source, when it occurred, its position in the event log with a link to
 * the event in its own system, and its payload as JSON. An address that is
 * not http or https is not linked, because a plugin or an agent sets it and
 * it could lead anywhere.
 */
export function TriggeringEvent({
  event,
  timezone,
}: {
  readonly event: TriggerEvent;
  readonly timezone: string;
}): JSX.Element {
  const payload = JSON.stringify(event.payload);
  return (
    <dl className="run-inputs run-facts" aria-label="Triggering event">
      {event.title === null ? null : (
        <Fact term="Title" title={event.title}>
          {event.title}
        </Fact>
      )}
      <Fact term="Kind" isCode title={event.kind}>
        {event.kind}
      </Fact>
      <Fact term="Source" isCode title={event.source}>
        {event.source}
      </Fact>
      {event.author === null ? null : <Fact term="Author">{event.author}</Fact>}
      <Fact term="Occurred">
        <time dateTime={event.occurredAt}>
          {formatPreciseStamp(new Date(event.occurredAt), timezone) ?? event.occurredAt}
        </time>
      </Fact>
      <Fact term="Event" isCode>
        {String(event.id)}
        {event.url === null || !isWebLink(event.url) ? null : (
          <>
            {" "}
            <a href={event.url} target="_blank" rel="noreferrer" title={event.url}>
              Open
            </a>
          </>
        )}
      </Fact>
      <Fact term="Payload" isCode title={payload}>
        {payload}
      </Fact>
    </dl>
  );
}

/**
 * Renders the band over the steps: the heading "Steps" with `count`, the
 * number of the steps' rows, and the switch "Show the steps as" between the
 * graph and the timeline, which calls `onPickView`. `children`, such as the
 * timeline's column heads, sit under the bar, inside the sticky band.
 */
export function StepsBand({
  count,
  view,
  onPickView,
  children,
}: {
  readonly count: number;
  readonly view: StepsView;
  readonly onPickView: (view: StepsView) => void;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className="tab-band">
      <div className="tab-bar">
        <h2 className="section-h run-steps">
          Steps <small>{count}</small>
        </h2>
        <span className="tab-tools">
          <ViewSwitch
            label="Show the steps as"
            choices={STEPS_VIEWS}
            view={view}
            onPick={onPickView}
          />
        </span>
      </div>
      {children}
    </div>
  );
}
