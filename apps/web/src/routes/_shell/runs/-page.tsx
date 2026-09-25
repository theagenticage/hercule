import { useMemo, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buildRunGraph,
  buildStepLines,
  isRunLive,
  queryKeys,
  type HerculeClient,
  type RunnerWait,
  type RunWorkspaceReading,
} from "@hercule/client-core";
import type { Run, Runner } from "@hercule/contract";
import {
  Button,
  Checkbox,
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
 * the graph and the steps count the same time.
 *
 * The page owns two actions, each with the question shown before it is done:
 *
 * - Cancel, while the run is live. When the run's ephemeral workspace exists,
 *   the question also asks whether to delete it, and deleting is the default.
 * - Delete workspace, while a failed or kept run's workspace is kept for
 *   inspection.
 *
 * While a question shows, its button is hidden instead of unmounted, so the
 * focus can return to it when the question is declined.
 */
export function RunPage({
  client,
  run,
  runner,
  workspaceLabel,
  workspaceReading,
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
  /** What the page shows and offers about the run's workspace. */
  readonly workspaceReading: RunWorkspaceReading;
  /** The steps that wait for a runner, and the line they show. */
  readonly runnerWait: RunnerWait | undefined;
  readonly timezone: string;
  readonly stepsView: StepsView;
  readonly onStepsViewChange: (view: StepsView) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const isLive = isRunLive(run.status);
  const now = useTickingClock(isLive);
  const [asking, setAsking] = useState<"cancel" | "delete-workspace" | undefined>(undefined);
  const [deletesWorkspace, setDeletesWorkspace] = useState(true);
  const { workspaceId } = run;

  const cancel = useMutation({
    mutationFn: (keepWorkspace: boolean) =>
      client.run.cancel({ params: { id: run.id }, payload: { keepWorkspace } }),
    onSuccess: async (cancelled) => {
      queryClient.setQueryData(queryKeys.run(run.id), cancelled);
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
    },
  });

  const deleteWorkspace = useMutation({
    mutationFn: (id: string) => client.workspace.dispose({ params: { id } }),
    // The controller marks the workspace deleted before it answers, so the
    // refetch already reads when it was deleted.
    onSuccess: (_, id) => queryClient.invalidateQueries({ queryKey: queryKeys.workspace(id) }),
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
        workspaceNote={workspaceReading.note}
        now={now}
        timezone={timezone}
      >
        {cancel.error === null ? null : (
          <span role="alert" className="min-w-0 truncate text-fine text-fail">
            {`Not cancelled: ${readErrorMessage(cancel.error)}`}
          </span>
        )}
        {deleteWorkspace.error === null ? null : (
          <span role="alert" className="min-w-0 truncate text-fine text-fail">
            {`Not deleted: ${readErrorMessage(deleteWorkspace.error)}`}
          </span>
        )}
        {!isLive ? null : (
          <>
            {asking === "cancel" ? (
              <InPlaceQuestion
                question="Cancel this run?"
                declineLabel="Keep running"
                acceptLabel="Confirm"
                onDecline={() => {
                  setAsking(undefined);
                }}
                onAccept={() => {
                  setAsking(undefined);
                  cancel.mutate(workspaceReading.asksOnCancel && !deletesWorkspace);
                }}
              >
                {!workspaceReading.asksOnCancel ? null : (
                  // A flex wrapper, so the label centres on the question's line
                  // instead of sitting on an inline line box that lifts it.
                  <span className="ml-1.5 flex shrink-0">
                    <Checkbox
                      label="Delete the run's workspace too"
                      checked={deletesWorkspace}
                      onChange={(event) => {
                        setDeletesWorkspace(event.target.checked);
                      }}
                    />
                  </span>
                )}
              </InPlaceQuestion>
            ) : null}
            <Button
              hidden={asking === "cancel"}
              aria-disabled={cancel.isPending}
              onClick={() => {
                cancel.reset();
                setDeletesWorkspace(true);
                setAsking("cancel");
              }}
            >
              Cancel
            </Button>
          </>
        )}
        {!workspaceReading.offersDelete || workspaceId === undefined ? null : (
          <>
            {asking === "delete-workspace" ? (
              <InPlaceQuestion
                question="Delete the run's workspace?"
                declineLabel="Keep it"
                acceptLabel="Delete"
                onDecline={() => {
                  setAsking(undefined);
                }}
                onAccept={() => {
                  setAsking(undefined);
                  deleteWorkspace.mutate(workspaceId);
                }}
              />
            ) : null}
            <Button
              hidden={asking === "delete-workspace"}
              aria-disabled={deleteWorkspace.isPending}
              onClick={() => {
                deleteWorkspace.reset();
                setAsking("delete-workspace");
              }}
            >
              Delete workspace
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
