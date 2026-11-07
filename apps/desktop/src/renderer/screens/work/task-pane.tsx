import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import {
  buildTaskThreadRow,
  chooseCardColleaguePose,
  chooseCardSecondLine,
  decideQuestionAnswers,
  describeNextThreadJoin,
  listTaskActions,
  STAGE_NAMES,
  type AnswerableTaskQuestion,
  type PaneAnswer,
  type SummaryStanding,
  type TaskAction,
  type TaskActionId,
  type TaskQuestion,
  type TaskThreadRow,
  type UnsentAnswer,
} from "@hercule/client-core/work";
import { BOARD_STAGES, type BoardStage, type TaskDetail, type WorkCard } from "@hercule/contract";
import { buildLook, Face } from "../../faces";
import { CheckIcon } from "../../icons/check";
import { ComposeIcon } from "../../icons/compose";
import { OverlapIcon } from "../../icons/overlap";
import { Colleague, FailedMark } from "../desk";
import "./task-pane.css";

/**
 * How long after the pane shows another Task the Return key does nothing, in
 * milliseconds. A Return pressed just as the card changed may have been
 * meant for the card before, and Return can send an answer.
 */
const RETURN_QUIET_MS = 250;

/**
 * What the pane's buttons change. Each one is called with nothing but what
 * the user chose; the caller sends it, and says what happened.
 */
export interface TaskPaneChanges {
  /** Tries again the run that failed (Try again, and Return on a failure). */
  readonly onTryAgain: () => void;
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
}

