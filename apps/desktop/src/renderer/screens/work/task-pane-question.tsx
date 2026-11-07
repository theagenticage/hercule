import { useState, type FormEvent, type JSX } from "react";
import type {
  AnswerableTaskQuestion,
  PaneAnswer,
  TaskAction,
  TaskQuestion,
  UnsentAnswer,
} from "@hercule/client-core/work";
import { buildLook, Face } from "../../faces";

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

/**
 * Renders a Thread's open question: who asks, the question, and what the pane
 * can do with it. `openThread` is the button that opens the Thread, or `null`
 * when the pane has none to offer.
 */
export function QuestionSection({
  question,
  said,
  openThread,
  onAnswer,
  onOpenThread,
}: {
  readonly question: TaskQuestion;
  /** What the user said to this question, while the answer is held or sent, or `null`. */
  readonly said: string | null;
  readonly openThread: TaskAction | null;
  readonly onAnswer: (answer: PaneAnswer, question: AnswerableTaskQuestion) => void;
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
        {openThread !== null && (
          <button
            type="button"
            className="task-pane-open-thread"
            onClick={() => {
              onOpenThread(question.sessionId);
            }}
          >
            {openThread.label}
          </button>
        )}
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
                onAnswer({ kind: "chip", label: chip.label }, answerable);
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
            onAnswer({ kind: "text", text }, answerable);
          }}
        />
      )}
    </section>
  );
}

/** Renders an answer that was not sent: the user's words, why, and Send again or Open thread, and Discard. */
export function UnsentAnswerSection({
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
