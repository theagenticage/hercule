import type { JSX } from "react";
import { buildTaskRunRow } from "@hercule/client-core/work";
import type { TaskDetail } from "@hercule/contract";
import { StatusShape } from "../desk";

/**
 * Renders the runs of the Task, newest first as the details list them, and
 * says how many more there are than the pane lists. A click on a row opens the
 * run. A run that is pending or running offers Stop, which shows where the
 * row's state is when the pointer is over the row.
 */
export function RunsSection({
  detail,
  onOpenRun,
  onStopRun,
}: {
  readonly detail: TaskDetail;
  readonly onOpenRun: (runId: string) => void;
  /** Asks the run `runId`, which runs the workflow `workflowName`, to stop. */
  readonly onStopRun: (runId: string, workflowName: string) => void;
}): JSX.Element | null {
  if (detail.runs.length === 0) return null;
  const hidden = detail.runCount - detail.runs.length;
  return (
    <section className="task-pane-sec" aria-label="Runs">
      <h3>
        Runs <span>{detail.runCount}</span>
      </h3>
      {detail.runs.map((run) => {
        const row = buildTaskRunRow(run);
        return (
          <div key={row.id} className="task-pane-row">
            <button
              type="button"
              className="task-pane-row-open"
              onClick={() => {
                onOpenRun(row.id);
              }}
            >
              <StatusShape shape={row.mark.shape} tone={row.mark.tone} size={14} />
              <span className="task-pane-row-text">{row.label}</span>
              <small>{row.state}</small>
            </button>
            {row.canStop && (
              <button
                type="button"
                className="task-pane-row-action"
                onClick={() => {
                  onStopRun(row.id, row.label);
                }}
              >
                Stop
              </button>
            )}
          </div>
        );
      })}
      {hidden > 0 && <p className="task-pane-more">and {hidden} more</p>}
    </section>
  );
}
