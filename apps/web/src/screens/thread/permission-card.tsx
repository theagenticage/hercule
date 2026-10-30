import type { JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  buildApprovalCard,
  describeFoldedQuestion,
  findComposerQuestion,
  type HerculeClient,
  readErrorMessage,
  UNFOLD_QUESTION_LABEL,
} from "@hercule/client-core";
import { type ApprovalDecision, isAsyncQuestion, type SessionRequest } from "@hercule/contract";
import { AnswerLedger, Button, cn, DecisionMark } from "@hercule/ui";
import { useRequestDraft, useSendAnswers } from "../../app/thread-drafts";
import { QuestionForm } from "./question-form";

/**
 * Where the thread's composer is, relative to the dock that shows a
 * Request. It decides where the user types the own answer to a question, and
 * where the text goes that a picked option displaces.
 *
 * - `"below"`: the composer sits right under the dock (the thread's page).
 *   The user types the own answer in the composer, which has the Previous
 *   and Next buttons, so the dock shows no field and no buttons. Text typed
 *   for a single-select question and then displaced by picking an option
 *   moves to the end of the message in the composer.
 * - `"elsewhere"`: the thread has a composer, but it is not on this page (a
 *   subagent's page). The user types the own answer in a field in the dock,
 *   with its own Previous and Next buttons. Displaced text still moves to the
 *   end of the thread's message, which shows again on the thread's page.
 * - `"none"`: the thread has no composer at all (an assistant's session).
 *   The user types in the dock's field, as in `"elsewhere"`, but displaced
 *   text is erased, because there is no message to move it to.
 */
export type DockComposer = "below" | "elsewhere" | "none";

/**
 * The dock's box: the composer's lip mirrored above the card (see
 * `PermissionCard`). It sits behind the card, which is `z-[1]`, so the 8px
 * of the dock tucked under it is covered by the card.
 */
const DOCK_CLASS =
  "mx-3.5 -mb-2 grid grid-cols-[18px_minmax(0,1fr)] rounded-t-[10px] border border-b-0 border-line-soft bg-surface px-3 pt-[5px] pb-[13px] text-fine text-muted";

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
 * otherwise go, it shows the question form. The user answers in the form's
 * own field, or, where the composer is right below, in the composer itself.
 * It has no ledger: a question offers no decision. To turn down the session's
 * own agent's question, the user stops the turn with the composer's Stop; to
 * turn down a subagent's, the user stops that subagent from its page.
 *
 * An async question, which the agent does not wait on, docks folded as one
 * row with an Answer button. Answer opens the whole card, and Later folds it
 * back with the answers kept.
 *
 * The request's text, its questions and its answers come from
 * `buildApprovalCard`, so an answer is described the same way everywhere and
 * no screen can reword or drop it. Only the controls' own labels, such as
 * Answer, are written here.
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
  composer,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
  readonly request: SessionRequest;
  readonly composer: DockComposer;
}): JSX.Element {
  const card = buildApprovalCard(request);
  const [draft, changeDraft] = useRequestDraft(request.requestId);
  // A failed send unlocks the Request, so the user can answer again. The
  // mutation's own callbacks run even after the card has unmounted, so the
  // draft is right when the user comes back.
  const markAnswered = (answered: boolean): void => {
    changeDraft((current) => ({ ...current, answered }));
  };
  // The decision is not written into the cache. See `useSendAnswers`.
  const decide = useMutation({
    mutationFn: (decision: ApprovalDecision) =>
      client.session.respondToApprovalRequest({
        params: { id: sessionId },
        payload: { requestId: request.requestId, decision },
      }),
    onMutate: () => markAnswered(true),
    onError: () => markAnswered(false),
  });
  const send = useSendAnswers(client, sessionId);
  // One answer per request. The card stays until the runner reports the
  // request resolved, and a second click in that time could send an answer
  // that contradicts the one already recorded.
  const locked = draft.answered || decide.isPending;
  // The composer owns the answer field while it answers this question, and
  // then it shows the failure of a send. The dock shows it only when the
  // dock has the field itself.
  const composerAnswers = composer === "below" && findComposerQuestion(request, draft) !== null;
  const failure =
    decide.error !== null ? readErrorMessage(decide.error) : composerAnswers ? null : draft.failure;

  const isAsync = request.kind === "question" && isAsyncQuestion(request);
  if (request.kind === "question" && isAsync && !draft.unfolded) {
    return (
      <div className={cn(DOCK_CLASS, "items-center")}>
        <DecisionMark />
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="min-w-0 text-meta text-ink">{describeFoldedQuestion(request)}</span>
          <Button
            variant="primary"
            className="shrink-0"
            onClick={() => {
              changeDraft((current) => ({ ...current, unfolded: true }));
            }}
          >
            {UNFOLD_QUESTION_LABEL}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={DOCK_CLASS}>
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
            composer={composer}
            composerAnswers={composerAnswers}
            onFold={
              isAsync
                ? () => {
                    changeDraft((current) => ({ ...current, unfolded: false }));
                  }
                : undefined
            }
            onSend={(answers) => {
              send(request.requestId, answers);
            }}
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
        {failure === null ? null : (
          <p className="mt-1 text-fail" role="alert">
            {failure}
          </p>
        )}
      </div>
    </div>
  );
}
