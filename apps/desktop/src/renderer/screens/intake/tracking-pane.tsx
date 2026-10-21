/**
 * Intake's pane while Tracking is open: the selected row of Tracking, top to
 * bottom as the Tracking drawing draws it, with its answers and the keys at
 * its foot (spec 17 §Tracking).
 */
import { useEffect, useId, useLayoutEffect, useRef, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  decideTrackingRowPose,
  describeTrackingStanding,
  findNextAgeChange,
  invalidateWithoutCancelling,
  listTrackingAnswers,
  nameTrackingState,
  queryKeys,
  readErrorMessage,
  readTrackingFaceSeed,
  type TrackingAnswer,
  type TrackingDestination,
  type TrackingRow,
  type TrackingState,
} from "@hercule/client-core";
import { useClockValue } from "../../app/age-clock";
import { useTrackingRows } from "../../app/tracking";
import { buildLook, Face } from "../../faces";
import { ExternalIcon } from "../../icons/external";
import { LedgerAnswer } from "./ledger-answer";
import { TrackingTrip } from "./tracking-trip";
import type { TakeOffStatus } from "./use-take-off-tracking";
import "./tracking.css";

/** The words of each answer's button. */
const ANSWER_LABELS: Readonly<Record<TrackingAnswer["kind"], string>> = {
  "stop-run": "Stop the run",
  "mark-done": "Mark done",
  cancel: "Cancel",
};

/** The tone of the state's word in the pane's head: Failed and Finished are drawn in their own colours, Needs you in marigold. */
const STATE_TONES: Readonly<Record<TrackingState, string>> = {
  "needs-you": "tr-tone--you",
  failed: "tr-tone--fail",
  finished: "tr-tone--ok",
  working: "",
  stopped: "",
};

/**
 * Renders the pane of the Tracking row of the Task `taskId`. The row is read
 * from the last read of Tracking, not from the rows the sheet draws, so the
 * pane shows what is true now while the sheet may still hold a change back.
 * A Task with no row in that read leaves the pane empty.
 *
 * `shown` is false while the pane slides out. The pane is inert then: on its
 * way off screen, it takes no focus and screen readers skip it.
 *
 * `focusAnswerOnOpen` puts the focus on the suggested answer as soon as the
 * pane shows the row, or on the pane itself when no answer is suggested, then
 * calls `onFocusedAnswer`. `onTakeOff` is called with the Task and the status
 * the user's answer sets it to, `done` or `cancelled`. `onOpenDestination` is
 * called with the run the user opens.
 */
export function TrackingPane({
  taskId,
  timezone,
  shown,
  focusAnswerOnOpen,
  onFocusedAnswer,
  onTakeOff,
  onOpenDestination,
}: {
  readonly taskId: string;
  readonly timezone: string;
  readonly shown: boolean;
  readonly focusAnswerOnOpen: boolean;
  readonly onFocusedAnswer: () => void;
  readonly onTakeOff: (taskId: string, status: TakeOffStatus) => void;
  readonly onOpenDestination: (destination: TrackingDestination) => void;
}): JSX.Element {
  const row = useTrackingRows().find((each) => each.task.taskId === taskId);
  return (
    <section className="asks-detail" aria-label="The open Tracking row" inert={!shown}>
      {row !== undefined && (
        <TrackingRowDetail
          row={row}
          timezone={timezone}
          focusAnswerOnOpen={focusAnswerOnOpen}
          onFocusedAnswer={onFocusedAnswer}
          onTakeOff={onTakeOff}
          onOpenDestination={onOpenDestination}
        />
      )}
    </section>
  );
}

/**
 * Renders the pane of `row`: its head, its trip, its answers and its keys.
 *
 * Stop the run is sent from here, since no other part of the screen stops a
 * run. It sends `keepWorkspace: true`, so the run's workspace is kept: the
 * pane asks for no confirmation, and the drawing's foot says that stopping
 * leaves the agent's work where it is. A refusal shows under the button, never
 * in a toast.
 */
