/**
 * PROTOTYPE. The parts of a run's page, top to bottom:
 *
 * - the header: a crumb from Workflows through the run's workflow to the
 *   run, and the run's one action, Cancel while it is live and Re-run once
 *   it has ended;
 * - the lead: how the run stands and how long it has run, what it asks the
 *   user or why it failed, who started it and when, and its inputs;
 * - a note when the run followed an earlier version of its workflow;
 * - its steps, as the graph of the plan it froze or on a time axis;
 * - the dialogs that confirm a cancel and a re-run.
 *
 * Every part takes values and callbacks and reads nothing.
 */
import { useRef, useState, type JSX, type RefObject } from "react";
import { Link } from "@tanstack/react-router";
import type { listRerunChoices } from "@hercule/client-core";
import { Mark } from "../../marks/mark";
import type { MarkState } from "../../marks/mark-state";
import { ConfirmDialog } from "../confirm-dialog";
import type { InputFact, RunLead, StepRow, StepTimelineRows } from "./run-page-rows";
import { SourceIcon } from "./workflow-detail";
import "../session/floating-header.css";
// The step timeline draws its rows as the workflow list's table rows
// (`.wl-cols`, `.wl-trow` and their cells), and a run's page can be the
// first Workflows page opened.
import "./workflow-list.css";
import "./run-timeline.css";
import "./run-page.css";

/** The two ways a run's page shows its steps. */
export type StepsView = "graph" | "timeline";

/** One way to re-run a run, as `listRerunChoices` lists them. */
export type RerunChoice = ReturnType<typeof listRerunChoices>[number];

/** Returns a fraction of the axis as a CSS percentage. */
const formatPlace = (place: number): string => `${String(place * 100)}%`;

/**
 * The workflow a run's crumb leads back to: one the user can open, or the
 * name of one that is gone, with why there is no page to open.
 */
export type RunCrumbWorkflow =
  | { readonly kind: "saved"; readonly workflowId: string; readonly name: string }
  | { readonly kind: "gone"; readonly name: string; readonly why: string };

/**
 * Renders the header of a run's page, as the book's thread header is drawn
 * (desktop/session-active.html): the places the run sits in as crumbs,
 * Workflows and its workflow, each a link back, then the run as the open
 * tab, with its mark and when it started. The run's action follows in a
 * pill of its own: Cancel run while it is live, and Re-run once it has
 * ended. `action` is `undefined` while neither is possible.
 */
export function RunTop({
  workflow,
  mark,
  timeText,
  action,
  onAction,
}: {
  readonly workflow: RunCrumbWorkflow;
  readonly mark: MarkState;
  readonly timeText: string;
  readonly action: "cancel" | "rerun" | undefined;
  readonly onAction: () => void;
}): JSX.Element {
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
            <span title={`${workflow.name}, ${workflow.why}`}>
              {workflow.name}
              <small>{workflow.why}</small>
            </span>
          )}
        </span>
        <span className="ptab is-on" aria-current="page">
          <Mark state={mark} />
          Run
          <small>{timeText}</small>
        </span>
      </nav>
      <span className="spacer" />
      {action === undefined ? null : (
        <div className="pill">
          <button type="button" className="pill-btn" onClick={onAction}>
            {action === "cancel" ? "Cancel run…" : "Re-run…"}
          </button>
        </div>
      )}
    </header>
  );
}

/**
 * Renders the lead of a run's page. A run that waits on the user offers to
 * open the thread whose Request it waits on, with `onOpenSession`.
 */
