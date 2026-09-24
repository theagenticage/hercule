import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describeRunOrigin, formatAge, shouldRunRecede } from "@hercule/client-core";
import type { RunSummary } from "@hercule/contract";
import { WORK_STATE_HUES, WorkStateMark, cn } from "@hercule/ui";
import { FailureText } from "./step-parts";

/**
 * One run in the run list: its status mark and word, the workflow's name, the
 * failure reason when it failed, who started it, and its age. The whole row
 * links to the run's page. A finished run that did not fail recedes, so the
 * runs still going and the runs that failed stand out.
 */
export function RunRow({
  run,
  now,
}: {
  readonly run: RunSummary;
  /** The time the age counts to. */
  readonly now: Date;
}): JSX.Element {
  const { starter } = describeRunOrigin(run.origin);
  return (
    <li>
      <Link
        to="/runs/$runId"
        params={{ runId: run.id }}
        className={cn(
          "flex items-center gap-3 rounded-control px-2.5 py-2 text-row hover:bg-line-soft",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
          shouldRunRecede(run.status) && "opacity-66",
        )}
      >
        <span className="flex w-3 shrink-0 justify-center">
          <WorkStateMark state={run.status} />
        </span>
        <span className="min-w-0 flex-1 truncate font-emph text-ink">{run.workflowName}</span>
        <span className="w-[200px] shrink-0 truncate text-meta">
          {run.failureReason === undefined ? null : (
            <FailureText reason={run.failureReason} stepId={run.failedStepId} />
          )}
        </span>
        <span
          className={cn("w-[76px] shrink-0 text-meta", WORK_STATE_HUES[run.status] ?? "text-muted")}
        >
          {run.status}
        </span>
        <span className="w-[132px] shrink-0 truncate text-meta text-muted">{`by ${starter.label}`}</span>
        <span className="w-8 shrink-0 text-right font-mono text-fine text-faint tabular-nums">
          {formatAge(run.createdAt, now)}
        </span>
      </Link>
    </li>
  );
}
