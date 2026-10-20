import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { transcriptQuery } from "../../app/queries";
import { SyncMarker } from "./sync-marker";

/**
 * Renders a header's free space, with "Syncing…" in it while the transcript
 * of `sessionId` (or of its subagent `subagentId`) is being read: after the
 * thread opened from its saved copy, the read brings the copy's rows up to
 * date.
 *
 * It only watches the transcript's query, which something else reads. Its
 * observer is disabled, so it starts no read and never suspends, and it
 * re-renders only when the query starts or ends a fetch. A thread read in
 * full from the controller is fetching only before it opens, so the marker
 * never shows for it.
 */
export function TranscriptSyncMarker({
  sessionId,
  subagentId,
}: {
  readonly sessionId: string;
  readonly subagentId?: string;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { isFetching } = useQuery({
    ...transcriptQuery(controller.client, sessionId, subagentId),
    enabled: false,
  });
  return <SyncMarker syncing={isFetching} />;
}
