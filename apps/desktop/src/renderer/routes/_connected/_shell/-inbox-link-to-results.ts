import { queryOptions } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { readLinkCandidates } from "@hercule/client-core/inbox";

/**
 * Returns the read of what "Link to..." offers for `text` when linking from
 * `fromRef`, leaving out `excludedRefs` (see `readLinkCandidates`). A newer
 * text replaces an older read, which aborts. The key holds the excluded refs
 * sorted, so the same pick always reads under the same key.
 *
 * Its key is not under the Inbox's, so a push on the Inbox never reads it
 * again while the popover is open: the results are a snapshot of the moment
 * the user searched, and a row must not change under the user's pointer. It
 * is read afresh each time the popover opens.
 */
export const linkCandidatesQuery = (
  client: HerculeClient,
  fromRef: string,
  text: string,
  excludedRefs: readonly string[],
) =>
  queryOptions({
    queryKey: ["inbox-link-to", fromRef, text, [...excludedRefs].sort()],
    queryFn: ({ signal }) => readLinkCandidates(client, { text, fromRef, excludedRefs }, signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 30_000,
  });
