import { useMemo, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import {
  buildRunGraph,
  buildStepLines,
  describeReruns,
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
  cn,
  useElementWidth,
  useTickingClock,
} from "@hercule/ui";
import { runsQuery } from "../../../app/queries";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { RunGraphView } from "../../../screens/runs/run-graph-view";
import { RunHeader } from "../../../screens/runs/run-header";
import { RunInputsCard } from "../../../screens/runs/run-inputs-card";
import { RunOutputCard } from "../../../screens/runs/run-output-card";
import { StepList } from "../../../screens/runs/step-list";
import { StepTimeline } from "../../../screens/runs/step-timeline";
import { readErrorMessage } from "../../../screens/save-status";
import { RerunQuestion, useRerun } from "./-rerun-question";

/** How a run's steps are shown below its graph. */
export type StepsView = "list" | "timeline";

/**
 * The heading row of each section: one height for all of them, the height of
 * the steps view control, so the sections side by side start level.
 */
const SECTION_HEADING = "mb-2 flex h-8 items-center justify-between gap-4";

/**
 * The narrowest width of the page's body, inside its padding, at which the
 * inputs sit beside the steps. It must match the body's `@min-[882px]`
 * breakpoint below.
 */
const SIDE_BY_SIDE_BODY_WIDTH = 882;

/** The page's padding on each side, `px-8`. */
const PAGE_PADDING = 32;

/**
 * Renders a run's page: the header, the frozen plan drawn as the workflow
 * graph with each step's progress on it, and below it the steps, as a list or
 * on a timeline, beside the inputs the run started with and, once it has
 * one, the run's output.
 *
 * While the run is live, one clock ticks for the whole page, so the header,
 * the graph and the steps count the same time.
 *
 * The page owns three actions, each with the question shown before it is done:
 *
 * - Cancel, while the run is live. When the run's ephemeral workspace exists,
 *   the question also asks whether to delete it, and deleting is the default.
 * - Delete workspace, while a failed or kept run's workspace is kept for
 *   inspection.
 * - Re-run, once the run has ended. The question asks which workflow the new
 *   run follows, and the page then goes to the new run.
 *
 * While a question shows, its button is hidden instead of unmounted, so the
 * focus can return to it when the question is declined. On a wide page the
 * cancel and delete questions sit beside the title; on a narrow one they have
 * a row of their own below the header's lines. The re-run question always has
 * that row, because it explains each choice.
 *
 * The page reads the runs that re-ran this one, which the header links. The
 * route's loader has already read them, so the page does not wait for them.
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
  const [asking, setAsking] = useState<"cancel" | "delete-workspace" | "rerun" | undefined>(
    undefined,
  );
  const [deletesWorkspace, setDeletesWorkspace] = useState(true);
  const { workspaceId } = run;
  const { observeElement: observePage, width: pageWidth } = useElementWidth();

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

  const { rerun, startRerun } = useRerun(client, run.id);

  // Only the first page is read: the header links the newest few re-runs and
  // counts the rest.
  const [rerunsPage = { items: [] }] = useSuspenseInfiniteQuery(
    runsQuery(client, { originalRunId: run.id }),
  ).data.pages;

  // The run stays the same object until a refetch changes it, so the graph,
  // and with it the graph's layout, is built once per change of the run and
  // not on every tick of the clock.
  const runGraph = useMemo(() => buildRunGraph(run), [run]);
  const lines = buildStepLines(run);

  // On a page too narrow for the inputs beside the steps, the title row has
  // no room for a question beside the title either. The question then gets a
  // row of its own below the header's lines, wrapped over as many lines as it
  // needs. Until the page is measured, and in tests, where nothing is laid
  // out, the question stays on the title row.
  const stacksQuestion =
    pageWidth !== undefined && pageWidth < SIDE_BY_SIDE_BODY_WIDTH + 2 * PAGE_PADDING;

  const cancelQuestion = (
    <InPlaceQuestion
      stacked={stacksQuestion}
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
        // A flex wrapper, so the label centres on the question's line instead
        // of sitting on an inline line box that lifts it.
        <span className={cn("flex shrink-0", !stacksQuestion && "ml-1.5")}>
          <Checkbox
            label="Delete workspace"
            checked={deletesWorkspace}
            onChange={(event) => {
              setDeletesWorkspace(event.target.checked);
            }}
          />
        </span>
      )}
    </InPlaceQuestion>
  );
  const deleteQuestion =
    workspaceId === undefined ? undefined : (
      <InPlaceQuestion
        stacked={stacksQuestion}
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
    );
  const questions = {
    cancel: cancelQuestion,
    "delete-workspace": deleteQuestion,
    rerun: (
      <RerunQuestion
        run={run}
        onDecline={() => {
          setAsking(undefined);
        }}
        onAccept={(mode) => {
          setAsking(undefined);
          startRerun(mode);
        }}
      />
    ),
  };
  // The re-run question always has a row of its own below the header's
  // lines. The other two have that row only on a narrow page.
  const questionBelowHeader =
    asking !== undefined && (asking === "rerun" || stacksQuestion) ? questions[asking] : undefined;

  return (
    <div ref={observePage} className="flex min-h-0 flex-1 flex-col pb-28">
      <RunHeader
        run={run}
        runner={runner}
        workspaceLabel={workspaceLabel}
        workspaceNote={workspaceReading.note}
        now={now}
        reruns={describeReruns(rerunsPage)}
        timezone={timezone}
        question={questionBelowHeader}
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
        {rerun.error === null ? null : (
          <span role="alert" className="min-w-0 truncate text-fine text-fail">
            {`Not re-run: ${readErrorMessage(rerun.error)}`}
          </span>
        )}
        {!isLive ? null : (
          <>
            {asking === "cancel" && !stacksQuestion ? cancelQuestion : null}
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
            {asking === "delete-workspace" && !stacksQuestion ? deleteQuestion : null}
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
        {isLive ? null : (
          <Button
            hidden={asking === "rerun"}
            // An `aria-disabled` button ignores clicks, so a second re-run
            // cannot start while the first is still starting.
            aria-disabled={rerun.isPending}
            onClick={() => {
              rerun.reset();
              setAsking("rerun");
            }}
          >
            Re-run
          </Button>
        )}
      </RunHeader>
      <div className="@container flex flex-col gap-6 px-8 pt-5">
        <section aria-label="Run graph">
          <div className={SECTION_HEADING}>
            <LaneLabel className="mb-0">Plan</LaneLabel>
            <span className="text-fine text-faint">Frozen when the run started</span>
          </div>
          <RunGraphView runGraph={runGraph} now={now} />
        </section>
        {/*
          The inputs sit beside the steps when the page is at least 882px wide:
          400px for the inputs, the 32px gap, and 450px for the steps. A step
          row's mark, status, duration, chevron, gaps and padding take 286px of
          those, which leaves about 160px for the step's id and action. On a
          narrower page the inputs move below the steps, and both take the
          full width.
        */}
        <div className="flex flex-col gap-6 @min-[882px]:flex-row @min-[882px]:items-start @min-[882px]:gap-8">
          <section aria-labelledby="run-steps" className="min-w-0 @min-[882px]:flex-1">
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
          <div className="flex flex-col gap-6 @min-[882px]:w-[400px] @min-[882px]:shrink-0">
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
