import type { JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { approvalCard, type HydraClient } from "@hydra/client-core";
import type { ApprovalDecision, OpenRequest } from "@hydra/contract";
import { cn, DecisionMark } from "@hydra/ui";
import { messageOf } from "../save-status";

/**
 * The question the harness parked on, docked onto the composer: the same place
 * every time, and never repeated in the transcript (spec 14 §The thread
 * surface). Its answers are a ledger - one full-width row per answer, the row
 * is the button, the label in the left column and the describe line beside it
 * (spec 14 §Answers as a ledger).
 *
 * The dock is the composer's bottom lip mirrored above the card: the same 14px
 * inset, the same `--surface` on a `--line-soft` border, a 10px radius on the
 * two corners facing away from the card, and 8px of it hidden under the card,
 * which keeps its own radius, border and lift (spec 14 §Measurements, amended
 * 2026-09-14). A second raised card would read as a second surface; a lip reads
 * as part of the composer, which is what this is.
 *
 * A `user_input` request is a question rather than a permission ask, so it
 * reads as one block per question - its chip, its prose, and its options
 * read-only under it - in the slot a command or a path would sit in.
 *
 * Every word on it comes from `approvalCard`, so what an answer does reads the
 * same wherever it is shown and no surface can reword or drop it.
 */
export function PermissionCard({
  client,
  sessionId,
  request,
}: {
  readonly client: HydraClient;
  readonly sessionId: string;
  readonly request: OpenRequest;
}): JSX.Element {
  const card = approvalCard(request);
  const respond = useMutation({
    mutationFn: (decision: ApprovalDecision) =>
      client.session.respond({
        params: { id: sessionId },
        payload: { requestId: request.requestId, decision },
      }),
    // The answer is not written into the cache. It is a snapshot of the record
    // as the controller had it when it was asked - the park still on it - and
    // writing it would resurrect a card the live `session` topic has already
    // cleared. That topic is the source of truth; until it clears the record
    // the rows stay disabled on `isSuccess`.
  });
  // One answer per request. The card stands until the runner reports the park
  // resolved, and a second click in that window would send a decision that
  // contradicts the one already audited.
  const answered = respond.isPending || respond.isSuccess;

  return (
    // Behind the card rather than in front of it: the card is `z-[1]`, so the
    // 8px this dock tucks under it is covered rather than drawn over.
    <div className="mx-3.5 -mb-2 grid grid-cols-[18px_minmax(0,1fr)] rounded-t-[10px] border border-b-0 border-line-soft bg-surface px-3 pt-[5px] pb-[13px] text-fine text-muted">
      {/* The mark hangs alone in its own column at the dock's inner edge, so
          the title, the subject, the note and the answers' labels all start on
          one left edge in the column beside it. */}
      <DecisionMark className="mt-[3px]" />
      <div className="flex min-w-0 flex-col">
        <span className="text-meta font-emph text-ink">{card.title}</span>
        {/* A 4096-character command or forty paths scroll here rather than
            pushing the composer off the screen. */}
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
        {/* A question is not a permission request: it has a chip, prose and
            answers of its own, so it reads as a block rather than a line. Its
            options are shown read-only - what each answer would have meant is
            part of the question - until answering with one is built. */}
        {card.questions.length === 0 ? null : (
          <div className="mt-1 flex max-h-48 flex-col gap-2 overflow-y-auto">
            {card.questions.map((question, index) => (
              <div key={index} className="flex min-w-0 flex-col">
                <span className="text-fine font-emph text-ink">{question.header}</span>
                <span className="text-fine text-ink">{question.question}</span>
                {question.options.map((option, optionIndex) => (
                  <span key={optionIndex} className="text-fine">
                    {option}
                  </span>
                ))}
                {/* A little air, or it reads as one more option. */}
                {question.note === null ? null : (
                  <span className="mt-0.5 text-fine">{question.note}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {/* A little air, or the note reads as one more question. */}
        {card.note === null ? null : <p className="mt-1">{card.note}</p>}
        {/* A row bleeds 8px past this column on each side, so a hover
            background has room around its label without crossing the edge the
            head shares with it. The 13px bottom padding is what keeps the last
            one clear of the card above. */}
        <div className="mt-1 flex flex-col">
          {card.rows.map((row) => (
            <button
              key={row.decision}
              type="button"
              disabled={answered}
              onClick={() => respond.mutate(row.decision)}
              className="-mx-2 grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-3 rounded-control px-2 py-[5px] text-left enabled:cursor-pointer enabled:hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
            >
              <span className="text-meta font-emph text-ink">{row.label}</span>
              {/* `--muted`, not `--faint`: 12px `--faint` on `--surface` is
                  about 2.9:1 in dark and 2.4:1 in light, which is not text. */}
              <span className="text-fine text-muted">{row.describe}</span>
            </button>
          ))}
        </div>
        {respond.error === null ? null : (
          <p className="mt-1 text-fail" role="alert">
            {messageOf(respond.error)}
          </p>
        )}
      </div>
    </div>
  );
}
