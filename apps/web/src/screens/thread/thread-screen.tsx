/**
 * The thread surface: a centered 800px column of turns, streaming live, the
 * composer floating at the foot (spec 14 §The thread surface).
 */
import { useLayoutEffect, type JSX } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { turnsOf, type HydraClient, type Live } from "@hydra/client-core";
import type { Profile, ProviderInstance, Runner, SettingsState } from "@hydra/contract";
import { inputsQuery, sessionQuery, transcriptQuery } from "../../app/queries";
import { Composer } from "../composer/composer";
import { useStickToBottom } from "./use-stick-to-bottom";
import { useThreadLive } from "./use-thread-live";
import { Turn } from "./turn";

export function ThreadScreen({
  client,
  live,
  sessionId,
  timezone,
  instances,
  runners,
  profiles,
  localRunnerId,
  settingsUser,
}: {
  readonly client: HydraClient;
  readonly live: Live;
  readonly sessionId: string;
  readonly timezone: string;
  readonly instances: readonly ProviderInstance[];
  readonly runners: readonly Runner[];
  readonly profiles: readonly Profile[];
  readonly localRunnerId: string | null;
  readonly settingsUser: SettingsState["user"];
}): JSX.Element {
  const queryClient = useQueryClient();
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const rows = useSuspenseQuery(transcriptQuery(client, sessionId)).data;
  const turns = turnsOf(rows);
  const { followIfAtBottom, scrollToBottom } = useStickToBottom();
  const tailRef = useThreadLive(live, queryClient, sessionId, rows, followIfAtBottom);
  const lastIndex = turns.length - 1;

  // The queued list above the composer is the transcript's third growth path
  // (the other two, a stream row and a tap flush, are covered by `rows` and
  // `useThreadLive` above); reading the same cache `QueuedInputs` reads below
  // costs nothing extra and needs no prop threading down to it.
  const queuedCount = (useQuery(inputsQuery(client, sessionId)).data?.items ?? []).filter(
    (row) => row.status === "queued",
  ).length;

  // Runs after the DOM already reflects whatever just grew - `rows.length` or
  // `queuedCount` changing is the signal, `followIfAtBottom` itself is what
  // decides whether that growth should move the scroll.
  useLayoutEffect(() => {
    followIfAtBottom();
  }, [rows.length, queuedCount, followIfAtBottom]);

  return (
    <div className="mx-auto flex w-full max-w-[800px] flex-1 flex-col gap-6">
      {turns.map((turn, index) => {
        // Only the last turn of a busy session can still be running: an
        // earlier one with no `turn.completed` was abandoned by an interrupt,
        // and a dangling last turn on a session that is idle or exited was
        // abandoned by the runner - neither is still running, so both read as
        // settled with nothing to time rather than as working since whenever
        // they were last touched.
        const isLive = session.status === "busy" && index === lastIndex && turn.duration === null;
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
      <Composer
        client={client}
        live={live}
        instances={instances}
        runners={runners}
        profiles={profiles}
        localRunnerId={localRunnerId}
        settingsUser={settingsUser}
        session={session}
        onSend={scrollToBottom}
      />
    </div>
  );
}
