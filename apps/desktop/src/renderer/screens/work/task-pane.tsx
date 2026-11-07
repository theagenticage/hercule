import type { JSX, KeyboardEvent } from "react";
import {
  chooseCardColleaguePose,
  STAGE_NAMES,
  type PaneAnswer,
  type SummaryStanding,
  type TaskActionId,
  type TaskPaneContent,
} from "@hercule/client-core/work";
import { BOARD_STAGES, type BoardStage, type TaskDetail, type WorkCard } from "@hercule/contract";
import { buildLook } from "../../faces";
import { Colleague } from "../desk";
import { FailureSection } from "./task-pane-failure";
import { Foot } from "./task-pane-foot";
import { QuestionSection, UnsentAnswerSection } from "./task-pane-question";
import { RunsSection } from "./task-pane-runs";
import { ThreadsSection } from "./task-pane-threads";
import "./task-pane.css";

/**
 * What the pane's buttons change. Each one is called with nothing but what
 * the user chose; the caller sends it, and says what happened.
 */
export interface TaskPaneChanges {
  /** Tries again the run that failed (the Try again button). */
  readonly onTryAgain: () => void;
  /**
   * Return was pressed on the pane's title: does what Return does for this
   * Task, which is to try again after a failure, else to send the suggested
   * answer of a question (`TaskActions.returnAction`). The same happens when
   * Return is pressed on the Task's card on the board.
   */
  readonly onReturn: () => void;
  /** Answers the question the pane shows, by a chip or by the user's own words. */
  readonly onAnswer: (answer: PaneAnswer) => void;
  readonly onDone: () => void;
  readonly onDrop: () => void;
  /** Asks what a Thread on this Task should do: the foot turns into a line to write it on. */
  readonly onStartThread: () => void;
  /** Starts the Thread, with what the user wrote on that line. */
  readonly onSendThreadPrompt: (prompt: string) => void;
  /** Takes the line back (Esc), and starts nothing. */
  readonly onCancelThreadPrompt: () => void;
  /** Starts choosing the Task this one merges into. */
  readonly onMerge: () => void;
  /** Moves one Thread of the Task to a new Task of its own. */
  readonly onMoveThreadToNewTask: (sessionId: string) => void;
  /** Sends an answer that was not sent again, at once. */
  readonly onSendAnswerAgain: (intentId: string) => void;
  /** Drops an answer that was not sent. */
  readonly onDiscardAnswer: (intentId: string) => void;
  /** Asks the run `runId`, which runs the workflow `workflowName`, to stop. */
  readonly onStopRun: (runId: string, workflowName: string) => void;
}

/** Everything the pane's buttons do: the changes above, and where the others lead. */
export interface TaskPaneActions extends TaskPaneChanges {
  readonly onMoveToStage: (stage: BoardStage) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenThread: (sessionId: string) => void;
  /** Goes to the Text Generation setting, which a note about summaries being off links to. */
  readonly onOpenTextGeneration: () => void;
  /** Reads the Task again, after a read that failed. */
  readonly onRetryRead: () => void;
  /** Esc: goes back, or closes. */
  readonly onStepBack: () => void;
}

/**
 * What the pane has of the Task's details: still being read, read, failed to
 * be read (with why, in words for the user), or gone because the Task was
 * deleted.
 */
export type TaskPaneRead =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly detail: TaskDetail; readonly standing: SummaryStanding }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "gone" };

