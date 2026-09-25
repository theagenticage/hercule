import type { JSX, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  describeRunOrigin,
  describeRunStatus,
  findFailedEdge,
  formatPreciseStamp,
  readTimestamps,
  toIdTail,
} from "@hercule/client-core";
import type { Run } from "@hercule/contract";
import { WORK_STATE_HUES, WorkStateMark, cn } from "@hercule/ui";
import { ActorLink } from "../actor-link";
import { FailureText } from "./step-parts";

/** The quiet link style of the breadcrumb back to the run list. */
const QUIET_LINK =
  "-mx-1 rounded-control px-1 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live";

/**
 * Renders the header of a run's page. The first line is a breadcrumb back to
 * the run list and the workflow's name, with the page's actions on the right.
 * The second line shows where the run is: its status mark and status with its
 * duration, why it failed, who started it and how, when it started and ended,
 * and its id's tail, which the CLI takes. A run that failed at an edge has a
 * third line: what went wrong there.
 *
 * The title sits where the shell's top bar puts every other screen's title,
 * so the page does not jump when it opens.
 */
export function RunHeader({
  run,
  now,
  timezone,
  children,
}: {
  readonly run: Run;
  /** The time a live run's duration counts to, in milliseconds since the epoch. */
  readonly now: number;
  readonly timezone: string;
  /** The actions on the right: Cancel, and the question shown before the run is cancelled. */
  readonly children: ReactNode;
}): JSX.Element {
  const origin = describeRunOrigin(run.origin);
  const { startedAt, finishedAt } = readTimestamps(run);
  const started = startedAt ?? run.createdAt;
  return (
    <header className="shrink-0 px-8 pt-[22px]">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[1lh] items-center gap-4 text-title">
        <div className="flex min-w-0 items-baseline gap-2 tracking-[-0.015em]">
          <Link
            to="/runs"
            activeOptions={{ exact: true }}
            className={cn("shrink-0 text-muted", QUIET_LINK)}
          >
            Runs
          </Link>
          <span aria-hidden="true" className="text-faint">
            /
          </span>
          <h1 title={run.plan.name} className="min-w-0 truncate font-emph text-ink">
            {run.plan.name}
          </h1>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1.5 [&_button]:h-8">
          {children}
        </div>
      </div>
      <p className="mt-1.5 flex h-5 min-w-0 items-center gap-2 text-meta whitespace-nowrap text-muted">
        <WorkStateMark state={run.status} />
        <span className={cn("font-emph", WORK_STATE_HUES[run.status] ?? "text-ink")}>
          {describeRunStatus(run, now)}
        </span>
        {run.status !== "failed" ? null : (
          <>
            <Dot />
            <FailureText
              reason={run.failureReason}
              stepId={run.failedStepId}
              edge={findFailedEdge(run)}
            />
          </>
        )}
        <Dot />
        <span>
          {"started by "}
          <ActorLink actor={origin.starter} plainClassName="text-ink" />
          {origin.howStarted === undefined ? null : ` ${origin.howStarted}`}
        </span>
        <Dot />
        <span className="font-mono text-fine tabular-nums">
          <time dateTime={started}>
            {formatPreciseStamp(new Date(started), timezone) ?? started}
          </time>
          {finishedAt === undefined ? null : (
            <>
              <span className="text-faint">{" → "}</span>
              <time dateTime={finishedAt}>
                {formatPreciseStamp(new Date(finishedAt), timezone, new Date(started)) ??
                  finishedAt}
              </time>
            </>
          )}
        </span>
        <Dot />
        <span className="font-mono text-fine text-faint" title={run.id}>
          {`run ${toIdTail(run.id)}`}
        </span>
      </p>
      {/* A `controller-error` failure has no `failureMessage`; the check narrows the type. */}
      {run.status !== "failed" || run.failureReason === "controller-error" ? null : (
        <FailureMessage message={run.failureMessage} />
      )}
    </header>
  );
}

/** Renders what went wrong at the edge a run failed at, or nothing for a run with no message. */
function FailureMessage({ message }: { readonly message: string | undefined }): JSX.Element | null {
  return message === undefined ? null : <p className="mt-1 text-fine text-fail">{message}</p>;
}

/** The separator between the facts of the status line. */
function Dot(): JSX.Element {
  return (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
}
