import { useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@hercule/ui";
import { queryKeys, buildRetireQuestion, type HerculeClient } from "@hercule/client-core";
import type { RunnerDetail } from "@hercule/contract";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { readErrorMessage } from "../../../screens/save-status";

type Move = "drain" | "undrain" | "refreshFacts" | "retire";

/**
 * Draining, re-probing and retiring.
 *
 * One move at a time, so one mutation carries all four: what the last one said
 * goes when the next is asked for, rather than a refusal left standing under a
 * move that then succeeded.
 *
 * Retiring is the one move that cannot be undone and the one whose cost is not
 * on the button, so it asks in place with whatever else this particular machine
 * is about to take with it.
 */
export function Moves({
  client,
  runner,
  defaultRunnerId,
}: {
  readonly client: HerculeClient;
  readonly runner: RunnerDetail;
  readonly defaultRunnerId: string | null;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const question = buildRetireQuestion(runner, defaultRunnerId);
  const params = { id: runner.id };
  const calls: Record<Move, () => Promise<RunnerDetail>> = {
    drain: () => client.runner.drain({ params }),
    undrain: () => client.runner.undrain({ params }),
    refreshFacts: () => client.runner.refreshFacts({ params }),
    retire: () => client.runner.retire({ params, payload: question.force ? { force: true } : {} }),
  };

  const move = useMutation({
    mutationFn: (which: Move) => calls[which](),
    onSuccess: (updated, which) => {
      queryClient.setQueryData(queryKeys.runner(runner.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runners() });
      // A retirement gives up the fleet default when it held it.
      if (which === "retire") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.controller() });
      }
    },
  });

  const service: { readonly move: Move; readonly label: string } =
    runner.lifecycle === "active"
      ? { move: "drain", label: "Drain" }
      : { move: "undrain", label: "Undrain" };

  return (
    <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          className="-ml-2"
          disabled={move.isPending}
          onClick={() => {
            move.mutate(service.move);
          }}
        >
          {service.label}
        </Button>
        <Button
          disabled={move.isPending}
          onClick={() => {
            move.mutate("refreshFacts");
          }}
        >
          Refresh facts
        </Button>
        <Button
          disabled={confirming || move.isPending}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Retire
        </Button>
      </div>

      {confirming ? (
        <div className="flex flex-col gap-1.5 text-row text-muted">
          {question.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
          <InPlaceQuestion
            question={`Retire ${runner.name}?`}
            declineLabel="Cancel"
            acceptLabel="Confirm"
            onDecline={() => {
              setConfirming(false);
            }}
            onAccept={() => {
              setConfirming(false);
              move.mutate("retire");
            }}
          />
        </div>
      ) : null}

      {move.error === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {readErrorMessage(move.error)}
        </p>
      )}
    </div>
  );
}
