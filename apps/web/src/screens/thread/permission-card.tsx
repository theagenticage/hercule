import { type JSX, useId } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  type ApprovalQuestion,
  buildApprovalCard,
  buildQuestionAnswers,
  buildQuestionDraft,
  type HerculeClient,
  isQuestionAnswered,
  pickQuestionOption,
  type QuestionDraft,
  readErrorMessage,
  type RequestDraft,
  typeQuestionAnswer,
} from "@hercule/client-core";
import type { ApprovalDecision, OpenRequest, QuestionAnswers } from "@hercule/contract";
import { AnswerLedger, Button, ChoiceInput, cn, DecisionMark, Input } from "@hercule/ui";
import { useRequestDraft } from "../../app/thread-drafts";

/**
 * Renders the permission card: one Request the session's agents are parked
 * on, docked onto the composer, or onto a subagent's status card. The Request
 * dock passes the Request it shows. The card always appears in the same place
 * and is never repeated in the transcript. Its answers form the same ledger as a
 * decision's answers in the notification center.
 *
 * The dock mirrors the composer's bottom lip above the card: the same 14px
 * inset, the same `--surface` on a `--line-soft` border, a 10px radius on the
 * two corners away from the card, and 8px hidden under the card. The card
 * keeps its own radius, border and shadow. A second raised card would look
 * like a separate surface; a lip looks like part of the composer, which is
 * what the dock is. Spec 14 §The thread surface and §Measurements own the
 * layout.
 *
 * A `question` request is not an approval. Where a command or path would
 * otherwise go, it shows the question form, and the user answers there. It
 * has no ledger: a question offers no decision. To turn down the session's
 * own agent's question, the user stops the turn with the composer's Stop; to
 * turn down a subagent's, the user stops that subagent from its page.
 *
 * The request's text, its questions and its answers come from
 * `buildApprovalCard`, so an answer is described the same way everywhere and
 * no screen can reword or drop it. Only the controls' own labels, such as
 * Next, are written here.
 *
 * What the user has typed, which question is shown, and whether an answer was
 * sent are the thread's drafts, not the card's own state. The card unmounts
 * when the user pages to another Request or opens another of the thread's
 * pages, and coming back must find the half-written answer, and must not
 * offer a second answer while the controller has not yet closed the Request.
 */
