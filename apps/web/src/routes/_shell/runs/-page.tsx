import { useMemo, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buildRunGraph,
  buildStepLines,
  isRunLive,
  queryKeys,
  type HerculeClient,
  type RunnerWait,
} from "@hercule/client-core";
import type { Run, Runner } from "@hercule/contract";
import {
  Button,
  LaneLabel,
  SegmentedControl,
  SegmentedControlItem,
  useTickingClock,
} from "@hercule/ui";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { RunGraphView } from "../../../screens/runs/run-graph-view";
import { RunHeader } from "../../../screens/runs/run-header";
import { RunInputsCard } from "../../../screens/runs/run-inputs-card";
import { RunOutputCard } from "../../../screens/runs/run-output-card";
import { StepList } from "../../../screens/runs/step-list";
import { StepTimeline } from "../../../screens/runs/step-timeline";
import { readErrorMessage } from "../../../screens/save-status";

/** How a run's steps are shown below its graph. */
export type StepsView = "list" | "timeline";

/**
 * The heading row of each section: one height for all of them, the height of
 * the steps view control, so the sections side by side start level.
 */
const SECTION_HEADING = "mb-2 flex h-8 items-center justify-between gap-4";

/**
 * Renders a run's page: the header, the frozen plan drawn as the workflow
 * graph with each step's progress on it, and below it the steps, as a list or
 * on a timeline, beside the inputs the run started with and, once it has
 * one, the run's output.
 *
 * While the run is live, one clock ticks for the whole page, so the header,
 * the graph and the steps count the same time. The page owns Cancel and the
 * question shown before the run is cancelled. While the question shows,
 * Cancel is hidden instead of unmounted, so the focus can return to it when
 * the question is declined.
 */
export function RunPage({
  client,
  run,
  runner,
  workspaceLabel,
  runnerWait,
  timezone,
  stepsView,
  onStepsViewChange,
}: {
  readonly client: HerculeClient;
  readonly run: Run;
  /** The runner the run is pinned to, once it is pinned and the runner has been read. */
  readonly runner: Runner | undefined;
  /** The name of the run's workspace, once it has one and it has been read. */
  readonly workspaceLabel: string | undefined;
  /** The running steps that wait for the run's runner to reconnect, and the line they show. */
  readonly runnerWait: RunnerWait | undefined;
  readonly timezone: string;
  readonly stepsView: StepsView;
  readonly onStepsViewChange: (view: StepsView) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const isLive = isRunLive(run.status);
  const now = useTickingClock(isLive);
  const [isAsking, setAsking] = useState(false);

  const cancel = useMutation({
    mutationFn: () => client.run.cancel({ params: { id: run.id }, payload: {} }),
    onSuccess: async (cancelled) => {
      queryClient.setQueryData(queryKeys.run(run.id), cancelled);
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
    },
  });

  // The run stays the same object until a refetch changes it, so the graph,
  // and with it the graph's layout, is built once per change of the run and
  // not on every tick of the clock.
  const runGraph = useMemo(() => buildRunGraph(run), [run]);
  const lines = buildStepLines(run);

  return (
    <div className="flex min-h-0 flex-1 flex-col pb-28">
      <RunHeader
        run={run}
        runner={runner}
        workspaceLabel={workspaceLabel}
        now={now}
        timezone={timezone}
      >
        {cancel.error === null ? null : (
          <span role="alert" className="min-w-0 truncate text-fine text-fail">
            {`Not cancelled: ${readErrorMessage(cancel.error)}`}
          </span>
        )}
        {!isLive ? null : (
          <>
            {isAsking ? (
              <InPlaceQuestion
                question="Cancel this run?"
                declineLabel="Keep running"
                acceptLabel="Confirm"
                onDecline={() => {
                  setAsking(false);
                }}
                onAccept={() => {
                  setAsking(false);
                  cancel.mutate();
                }}
              />
            ) : null}
            <Button
              hidden={isAsking}
              aria-disabled={cancel.isPending}
              onClick={() => {
                cancel.reset();
                setAsking(true);
              }}
            >
              Cancel
            </Button>
          </>
        )}
      </RunHeader>
      <div className="flex flex-col gap-6 px-8 pt-5">
        <section aria-label="Run graph">
          <div className={SECTION_HEADING}>
            <LaneLabel className="mb-0">Plan</LaneLabel>
            <span className="text-fine text-faint">Frozen when the run started</span>
          </div>
          <RunGraphView runGraph={runGraph} now={now} />
        </section>
        <div className="flex items-start gap-8">
          <section aria-labelledby="run-steps" className="min-w-0 flex-1">
            <div className={SECTION_HEADING}>
              <LaneLabel id="run-steps" className="mb-0">
                Steps
              </LaneLabel>
              <SegmentedControl
                aria-label="Show the steps as"
                className="w-auto"
                value={stepsView}
                onValueChange={(next) => {
                  onStepsViewChange(next === "timeline" ? "timeline" : "list");
                }}
              >
                <SegmentedControlItem value="list" className="px-3">
                  List
                </SegmentedControlItem>
                <SegmentedControlItem value="timeline" className="px-3">
                  Timeline
                </SegmentedControlItem>
              </SegmentedControl>
            </div>
            {stepsView === "list" ? (
              <StepList lines={lines} runStatus={run.status} runnerWait={runnerWait} now={now} />
            ) : (
              <StepTimeline run={run} runnerWait={runnerWait} now={now} />
            )}
          </section>
          {/* Wide enough for a quoted id beside a name of up to ten characters, so an id input shows whole. */}
          <div className="flex w-[400px] shrink-0 flex-col gap-6">
            <section aria-labelledby="run-inputs">
              <div className={SECTION_HEADING}>
                <LaneLabel id="run-inputs" className="mb-0">
                  Inputs
                </LaneLabel>
              </div>
              <RunInputsCard inputs={run.inputs} />
            </section>
            {run.status !== "completed" || run.output === undefined ? null : (
              <section aria-labelledby="run-output">
                <div className={SECTION_HEADING}>
                  <LaneLabel id="run-output" className="mb-0">
                    Output
                  </LaneLabel>
                </div>
                <RunOutputCard output={run.output} />
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
