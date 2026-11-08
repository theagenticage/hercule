import type { JSX, KeyboardEvent, ReactNode } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { PlaceRow } from "@hercule/client-core/desk";
import {
  chooseCardColleaguePose,
  findCardInitiative,
  STAGE_NAMES,
  type WorkInitiative,
  type AddRow,
  type PaneAnswer,
  type SummaryStanding,
  type TaskActionId,
  type TaskPaneContent,
} from "@hercule/client-core/work";
import { BOARD_STAGES, type BoardStage, type TaskDetail, type WorkCard } from "@hercule/contract";
import { buildLook } from "../../faces";
import { Colleague } from "../desk";
import { BlockerSections } from "./task-pane-blockers";
import { ContextSections } from "./task-pane-context";
import { FailureSection } from "./task-pane-failure";
import { Foot } from "./task-pane-foot";
import { InitiativeSection } from "./task-pane-initiative";
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
  /** Links the thing a search row found to the Task, as the user's own link. */
  readonly onLinkEntity: (row: AddRow) => void;
  /** Removes the link from the Task to the thing a row of Linked draws. */
  readonly onUnlinkEntity: (row: PlaceRow) => void;
  /**
   * Makes the Task wait on `blocker`, the card the user chose in "Add a
   * blocker". Resolves to the controller's message when it refused because
   * the blocker would close a loop (the pane shows it under Blocked by), and
   * to `null` otherwise. Other refusals go to the undo line.
   */
  readonly onAddBlocker: (blocker: TaskPaneBlocker) => Promise<string | null>;
  /** Takes `blocker` off what the Task waits on, from the remove button of a Blocked by row. */
  readonly onRemoveBlocker: (blocker: TaskPaneBlocker) => void;
  /**
   * Puts the Task on `initiative`, or takes it off its Initiative when it is
   * `null`. The caller has checked that this changes something.
   */
  readonly onSetInitiative: (initiative: Pick<WorkInitiative, "id" | "name"> | null) => void;
}

/** A Task as the blocker changes name it: its id, and its title for the undo line. */
export interface TaskPaneBlocker {
  readonly id: string;
  readonly title: string;
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
  /** Shows only the Tasks that are part of an outside place, from a row of Part of. */
  readonly onFilterByPlace: (placeRef: string) => void;
  /** Opens the Task `taskId` in the pane, from a row of Blocked by or Blocks. */
  readonly onOpenTask: (taskId: string) => void;
  /**
   * Handles a pick in the Initiative menu: `choiceId` is an Initiative's id,
   * `NO_INITIATIVE_CHOICE_ID` or `NEW_INITIATIVE_CHOICE_ID`. The caller works
   * out what it means for the Task (`decideInitiativePick`).
   */
  readonly onPickInitiative: (choiceId: string) => void;
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
 * - `projectName` and the Initiative the Task is on (from `initiatives`, the
 *   open ones) are the crumbs.
 * - `read` is what the details read gives: quiet bars while it is on its
 *   way, a line and a retry after it failed, a line when the Task is gone.
 *   The pane has its final size at once, so nothing moves when the words
 *   arrive.
 * - `plugins` is what `plugin.query` returns, for the marks and the names of
 *   the outside things the Task links.
 * - `threadPromptWords` turns the foot into the line that asks what a new
 *   Thread should do, with those words in it to start with (empty for a new
 *   line). `null` leaves the foot as it is.
 * - `linkSearch` is the "Link something" search that stands at the foot of
 *   Linked, which the caller builds because it reads. `null` leaves it out.
 * - `boardCards` are the cards "Add a blocker" searches.
 * - `canCreateInitiative` adds "New initiative…" to the Initiative menu.
 * - `actions` is what its buttons do.
 *
 * From the top: the crumbs, the title, the stage path, where it stands with
 * the quiet line under it, a failure, a question, What is left, Blocked by and
 * Blocks, Threads, Initiative, Part of, Linked, Runs, and the foot. Esc steps back. Return does what the first button of the section
 * above says, unless the focus is on a button or a field: it tries again
 * after a failure, and sends the suggested answer of a question.
 *
 * The title carries `data-sheet-focus`: when the Task changes while the focus
 * is in the pane, the sheet moves the focus to the new title.
 */
export function TaskPane({
  pane,
  projectName,
  initiatives,
  canCreateInitiative,
  boardCards,
  read,
  plugins,
  threadPromptWords,
  linkSearch,
  actions,
}: {
  readonly pane: TaskPaneContent;
  readonly projectName: string | null;
  readonly initiatives: readonly WorkInitiative[];
  readonly canCreateInitiative: boolean;
  readonly boardCards: readonly WorkCard[];
  readonly read: TaskPaneRead;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  /** The words the line that asks what a new Thread should do starts with, or `null` when the foot is not that line. */
  readonly threadPromptWords: string | null;
  readonly linkSearch: ReactNode;
  readonly actions: TaskPaneActions;
}): JSX.Element {
  const { card, question, actions: taskActions } = pane;
  const isGone = read.status === "gone";
  const initiative = findCardInitiative(card, initiatives);
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
            <span className="task-pane-crumb-text">
              {[projectName, initiative?.name]
                .filter((name): name is string => name !== null && name !== undefined)
                .join(" · ")}
            </span>
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
            <BlockerSections
              key={pane.taskId}
              blockers={read.detail}
              taskId={pane.taskId}
              cards={boardCards}
              onOpenTask={actions.onOpenTask}
              onAdd={actions.onAddBlocker}
              onRemove={actions.onRemoveBlocker}
            />
            <ThreadsSection
              detail={read.detail}
              taskTitle={read.detail.card.title}
              onOpenThread={actions.onOpenThread}
              onMoveThreadToNewTask={actions.onMoveThreadToNewTask}
            />
            <InitiativeSection
              current={initiative}
              initiatives={initiatives}
              canCreate={canCreateInitiative}
              isDisabled={card === undefined}
              onPick={actions.onPickInitiative}
            />
            <ContextSections
              detail={read.detail}
              plugins={plugins}
              onFilterByPlace={actions.onFilterByPlace}
              onUnlink={actions.onUnlinkEntity}
              linkSearch={linkSearch}
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
