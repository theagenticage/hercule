import { Fragment, useId, type JSX, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildApprovalCard, formatRequestQuestion, readErrorMessage } from "@hercule/client-core";
import type { ApprovalDecision, OpenRequest } from "@hercule/contract";
import { buildLook, Face } from "../../faces";
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
 * Renders the Request the thread's session is waiting on, docked on top of
 * the composer, as the Bureau book's `.dock` draws it:
 *
 * - the question: the thread's face in the waiting pose, then the card's
 *   title with what it asks about in `code`;
 * - for a `question` request, its questions and their options, read-only,
 *   and client-core's note that answering them here is not built yet;
 * - the ledger: one answer per decision the request offers, in the
 *   request's order, each with what it does and its key.
 *
 * All the text comes from `buildApprovalCard`, so an answer is described in
 * the same words on every screen.
 *
 * While the composer is shrunk, all of that gives way to `dock-mini`: the
 * face, the question in the one line the sidebar's Waiting on you row
 * shows, and the Allow once and Deny answers, when the request offers
 * them. These answer the request as the ledger's do, without expanding the
 * composer.
 *
 * The dock is a group named by its title, and it can take focus. While the
 * focus is inside it, the keys `findDecisionForKey` lists send their answer.
 * The keys are read here rather than on the window, so nothing outside the
 * dock ever answers a Request, and the dock never takes the focus when it
 * opens.
 *
 * An answer is sent with `session.respond`. Mount one dock per request, keyed
 * by its id, so an answer given to one request never disables the next.
 */
export function RequestDock({
  sessionId,
  request,
}: {
  readonly sessionId: string;
  readonly request: OpenRequest;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const titleId = useId();
  const card = buildApprovalCard(request);
  const respond = useMutation({
    mutationFn: (decision: ApprovalDecision) =>
      client.session.respond({
        params: { id: sessionId },
        payload: { requestId: request.requestId, decision },
      }),
    // The response is not written into the cache. It is the session as the
    // controller held it when the answer arrived, still waiting on the
    // request, so writing it could bring back a dock the live `session` push
    // has already cleared. Until that push clears the request, the answers
    // stay disabled through `isSuccess`.
  });
  // One answer per request. The dock stays until the runner reports the
  // request resolved, and a second answer in that time could contradict the
  // one already sent. The keys obey this too, so the keyboard cannot answer
  // where a click cannot.
  const answered = respond.isPending || respond.isSuccess;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (answered) return;
    const decision = findDecisionForKey(event);
    if (decision === null || !request.decisions.includes(decision)) return;
    // Without this, ↩ or ⌥↩ on a focused answer would also press that
    // answer, and send a second decision.
    event.preventDefault();
    respond.mutate(decision);
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
          <Face look={buildLook(sessionId)} pose="waiting" size={30} decorative />
          <span className="dock-text">
            <span id={titleId}>{card.title}</span>
            {card.subject.map((line, index) => (
              <Fragment key={index}> {card.code ? <code>{line}</code> : line}</Fragment>
            ))}
          </span>
        </div>
        {card.questions.length === 0 ? null : (
          <div className="dock-questions">
            {card.questions.map((question, index) => (
              <div key={index} className="dock-question">
                <span className="dock-question-header">{question.header}</span>
                <span>{question.question}</span>
                <div className="dock-options">
                  {question.options.map((option, optionIndex) => (
                    <Fragment key={optionIndex}>
                      <span className="dock-option-label">{option.label}</span>
                      <span className="ans-desc">{option.description}</span>
                    </Fragment>
                  ))}
                </div>
                {question.note === null ? null : <span className="faint">{question.note}</span>}
              </div>
            ))}
          </div>
        )}
        {card.note === null ? null : <p className="dock-note">{card.note}</p>}
        <div className="ledger">
          {card.rows.map((row) => {
            const key = DECISION_KEYS[row.decision];
            const describeId = `${titleId}-${row.decision}`;
            return (
              <button
                key={row.decision}
                type="button"
                className="ans"
                aria-label={row.label}
                aria-describedby={describeId}
                aria-keyshortcuts={key?.shortcut}
                aria-disabled={answered || undefined}
                onClick={() => {
                  if (!answered) respond.mutate(row.decision);
                }}
              >
                <span className={DECISION_BUTTON_CLASSES[row.decision]}>{row.label}</span>
                <span className="ans-desc" id={describeId}>
                  {row.describe}
                </span>
                {key === null ? null : <kbd aria-hidden="true">{key.hint}</kbd>}
              </button>
            );
          })}
        </div>
        {respond.error === null ? null : (
          <p className="dock-error" role="alert">
            {readErrorMessage(respond.error)}
          </p>
        )}
      </div>
      <div className="dock-mini">
        <Face look={buildLook(sessionId)} pose="waiting" size={24} decorative />
        <span className="dock-mini-q">{formatRequestQuestion(request)}</span>
        <span className="spacer" />
        {card.rows
          .filter((row) => row.decision === "allow" || row.decision === "deny")
          .map((row) => (
            <button
              key={row.decision}
              type="button"
              className={DECISION_BUTTON_CLASSES[row.decision]}
              aria-disabled={answered || undefined}
              onClick={() => {
                if (!answered) respond.mutate(row.decision);
              }}
            >
              {row.label}
            </button>
          ))}
      </div>
    </div>
  );
}
