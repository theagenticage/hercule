/**
 * Intake's pane while Tracking is open: the selected row of Tracking, top to
 * bottom as the Tracking drawing draws it, with its answers and the keys at
 * its foot (spec 17 §Tracking).
 */
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  decideTrackingRowPose,
  describeTrackingStanding,
  findNextTrackingElapsedChange,
  invalidateWithoutCancelling,
  listTrackingAnswers,
  nameTrackingState,
  queryKeys,
  readErrorMessage,
  readTrackingFaceSeed,
  readTrackingRunStart,
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
import type { RerunTracking } from "./use-rerun-tracking";
import type { TakeOffStatus } from "./use-take-off-tracking";
import "./tracking.css";

/** The words of each answer's button. */
const ANSWER_LABELS: Readonly<Record<TrackingAnswer["kind"], string>> = {
  "stop-run": "Stop the run",
  "try-again": "Try again",
  "mark-done": "Mark done",
  cancel: "Cancel",
};

/** The tone of the state's word in the pane's head: Failed and Finished are drawn in their own colours, Needs you in marigold. */
const STATE_TONES: Readonly<Record<TrackingState, string | undefined>> = {
  "needs-you": "tr-tone--you",
  failed: "tr-tone--fail",
  finished: "tr-tone--ok",
  working: undefined,
  stopped: undefined,
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
 * the user's answer sets it to, `done` or `cancelled`. `rerun` starts the
 * re-run Try again asks for, and tells whether one is starting for the row.
 * `onOpenDestination` is called with the run the user opens.
 */
export function TrackingPane({
  taskId,
  timezone,
  shown,
  focusAnswerOnOpen,
  onFocusedAnswer,
  onTakeOff,
  rerun,
  onOpenDestination,
}: {
  readonly taskId: string;
  readonly timezone: string;
  readonly shown: boolean;
  readonly focusAnswerOnOpen: boolean;
  readonly onFocusedAnswer: () => void;
  readonly onTakeOff: (taskId: string, status: TakeOffStatus) => void;
  readonly rerun: RerunTracking;
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
          rerun={rerun}
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
 * run. It sends `keepWorkspace: true`, so the run's workspace is kept: the pane
 * asks for no confirmation, and the drawing's foot notes that stopping leaves
 * the agent's work where it is. Try again is sent by `rerun`, which the screen
 * owns (see `useRerunTracking`).
 *
 * Every answer is locked while Stop is being sent or a re-run of the row's Task
 * is starting. Tracking's read keeps showing the old run until the new run
 * arrives, so Try again would still be on screen, and a second press would
 * start a second run. Mark done and Cancel are locked too: closing the Task
 * would leave the starting run on a closed Task.
 *
 * A refusal of Stop or of Try again shows under its button, never in a toast.
 */
function TrackingRowDetail({
  row,
  timezone,
  focusAnswerOnOpen,
  onFocusedAnswer,
  onTakeOff,
  rerun,
  onOpenDestination,
}: {
  readonly row: TrackingRow;
  readonly timezone: string;
  readonly focusAnswerOnOpen: boolean;
  readonly onFocusedAnswer: () => void;
  readonly onTakeOff: (taskId: string, status: TakeOffStatus) => void;
  readonly rerun: RerunTracking;
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
      invalidateWithoutCancelling(queryClient, queryKeys.tracking());
    },
  });
  const answersLocked = stop.isPending || rerun.isStarting(row.task);
  /** Returns what shows under the button of `answer`: the refusal of the request it sent, if any. */
  const readRefusal = (answer: TrackingAnswer): string | null => {
    if (answer.kind === "stop-run") {
      return stop.isError ? readErrorMessage(stop.error) : null;
    }
    if (answer.kind === "try-again") return rerun.readRefusal(row.task);
    return null;
  };

  // The standing line of a Working row counts "8m so far", so it follows the
  // shared age clock, which keeps one timer for every label on screen. The
  // other lines hold times that do not move.
  const working = row.state === "working";
  const standing = useClockValue(
    readTrackingRunStart(row.run),
    working,
    findNextTrackingElapsedChange,
    (now) => describeTrackingStanding(row, timezone, now),
  );

  // The effect below runs when the screen asks for the focus, not each time
  // the row or its answers change, so what it reads is an effect event.
  const focusSuggestedAnswer = useEffectEvent(() => {
    const button =
      suggested === undefined
        ? null
        : rootRef.current?.querySelector<HTMLElement>(`[data-answer="${suggested.kind}"]`);
    (button ?? rootRef.current)?.focus();
    button?.scrollIntoView({ block: "nearest" });
    onFocusedAnswer();
  });
  useEffect(() => {
    if (focusAnswerOnOpen) focusSuggestedAnswer();
  }, [focusAnswerOnOpen]);

  // Anything the pane draws can be removed while it holds the focus: Stop the
  // run turning into Mark done once the run has stopped, the trip's Thread
  // button when a failed re-read replaces the trip with its error. The focus
  // would then fall to the page's body, outside the screen's keys, so it moves
  // to the pane. The pane remembers which element had the focus, and repairs
  // only when that element was removed. When the user clicks the page's body,
  // the focused element stays in the page, so it is forgotten and the focus
  // stays on the body.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    let lastFocused: EventTarget | null = null;
    const remember = (event: FocusEvent): void => {
      lastFocused = event.target;
    };
    // A focus that moved to another element is not lost, so it is forgotten.
    // A focus that moved to no element is either a removal or the user leaving
    // the pane for the body. Only one microtask later is the element's
    // removal visible, so the choice waits for it.
    const forgetWhenMoved = (event: FocusEvent): void => {
      const element = event.target;
      if (event.relatedTarget !== null) {
        lastFocused = null;
        return;
      }
      queueMicrotask(() => {
        if (element === lastFocused && element instanceof Node && element.isConnected) {
          lastFocused = null;
        }
      });
    };
    const repair = (): void => {
      const lost = lastFocused instanceof Node && !lastFocused.isConnected;
      const onBody = document.activeElement === null || document.activeElement === document.body;
      if (lost && onBody) root.focus();
      if (lost) lastFocused = null;
    };
    root.addEventListener("focusin", remember);
    root.addEventListener("focusout", forgetWhenMoved);
    const observer = new MutationObserver(repair);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      root.removeEventListener("focusin", remember);
      root.removeEventListener("focusout", forgetWhenMoved);
      observer.disconnect();
    };
  }, []);

  const pressAnswer = (answer: TrackingAnswer): void => {
    switch (answer.kind) {
      case "stop-run":
        stop.mutate(answer.run.id);
        return;
      case "try-again":
        rerun.start(taskId, answer.run.id);
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
                taskTitle={title}
                locked={answersLocked}
                error={readRefusal(answer)}
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
  taskTitle,
  locked,
  error,
  idPrefix,
  onPress,
}: {
  readonly answer: TrackingAnswer;
  readonly taskTitle: string;
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
      describe={describeAnswer(answer, taskTitle)}
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

/** Returns what pressing `answer` does, for the line beside its button. `taskTitle` is the title of the row's Task. */
const describeAnswer = (answer: TrackingAnswer, taskTitle: string): JSX.Element | string => {
  switch (answer.kind) {
    case "stop-run":
      return (
        <>
          Stops <b>{answer.run.workflowName}</b>. The row stays in Tracking
          {answer.leavesRowStopped ? ", as Stopped" : ""}
        </>
      );
    case "try-again":
      return (
        <>
          Re-runs <b>{answer.run.workflowName}</b> on <b>{taskTitle}</b> from the start
        </>
      );
    case "mark-done":
      return "Takes it off Tracking and marks the work done. Nothing is sent";
    case "cancel":
      return "Takes it off Tracking as cancelled. Nothing is sent";
  }
};
