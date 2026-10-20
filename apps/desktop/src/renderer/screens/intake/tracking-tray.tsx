/**
 * Tracking in Intake's list column, folded or opened (spec 17 §Tracking).
 */
import type { JSX, ReactNode } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  countWaitingTrackingRows,
  describeTrackingLine,
  groupTrackingRows,
  listRecentTrackingRows,
  type TrackingRow,
} from "@hercule/client-core";
import { pluginsQuery } from "../../app/queries";
import type { HandoffFlights } from "./handoff-flight";
import { SourceMark } from "./source-mark";
import { TrackingFold } from "./tracking-fold";
import type { TrackingRowFacts } from "./tracking-row";
import { TrackingSheet } from "./tracking-sheet";
import { useTrackingSheetMotion } from "./tracking-sheet-motion";

/**
 * Returns what a row draws. A Failed row says why its run failed when the run
 * carries a `failureCause`, and "failed" alone when it has none. A run of a
 * workflow that was sent with the request has no workflow id, so its face is
 * drawn from the workflow's name: every run of that name wears the same face.
 */
const buildRowFacts = (row: TrackingRow): TrackingRowFacts => {
  const line = describeTrackingLine(row);
  return {
    taskId: row.task.taskId,
    title: row.task.title,
    state: row.state,
    faceSeed: row.run.workflowId ?? row.run.workflowName,
    workflowName: line.workflowName,
    lineText: line.text,
    since: row.since,
    handoffSignalIds: row.task.handoffs.map((handoff) => handoff.signalId),
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
 *   that the flights move in, and tells `flights` where
 *   that layer and folded Tracking are. The sheet rises when it opens and
 *   drops when it closes, and stays drawn, taking no pointer, until the drop
 *   ends (`useTrackingSheetMotion`).
 *
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
  const shown = open ? rows : listRecentTrackingRows(rows);
  const waitingCount = countWaitingTrackingRows(rows);
  const { sheetDrawn, sheetLeaving, setFoldElement, setSheetElement, setLayerElement } =
    useTrackingSheetMotion(open, flights);

  return (
    <>
      <div ref={setLayerElement} className="tr-fly" aria-hidden="true" inert />
      {sheetDrawn && (
        <TrackingSheet
          ref={setSheetElement}
          total={rows.length}
          waitingCount={waitingCount}
          groups={groupTrackingRows(rows).map((group) => ({
            state: group.state,
            rows: group.rows.map(buildRowFacts),
          }))}
          selectedTaskId={selectedTaskId}
          signalCount={signalCount}
          signalMarks={<SignalSourceMarks sources={signalSources} />}
          dock={dock}
          leaving={sheetLeaving}
          onClose={onClose}
          onOpenRow={onOpenRow}
          onMarkDone={onMarkDone}
        />
      )}
      {!open && (
        <TrackingFold
          ref={setFoldElement}
          total={rows.length}
          waitingCount={waitingCount}
          rows={shown.map(buildRowFacts)}
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
