import { Fragment, useId, type JSX, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  FOLD_QUESTION_LABEL,
  PREVIOUS_QUESTION_LABEL,
  UNFOLD_QUESTION_LABEL,
  buildApprovalCard,
  buildQuestionDraft,
  buildQuestionStepper,
  describeFoldedQuestion,
  formatDescribeLine,
  formatRequestQuestion,
  pickQuestionOption,
  readErrorMessage,
  decideQuestionStep,
  typeShownQuestionAnswer,
  type QuestionDraft,
} from "@hercule/client-core";
import {
  isAsyncQuestion,
  type ApprovalDecision,
  type DescribeLine,
  type SessionRequest,
} from "@hercule/contract";
import { useRequestDraft, useSendAnswers } from "../../app/request-drafts";
import { buildLook, Face, type Look } from "../../faces";
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
 * a `question` request. `PermissionRequestDock` reads the same keys for the
 * answers that mirror these decisions.
 *
 * A key held with ⌘, ⌃ or ⇧ sends nothing, so those combinations keep any
 * meaning the app gives them.
 */
export const findDecisionForKey = (event: KeyboardEvent<HTMLElement>): ApprovalDecision | null => {
  if (event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (event.key === "Enter") {
    if (event.altKey) return "allow_always";
    return event.target === event.currentTarget ? "allow" : null;
  }
  if (event.key === "Escape" && !event.altKey) return "deny";
  return null;
};

/**
 * One answer of a dock's ledger, which `AnswerLedger` and `ShrunkDockRow`
 * draw. `Id` is what the answer sends when it is given.
 */
export interface DockAnswer<Id extends string> {
  /** What the answer sends, which also tells the answers apart. */
  readonly id: Id;
  readonly label: string;
  /** What the answer does, drawn beside its button. */
  readonly describeLine: DescribeLine;
  /** The approval decision whose key and button the answer takes. */
  readonly decision: ApprovalDecision;
  /** Whether the answer can be given now. One that cannot is drawn faded and sends nothing. */
  readonly available: boolean;
}

/**
 * Renders the ledger of a dock, as the Bureau book's `.ledger` draws it:
 * one row per answer of `answers`, each with its button, what it does and
 * its key. A click on a row calls `onAnswer` with the answer's id, unless
 * the dock is `locked` or the answer is not available. The key itself is
 * read by the dock, not here. `titleId` is the id of the dock's title, from
 * which each row's description takes its id.
 */
export function AnswerLedger<Id extends string>({
  titleId,
  answers,
  locked,
  onAnswer,
}: {
  readonly titleId: string;
  readonly answers: readonly DockAnswer<Id>[];
  readonly locked: boolean;
  readonly onAnswer: (id: Id) => void;
}): JSX.Element {
  return (
    <div className="ledger">
      {answers.map((answer) => {
        const key = DECISION_KEYS[answer.decision];
        const describeId = `${titleId}-${answer.id}`;
        const disabled = locked || !answer.available;
        return (
          <button
            key={answer.id}
            type="button"
            className="ans"
            aria-label={answer.label}
            aria-describedby={describeId}
            aria-keyshortcuts={key?.shortcut}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (!disabled) onAnswer(answer.id);
            }}
          >
            <span
              className={DECISION_BUTTON_CLASSES[answer.decision]}
              data-unready={!answer.available || undefined}
            >
              {answer.label}
            </span>
            <span className="ans-desc" id={describeId}>
              {formatDescribeLine(answer.describeLine)}
            </span>
            {key === null ? null : <kbd aria-hidden="true">{key.hint}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Renders the dock while the composer is shrunk, as the Bureau book's
 * `.dock-mini` draws it: the face of the agent that asks, in the waiting
 * pose, `question` in one line, and the answers of `answers` that take the
 * Allow and Deny decisions. A click calls `onAnswer` as the ledger's
 * rows do, without expanding the composer.
 */
export function ShrunkDockRow<Id extends string>({
  look,
  question,
  answers,
  locked,
  onAnswer,
}: {
  readonly look: Look;
  readonly question: string;
  readonly answers: readonly DockAnswer<Id>[];
  readonly locked: boolean;
  readonly onAnswer: (id: Id) => void;
}): JSX.Element {
  return (
    <div className="dock-mini">
      <Face look={look} pose="waiting" size={24} />
      <span className="dock-mini-q">{question}</span>
      <span className="spacer" />
      {answers
        .filter((answer) => answer.decision === "allow" || answer.decision === "deny")
        .map((answer) => {
          const disabled = locked || !answer.available;
          return (
            <button
              key={answer.id}
              type="button"
              className={DECISION_BUTTON_CLASSES[answer.decision]}
              aria-disabled={disabled || undefined}
              data-unready={!answer.available || undefined}
              onClick={() => {
                if (!disabled) onAnswer(answer.id);
              }}
            >
              {answer.label}
            </button>
          );
        })}
    </div>
  );
}

/**
 * Renders one Request the session `sessionId` is waiting on, docked on top
 * of the composer, as the Bureau book's `.dock` draws it. On a thread's
 * agent page `AgentRequestDock`, and in an assistant's Conversation
 * `ConversationRequestDock`, decides which Request and pages between them;
 * the Office's dossier shows the oldest.
 *
 * - the question: the face of the agent that asked, in the waiting pose,
 *   then the card's title with what it asks about in `code`. A subagent's
 *   Request shows the subagent's face, else `look`, the face of the
 *   session's own agent (the thread's or the assistant's);
 * - for a `question` request, one question at a time: its header, its place
 *   among the questions when there are several, its options as choices, and,
 *   where the dock has to take the user's own answer itself, a field with
 *   Previous and Next, or Send answers on the last question (see below). An
 *   async question (one the agent does not wait on) is folded by default into
 *   one row, with an Answer button that opens the card, and the open card has
 *   a Later button that folds it back;
 * - for an approval, the ledger: one answer per decision the approval
 *   offers, in the approval's order, each with what it does and its key.
 *
 * A question offers no decision. To turn it down, the user stops the turn
 * with the composer's Stop, which resolves the question as cancelled.
 *
 * The request's text, its questions and its answers come from
 * `buildApprovalCard`, so an answer is described in the same words on every
 * screen. The controls' labels, and the rules for stepping through the
 * questions, come from `@hercule/client-core`.
 *
 * Where the user's own answer is typed. With `composerBelow`, the composer
 * under the dock answers the shown question (`findComposerQuestion`), and the
 * dock draws no field and no step button. The dock keeps its own field, masked
 * for a secret question, when the composer does not answer: a secret question,
 * or a place with no composer below (a subagent's page, the Office's dossier).
 * It then also shows the failure of a send, which the composer would show
 * otherwise.
 *
 * `messageDraftKey` is the `pendingSubmissions` key of the Message Draft that
 * a pick moves typed text to. Picking an option on a single-select question
 * replaces the typed answer, and the typed text is appended to that Message
 * Draft rather than lost. On a secret question a pick erases the typed text
 * and never moves it to the Message Draft, which is not secret.
 *
 * While the composer is shrunk, all of that gives way to `dock-mini`: the
 * face, the question in the one line the sidebar's Waiting on you row
 * shows, and the Allow and Deny answers, when the approval offers
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
 * sent are kept in the session's Request draft (`useRequestDraft`), so they
 * survive paging to another Request, and a move to a subagent's page and
 * back. Something that shows the session must keep its drafts
 * (`useKeepRequestDrafts`).
 */
export function RequestDock({
  sessionId,
  look,
  request,
  composerBelow,
  messageDraftKey,
}: {
  readonly sessionId: string;
  readonly look: Look;
  readonly request: SessionRequest;
  /** Whether a composer is drawn under the dock, which then answers a question that is not secret. */
  readonly composerBelow: boolean;
  /** The `pendingSubmissions` key of the Message Draft that text displaced by picking an option moves to. */
  readonly messageDraftKey: string;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, pendingSubmissions } = controller;
  const titleId = useId();
  const card = buildApprovalCard(request);
  const answers = card.rows.map((row): DockAnswer<ApprovalDecision> => ({
    ...row,
    decision: row.id,
    available: true,
  }));
  const faceLook =
    request.subagentId === undefined
      ? look
      : buildLook(buildAgentFaceSeed(sessionId, request.subagentId));
  const [requestDraft, changeRequestDraft] = useRequestDraft(sessionId, request.requestId);
  const sendAnswers = useSendAnswers(sessionId);
  // A failed decision unlocks the Request, so the user can decide again. The
  // mutation's own callbacks run even after the dock has unmounted, and the
  // draft is changed through the session's Request drafts, so the unlock lands
  // whether or not the dock is still shown.
  const markAnswered = (answered: boolean): void => {
    changeRequestDraft((current) => ({ ...current, answered }));
  };
  // The response is not written into the cache. It is the session as the
  // controller held it when the decision arrived, still waiting on the
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
  // One answer per request. The dock stays until the runner reports the
  // request resolved, and a second answer in that time could contradict the
  // one already sent. The keys obey this too, so the keyboard cannot answer
  // where a click cannot.
  const locked = requestDraft.answered || decide.isPending;
  // The state of a `question` request: what the user has given so far, and
  // which question is shown. For every other kind the draft stays empty and
  // the index is not used.
  const draft = requestDraft.question ?? buildQuestionDraft(card.questions);
  const question = card.questions[requestDraft.shownQuestionIndex];
  const setDraft = (next: QuestionDraft): void => {
    changeRequestDraft((current) => ({ ...current, question: next }));
  };
  // A folded async question is one row and has no question shown.
  const folded = isAsyncQuestion(request) && !requestDraft.unfolded;
  const shownQuestion = folded ? undefined : question;
  const setUnfolded = (unfolded: boolean): void => {
    changeRequestDraft((current) => ({ ...current, unfolded }));
  };
  // The dock takes the own answer itself where the composer does not: with no
  // composer below, or on a secret question (`findComposerQuestion` leaves a
  // secret question to the dock). The stepper is built only then, so a key
  // typed in the composer costs the dock no more than its draft read.
  const ownsAnswerField =
    shownQuestion !== undefined && (!composerBelow || shownQuestion.secretWarning !== null);
  const stepper = ownsAnswerField ? buildQuestionStepper(requestDraft, card.questions) : null;
  const error = ownsAnswerField
    ? requestDraft.failure
    : decide.error === null
      ? null
      : readErrorMessage(decide.error);

  /** Shows the question before or after the shown one, or sends the answers from the last one. */
  const stepThroughQuestions = (direction: "previous" | "next"): void => {
    if (shownQuestion === undefined) return;
    const step = decideQuestionStep(requestDraft, card.questions, direction);
    if (step === null) return;
    if (step.kind === "send") {
      sendAnswers(request.requestId, step.answers);
      return;
    }
    changeRequestDraft((current) => ({ ...current, shownQuestionIndex: step.index }));
  };

  /**
   * Picks an option, and moves the text it displaces to the end of the Message
   * Draft. On a secret question the displaced text is erased instead, never
   * moved to the Message Draft.
   */
  const pickOption = (label: string): void => {
    if (shownQuestion === undefined) return;
    const messageText = pendingSubmissions.read(messageDraftKey).message.text;
    const picked = pickQuestionOption(draft, shownQuestion, label, messageText);
    setDraft(picked.question);
    if (picked.messageText !== messageText) {
      pendingSubmissions.writeText(messageDraftKey, picked.messageText);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (
      request.kind === "question" &&
      isSendKey(event.nativeEvent) &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // ↩ on a button presses that button. ⌘↵ is the app's send key, and
      // left alone it would reach the menu's Send and send the composer's
      // message, so it is caught wherever the focus is in the dock, even
      // once the answers are sent.
      if (event.target instanceof HTMLButtonElement && !event.metaKey) return;
      event.preventDefault();
      stepThroughQuestions("next");
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
        <div className={folded ? "dock-q dock-q--folded" : "dock-q"}>
          <Face look={faceLook} pose="waiting" size={30} />
          {request.kind === "question" && folded ? (
            <>
              <span className="dock-text" id={titleId}>
                {describeFoldedQuestion(request)}
              </span>
              <button
                type="button"
                className="btn btn--accent btn--sm"
                onClick={() => {
                  setUnfolded(true);
                }}
              >
                {UNFOLD_QUESTION_LABEL}
              </button>
            </>
          ) : (
            <>
              <span className="dock-text">
                <span id={titleId}>{card.title}</span>
                {card.subject.map((line, index) => (
                  <Fragment key={index}> {card.code ? <code>{line}</code> : line}</Fragment>
                ))}
              </span>
              {isAsyncQuestion(request) ? (
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => {
                    setUnfolded(false);
                  }}
                >
                  {FOLD_QUESTION_LABEL}
                </button>
              ) : null}
            </>
          )}
        </div>
        {shownQuestion === undefined ? null : (
          <div className="dock-question">
            <div className="dock-question-top">
              <span className="dock-question-header">{shownQuestion.header}</span>
              {card.questions.length === 1 ? null : (
                <span className="dock-question-place">
                  Question {requestDraft.shownQuestionIndex + 1} of {card.questions.length}
                </span>
              )}
            </div>
            <span className="dock-question-text">{shownQuestion.question}</span>
            {/* The choices sit on the ledger's grid: the choice and its label
                in the buttons' column, what it means in the descriptions'
                column, so options and answers line up. The whole row is the
                click target. */}
            {shownQuestion.options.length === 0 ? null : (
              <div
                className={
                  // Decided here, not by a `:has()` selector in the CSS:
                  // `:has()` makes style invalidation depend on descendants,
                  // which costs while the transcript streams.
                  shownQuestion.options.some((option) => option.description !== undefined)
                    ? "dock-options"
                    : "dock-options dock-options--plain"
                }
              >
                {shownQuestion.options.map((option, index) => (
                  // Keyed by place, so a focused choice keeps the focus when
                  // the next question has a choice in the same place.
                  <label key={index} className="dock-option">
                    <span className="dock-option-label">
                      <span className="dock-choice">
                        <input
                          type={shownQuestion.multiSelect ? "checkbox" : "radio"}
                          name={titleId}
                          checked={draft[shownQuestion.header]!.picks.includes(option.label)}
                          disabled={locked}
                          onChange={() => {
                            pickOption(option.label);
                          }}
                        />
                        {shownQuestion.multiSelect ? <CheckIcon size={12} /> : null}
                      </span>
                      {option.label}
                    </span>
                    {option.description === undefined ? null : (
                      <span className="ans-desc">{option.description}</span>
                    )}
                  </label>
                ))}
              </div>
            )}
            {shownQuestion.note === null ? null : (
              <span className="dock-question-note">{shownQuestion.note}</span>
            )}
            {shownQuestion.secretWarning === null ? null : (
              <span className="dock-question-warning">{shownQuestion.secretWarning}</span>
            )}
            {stepper === null ? null : (
              <div className="dock-own">
                <input
                  className="field"
                  // A secret answer is masked, so it never shows on screen.
                  type={shownQuestion.secretWarning === null ? "text" : "password"}
                  autoComplete="off"
                  aria-label="Your own answer"
                  aria-describedby={stepper.notice === null ? undefined : `${titleId}-notice`}
                  placeholder={stepper.placeholder}
                  value={draft[shownQuestion.header]!.text}
                  disabled={locked}
                  onChange={(event) => {
                    const text = event.target.value;
                    changeRequestDraft((current) =>
                      typeShownQuestionAnswer(current, card.questions, text),
                    );
                  }}
                />
                {stepper.showsPrevious ? (
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    aria-disabled={!stepper.canGoBack}
                    data-unready={!stepper.canGoBack || undefined}
                    onClick={() => {
                      stepThroughQuestions("previous");
                    }}
                  >
                    {PREVIOUS_QUESTION_LABEL}
                  </button>
                ) : null}
                {/* `aria-disabled` rather than `disabled`, so the button keeps
                    the focus when Next turns into Send answers on a question
                    not yet answered. Until the shown question is answered, and
                    once the answers are sent, it looks like a plain button with
                    a faint label, as the locked choices and field do. */}
                <button
                  type="button"
                  className="btn btn--accent btn--sm"
                  aria-disabled={!stepper.ready}
                  data-unready={!stepper.ready || undefined}
                  onClick={() => {
                    stepThroughQuestions("next");
                  }}
                >
                  {stepper.stepLabel}
                </button>
              </div>
            )}
            {stepper !== null && stepper.notice !== null ? (
              <p className="dock-error" id={`${titleId}-notice`}>
                {stepper.notice}
              </p>
            ) : null}
          </div>
        )}
        {answers.length === 0 ? null : (
          <AnswerLedger
            titleId={titleId}
            answers={answers}
            locked={locked}
            onAnswer={(decision) => decide.mutate(decision)}
          />
        )}
        {error === null ? null : (
          <p className="dock-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <ShrunkDockRow
        look={faceLook}
        question={formatRequestQuestion(request)}
        answers={answers}
        locked={locked}
        onAnswer={(decision) => decide.mutate(decision)}
      />
    </div>
  );
}
