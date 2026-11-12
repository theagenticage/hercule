import type { JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import {
  describeInboxRail,
  type InboxScope,
  type InboxScopeValue,
} from "@hercule/client-core/inbox";
import { InboxRail, type RailFacetScope } from "../../../screens/inbox/inbox-rail";
import { inboxOutlineQuery, pluginsQuery, settingsQuery } from "../../../app/queries";
import { readReason } from "../../../app/read-reason";
import { useInboxClock } from "./-inbox-clock";

type Pin = InboxScopeValue;
type FoldedSource = { source: string; connectionId?: string };

const isSameValue = (a: InboxScopeValue, b: InboxScopeValue): boolean =>
  a.source === b.source &&
  a.connectionId === b.connectionId &&
  a.key === b.key &&
  a.value === b.value;

/**
 * Renders the Inbox's rail from the outline, which only the Inbox screen reads
 * (the sidebar's row reads the small counts). It owns the two settings the rail writes: folding a
 * source (`inbox.browseFolded`) and pinning a value (`inbox.pins`). A save
 * reads the outline again, because their reply carries what the rail draws.
 *
 * `isLoading` draws the count bars while the list's first read is pending, as
 * the drawing does. The route's loader reads the outline before the screen draws.
 *
 * `current` is the entry the list is on, or `null` while a search narrows it.
 * `onSaveFailed` is called with the sentence that says why a save did not go
 * through, for the screen to put on its undo line.
 */
export function InboxRailPart({
  client,
  current,
  onPick,
  isLoading,
  onSearchMore,
  onSaveFailed,
}: {
  readonly client: HerculeClient;
  readonly current: InboxScope | null;
  readonly onPick: (entry: InboxScope) => void;
  readonly isLoading: boolean;
  readonly onSearchMore: (facet: RailFacetScope) => void;
  readonly onSaveFailed: (sentence: string) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const formatClock = useInboxClock(client);
  const outline = useSuspenseQuery(inboxOutlineQuery(client)).data;
  const { user: settings } = useSuspenseQuery(settingsQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const save = useMutation({
    // One scope for every settings save, so they run in the order they were made.
    scope: { id: "settings" },
    mutationFn: (user: {
      readonly "inbox.pins"?: ReadonlyArray<Pin>;
      readonly "inbox.browseFolded"?: ReadonlyArray<FoldedSource>;
    }) => client.settings.update({ payload: { user } }),
    onError: (error) => {
      onSaveFailed(`Your pins and folded sources did not save. ${readReason(error)}.`);
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(settingsQuery(client).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: queryKeys.inboxOutline() });
    },
  });
  const rail = describeInboxRail(outline, plugins, formatClock);
  return (
    <InboxRail
      {...rail}
      plugins={plugins}
      current={current}
      loading={isLoading}
      onPick={onPick}
      onToggleFold={(source) => {
        // Written from the setting itself, not from the outline: a folded source that holds nothing
        // now is not in the outline, and rewriting from them would unfold it.
        const folded = settings["inbox.browseFolded"] ?? [];
        const kept = folded.filter((entry) => entry.source !== source);
        save.mutate({
          "inbox.browseFolded": kept.length < folded.length ? kept : [...folded, { source }],
        });
      }}
      onTogglePin={(value) => {
        const pins: Pin[] = outline.pins.map(({ source, connectionId, key, value: text }) => ({
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
