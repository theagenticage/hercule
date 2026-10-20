/**
 * Tracking in Intake's list column, folded or opened (spec 17 §Tracking).
 */
import { useState, type JSX, type ReactNode } from "react";
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
import type { HandoffFlights } from "./handoff-flight";
import { SourceMark } from "./source-mark";
import { TrackingFold } from "./tracking-fold";
import type { TrackingRowFacts } from "./tracking-row";
import { TrackingSheet } from "./tracking-sheet";
import { useTrackingSheetMotion } from "./tracking-sheet-motion";

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
    faceSeed: row.run.workflowId ?? row.run.workflowName,
    workflowName: line.workflowName,
    lineText: line.text,
    since: row.since,
    handoffSignalIds: row.task.provenance.flatMap((entry) =>
      entry.signalId === undefined ? [] : [entry.signalId],
    ),
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
 * - `flights` carries a handoff's flight from the list to the first row of
 *   folded Tracking. This component draws the layer over the whole list column
 *   that the flights and the closing sheet move in, and tells `flights` where
 *   that layer and folded Tracking are. The sheet rises when it opens and
 *   drops when it closes (`useTrackingSheetMotion`).
 *
 * It reads, for each Failed row it draws, why its run failed. The read of a
 * run is one `run.read`, and only a Failed row on screen asks for it: a
 * `RunSummary` carries the failure reason's code, not the step's error
 * message. Folded Tracking is on screen, and a row of opened Tracking is once
 * it has come into view. Until then its line says "failed" alone.
 */
export function TrackingTray({
  rows,
  open,
  selectedTaskId,
  signalCount,
  signalSources,
  dock,
  flights,
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
  readonly flights: HandoffFlights;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onOpenRow: (taskId: string) => void;
  readonly onMarkDone: (taskId: string) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  // The Tasks whose rows of opened Tracking have been in view. A seen row stays
  // seen: its read is cached, and the row keeps its reason when it scrolls away.
  const [seenTaskIds, setSeenTaskIds] = useState<ReadonlySet<string>>(new Set());
  const shown = open ? rows : listRecentTrackingRows(rows);
  const failedRows = shown.filter(
    (row) => row.state === "failed" && (!open || seenTaskIds.has(row.task.id)),
  );
  const failureCauses = useQueries({
    queries: failedRows.map((row) => runFailureCauseQuery(client, row.run.id)),
  });
  const buildFacts = (row: TrackingRow): TrackingRowFacts =>
    buildRowFacts(row, failureCauses[failedRows.indexOf(row)]?.data);
  const waitingCount = countWaitingTrackingRows(rows);
  const { setFoldElement, setSheetElement, setLayerElement } = useTrackingSheetMotion(
    open,
    flights,
  );

  return (
    <>
      <div ref={setLayerElement} className="tr-fly" aria-hidden="true" inert />
      {open ? (
        <TrackingSheet
          ref={setSheetElement}
          total={rows.length}
          waitingCount={waitingCount}
          groups={groupTrackingRows(rows).map((group) => ({
            state: group.state,
            rows: group.rows.map(buildFacts),
          }))}
          selectedTaskId={selectedTaskId}
          signalCount={signalCount}
          signalMarks={<SignalSourceMarks sources={signalSources} />}
          dock={dock}
          onRowsSeen={(taskIds) => {
            setSeenTaskIds((seen) =>
              taskIds.every((id) => seen.has(id)) ? seen : new Set([...seen, ...taskIds]),
            );
          }}
          onClose={onClose}
          onOpenRow={onOpenRow}
          onMarkDone={onMarkDone}
        />
      ) : (
        <TrackingFold
          ref={setFoldElement}
          total={rows.length}
          waitingCount={waitingCount}
          rows={shown.map(buildFacts)}
          selectedTaskId={selectedTaskId}
          flights={flights}
          onOpen={onOpen}
          onOpenRow={onOpenRow}
          onMarkDone={onMarkDone}
        />
      )}
    </>
  );
}

/**
 * Renders the marks of the sources the signals come from, one each, in the
 * order of `sources` (`null` is the core). It reads the plugins, which name
 * the sources, where it draws them.
 */
function SignalSourceMarks({
  sources,
}: {
  readonly sources: ReadonlyArray<string | null>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  return (
    <>
      {sources.map((pluginId) => (
        <SourceMark key={pluginId ?? "core"} pluginId={pluginId} plugins={plugins} size={14} />
      ))}
    </>
  );
}
