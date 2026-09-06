import { useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@hydra/ui";
import { queryKeys, retireQuestion, type HydraClient } from "@hydra/client-core";
import type { RunnerDetail } from "@hydra/contract";
import { messageOf } from "../../../screens/save-status";

/**
 * Draining, re-probing and retiring.
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
  readonly client: HydraClient;
  readonly runner: RunnerDetail;
  readonly defaultRunnerId: string | null;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const params = { id: runner.id };

  const held = (updated: RunnerDetail): void => {
    queryClient.setQueryData(queryKeys.runner(runner.id), updated);
    void queryClient.invalidateQueries({ queryKey: queryKeys.runners() });
  };

  const drain = useMutation({ mutationFn: () => client.runner.drain({ params }), onSuccess: held });
  const undrain = useMutation({
    mutationFn: () => client.runner.undrain({ params }),
    onSuccess: held,
  });
  const refresh = useMutation({
    mutationFn: () => client.runner.refreshFacts({ params }),
    onSuccess: held,
  });
  const retire = useMutation({
    mutationFn: (force: boolean): Promise<RunnerDetail> =>
      client.runner.retire({ params, payload: force ? { force: true } : {} }),
    onSuccess: (updated) => {
      held(updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.controller() });
    },
  });

  const moves = [drain, undrain, refresh, retire];
  const failed = drain.error ?? undrain.error ?? refresh.error ?? retire.error;
  const busy = moves.some((move) => move.isPending);

  // What the last move said goes when the next one is asked for: a refusal left
  // standing under a move that then succeeded reads as that move's.
  const start = (run: () => void): void => {
    for (const move of moves) if (!move.isIdle) move.reset();
    run();
  };

  const question = retireQuestion(runner, defaultRunnerId);

  return (
    <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {runner.lifecycle === "active" ? (
          <Button
            className="-ml-2"
            disabled={busy}
            onClick={() => {
              start(() => {
                drain.mutate();
              });
            }}
          >
            Drain
          </Button>
        ) : (
          <Button
            className="-ml-2"
            disabled={busy}
            onClick={() => {
              start(() => {
                undrain.mutate();
              });
            }}
          >
            Undrain
          </Button>
        )}
        <Button
          disabled={busy}
          onClick={() => {
            start(() => {
              refresh.mutate();
            });
          }}
        >
          Refresh facts
        </Button>
        <Button
          disabled={confirming || busy}
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
          <div className="flex flex-wrap items-center gap-1.5">
            <span>Retire {runner.name}?</span>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(false);
                start(() => {
                  retire.mutate(question.force);
                });
              }}
            >
              Confirm
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {failed === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {messageOf(failed)}
        </p>
      )}
    </div>
  );
}
