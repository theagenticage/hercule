import type { JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import {
  InboxRail,
  type RailEntry,
  type RailFacetScope,
  type RailValue,
} from "../../../screens/inbox/inbox-rail";
import { describeInboxRail } from "../../../screens/inbox/inbox-rail-props";
import { inboxCountQuery, pluginsQuery, settingsQuery } from "../../../app/queries";
import { formatInboxClock } from "./-inbox-scope";

type Pin = { source: string; connectionId?: string; key: string; value: string };

const isSameValue = (a: RailValue, b: RailValue): boolean =>
  a.source === b.source &&
  a.connectionId === b.connectionId &&
  a.key === b.key &&
  a.value === b.value;

/**
 * Renders the Inbox's rail from the counts, which the sidebar's row reads from
 * the same cache entry. It owns the two settings the rail writes: folding a
 * source (`inbox.browseFolded`) and pinning a value (`inbox.pins`). A save
 * reads the counts again, because their reply carries what the rail draws.
 *
 * `current` is the entry the list is on, or `null` while a search narrows it.
 */
export function InboxRailPart({
  client,
  current,
  onPick,
  onSearchMore,
}: {
  readonly client: HerculeClient;
  readonly current: RailEntry | null;
  readonly onPick: (entry: RailEntry) => void;
  readonly onSearchMore: (facet: RailFacetScope) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const counts = useSuspenseQuery(inboxCountQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const save = useMutation({
    // One scope for every settings save, so they run in the order they were made.
    scope: { id: "settings" },
    mutationFn: (user: {
      readonly "inbox.pins"?: ReadonlyArray<Pin>;
      readonly "inbox.browseFolded"?: ReadonlyArray<{ source: string }>;
    }) => client.settings.update({ payload: { user } }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(settingsQuery(client).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: queryKeys.inboxCount() });
    },
  });
  const rail = describeInboxRail(counts, plugins, formatInboxClock);
  return (
    <InboxRail
      {...rail}
      plugins={plugins}
      current={current}
      loading={false}
      onPick={onPick}
      onToggleFold={(source) => {
        const folded = counts.sources
          .filter((each) => each.folded !== (each.source === source))
          .map((each) => ({ source: each.source }));
        save.mutate({ "inbox.browseFolded": folded });
      }}
      onTogglePin={(value) => {
        const pins: Pin[] = counts.pins.map(({ source, connectionId, key, value: text }) => ({
          source,
          key,
          value: text,
          ...(connectionId === undefined ? {} : { connectionId }),
        }));
        const kept = pins.filter((pin) => !isSameValue(pin, value));
        save.mutate({ "inbox.pins": kept.length < pins.length ? kept : [...pins, value] });
      }}
      onSearchMore={onSearchMore}
    />
  );
}
