import type { JSX } from "react";
import { formatProblemCount, type WorkflowValidationState } from "@hercule/client-core";
import { cn } from "@hercule/ui";
import type { MarkedIssue } from "../../../screens/workflow-editor";

/**
 * Renders the problems panel below the editor, in every view. It lists the
 * errors first, then the warnings, each with its line number. Each problem
 * is a button, because clicking it moves the cursor to its line.
 *
 * The panel has a fixed height, and a long list scrolls inside it. So the
 * editor and the graph above keep their size and position when problems
 * appear or disappear.
 *
 * "No problems." shows only after the validation has returned, because until
 * then a source with no marks can still have problems. A validation that
 * could not run is shown separately, because it is not a problem in the
 * source.
 */
export function ProblemsPanel({
  issues,
  validationState,
  onIssueClick,
}: {
  readonly issues: ReadonlyArray<MarkedIssue>;
  readonly validationState: WorkflowValidationState;
  readonly onIssueClick: (issue: MarkedIssue) => void;
}): JSX.Element {
  return (
    <section
      aria-label="Problems"
      // Fits the header and two and a half rows. The half-visible row shows
      // that the list scrolls.
      className="flex h-[104px] shrink-0 flex-col rounded-card border border-line-soft bg-surface"
    >
      <div className="flex items-baseline gap-2.5 px-4 py-2 text-meta">
        {issues.length > 0 ? (
          <span className="font-emph text-ink">{formatProblemCount(issues.length)}</span>
        ) : validationState.status === "validated" ? (
          <span className="text-muted">No problems.</span>
        ) : null}
        {/* The `{" "}` spaces are for screen readers. Flex layout adds no
            space between items, so without them the texts run together. */}{" "}
        {validationState.status === "validating" ? (
          <span className="text-faint">Checking…</span>
        ) : validationState.status === "failed" ? (
          <span className="min-w-0 truncate text-fail" title={validationState.reason}>
            {`Not checked: ${validationState.reason}`}
          </span>
        ) : null}
      </div>{" "}
      {issues.length === 0 ? null : (
        <ul className="flex min-h-0 flex-col overflow-y-auto px-1.5 pb-1.5">
          {issues.map((issue, index) => (
            // The whole list is replaced on every change, so the index is a
            // stable key.
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
                {/* A small dot in the colour of the severity, like the editor's own marks. */}
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
