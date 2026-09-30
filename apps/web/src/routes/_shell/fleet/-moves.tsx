import { useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@hercule/ui";
import {
  queryKeys,
  buildRetireQuestion,
  type HerculeClient,
  readErrorMessage,
} from "@hercule/client-core";
import type { RunnerDetail } from "@hercule/contract";
import { InPlaceQuestion } from "../../../screens/in-place-question";

type Move = "drain" | "undrain" | "refreshFacts" | "retire";

/**
 * The buttons that drain, undrain, re-probe and retire a runner.
 *
 * Only one action runs at a time, so a single mutation handles all four. The
 * next action then clears the last one's error, so an old failure never stays
 * on screen under an action that later succeeded.
 *
 * Retiring is the only action that cannot be undone, and the button alone does
 * not show its cost. So it asks for confirmation first, listing what this
 * runner's retirement also affects.
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
      // Retiring the default runner also clears the fleet default, so the
      // controller record is fetched again.
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
