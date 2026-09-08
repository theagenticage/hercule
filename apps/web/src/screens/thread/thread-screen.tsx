/**
 * The thread surface: a centered 800px column of turns, streaming live. The
 * composer that belongs under it is a later piece of work; this leaves its
 * shape rather than any of its behaviour.
 */
import type { JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { turnsOf, type HydraClient, type Live } from "@hydra/client-core";
import { transcriptQuery } from "../../app/queries";
import { useThreadLive } from "./use-thread-live";
import { Turn } from "./turn";

export function ThreadScreen({
  client,
  live,
  sessionId,
  timezone,
}: {
  readonly client: HydraClient;
  readonly live: Live;
  readonly sessionId: string;
  readonly timezone: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const rows = useSuspenseQuery(transcriptQuery(client, sessionId)).data;
  const turns = turnsOf(rows);
  const tailRef = useThreadLive(live, queryClient, sessionId, rows);
  const lastIndex = turns.length - 1;

  return (
    <div className="mx-auto flex w-full max-w-[800px] flex-1 flex-col gap-6">
      {turns.map((turn, index) => {
        // Only the last turn can still be running: an earlier one with no
        // `turn.completed` was abandoned by an interrupt, not left mid-turn
        // forever, so it reads its own turn as settled with nothing to time
        // rather than as running since whenever it was last touched.
        const isLive = index === lastIndex && turn.duration === null;
        return (
          <Turn
            key={turn.turnId}
            turn={turn}
            live={isLive}
            // The tap buffer holds one item's text at a time, so only the
            // live last turn gets the live node.
            tailRef={isLive ? tailRef : undefined}
            timezone={timezone}
          />
        );
      })}
      <div className="sticky bottom-0 mt-auto rounded-card border border-line-soft bg-surface px-4 py-6 text-fine text-faint">
        The composer arrives in the next slice.
      </div>
    </div>
  );
}
