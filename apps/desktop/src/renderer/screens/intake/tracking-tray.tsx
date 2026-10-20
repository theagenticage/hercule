/**
 * Tracking in Intake's list column, folded or opened (spec 17 §Tracking).
 */
import type { JSX, ReactNode } from "react";
import { useQueries, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  countWaitingTrackingRows,
  describeTrackingLine,
  groupTrackingRows,
  listRecentTrackingRows,
  type TrackingRow,
} from "@hercule/client-core";
import { pluginsQuery, runFailureCauseQuery } from "../../app/queries";
import { TrackingFold } from "./tracking-fold";
import type { TrackingRowFacts } from "./tracking-row";
import { TrackingSheet } from "./tracking-sheet";

/**
 * Returns what a row draws, from the row and why its run failed. A run of a
 * workflow that was sent with the request has no workflow id, so its face is
 * drawn from the workflow's name: every run of that name wears the same face.
 */
const buildRowFacts = (row: TrackingRow, failureCause: string | undefined): TrackingRowFacts => {
  const line = describeTrackingLine(row, failureCause);
  return {
    taskId: row.task.id,
    title: row.task.title,
    state: row.state,
    workflowId: row.run.workflowId ?? row.run.workflowName,
    workflowName: line.workflowName,
    lineText: line.text,
    since: row.since,
  };
};

/**
 * Renders Tracking over the foot of Intake's list, or opened over the whole
 * list column when `open` is set.
 *
 * - `rows` are Tracking's rows, in Tracking's order. Folded Tracking draws
 *   the two that changed state last. `selectedTaskId` is the selected row.
 * - `signalCount` and `signalSources` sum up the signals of the list, for the
 *   row at the foot of opened Tracking. `signalSources` are the plugins the
 *   signals come from, each once, with `null` for the core.
 * - `dock` is drawn inside opened Tracking, for the toast of the last move.
 * - `onOpen` and `onClose` open and close Tracking. `onOpenRow` and
 *   `onMarkDone` are called with a Task's id.
 *
 * It reads the plugins, which name the signals' sources, and for each Failed
 * row it draws, why its run failed. The read of a run is one `run.read`, and
 * only a Failed row on screen asks for it: a `RunSummary` carries the failure
 * reason's code, not the step's error message.
 */
export function TrackingTray({
  rows,
  open,
  selectedTaskId,
  signalCount,
  signalSources,
  dock,
  onOpen,
  onClose,
  onOpenRow,
  onMarkDone,
}: {
  readonly rows: ReadonlyArray<TrackingRow>;
  readonly open: boolean;
  readonly selectedTaskId: string | null;
  readonly signalCount: number;
  readonly signalSources: ReadonlyArray<string | null>;
  readonly dock: ReactNode;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onOpenRow: (taskId: string) => void;
  readonly onMarkDone: (taskId: string) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const shown = open ? rows : listRecentTrackingRows(rows);
  const failedRows = shown.filter((row) => row.state === "failed");
  const failureCauses = useQueries({
    queries: failedRows.map((row) => runFailureCauseQuery(client, row.run.id)),
  });
  const buildFacts = (row: TrackingRow): TrackingRowFacts =>
    buildRowFacts(row, failureCauses[failedRows.indexOf(row)]?.data);
  const waitingCount = countWaitingTrackingRows(rows);

  if (open) {
    return (
      <TrackingSheet
        total={rows.length}
        waitingCount={waitingCount}
        groups={groupTrackingRows(rows).map((group) => ({
          state: group.state,
          rows: group.rows.map(buildFacts),
        }))}
        selectedTaskId={selectedTaskId}
        signalCount={signalCount}
        signalSources={signalSources}
        plugins={plugins}
        dock={dock}
        onClose={onClose}
        onOpenRow={onOpenRow}
        onMarkDone={onMarkDone}
      />
    );
  }
  return (
    <TrackingFold
      total={rows.length}
      waitingCount={waitingCount}
      rows={shown.map(buildFacts)}
      selectedTaskId={selectedTaskId}
      onOpen={onOpen}
      onOpenRow={onOpenRow}
      onMarkDone={onMarkDone}
    />
  );
}