/** What the pane shows of the answers the user gave to this Task's questions. */
export interface TaskPaneAnswers {
  /**
   * What the user said to the question the pane shows, while the answer waits
   * in the undo line or is being sent, or `null`. The question's chips and
   * line give way to it, so the question cannot be answered twice.
   */
  readonly said: string | null;
  /** The answers of this Task that were not sent, with their words and what to do about them. */
  readonly unsent: readonly UnsentAnswer[];
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

/** The pose a Thread's face takes in a row, from what the Thread is doing. */
const ROW_POSES = {
  Asks: "waiting",
  Waiting: "waiting",
  Working: "working",
  Done: "idle",
} as const;

/** Renders the stage path: each stage as a step, the current one in ink. Choosing a step moves the Task there. */
function StagePath({
  stage,
  onMoveToStage,
}: {
  readonly stage: BoardStage;
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
            tabIndex={-1}
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
  readonly card: WorkCard | null;
  readonly isStill: boolean;
}): JSX.Element | null {
  const colleague = card === null ? null : chooseCardColleaguePose(card);
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

/** Renders what a failed run needs: the card's words, then the two moves only a failure has. */
function FailureSection({
  card,
  actions,
  onAction,
}: {
  readonly card: WorkCard;
  readonly actions: readonly TaskAction[];
  readonly onAction: (id: TaskActionId) => void;
}): JSX.Element | null {
  const failure = card.failure;
  const words = chooseCardSecondLine(card, false);
  if (failure === undefined || words?.tone !== "failed") return null;
  const colleague = chooseCardColleaguePose(card);
  return (
    <section className="task-pane-sec" aria-label="What failed">
      <p className="task-pane-who">
        {colleague !== null && (
          <Face look={buildLook(colleague.sessionId)} pose="failed" size={22} />
        )}
        <span>
          <b>{failure.workflowName}</b> stopped.
        </span>
      </p>
      <p className="task-pane-ask task-pane-failed">
        <FailedMark />
        {words.text}
      </p>
      <div className="task-pane-answers">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={action.filled ? "task-pane-answer is-suggested" : "task-pane-answer"}
            onClick={() => {
              onAction(action.id);
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Renders the line for the user's own answer. Return sends it. */
function ReplyLine({
  placeholder,
  onSend,
}: {
  readonly placeholder: string;
  readonly onSend: (text: string) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const send = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const words = text.trim();
    if (words === "") return;
    // The words stay: a refused answer (too long) keeps them to be edited,
    // and a taken one closes the sheet.
    onSend(words);
  };
  return (
    <form className="task-pane-reply" onSubmit={send}>
      <input
        value={text}
        placeholder={placeholder}
        aria-label="Your answer"
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
    </form>
  );
}

/** Renders a Thread's open question: who asks, the question, and what the pane can do with it. */
function QuestionSection({
  question,
  said,
  actions,
  onAnswer,
  onOpenThread,
}: {
  readonly question: TaskQuestion;
  /** What the user said to this question, while the answer is held or sent, or `null`. */
  readonly said: string | null;
  readonly actions: readonly TaskAction[];
  readonly onAnswer: (answer: PaneAnswer) => void;
  readonly onOpenThread: (sessionId: string) => void;
}): JSX.Element {
  const answerable: AnswerableTaskQuestion | null =
    question.kind === "answerable" ? question : null;
  return (
    <section className="task-pane-sec" aria-label="What a Thread asks">
      <p className="task-pane-who">
        <Face look={buildLook(question.sessionId)} pose="waiting" size={22} />
        <span>
          {question.asker === null ? (
            "A Thread asks."
          ) : (
            <>
              <b>{question.asker}</b> asks.
            </>
          )}
        </span>
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="task-pane-open-thread"
            onClick={() => {
              onOpenThread(question.sessionId);
            }}
          >
            {action.label}
          </button>
        ))}
      </p>
      <p className="task-pane-ask">{question.question}</p>
      {said !== null && <p className="task-pane-said">{said}</p>}
      {said === null && answerable !== null && answerable.chips.length > 0 && (
        <div className="task-pane-answers">
          {answerable.chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              title={chip.description}
              className={chip.suggested ? "task-pane-answer is-suggested" : "task-pane-answer"}
              onClick={() => {
                onAnswer({ kind: "chip", label: chip.label });
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
      {said === null && answerable !== null && (
        <ReplyLine
          key={question.requestId}
          placeholder={answerable.placeholder}
          onSend={(text) => {
            onAnswer({ kind: "text", text });
          }}
        />
      )}
    </section>
  );
}

/** Renders an answer that was not sent: the user's words, why, and Send again or Open thread, and Discard. */
function UnsentAnswerSection({
  unsent,
  onSendAgain,
  onOpenThread,
  onDiscard,
}: {
  readonly unsent: UnsentAnswer;
  readonly onSendAgain: (intentId: string) => void;
  readonly onOpenThread: (sessionId: string) => void;
  readonly onDiscard: (intentId: string) => void;
}): JSX.Element {
  const choose = (id: UnsentAnswer["actions"][number]["id"]): void => {
    if (id === "send-again") onSendAgain(unsent.intentId);
    else if (id === "open-thread") onOpenThread(unsent.sessionId);
    else onDiscard(unsent.intentId);
  };
  return (
    <section className="task-pane-sec" aria-label="An answer that was not sent" role="status">
      <p className="task-pane-said">{unsent.said}</p>
      <p className="task-pane-unsent-note">{unsent.notice}</p>
      <div className="task-pane-answers">
        {unsent.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={
              action.id === "discard" ? "task-pane-answer" : "task-pane-answer is-suggested"
            }
            onClick={() => {
              choose(action.id);
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Renders the line under a Thread's row that asks before the Thread moves to a
 * new Task. Moving a Thread leaves the workspace's link to the old Task, so it
 * says first that the next Thread there still joins the old Task. Esc takes
 * the line back and keeps the pane open.
 */
function MoveThreadConfirm({
  taskTitle,
  onConfirm,
  onCancel,
}: {
  readonly taskTitle: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <div
      className="task-pane-confirm"
      role="group"
      aria-label="Move this Thread to a new Task"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p>{describeNextThreadJoin({ title: taskTitle })}</p>
      <div className="task-pane-confirm-buttons">
        <button type="button" className="task-pane-btn" ref={confirmRef} onClick={onConfirm}>
          Move
        </button>
        <button type="button" className="task-pane-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Renders the Threads of the Task, and says how many more there are than the pane lists. */
function ThreadsSection({
  detail,
  taskTitle,
  onOpenThread,
  onMoveThreadToNewTask,
}: {
  readonly detail: TaskDetail;
  /** The title of the Task the pane shows, which the note before a move names. */
  readonly taskTitle: string;
  readonly onOpenThread: (sessionId: string) => void;
  readonly onMoveThreadToNewTask: (sessionId: string) => void;
}): JSX.Element | null {
  // The Thread whose "Move to a new Task" asks for a second press, and the
  // buttons that opened it, so the focus can go back to the one that did.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  if (detail.sessions.length === 0) return null;
  const hidden = detail.sessionCount - detail.sessions.length;
  return (
    <section className="task-pane-sec" aria-label="Threads">
      <h3>
        Threads <span>{detail.sessionCount}</span>
      </h3>
      {detail.sessions.map((session) => {
        const row: TaskThreadRow = buildTaskThreadRow(session);
        return (
          <Fragment key={row.id}>
            <div className="task-pane-row">
              <button
                type="button"
                className="task-pane-row-open"
                onClick={() => {
                  onOpenThread(row.id);
                }}
              >
                <Face
                  look={buildLook(row.id)}
                  pose={row.state === null ? "idle" : ROW_POSES[row.state]}
                  size={20}
                />
                <span className="task-pane-row-text">{row.label}</span>
                {row.state !== null && <small>{row.state}</small>}
              </button>
              <button
                type="button"
                className="task-pane-row-move"
                aria-expanded={confirmingId === row.id}
                ref={(button) => {
                  if (button === null) moveButtons.current.delete(row.id);
                  else moveButtons.current.set(row.id, button);
                }}
                onClick={() => {
                  setConfirmingId(confirmingId === row.id ? null : row.id);
                }}
              >
                Move to a new Task
              </button>
            </div>
            {confirmingId === row.id && (
              <MoveThreadConfirm
                taskTitle={taskTitle}
                onConfirm={() => {
                  setConfirmingId(null);
                  onMoveThreadToNewTask(row.id);
                }}
                onCancel={() => {
                  setConfirmingId(null);
                  moveButtons.current.get(row.id)?.focus();
                }}
              />
            )}
          </Fragment>
        );
      })}
      {hidden > 0 && <p className="task-pane-more">and {hidden} more</p>}
    </section>
  );
}

/**
 * Renders the line that asks what a new Thread should do, in place of the
 * foot's buttons. It starts with `words`. Return sends what is written (an
 * empty line sends nothing), and Esc takes the line back.
 */
function ThreadPrompt({
  words,
  onSend,
  onCancel,
}: {
  readonly words: string;
  readonly onSend: (prompt: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [text, setText] = useState(words);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const send = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const prompt = text.trim();
    if (prompt !== "") onSend(prompt);
  };
  return (
    <form className="task-pane-thread" onSubmit={send}>
      <input
        ref={inputRef}
        value={text}
        placeholder="What should this thread do?"
        aria-label="What should this thread do?"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          // The line goes, so the focus goes back to the pane's title, not to nowhere.
          event.currentTarget
            .closest(".task-pane")
            ?.querySelector<HTMLElement>("[data-sheet-focus]")
            ?.focus();
          onCancel();
        }}
      />
      <kbd>↩</kbd>
    </form>
  );
}

/**
 * Renders the foot: Done, Start a thread and Merge on the left, and Drop alone
 * at the right. While the pane asks what a new Thread should do
 * (`threadPrompt`), the foot is that one line instead.
 */
function Foot({
  start,
  end,
  threadPrompt,
  onAction,
}: {
  readonly start: readonly TaskAction[];
  readonly end: TaskAction;
  readonly threadPrompt: {
    readonly words: string;
    readonly onSend: (prompt: string) => void;
    readonly onCancel: () => void;
  } | null;
  readonly onAction: (id: TaskActionId) => void;
}): JSX.Element {
  const icons: Partial<Record<TaskActionId, JSX.Element>> = {
    done: <CheckIcon size={14} />,
    "start-thread": <ComposeIcon size={14} />,
    merge: <OverlapIcon size={14} />,
  };
  const draw = (action: TaskAction, className: string): JSX.Element => (
    <button
      key={action.id}
      type="button"
      className={className}
      onClick={() => {
        onAction(action.id);
      }}
    >
      {icons[action.id]}
      {action.label}
      {action.keyHint !== null && <kbd>{action.keyHint}</kbd>}
    </button>
  );
  if (threadPrompt !== null) {
    return (
      <footer className="task-pane-foot">
        <ThreadPrompt
          words={threadPrompt.words}
          onSend={threadPrompt.onSend}
          onCancel={threadPrompt.onCancel}
        />
      </footer>
    );
  }
  return (
    <footer className="task-pane-foot">
      {start.map((action) => draw(action, "task-pane-btn"))}
      {draw(end, "task-pane-btn task-pane-btn--end")}
    </footer>
  );
}

/**
 * Renders a Task's details, the words of the opening sheet. It is
 * presentational: it reads nothing, and every button calls a callback.
 *
 * - `card` is the Task as the board shows it, or the read's when the board
 *   has not got it, or `null` while neither is there. It gives the title, the
 *   stage and the failure, so they show before the read arrives.
 * - `projectName` is the crumb.
 * - `read` is what the details read gives: quiet bars while it is on its
 *   way, a line and a retry after it failed, a line when the Task is gone.
 *   The pane has its final size at once, so nothing moves when the words
 *   arrive.
 * - `answers` is what the user said to the Task's questions: the words of one
 *   held for sending, and the ones that were not sent.
 * - `threadPromptWords` turns the foot into the line that asks what a new
 *   Thread should do, with those words in it to start with (empty for a new
 *   line). `null` leaves the foot as it is.
 * - `actions` is what its buttons do.
 *
 * From the top: the crumb, the title, the stage path, where it stands with
 * the quiet line under it, a failure, a question, What is left, Threads, and
 * the foot. Esc steps back. Return does what the first button of the section
 * above says, unless the focus is on a button or a field: it tries again
 * after a failure, and sends the suggested answer of a question.
 *
 * The title carries `data-sheet-focus`: when the Task changes while the focus
 * is in the pane, the sheet moves the focus to the new title.
 */
export function TaskPane({
  card,
  projectName,
  read,
  answers,
  threadPromptWords,
  actions,
}: {
  readonly card: WorkCard | null;
  readonly projectName: string | null;
  readonly read: TaskPaneRead;
  readonly answers: TaskPaneAnswers;
  /** The words the line that asks what a new Thread should do starts with, or `null` when the foot is not that line. */
  readonly threadPromptWords: string | null;
  readonly actions: TaskPaneActions;
}): JSX.Element {
  const detail = read.status === "ready" ? read.detail : null;
  const taskActions = card === null ? null : listTaskActions(detail ?? { card, sessions: [] });
  const question = detail === null ? null : decideQuestionAnswers(detail);
  // When the pane started to show this Task, for the Return key's quiet moment.
  const shownAt = useRef(0);
  const cardId = card?.id;
  useEffect(() => {
    shownAt.current = performance.now();
  }, [cardId]);

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
    if (performance.now() - shownAt.current < RETURN_QUIET_MS) return;
    event.preventDefault();
    if (taskActions?.returnKey === "try-again") {
      actions.onTryAgain();
    } else if (
      taskActions?.returnKey === "send-suggested-answer" &&
      question?.kind === "answerable"
    ) {
      const suggested = question.chips.find((chip) => chip.suggested);
      if (suggested !== undefined) actions.onAnswer({ kind: "chip", label: suggested.label });
    }
  };

  const hasCard = card !== null;
  return (
    <div className="task-pane" onKeyDown={handleKeyDown} aria-busy={read.status === "loading"}>
      <div className="task-pane-scroll">
        <header className="task-pane-head">
          <p className="task-pane-crumb">
            <span className="task-pane-crumb-text">{projectName}</span>
          </p>
          {hasCard ? (
            <h2 className="task-pane-title" tabIndex={-1} data-sheet-focus>
              {card.title}
            </h2>
          ) : (
            <h2 className="task-pane-title" tabIndex={-1} data-sheet-focus>
              <span className="task-pane-title-bar" />
            </h2>
          )}
          {hasCard && <StagePath stage={card.stage} onMoveToStage={actions.onMoveToStage} />}
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
            <FailureSection
              card={read.detail.card}
              actions={taskActions?.failure ?? []}
              onAction={act}
            />
            {answers.unsent.map((unsent) => (
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
                said={answers.said}
                actions={taskActions?.question ?? []}
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