/** Renders the stage path: each stage as a step, the current one in ink. Choosing a step moves the Task there. */
function StagePath({
  stage,
  isDisabled,
  onMoveToStage,
}: {
  readonly stage: BoardStage;
  /** True for a Task that no longer exists, which cannot be moved. */
  readonly isDisabled: boolean;
  readonly onMoveToStage: (stage: BoardStage) => void;
}): JSX.Element {
  const here = BOARD_STAGES.indexOf(stage);
  return (
    <ol className="task-pane-path" aria-label="Stage">
      {BOARD_STAGES.map((each, index) => (
        <li
          key={each}
          className={index === here ? "is-here" : index < here ? "is-past" : undefined}
          aria-current={index === here ? "step" : undefined}
        >
          <button
            type="button"
            disabled={isDisabled}
            title={`Move it to ${STAGE_NAMES[each]}`}
            onClick={() => {
              onMoveToStage(each);
            }}
          >
            {STAGE_NAMES[each]}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Renders the colleague on the sheet's top edge, or nothing when the Task has none. */
export function TaskPaneColleague({
  card,
  isStill,
}: {
  readonly card: WorkCard | undefined;
  readonly isStill: boolean;
}): JSX.Element | null {
  const colleague = card === undefined ? null : chooseCardColleaguePose(card);
  if (colleague === null) return null;
  return (
    <Colleague
      look={buildLook(colleague.sessionId)}
      pose={colleague.pose}
      seed={colleague.sessionId}
      still={isStill}
    />
  );
}

/**
 * Renders a Task's details, the words of the opening sheet. It is
 * presentational: it reads nothing, and every button calls a callback.
 *
 * - `pane` is what the pane shows and does for the Task: its card (the title,
 *   the stage and the failure, which show before the read arrives), the
 *   question, the actions, and the answers the user gave. Every button acts on
 *   this value.
 * - `projectName` is the crumb.
 * - `read` is what the details read gives: quiet bars while it is on its
 *   way, a line and a retry after it failed, a line when the Task is gone.
 *   The pane has its final size at once, so nothing moves when the words
 *   arrive.
 * - `threadPromptWords` turns the foot into the line that asks what a new
 *   Thread should do, with those words in it to start with (empty for a new
 *   line). `null` leaves the foot as it is.
 * - `actions` is what its buttons do.
 *
 * From the top: the crumb, the title, the stage path, where it stands with
 * the quiet line under it, a failure, a question, What is left, Threads, Runs,
 * and the foot. Esc steps back. Return does what the first button of the section
 * above says, unless the focus is on a button or a field: it tries again
 * after a failure, and sends the suggested answer of a question.
 *
 * The title carries `data-sheet-focus`: when the Task changes while the focus
 * is in the pane, the sheet moves the focus to the new title.
 */
export function TaskPane({
  pane,
  projectName,
  read,
  threadPromptWords,
  actions,
}: {
  readonly pane: TaskPaneContent;
  readonly projectName: string | null;
  readonly read: TaskPaneRead;
  /** The words the line that asks what a new Thread should do starts with, or `null` when the foot is not that line. */
  readonly threadPromptWords: string | null;
  readonly actions: TaskPaneActions;
}): JSX.Element {
  const { card, question, actions: taskActions } = pane;
  const isGone = read.status === "gone";
  const act = (id: TaskActionId): void => {
    switch (id) {
      case "try-again":
        actions.onTryAgain();
        return;
      case "open-run":
        if (card?.failure !== undefined) actions.onOpenRun(card.failure.runId);
        return;
      case "open-thread":
        if (question !== null) actions.onOpenThread(question.sessionId);
        return;
      case "done":
        actions.onDone();
        return;
      case "start-thread":
        actions.onStartThread();
        return;
      case "merge":
        actions.onMerge();
        return;
      case "drop":
        actions.onDrop();
        return;
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      actions.onStepBack();
      return;
    }
    // Return belongs to the button or the field that has the focus. Only the
    // title, which the sheet focuses, and the sheet itself leave it to the pane.
    if (event.key !== "Enter" || !(event.target instanceof HTMLHeadingElement) || event.repeat)
      return;
    event.preventDefault();
    actions.onReturn();
  };

  return (
    <div className="task-pane" onKeyDown={handleKeyDown} aria-busy={read.status === "loading"}>
      <div className="task-pane-scroll">
        <header className="task-pane-head">
          <p className="task-pane-crumb">
            <span className="task-pane-crumb-text">{projectName}</span>
          </p>
          {card !== undefined ? (
            <h2 className="task-pane-title" tabIndex={-1} data-sheet-focus>
              {card.title}
            </h2>
          ) : (
            <h2 className="task-pane-title" tabIndex={-1} data-sheet-focus>
              <span className="task-pane-title-bar" />
            </h2>
          )}
          {card !== undefined && (
            <StagePath
              stage={card.stage}
              isDisabled={isGone}
              onMoveToStage={actions.onMoveToStage}
            />
          )}
        </header>
        {read.status === "loading" && (
          <div className="task-pane-bars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
        )}
        {read.status === "gone" && (
          <p className="task-pane-read-failed" role="status">
            This Task no longer exists.
          </p>
        )}
        {read.status === "failed" && (
          <div className="task-pane-read-failed" role="alert">
            <p>Could not read the Task: {read.message}</p>
            <button type="button" className="btn" onClick={actions.onRetryRead}>
              Try again
            </button>
          </div>
        )}
        {read.status === "ready" && (
          <>
            {read.standing.standing !== null && (
              <p className="task-pane-where">{read.standing.standing}</p>
            )}
            {read.standing.linksToTextGeneration ? (
              <button
                type="button"
                className="task-pane-note"
                onClick={actions.onOpenTextGeneration}
              >
                {read.standing.note}
              </button>
            ) : (
              <p className="task-pane-note">{read.standing.note}</p>
            )}
            {card !== undefined && (
              <FailureSection card={card} actions={taskActions?.failure ?? []} onAction={act} />
            )}
            {pane.unsent.map((unsent) => (
              <UnsentAnswerSection
                key={unsent.intentId}
                unsent={unsent}
                onSendAgain={actions.onSendAnswerAgain}
                onOpenThread={actions.onOpenThread}
                onDiscard={actions.onDiscardAnswer}
              />
            ))}
            {question !== null && (
              <QuestionSection
                question={question}
                said={pane.said}
                openThread={taskActions?.openThread ?? null}
                onAnswer={actions.onAnswer}
                onOpenThread={actions.onOpenThread}
              />
            )}
            {read.detail.card.summary !== undefined &&
              read.detail.card.summary.left.trim() !== "" && (
                <section className="task-pane-sec" aria-label="What is left">
                  <h3>What is left</h3>
                  <p className="task-pane-left">{read.detail.card.summary.left}</p>
                </section>
              )}
            <ThreadsSection
              detail={read.detail}
              taskTitle={read.detail.card.title}
              onOpenThread={actions.onOpenThread}
              onMoveThreadToNewTask={actions.onMoveThreadToNewTask}
            />
            <RunsSection
              detail={read.detail}
              onOpenRun={actions.onOpenRun}
              onStopRun={actions.onStopRun}
            />
          </>
        )}
      </div>
      {taskActions !== null && (
        <Foot
          start={taskActions.foot.start}
          end={taskActions.foot.end}
          threadPrompt={
            threadPromptWords === null
              ? null
              : {
                  words: threadPromptWords,
                  onSend: actions.onSendThreadPrompt,
                  onCancel: actions.onCancelThreadPrompt,
                }
          }
          onAction={act}
        />
      )}
    </div>
  );
}
