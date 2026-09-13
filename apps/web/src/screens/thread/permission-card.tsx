import type { JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalCard, queryKeys, type HydraClient } from "@hydra/client-core";
import type { OpenRequest } from "@hydra/contract";
import { cn, DecisionMark } from "@hydra/ui";
import { messageOf } from "../save-status";

/**
 * The question the harness parked on, docked onto the composer: the same place
 * every time, and never repeated in the transcript (spec 14 §The thread
 * surface). Its answers are a ledger - one full-width row per answer, the row
 * is the button, the label in the left column and the describe line beside it
 * (spec 14 §Answers as a ledger).
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
  const queryClient = useQueryClient();
  const card = approvalCard(request);
  const respond = useMutation({
    mutationFn: (decision: OpenRequest["decisions"][number]) =>
      client.session.respond({
        params: { id: sessionId },
        payload: { requestId: request.requestId, decision },
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.session(updated.id), updated);
    },
  });
  // One answer per request. The card stands until the runner reports the park
  // resolved, and a second click in that window would send a decision that
  // contradicts the one already audited.
  const answered = respond.isPending || respond.isSuccess;

  return (
    // The card and the composer under it are one box: its bottom corners stay
    // square and its bottom border is the composer's top one.
    <div className="relative z-[1] rounded-t-[14px] border border-b-0 border-line bg-raised shadow-lift">
      {/* The mark hangs in a gutter of its own so the title, the subject and
          the note all start where the answers' labels start. */}
      <div className="grid grid-cols-[14px_minmax(0,1fr)] pt-3 pr-3.5 pb-2.5">
        <DecisionMark className="mt-[4px] justify-self-center" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-row font-emph text-ink">{card.title}</span>
          {/* A 4096-character command or forty paths scroll here rather than
              pushing the composer off the screen. */}
          <div className="flex max-h-36 flex-col overflow-y-auto">
            {card.subject.map((line, index) => (
              <span
                key={index}
                className={cn(
                  "break-all text-muted",
                  card.code ? "font-mono text-fine" : "text-row",
                )}
              >
                {line}
              </span>
            ))}
          </div>
          {card.note === null ? null : <p className="text-fine text-muted">{card.note}</p>}
        </div>
      </div>
      {card.rows.map((row) => (
        <button
          key={row.decision}
          type="button"
          disabled={answered}
          onClick={() => respond.mutate(row.decision)}
          className="group grid w-full grid-cols-[150px_minmax(0,1fr)] items-baseline gap-3 border-t border-line-soft px-3.5 py-2 text-left enabled:cursor-pointer enabled:hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
        >
          <span className="text-row font-emph text-muted group-enabled:group-hover:text-ink">
            {row.label}
          </span>
          <span className="text-meta text-muted">{row.describe}</span>
        </button>
      ))}
      {respond.error === null ? null : (
        <p className="border-t border-line-soft px-3.5 py-2 text-fine text-fail" role="alert">
          {messageOf(respond.error)}
        </p>
      )}
    </div>
  );
}
