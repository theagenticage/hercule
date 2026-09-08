/**
 * The thread surface: a centered 800px column of turns, streaming live, the
 * composer floating at the foot (spec 14 §The thread surface).
 */
import type { JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { turnsOf, type HydraClient, type Live } from "@hydra/client-core";
import type { Profile, ProviderInstance, Runner, SettingsState } from "@hydra/contract";
import { sessionQuery, transcriptQuery } from "../../app/queries";
import { Composer } from "../composer/composer";
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
      <Composer
        client={client}
        live={live}
        instances={instances}
        runners={runners}
        profiles={profiles}
        localRunnerId={localRunnerId}
        settingsUser={settingsUser}
        session={session}
      />
    </div>
  );
}
