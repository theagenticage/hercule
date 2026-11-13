import { useState, type JSX } from "react";
import { keepPreviousData, queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import type { InboxThing } from "@hercule/contract";
import { LIVE_KEPT_READ_OPTIONS, pluginsQuery } from "../../../app/queries";
import { useQuietValue } from "../../../app/use-quiet-value";
import { InboxLinkTo, type InboxLinkToResult } from "../../../screens/inbox/inbox-link-to";

/** How long typing stops before the search is read, in milliseconds. */
const QUIET_MS = 150;

/** How many results the popover shows at most. */
const MAX_RESULTS = 6;

/**
 * Reads the first page of the Inbox's Everything list, narrowed by `text`
 * (no text narrows nothing). A newer text replaces an older read, which
 * aborts, and the previous page stays in view until the new one arrives.
 */
const linkToResultsQuery = (client: HerculeClient, text: string) =>
  queryOptions({
    queryKey: [...queryKeys.inbox(), "link-to", text],
    queryFn: async ({ signal }): Promise<readonly InboxThing[]> => {
      const reply = await client.externalEntity.queryInbox(
        {
          payload: {
            mode: "first",
            list: { savedQuery: "everything" },
            ...(text === "" ? {} : { text }),
          },
        },
        { signal },
      );
      if (reply.mode !== "first") {
        throw new Error(`The Inbox answered a read in first mode in ${reply.mode} mode.`);
      }
      return reply.things;
    },
    placeholderData: keepPreviousData,
    retry: false,
    ...LIVE_KEPT_READ_OPTIONS,
    gcTime: 30_000,
  });

/**
 * Renders "Link to..." for one thing or one group, and searches the Inbox
 * for what to link it to.
 *
 * - `fromRef` is the ref of the thing, or the label ref of the group, that
 *   is being linked. `fromLabel` names it in the field ("#6213").
 * - `memberRefs` are the refs of a group's members. Neither they nor
 *   `fromRef` are offered, because linking them changes nothing.
 * - The popover opens with the first page of Everything. Typing narrows it
 *   by text; the read waits for a short quiet, and sets no timer while
 *   nothing is typed. At most 6 things are shown.
 * - Picking a result calls `onLink(fromRef, to)`, with `to` the picked thing's
 *   ref, identifier and title so the caller can name it, and `onClose`. The link
 *   itself, and its undo, belong to the caller.
 * - `anchor` is the row the popover opens under.
 */
export function InboxLinkToPart({
  client,
  anchor,
  fromRef,
  fromLabel,
  memberRefs,
  onLink,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly anchor: HTMLElement;
  readonly fromRef: string;
  readonly fromLabel: string;
  readonly memberRefs: readonly string[];
  readonly onLink: (fromRef: string, to: Pick<InboxThing, "ref" | "identifier" | "title">) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const text = useQuietValue(query.trim(), QUIET_MS);
  const { data: things = [] } = useQuery(linkToResultsQuery(client, text));

  const results: InboxLinkToResult[] = things
    .filter((thing) => thing.ref !== fromRef && !memberRefs.includes(thing.ref))
    .slice(0, MAX_RESULTS)
    .map(({ ref, identifier, title, source }) => ({ ref, identifier, title, source }));

  return (
    <InboxLinkTo
      anchor={anchor}
      fromLabel={fromLabel}
      query={query}
      results={results}
      highlighted={Math.min(highlighted, results.length - 1)}
      plugins={plugins}
      onQueryChange={(next) => {
        setQuery(next);
        setHighlighted(0);
      }}
      onHighlightChange={setHighlighted}
      onPick={(toRef) => {
        const picked = results.find((result) => result.ref === toRef);
        if (picked !== undefined) onLink(fromRef, picked);
        onClose();
      }}
      onClose={onClose}
    />
  );
}
