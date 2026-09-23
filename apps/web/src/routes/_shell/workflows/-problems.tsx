import type { JSX } from "react";
import {
  formatProblemCount,
  type LocatedIssue,
  type WorkflowCheckState,
} from "@hercule/client-core";
import { cn } from "@hercule/ui";

/**
 * The problems that the text shows marked, under the editor in every view:
 * errors first, then warnings, each with its line. A problem is a button,
 * because a press takes the cursor to its line.
 *
 * The panel has one height whatever it holds, and a long list scrolls inside
 * it. The editor and the graph above it keep their size, and their place,
 * when the first problem comes or the last one goes.
 *
 * "No problems." is said only when the check has answered, because until
 * then a text with no marks can still have problems. A check that could not
 * run is said apart from the problems, because it is not a problem of the
 * text.
 */
export function ProblemsPanel({
  issues,
  checkState,
  onIssueClick,
}: {
  readonly issues: ReadonlyArray<LocatedIssue>;
  readonly checkState: WorkflowCheckState;
  readonly onIssueClick: (issue: LocatedIssue) => void;
}): JSX.Element {
  return (
    <section
      aria-label="Problems"
      // The header and two and a half rows: a row that is cut in half shows
      // that the list scrolls.
      className="flex h-[104px] shrink-0 flex-col rounded-card border border-line-soft bg-surface"
    >
      <div className="flex items-baseline gap-2.5 px-4 py-2 text-meta">
        {issues.length > 0 ? (
          <span className="font-emph text-ink">{formatProblemCount(issues.length)}</span>
        ) : checkState.status === "checked" ? (
          <span className="text-muted">No problems.</span>
        ) : null}
        {/* The spaces between the parts of the panel are for the text that a
            screen reader reads: a flex row or column draws no space of its own. */}{" "}
        {checkState.status === "checking" ? (
          <span className="text-faint">Checking…</span>
        ) : checkState.status === "failed" ? (
          <span className="min-w-0 truncate text-fail" title={checkState.reason}>
            {`Not checked: ${checkState.reason}`}
          </span>
        ) : null}
      </div>{" "}
      {issues.length === 0 ? null : (
        <ul className="flex min-h-0 flex-col overflow-y-auto px-1.5 pb-1.5">
          {issues.map((issue, index) => (
            // The list is replaced as a whole on each change, so a place in
            // it is a key that holds for as long as the list does.
            <li key={index}>
              <button
                type="button"
                onClick={() => {
                  onIssueClick(issue);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-3 rounded-control px-2.5 py-1 text-left text-meta",
                  "hover:bg-line-soft",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
                )}
              >
                {/* Colour at dot scale, in the hue of the severity, as the editor's own marks. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-[7px] size-1.5 shrink-0 rounded-full",
                    issue.severity === "error" ? "bg-fail" : "bg-attn",
                  )}
                />
                <span className="sr-only">{issue.severity === "error" ? "Error" : "Warning"}</span>{" "}
                <span className="w-16 shrink-0 font-mono text-fine leading-[inherit] text-faint tabular-nums">
                  {`Line ${String(issue.line)}`}
                </span>{" "}
                <span className="min-w-0 flex-1 text-ink">{issue.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