function TrackingRowDetail({
  row,
  timezone,
  focusAnswerOnOpen,
  onFocusedAnswer,
  onTakeOff,
  onOpenDestination,
}: {
  readonly row: TrackingRow;
  readonly timezone: string;
  readonly focusAnswerOnOpen: boolean;
  readonly onFocusedAnswer: () => void;
  readonly onTakeOff: (taskId: string, status: TakeOffStatus) => void;
  readonly onOpenDestination: (destination: TrackingDestination) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const idPrefix = useId();
  const rootRef = useRef<HTMLElement>(null);
  const { taskId, title } = row.task;
  const answers = listTrackingAnswers(row);
  const suggested = answers.find((answer) => answer.suggested);
  const hasMarkDone = answers.some((answer) => answer.kind === "mark-done");

  const stop = useMutation({
    mutationFn: (runId: string) =>
      client.run.cancel({ params: { id: runId }, payload: { keepWorkspace: true } }),
    onSuccess: (cancelled, runId) => {
      queryClient.setQueryData(queryKeys.run(runId), cancelled);
      invalidateWithoutCancelling(queryClient, queryKeys.runs());
      invalidateWithoutCancelling(queryClient, queryKeys.tracking());
    },
  });

  // The standing line of a Working row counts "8m so far", so it follows the
  // shared age clock, which keeps one timer for every label on screen. The
  // other lines hold times that do not move.
  const working = row.state === "working";
  const standing = useClockValue(
    row.run.startedAt ?? row.run.createdAt,
    working,
    findNextAgeChange,
    (now) => describeTrackingStanding(row, timezone, now),
  );

  useEffect(() => {
    if (!focusAnswerOnOpen) return;
    const button =
      suggested === undefined
        ? null
        : rootRef.current?.querySelector<HTMLElement>(`[data-answer="${suggested.kind}"]`);
    (button ?? rootRef.current)?.focus();
    button?.scrollIntoView({ block: "nearest" });
    onFocusedAnswer();
    // Runs when the screen asks for the focus, not each time the row changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAnswerOnOpen]);

  // When the answers change while the pane shows the row, such as Stop the
  // run turning into Mark done once the run has stopped, a focused answer is
  // removed. The focus would fall to the page's body, outside the screen's
  // keys, so it moves to the pane.
  const answerKinds = answers.map((answer) => answer.kind).join();
  const previousAnswerKinds = useRef(answerKinds);
  useLayoutEffect(() => {
    if (previousAnswerKinds.current === answerKinds) return;
    previousAnswerKinds.current = answerKinds;
    const focused = document.activeElement;
    if (focused === null || focused === document.body) rootRef.current?.focus();
  }, [answerKinds]);

  const pressAnswer = (answer: TrackingAnswer): void => {
    switch (answer.kind) {
      case "stop-run":
        stop.mutate(answer.runId);
        return;
      case "mark-done":
        onTakeOff(taskId, "done");
        return;
      case "cancel":
        onTakeOff(taskId, "cancelled");
        return;
    }
  };

  return (
    <>
      <article ref={rootRef} className="ad tr-pane" tabIndex={-1}>
        <header>
          <div className="ad-kind">
            <span className="src">
              <Face
                look={buildLook(readTrackingFaceSeed(row))}
                pose={decideTrackingRowPose(row)}
                size={18}
              />
              {row.run.workflowName}
            </span>
            <span>·</span>
            <span className={STATE_TONES[row.state]}>{nameTrackingState(row.state)}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => {
                onOpenDestination({ kind: "run", runId: row.run.id });
              }}
            >
              Open the run
              <ExternalIcon size={13} />
            </button>
          </div>
          <h2 className="ad-title">{title}</h2>
          <p className="ad-asked">{standing}</p>
        </header>
        <TrackingTrip row={row} timezone={timezone} onOpenDestination={onOpenDestination} />
        <div className="ad-answers">
          <div className="ledger">
            {answers.map((answer) => (
              <AnswerRow
                key={answer.kind}
                answer={answer}
                workflowName={row.run.workflowName}
                locked={stop.isPending}
                error={
                  answer.kind === "stop-run" && stop.isError ? readErrorMessage(stop.error) : null
                }
                idPrefix={idPrefix}
                onPress={pressAnswer}
              />
            ))}
          </div>
        </div>
      </article>
      <div className="ad-keys" aria-hidden="true">
        <span>
          <kbd>J</kbd>
          <kbd>K</kbd> move
        </span>
        {suggested !== undefined && (
          <span>
            <kbd>↩</kbd> {ANSWER_LABELS[suggested.kind].toLowerCase()}
          </span>
        )}
        {hasMarkDone && suggested?.kind !== "mark-done" && (
          <span>
            <kbd>E</kbd> mark done
          </span>
        )}
        <span>
          <kbd>O</kbd> open the run
        </span>
      </div>
    </>
  );
}

/**
 * Renders one answer as a ledger row, as the signal pane draws its answers.
 * The key beside it is ↩ for the suggested answer and E for Mark done. `error`
 * shows under the button when the answer failed. While `locked`, the answer
 * keeps its place and its focus, and does nothing.
 */
function AnswerRow({
  answer,
  workflowName,
  locked,
  error,
  idPrefix,
  onPress,
}: {
  readonly answer: TrackingAnswer;
  readonly workflowName: string;
  readonly locked: boolean;
  readonly error: string | null;
  readonly idPrefix: string;
  readonly onPress: (answer: TrackingAnswer) => void;
}): JSX.Element {
  return (
    <LedgerAnswer
      answerId={answer.kind}
      label={ANSWER_LABELS[answer.kind]}
      buttonClass={
        answer.suggested ? "btn btn--accent" : answer.kind === "cancel" ? "btn btn--quiet" : "btn"
      }
      describe={describeAnswer(answer, workflowName)}
      shortcut={answer.suggested ? "↩" : answer.kind === "mark-done" ? "E" : null}
      error={error}
      locked={locked}
      idPrefix={idPrefix}
      onPress={() => {
        onPress(answer);
      }}
    />
  );
}

/** Returns what pressing `answer` does, for the line beside its button. `workflowName` is the agent's workflow. */
const describeAnswer = (answer: TrackingAnswer, workflowName: string): JSX.Element | string => {
  switch (answer.kind) {
    case "stop-run":
      return (
        <>
          Stops <b>{workflowName}</b>. The row stays in Tracking, as Stopped
        </>
      );
    case "mark-done":
      return "Takes it off Tracking and marks the work done. Nothing is sent";
    case "cancel":
      return "Takes it off Tracking as cancelled. Nothing is sent";
  }
};