export function RunLeadView({
  lead,
  durationText,
  inputs,
  onOpenSession,
}: {
  readonly lead: RunLead;
  /** How long the run has run, or ran: "29m 12s". */
  readonly durationText: string;
  readonly inputs: ReadonlyArray<InputFact>;
  readonly onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const { gist, askingSessionId } = lead;
  return (
    <header className="wfd-lead run-lead">
      <div className="wfd-name">
        <h1>
          <Mark state={lead.mark} size={16} />
          {lead.title}
        </h1>
        {durationText === "" ? null : <span className="run-took">{durationText}</span>}
      </div>
      {gist === undefined ? null : (
        <div
          className={`run-gist run-gist--${gist.tone}`}
          role={gist.tone === "fail" ? "alert" : undefined}
        >
          <p>{gist.text}</p>
          {gist.tone === "you" && askingSessionId !== undefined ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onOpenSession(askingSessionId)}
            >
              Open thread
            </button>
          ) : null}
        </div>
      )}
      <ul className="wfd-chips" aria-label="About this run">
        <li className="chip">
          <SourceIcon source={lead.startedBy.source} />
          Started by {lead.startedBy.text}
        </li>
      </ul>
      {inputs.length === 0 ? null : (
        <dl className="run-inputs" aria-label="Inputs">
          {inputs.map((input) => (
            <div key={input.name}>
              <dt>{input.name}</dt>
              <dd title={input.value}>{input.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </header>
  );
}

/**
 * Renders the note a run's page shows when the run followed an earlier
 * version of `name`: what the page then draws, and why.
 */
export function EarlierVersionNote({ name }: { readonly name: string }): JSX.Element {
  return (
    <p className="run-note">
      {`This run followed an earlier version of ${name}. Its steps are shown as they were then.`}
    </p>
  );
}

/**
 * Renders the steps band's bar: the heading, with how many step lines the
 * run has, and the switch between the graph and the time axis.
 */
export function StepsBar({
  count,
  view,
  onPickView,
}: {
  readonly count: number;
  readonly view: StepsView;
  readonly onPickView: (view: StepsView) => void;
}): JSX.Element {
  return (
    <div className="wfd-bar">
      <h2 className="section-h run-steps-h">
        Steps
        <small>{count}</small>
      </h2>
      <div className="wfd-tools">
        <div className="seg" role="group" aria-label="Show the steps as">
          <button type="button" aria-pressed={view === "graph"} onClick={() => onPickView("graph")}>
            Graph
          </button>
          <button
            type="button"
            aria-pressed={view === "timeline"}
            onClick={() => onPickView("timeline")}
          >
            Timeline
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Measures how many characters of the axis labels fit across the axis, so
 * its ticks are as close as their labels allow. Returns the ref to put on
 * the axis's track and the width, 0 until it is measured. The labels are in
 * the monospace font, whose `1ch` is the width of every character.
 */
export function useAxisWidth(): {
  readonly axisRef: (element: HTMLElement | null) => void;
  readonly widthInCharacters: number;
} {
  const [widthInCharacters, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const axisRef = (element: HTMLElement | null): void => {
    observerRef.current?.disconnect();
    if (element === null) return;
    const probe = element.querySelector<HTMLElement>(".rs-ch");
    const measure = (): void => {
      const character = probe?.getBoundingClientRect().width ?? 0;
      setWidth(character === 0 ? 0 : element.getBoundingClientRect().width / character);
    };
    observerRef.current = new ResizeObserver(measure);
    observerRef.current.observe(element);
    measure();
  };
  return { axisRef, widthInCharacters };
}

/**
 * Renders the time axis of the steps, in the band where a table's column
 * heads are: a label at each tick, and while the run is live, how long it
 * has run, in a pill at the axis's end, which is now, as the day timeline
 * draws now.
 */
export function StepAxis({
  timeline,
  axisRef,
}: {
  readonly timeline: StepTimelineRows;
  readonly axisRef: (element: HTMLElement | null) => void;
}): JSX.Element {
  // The axis repeats what each row's duration says in words.
  return (
    <div className="rs-grid wl-cols rs-axis" aria-hidden="true">
      <span />
      <span>Step</span>
      <span ref={axisRef} className="rs-track">
        <i className="rs-ch">0</i>
        {timeline.ticks.map((tick) => (
          <span
            key={tick.position}
            className="rs-tick"
            style={{ "--rt-at": formatPlace(tick.position) }}
          >
            {tick.label}
          </span>
        ))}
        {timeline.nowText === undefined ? null : (
          <b className="rt-now-pill rs-now-pill">{timeline.nowText}</b>
        )}
      </span>
      <span className="wl-num">Took</span>
    </div>
  );
}

/**
 * Renders the steps on the time axis: one row per step line, with its mark,
 * its id, a bar from when it started to when it ended, or to now while it
 * runs, and how long it took. A row of a step that drives a session opens
 * the session's transcript with `onOpenSession`. A failed step says why
 * under its id.
 */
export function StepTimeline({
  timeline,
  isLive,
  onOpenSession,
}: {
  readonly timeline: StepTimelineRows;
  readonly isLive: boolean;
  readonly onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  return (
    <div className="wfd-rows rs-rows">
      {timeline.rows.map((row, order) => (
        <StepTimelineRow
          key={row.key}
          row={row}
          order={order}
          ticks={timeline.ticks}
          isLive={isLive}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}

/** Renders one row of the step timeline. `order` staggers the bars as they arrive. */
function StepTimelineRow({
  row,
  order,
  ticks,
  isLive,
  onOpenSession,
}: {
  readonly row: StepRow;
  readonly order: number;
  readonly ticks: StepTimelineRows["ticks"];
  readonly isLive: boolean;
  readonly onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const content = (
    <>
      <span className="wl-mark">{row.mark === undefined ? null : <Mark state={row.mark} />}</span>
      <span className="rs-step">
        <span
          className={row.mark === undefined ? "wl-name rs-step-id is-quiet" : "wl-name rs-step-id"}
        >
          {row.stepId}
          {row.iterationLabel === undefined ? null : <small>{row.iterationLabel}</small>}
        </span>
        {row.errorText === undefined ? null : <span className="rs-err">{row.errorText}</span>}
      </span>
      <span className="rs-track">
        {ticks.map((tick) => (
          <i
            key={tick.position}
            className="rt-line"
            style={{ "--rt-at": formatPlace(tick.position) }}
          />
        ))}
        {isLive ? <i className="rt-now" style={{ "--rt-at": "calc(100% - 1px)" }} /> : null}
        {row.note === undefined ? null : (
          <span
            className="rs-note"
            style={{
              "--rt-at": formatPlace(row.note.position),
            }}
          >
            {row.note.text}
          </span>
        )}
        {row.bar === undefined ? null : (
          <span
            className={row.tone === undefined ? "rs-bar" : `rs-bar rs-bar--${row.tone}`}
            style={{
              "--rt-at": formatPlace(row.bar.start),
              "--rt-span": formatPlace(row.bar.end - row.bar.start),
              "--rt-order": String(order),
            }}
          >
            <i className="rt-fill" />
            {row.mark === undefined ? null : <Mark key={row.mark} state={row.mark} />}
          </span>
        )}
      </span>
      <span className="wl-num">{row.durationText}</span>
    </>
  );
  const label = `${row.stepId}${row.iterationLabel === undefined ? "" : ` ${row.iterationLabel}`}`;
  return row.sessionId === undefined ? (
    <div className="rs-grid wl-trow rs-row">{content}</div>
  ) : (
    <button
      type="button"
      className="rs-grid wl-trow rs-row"
      title={`Open ${label}'s thread`}
      onClick={() => onOpenSession(row.sessionId!)}
    >
      {content}
    </button>
  );
}

/**
 * Renders the dialog that confirms a re-run. With more than one way to
 * re-run, a switch picks one, and the chosen way's explanation shows under
 * it. The re-run starts with the run's inputs whichever way is picked.
 */
export function RerunDialog({
  dialogRef,
  choices,
  mode,
  onPickMode,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly choices: ReadonlyArray<RerunChoice>;
  readonly mode: RerunChoice["mode"];
  readonly onPickMode: (mode: RerunChoice["mode"]) => void;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const chosen = choices.find((choice) => choice.mode === mode) ?? choices[0];
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title="Re-run with the same inputs?"
      actionLabel={pending ? "Starting…" : "Re-run"}
      actionClass="accent"
      pending={pending}
      error={error}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {choices.length > 1 ? (
        <div className="seg run-rerun-seg" role="group" aria-label="Re-run">
          {choices.map((choice) => (
            <button
              key={choice.mode}
              type="button"
              aria-pressed={choice.mode === mode}
              onClick={() => onPickMode(choice.mode)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
      {chosen === undefined ? null : <p>{chosen.explanation}</p>}
    </ConfirmDialog>
  );
}

/**
 * Renders the dialog that confirms cancelling a live run. Cancelling stops
 * its steps and their sessions, and deletes the run's workspace when
 * `hasWorkspace` is true (spec 07 §7.2). It cannot be undone.
 */
export function CancelRunDialog({
  dialogRef,
  hasWorkspace,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly hasWorkspace: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title="Cancel this run?"
      actionLabel={pending ? "Cancelling…" : "Cancel run"}
      actionClass="danger"
      pending={pending}
      error={error}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <p>
        {hasWorkspace
          ? "Its running steps stop, their sessions end, and its workspace is deleted. You can re-run it afterwards."
          : "Its running steps stop and their sessions end. You can re-run it afterwards."}
      </p>
    </ConfirmDialog>
  );
}
