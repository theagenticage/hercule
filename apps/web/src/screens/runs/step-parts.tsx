import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import {
  describeFailureReason,
  describeStepSession,
  type RunnerWait,
  type StepLine,
  type StepLineKind,
} from "@hercule/client-core";
import type { FailureReason, Session, StepError } from "@hercule/contract";
import { WorkStateMark, cn } from "@hercule/ui";
import { INLINE_LINK } from "../actor-link";

/** The words in place of an action on a line that is not an action step's. */
const KIND_LABELS: Readonly<Record<Exclude<StepLineKind, "action">, string>> = {
  agent: "Agent step",
  signal: "Signal",
};

/**
 * Renders the first two cells of a step's line, in the step list and on the timeline:
 * the state mark, then the step id, its iteration (`#2`) when the step has
 * more than one step record, and the action it calls. An agent step's line
 * says "Agent step" in place of the action, and a signal's line "Signal",
 * not in mono, because they are words rather than names from the plan. A step
 * the run has not reached has no mark, and its id recedes.
 *
 * The space between the cells keeps their words apart when the row is read
 * as text, as a screen reader reads it; between grid cells it takes no room.
 */
export function StepCells({ line }: { readonly line: StepLine }): JSX.Element {
  return (
    <>
      <span className="flex items-center" aria-hidden="true">
        <WorkStateMark state={line.state} />
      </span>{" "}
      <span className="flex min-w-0 items-baseline gap-2.5">
        <span className="flex min-w-0 items-baseline gap-1">
          <span
            className={cn(
              "truncate font-mono text-row font-emph",
              line.state === "unreached" ? "text-muted" : "text-ink",
            )}
          >
            {line.stepId}
          </span>{" "}
          {line.iterationLabel === undefined ? null : (
            <span className="shrink-0 font-mono text-fine text-faint">{line.iterationLabel}</span>
          )}
        </span>{" "}
        <span
          className={cn("truncate text-fine text-faint", line.kind === "action" && "font-mono")}
        >
          {line.kind === "action" ? line.action : KIND_LABELS[line.kind]}
        </span>
      </span>
    </>
  );
}

/** Renders a failed step's error, under its row: the code a program acts on, then the sentence. */
export function StepErrorLine({ error }: { readonly error: StepError }): JSX.Element {
  return (
    <p className="pr-2.5 pb-2.5 pl-[42px] text-fine text-fail">
      <span className="font-mono">{error.code}</span>
      {` · ${error.message}`}
    </p>
  );
}

/**
 * Renders the line under a pending or running step that waits for a runner,
 * when `runnerWait` names the step, and nothing otherwise. The state check
 * keeps the line off the step's earlier records, which have ended.
 */
export function StepWaitLine({
  line,
  runnerWait,
}: {
  readonly line: StepLine;
  readonly runnerWait: RunnerWait | undefined;
}): JSX.Element | null {
  const isLive = line.state === "pending" || line.state === "running";
  if (!isLive || runnerWait?.stepIds.has(line.stepId) !== true) return null;
  return <p className="pr-2.5 pb-2.5 pl-[42px] text-fine text-muted">{runnerWait.text}</p>;
}

/**
 * Renders the line under an agent step's record that names the session the
 * record drives, as a link to the session's thread, followed by the session's
 * status, such as "Session Fix the login bug · busy". A session that has not
 * been read yet is named by the tail of its id and shows no status. Renders
 * nothing for a line with no session: any line but an agent step's, and an
 * agent step's before its session starts.
 */
export function StepSessionLine({
  line,
  sessions,
}: {
  readonly line: StepLine;
  /** The sessions the run's agent steps started, by id. */
  readonly sessions: ReadonlyMap<string, Session>;
}): JSX.Element | null {
  const reading = describeStepSession(line.sessionId, sessions);
  if (reading === undefined) return null;
  return (
    <p className="truncate pr-2.5 pb-2.5 pl-[42px] text-fine text-muted">
      {"Session "}
      <Link
        to="/threads/$sessionId"
        params={{ sessionId: reading.sessionId }}
        className={INLINE_LINK}
      >
        {reading.title}
      </Link>
      {reading.status === undefined ? null : ` · ${reading.status}`}
    </p>
  );
}

/**
 * Renders why a run failed, in the fail hue: "step failed at create_task", or
 * for a run that failed at an edge, "iteration limit at count → file".
 */
export function FailureText({
  reason,
  stepId,
  edge,
}: {
  readonly reason: FailureReason;
  readonly stepId: string | undefined;
  /** The edge the run failed at, when it failed at one and the plan is at hand. */
  readonly edge?: { readonly from: string; readonly to: string } | undefined;
}): JSX.Element {
  return (
    <span className="text-fail">
      {describeFailureReason(reason)}
      {stepId === undefined && edge === undefined ? null : (
        <>
          {" at "}
          <span className="font-mono text-fine">
            {edge === undefined ? stepId : `${edge.from} → ${edge.to}`}
          </span>
        </>
      )}
    </span>
  );
}