export function PermissionCard({
  client,
  sessionId,
  request,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
  readonly request: OpenRequest;
}): JSX.Element {
  const card = buildApprovalCard(request);
  const [draft, changeDraft] = useRequestDraft(request.requestId);
  // A failed send unlocks the Request, so the user can answer again. The
  // mutation's own callbacks run even after the card has unmounted, so the
  // draft is right when the user comes back.
  const markAnswered = (answered: boolean): void => {
    changeDraft((current) => ({ ...current, answered }));
  };
  // Neither response is written into the cache. It is a snapshot of the
  // session from when the controller received the answer, still parked on
  // the request, so writing it would bring back a card the live `session`
  // topic has already cleared. That topic is the source of truth; until it
  // clears the request, the card stays locked through the draft's `answered`.
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
  // One answer per request. The card stays until the runner reports the
  // request resolved, and a second click in that time could send an answer
  // that contradicts the one already recorded.
  const locked = draft.answered || decide.isPending || answer.isPending;
  const error = decide.error ?? answer.error;

  return (
    // The dock sits behind the card: the card is `z-[1]`, so the 8px of the
    // dock tucked under it is covered by the card.
    <div className="mx-3.5 -mb-2 grid grid-cols-[18px_minmax(0,1fr)] rounded-t-[10px] border border-b-0 border-line-soft bg-surface px-3 pt-[5px] pb-[13px] text-fine text-muted">
      {/* The mark sits alone in its own column at the dock's left edge, so the
          title, the subject, the questions and the answer labels all line up
          on one left edge in the column beside it. */}
      <DecisionMark className="mt-[3px]" />
      <div className="flex min-w-0 flex-col">
        <span className="text-meta font-emph text-ink">{card.title}</span>
        {/* A 4096-character command or forty paths scroll here rather than
            push the composer off the screen. */}
        <div className="flex max-h-36 flex-col overflow-y-auto">
          {card.subject.map((line, index) => (
            <span
              key={index}
              className={cn("break-all", card.code ? "font-mono text-[11px]" : "text-fine")}
            >
              {line}
            </span>
          ))}
        </div>
        {card.questions.length === 0 ? null : (
          <QuestionForm
            questions={card.questions}
            draft={draft}
            onDraftChange={changeDraft}
            locked={locked}
            onSend={(answers) => answer.mutate(answers)}
          />
        )}
        {/* The ledger's rows extend 8px past this column on both sides, so
            the labels stay on the same left edge as the title. The dock's
            13px bottom padding keeps the last row clear of the card, which
            covers the dock's bottom 8px. */}
        {card.rows.length === 0 ? null : (
          <div className="mt-1">
            <AnswerLedger
              rows={card.rows}
              disabled={locked}
              onSelect={(decision) => decide.mutate(decision)}
            />
          </div>
        )}
        {error === null ? null : (
          <p className="mt-1 text-fail" role="alert">
            {readErrorMessage(error)}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Renders the questions of a `question` request one at a time, and calls
 * `onSend` with the answers to all of them once the user sends.
 *
 * Each question shows its chip, its text, its options as choices (radios when
 * it takes one answer, checkboxes when it takes several) and a field for the
 * user's own answer. Next and Send stay unusable until the shown question is
 * answered, so the answers sent never leave a question out. They use
 * `aria-disabled` rather than `disabled`, so the button keeps focus while the
 * user picks. The form submits on Enter in the field, like any form.
 */
function QuestionForm({
  questions,
  draft: requestDraft,
  onDraftChange,
  locked,
  onSend,
}: {
  readonly questions: readonly ApprovalQuestion[];
  /** The Request's draft, which holds the answers typed so far and the shown question. */
  readonly draft: RequestDraft;
  readonly onDraftChange: (change: (draft: RequestDraft) => RequestDraft) => void;
  /** Whether an answer was sent, so nothing in the form takes input. */
  readonly locked: boolean;
  readonly onSend: (answers: QuestionAnswers) => void;
}): JSX.Element {
  const draft = requestDraft.question ?? buildQuestionDraft(questions);
  const { shownQuestionIndex } = requestDraft;
  const setDraft = (question: QuestionDraft): void => {
    onDraftChange((current) => ({ ...current, question }));
  };
  // Radios of one question share a name, so the browser moves between them
  // with the arrow keys. The id keeps two cards from sharing a group.
  const groupName = useId();
  const question = questions[shownQuestionIndex]!;
  const answer = draft[question.header]!;
  const isLast = shownQuestionIndex === questions.length - 1;
  const questionAnswered = isQuestionAnswered(draft, question);

  return (
    <form
      className="mt-3 flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (locked || !questionAnswered) return;
        if (!isLast) {
          onDraftChange((current) => ({ ...current, shownQuestionIndex: shownQuestionIndex + 1 }));
          return;
        }
        const answers = buildQuestionAnswers(draft, questions);
        if (answers !== null) onSend(answers);
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        {/* The chip is styled as a lane label, not a sentence: 10px uppercase
            `--faint`, the size of a label inside a surface (spec 14
            §Measurements, the popover's options grid). */}
        <span className="text-[10px] font-emph tracking-[0.09em] text-faint uppercase">
          {question.header}
        </span>
        {questions.length === 1 ? null : (
          <span className="text-[11px] text-faint tabular-nums">
            {/* "Question" keeps this count apart from the dock's "1 of 2",
                which pages through Requests. */}
            Question {shownQuestionIndex + 1} of {questions.length}
          </span>
        )}
      </div>
      <span className="mt-0.5 text-meta text-ink">{question.question}</span>
      {/* The same two columns as the answer ledger, so options and answers
          line up: the choice and its label on the shared left edge, its
          meaning beside it. The whole row is the click target. The list, not
          each row, reaches 8px past the column, because a scrolling box
          clips its rows at its own edges. */}
      {question.options.length === 0 ? null : (
        <div className="-mx-2 mt-1 flex max-h-48 flex-col overflow-y-auto">
          {question.options.map((option, index) => (
            // Keyed by place, so a focused choice keeps the focus when the next
            // question has a choice in the same place, and ↩ moves on again
            // from there.
            <label
              key={index}
              className={cn(
                "grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-3 rounded-control px-2 py-[3px]",
                locked ? "cursor-not-allowed" : "cursor-pointer hover:bg-line-soft",
              )}
            >
              {/* The label, not the choice, gives this column its baseline, so
                the label sits on the same line as its description. The
                choice is one line of the label's text tall and centred in
                it, so it stays beside the first line when a long label
                wraps. */}
              <span className="flex min-w-0 items-baseline gap-2">
                <ChoiceInput
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={groupName}
                  checked={answer.picks.includes(option.label)}
                  disabled={locked}
                  onChange={() => setDraft(pickQuestionOption(draft, question, option.label))}
                  className="h-[1lh] self-start text-meta"
                />
                <span className="text-meta font-emph text-ink wrap-anywhere">{option.label}</span>
              </span>
              <span className="text-fine text-muted wrap-anywhere">{option.description}</span>
            </label>
          ))}
        </div>
      )}
      {/* Smaller and fainter than an option, with space above it, so it does
          not look like another option. */}
      {question.note === null ? null : (
        <span className="mt-1 text-[11px] text-faint">{question.note}</span>
      )}
      {question.secretWarning === null ? null : (
        <span className="mt-1 text-[11px] text-attn">{question.secretWarning}</span>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Input
          aria-label="Your own answer"
          placeholder="Or type your own answer"
          value={answer.text}
          disabled={locked}
          onChange={(event) => setDraft(typeQuestionAnswer(draft, question, event.target.value))}
          className="py-1 text-meta"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={locked}
          aria-disabled={!questionAnswered}
          className="py-1.5"
        >
          {isLast ? "Send answers" : "Next"}
        </Button>
      </div>
    </form>
  );
}
