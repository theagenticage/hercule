import { Fragment, useId, type JSX, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildApprovalCard,
  buildQuestionAnswers,
  buildQuestionDraft,
  formatDescribeLine,
  formatRequestQuestion,
  isQuestionAnswered,
  pickQuestionOption,
  readErrorMessage,
  typeQuestionAnswer,
  type QuestionDraft,
} from "@hercule/client-core";
import type { ApprovalDecision, QuestionAnswers, SessionRequest } from "@hercule/contract";
import { useRequestDraft } from "../../app/thread-drafts";
import { buildLook, Face } from "../../faces";
import { CheckIcon } from "../../icons/check";
import { buildAgentFaceSeed } from "../subagents/subagent-face";
import { isSendKey } from "./send-key";
import "./dock.css";

/**
 * The key that sends each decision while focus is in the dock: its hint, as
 * the answer's key cap draws it, and its name, as `aria-keyshortcuts` spells
 * it. Cancel has no key.
 */
const DECISION_KEYS: Readonly<
  Record<ApprovalDecision, { readonly hint: string; readonly shortcut: string } | null>
> = {
  allow: { hint: "↩", shortcut: "Enter" },
  allow_always: { hint: "⌥↩", shortcut: "Alt+Enter" },
  deny: { hint: "esc", shortcut: "Escape" },
  cancel: null,
};

/**
 * The button each decision is drawn as. Allow is the suggested answer, so it
 * takes the accent; Allow always does something too, so it is a plain
 * button; Deny and Cancel decline, so they are quiet.
 */
const DECISION_BUTTON_CLASSES: Readonly<Record<ApprovalDecision, string>> = {
  allow: "btn btn--accent btn--sm",
  allow_always: "btn btn--sm",
  deny: "btn btn--quiet btn--sm",
  cancel: "btn btn--quiet btn--sm",
};

/**
 * Returns the decision a key pressed inside the dock sends, or `null` when
 * the key sends none:
 *
 * - ⌥↩ sends allow_always, wherever the focus is in the dock;
 * - esc sends deny, wherever the focus is in the dock;
 * - ↩ sends allow only when the dock itself has focus. When an answer has
 *   focus, ↩ presses that answer, as it presses any button, so a focused
 *   Deny is never turned into Allow.
 *
 * Only an approval takes a decision, so `RequestDock` never asks for one on
 * a `question` request.
 *
 * A key held with ⌘, ⌃ or ⇧ sends nothing, so those combinations keep any
 * meaning the app gives them.
 */
