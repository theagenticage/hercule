import type { JSX } from "react";
import { Link, useParams, useRouteContext } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  describeFailureReason,
  describeStepSession,
  type RunnerWait,
  type StepLine,
  type StepLineKind,
} from "@hercule/client-core";
import type { FailureReason, StepError } from "@hercule/contract";
import { WorkStateMark, cn } from "@hercule/ui";
import { runSessionsQuery, runnerQuery } from "../../app/queries";
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

/**
 * Renders a failed step's error, under its row: the code a program acts on,
 * in the fail hue, then the sentence, muted. Colour stays at the scale of a
 * word, so only the code is coloured.
 */
export function StepErrorLine({ error }: { readonly error: StepError }): JSX.Element {
  return (
    <p className="pr-2.5 pb-2.5 pl-[42px] text-fine text-muted">
      <span className="font-mono text-fail">{error.code}</span>
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
 * status, such as "Session Fix the login bug · busy". A long title is cut
 * short so the status stays in view. A session that has not been read yet is
 * named by the tail of its id and shows no status. A queued session adds a
 * second line that says what it waits for, such as "Waiting for runner atlas
 * to free a session slot", as a step that waits for a runner does.
 *
 * It reads the run's sessions from the query cache itself, which the run's
 * page fills before it renders. Only a queued session's runner is read, and
 * its wait line shows once that read returns. Fails when it is rendered
 * outside a run's page.
 */
export function StepSessionLine({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { client } = useRouteContext({ from: "/_shell" });
  const { runId } = useParams({ from: "/_shell/runs/$runId" });
  const sessions = useSuspenseQuery(runSessionsQuery(client, runId)).data.items;
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const runner = useQuery({
    ...runnerQuery(client, session?.runnerId ?? ""),
    enabled: session?.status === "queued",
  }).data;
  const reading = describeStepSession(sessionId, sessions, runner);
  return (
    <>
      {/* The words beside the link keep their spaces with `whitespace-pre`:
          a flex item drops the spaces at its edges. */}
      <p className="flex min-w-0 pr-2.5 pb-2.5 pl-[42px] text-fine text-muted">
        <span className="shrink-0 whitespace-pre">{"Session "}</span>
        <Link
          to="/threads/$sessionId"
          params={{ sessionId: reading.sessionId }}
          className={cn(INLINE_LINK, "min-w-0 truncate")}
        >
          {reading.title}
        </Link>
        {reading.status === undefined ? null : (
          <span className="shrink-0 whitespace-pre">{` · ${reading.status}`}</span>
        )}
      </p>
      {reading.wait === undefined ? null : (
        <p className="pr-2.5 pb-2.5 pl-[42px] text-fine text-muted">{reading.wait}</p>
      )}
    </>
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
