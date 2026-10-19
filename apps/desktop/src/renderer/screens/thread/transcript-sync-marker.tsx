import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { transcriptCatchUpQuery } from "../../app/queries";
import { SyncMarker } from "./sync-marker";

/**
 * Renders a header's free space, with "Syncing…" in it while the transcript
 * of `sessionId` (or of its subagent `subagentId`) is being brought up to
 * date after the thread opened from its saved copy.
 *
 * It only watches the catch-up read, which the agent's page starts, so it is
 * disabled here: a thread opened without a saved copy never runs the read
 * and never shows the marker. The read counts as syncing from the first
 * request until it has data.
 */
export function TranscriptSyncMarker({
  sessionId,
  subagentId,
}: {
  readonly sessionId: string;
  readonly subagentId?: string;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { isLoading } = useQuery({
    ...transcriptCatchUpQuery(controller.client, sessionId, subagentId),
    enabled: false,
  });
  return <SyncMarker syncing={isLoading} />;
}
