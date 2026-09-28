import { Fragment, type JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { buildApprovalCard, type HerculeClient } from "@hercule/client-core";
import type { ApprovalDecision, OpenRequest } from "@hercule/contract";
import { AnswerLedger, cn, DecisionMark } from "@hercule/ui";
import { readErrorMessage } from "../save-status";

/**
 * Renders the permission card: the request the session is parked on, docked
 * onto the composer. The card always appears in the same place and is never
 * repeated in the transcript. Its answers form the same ledger as a
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
 * A `question` request is not a permission request. It shows one block per
 * question (its chip, its prose, and its options, read-only) where a command
 * or path would otherwise go.
 *
 * All text on the card comes from `buildApprovalCard`, so an answer is
 * described the same way everywhere and no screen can reword or drop it.
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
  const respond = useMutation({
    mutationFn: (decision: ApprovalDecision) =>
      client.session.respond({
        params: { id: sessionId },
        payload: { requestId: request.requestId, decision },
      }),
    // The response is not written into the cache. It is a snapshot of the
    // session from when the controller received the answer, still parked on
    // the request, so writing it would bring back a card the live `session`
    // topic has already cleared. That topic is the source of truth; until it
    // clears the request, the rows stay disabled through `isSuccess`.
  });
  // One answer per request. The card stays until the runner reports the
  // request resolved, and a second click in that time could send a decision
  // that contradicts the one already recorded.
  const rowsLocked = respond.isPending || respond.isSuccess;

  return (
    // The dock sits behind the card: the card is `z-[1]`, so the 8px of the
    // dock tucked under it is covered by the card.
    <div className="mx-3.5 -mb-2 grid grid-cols-[18px_minmax(0,1fr)] rounded-t-[10px] border border-b-0 border-line-soft bg-surface px-3 pt-[5px] pb-[13px] text-fine text-muted">
      {/* The mark sits alone in its own column at the dock's left edge, so the
          title, the subject, the note and the answer labels all line up on one
          left edge in the column beside it. */}
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
        {/* A question is not a permission request: it has its own chip, prose
            and answers, so it is shown as a block rather than a line. Its
            options are shown read-only, because what each option means is part
            of the question. Answering with an option is not built yet. */}
        {card.questions.length === 0 ? null : (
          // One block per question, 12px apart. Inside a block the lines are
          // 2px apart, so the chip, the question and the options look like one
          // unit rather than three.
          <div className="mt-3 flex max-h-48 flex-col gap-3 overflow-y-auto">
            {card.questions.map((question, index) => (
              <div key={index} className="flex min-w-0 flex-col">
                {/* The chip is styled as a lane label, not a sentence: 10px
                    uppercase `--faint`, the size of a label inside a surface
                    (spec 14 §Measurements, the popover's options grid). */}
                <span className="text-[10px] font-emph tracking-[0.09em] text-faint uppercase">
                  {question.header}
                </span>
                <span className="mt-0.5 text-meta text-ink">{question.question}</span>
                {/* The same two columns as the answer ledger, so options and
                    answers line up: the label on the shared left edge, its
                    meaning beside it. These are plain rows; nothing here is
                    clickable. */}
                <div className="mt-0.5 grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5">
                  {question.options.map((option, optionIndex) => (
                    <Fragment key={optionIndex}>
                      <span className="text-fine font-emph text-ink">{option.label}</span>
                      <span className="text-fine text-muted">{option.description}</span>
                    </Fragment>
                  ))}
                </div>
                {/* Smaller and fainter than an option, with space above it, so
                    it does not look like another option. */}
                {question.note === null ? null : (
                  <span className="mt-1.5 text-[11px] text-faint">{question.note}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {/* An instruction, not an option: 12px `--muted` with space above it. */}
        {card.note === null ? null : <p className="mt-2">{card.note}</p>}
        {/* The ledger's rows extend 8px past this column on both sides, so
            the labels stay on the same left edge as the title. The dock's
            13px bottom padding keeps the last row clear of the card, which
            covers the dock's bottom 8px. */}
        <div className="mt-1">
          <AnswerLedger
            rows={card.rows}
            disabled={rowsLocked}
            onSelect={(decision) => respond.mutate(decision)}
          />
        </div>
        {respond.error === null ? null : (
          <p className="mt-1 text-fail" role="alert">
            {readErrorMessage(respond.error)}
          </p>
        )}
      </div>
    </div>
  );
}