const findDecisionForKey = (event: KeyboardEvent<HTMLElement>): ApprovalDecision | null => {
  if (event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (event.key === "Enter") {
    if (event.altKey) return "allow_always";
    return event.target === event.currentTarget ? "allow" : null;
  }
  if (event.key === "Escape" && !event.altKey) return "deny";
  return null;
};

/**
 * Renders one Request the thread's session is waiting on, docked on top of
 * the composer, as the Bureau book's `.dock` draws it. On an agent's page,
 * `AgentRequestDock` decides which Request and pages between them; the
 * Office's dossier shows the oldest.
 *
 * - the question: the face of the agent that asked, in the waiting pose,
 *   then the card's title with what it asks about in `code`. A subagent's
 *   Request shows the subagent's face, else the thread's;
 * - for a `question` request, one question at a time: its header, its place
 *   among the questions when there are several, its options as choices, a
 *   field for the user's own answer, and Next, or Send answers on the last
 *   question;
 * - for an approval, the ledger: one answer per decision the approval
 *   offers, in the approval's order, each with what it does and its key.
 *
 * A question offers no decision. To turn it down, the user stops the turn
 * with the composer's Stop, which resolves the question as cancelled.
 *
 * The request's text, its questions and its answers come from
 * `buildApprovalCard`, so an answer is described in the same words on every
 * screen. Only the controls' own labels, such as Next, are written here.
 *
 * While the composer is shrunk, all of that gives way to `dock-mini`: the
 * face, the question in the one line the sidebar's Waiting on you row
 * shows, and the Allow once and Deny answers, when the approval offers
 * them. These answer the request as the ledger's do, without expanding the
 * composer.
 *
 * The dock is a group named by its title, and it can take focus. While the
 * focus is inside an approval's dock, the keys `findDecisionForKey` lists
 * send their answer. On a `question` request, ↩ on the dock itself, on a
 * choice or in the own-answer field, and ⌘↵ anywhere in the dock, do what
 * Next or Send answers does. A user who clicks a choice and presses ↩ moves
 * on, while ↩ on a focused button still presses that button. The keys are
 * read here rather than on the window, so nothing outside the dock ever
 * answers a Request, and the dock never takes the focus when it opens.
 *
 * A decision is sent with `session.respondToApprovalRequest`, and answers
 * with `session.respondToQuestion`. Mount one dock per request, keyed by its
 * id, so an answer given to one request never disables the next.
 *
 * What the user has typed, the shown question and whether an answer was
 * sent are kept in the thread's Request draft (`useRequestDraft`), so they
 * survive paging to another Request, and a move to a subagent's page and
 * back. Something that shows the thread must keep its drafts
 * (`useKeepRequestDrafts`).
 */
export function RequestDock({
  sessionId,
  request,
}: {
  readonly sessionId: string;
  readonly request: SessionRequest;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const titleId = useId();
  const card = buildApprovalCard(request);
  const faceLook = buildLook(buildAgentFaceSeed(sessionId, request.subagentId));
  const [requestDraft, changeRequestDraft] = useRequestDraft(sessionId, request.requestId);
  // A failed send unlocks the Request, so the user can answer again. The
  // mutation's own callbacks run even after the dock has unmounted, and the
  // draft is changed through the thread's drafts, so the unlock lands
  // whether or not the dock is still shown.
  const markAnswered = (answered: boolean): void => {
    changeRequestDraft((current) => ({ ...current, answered }));
  };
  // Neither response is written into the cache. It is the session as the
  // controller held it when the answer arrived, still waiting on the
  // request, so writing it could bring back a dock the live `session` push
  // has already cleared. Until that push clears the request, the answers
  // stay disabled through the draft's `answered`.
  const decide = useMutation({
    mutationFn: (decision: ApprovalDecision) =>
      client.session.respondToApprovalRequest({
        params: { id: sessionId },
        payload: { requestId: request.requestId, decision },
      }),
    onMutate: () => markAnswered(true),
    onError: () => markAnswered(false),
  });
  const answer = useMutation({
    mutationFn: (answers: QuestionAnswers) =>
      client.session.respondToQuestion({
        params: { id: sessionId },
        payload: { requestId: request.requestId, answers },
      }),
    onMutate: () => markAnswered(true),
    onError: () => markAnswered(false),
  });
  // One answer per request. The dock stays until the runner reports the
  // request resolved, and a second answer in that time could contradict the
  // one already sent. The keys obey this too, so the keyboard cannot answer
  // where a click cannot.
  const locked = requestDraft.answered || decide.isPending || answer.isPending;
  const error = decide.error ?? answer.error;
  // The state of a `question` request: what the user has given so far, and
  // which question is shown. For every other kind the draft stays empty and
  // the index is not used.
  const draft = requestDraft.question ?? buildQuestionDraft(card.questions);
  const { shownQuestionIndex } = requestDraft;
  const setDraft = (question: QuestionDraft): void => {
    changeRequestDraft((current) => ({ ...current, question }));
  };
  const question = card.questions[shownQuestionIndex];
  const questionAnswered = question !== undefined && isQuestionAnswered(draft, question);
  const isLastQuestion = shownQuestionIndex === card.questions.length - 1;

  /** Shows the next question, or sends the answers from the last one, once the shown question is answered. */
  const advanceQuestions = (): void => {
    if (locked || !questionAnswered) return;
    if (!isLastQuestion) {
      changeRequestDraft((current) => ({ ...current, shownQuestionIndex: shownQuestionIndex + 1 }));
      return;
    }
    const answers = buildQuestionAnswers(draft, card.questions);
    if (answers !== null) answer.mutate(answers);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (question !== undefined && isSendKey(event) && !event.ctrlKey && !event.altKey) {
      // ↩ on a button presses that button. ⌘↵ is the app's send key, and
      // left alone it would reach the menu's Send and send the composer's
      // message, so it is caught wherever the focus is in the dock, even
      // once the answers are sent.
      if (event.target instanceof HTMLButtonElement && !event.metaKey) return;
      event.preventDefault();
      advanceQuestions();
      return;
    }
    if (locked || request.kind === "question") return;
    const decision = findDecisionForKey(event);
    if (decision === null || !request.decisions.includes(decision)) return;
    // Without this, ↩ or ⌥↩ on a focused answer would also press that
    // answer, and send a second decision.
    event.preventDefault();
    decide.mutate(decision);
  };

  return (
    <div
      className="dock"
      role="group"
      aria-labelledby={titleId}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="fold">
        <div className="dock-q">
          <Face look={faceLook} pose="waiting" size={30} />
          <span className="dock-text">
            <span id={titleId}>{card.title}</span>
            {card.subject.map((line, index) => (
              <Fragment key={index}> {card.code ? <code>{line}</code> : line}</Fragment>
            ))}
          </span>
        </div>
        {question === undefined ? null : (
          <div className="dock-question">
            <div className="dock-question-top">
              <span className="dock-question-header">{question.header}</span>
              {card.questions.length === 1 ? null : (
                <span className="dock-question-place">
                  Question {shownQuestionIndex + 1} of {card.questions.length}
                </span>
              )}
            </div>
            <span className="dock-question-text">{question.question}</span>
            {/* The choices sit on the ledger's grid: the choice and its label
                in the buttons' column, what it means in the descriptions'
                column, so options and answers line up. The whole row is the
                click target. */}
            {question.options.length === 0 ? null : (
              <div className="dock-options">
                {question.options.map((option, index) => (
                  // Keyed by place, so a focused choice keeps the focus when
                  // the next question has a choice in the same place.
                  <label key={index} className="dock-option">
                    <span className="dock-option-label">
                      <span className="dock-choice">
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          name={titleId}
                          checked={draft[question.header]!.picks.includes(option.label)}
                          disabled={locked}
                          onChange={() =>
                            setDraft(pickQuestionOption(draft, question, option.label))
                          }
                        />
                        {question.multiSelect ? <CheckIcon size={12} /> : null}
                      </span>
                      {option.label}
                    </span>
                    <span className="ans-desc">{option.description}</span>
                  </label>
                ))}
              </div>
            )}
            {question.note === null ? null : (
              <span className="dock-question-note">{question.note}</span>
            )}
            {question.secretWarning === null ? null : (
              <span className="dock-question-warning">{question.secretWarning}</span>
            )}
            <div className="dock-own">
              <input
                className="field"
                type="text"
                aria-label="Your own answer"
                placeholder="Or type your own answer"
                value={draft[question.header]!.text}
                disabled={locked}
                onChange={(event) =>
                  setDraft(typeQuestionAnswer(draft, question, event.target.value))
                }
              />
              {/* `aria-disabled` rather than `disabled`, so the button keeps
                  the focus when Next turns into Send answers on a question
                  not yet answered. Until the shown question is answered, and
                  once the answers are sent, it looks like a plain button with
                  a faint label, as the locked choices and field do. */}
              <button
                type="button"
                className="btn btn--accent btn--sm"
                aria-disabled={locked || !questionAnswered}
                data-unready={locked || !questionAnswered || undefined}
                onClick={advanceQuestions}
              >
                {isLastQuestion ? "Send answers" : "Next"}
              </button>
            </div>
          </div>
        )}
        {card.rows.length === 0 ? null : (
          <div className="ledger">
            {card.rows.map((row) => {
              const key = DECISION_KEYS[row.id];
              const describeId = `${titleId}-${row.id}`;
              return (
                <button
                  key={row.id}
                  type="button"
                  className="ans"
                  aria-label={row.label}
                  aria-describedby={describeId}
                  aria-keyshortcuts={key?.shortcut}
                  aria-disabled={locked || undefined}
                  onClick={() => {
                    if (!locked) decide.mutate(row.id);
                  }}
                >
                  <span className={DECISION_BUTTON_CLASSES[row.id]}>{row.label}</span>
                  <span className="ans-desc" id={describeId}>
                    {formatDescribeLine(row.describeLine)}
                  </span>
                  {key === null ? null : <kbd aria-hidden="true">{key.hint}</kbd>}
                </button>
              );
            })}
          </div>
        )}
        {error === null ? null : (
          <p className="dock-error" role="alert">
            {readErrorMessage(error)}
          </p>
        )}
      </div>
      <div className="dock-mini">
        <Face look={faceLook} pose="waiting" size={24} />
        <span className="dock-mini-q">{formatRequestQuestion(request)}</span>
        <span className="spacer" />
        {card.rows
          .filter((row) => row.id === "allow" || row.id === "deny")
          .map((row) => (
            <button
              key={row.id}
              type="button"
              className={DECISION_BUTTON_CLASSES[row.id]}
              aria-disabled={locked || undefined}
              onClick={() => {
                if (!locked) decide.mutate(row.id);
              }}
            >
              {row.label}
            </button>
          ))}
      </div>
    </div>
  );
}
