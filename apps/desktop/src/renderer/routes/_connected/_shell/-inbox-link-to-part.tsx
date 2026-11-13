import { useMemo, useState, type JSX } from "react";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { InboxThing } from "@hercule/contract";
import { pluginsQuery } from "../../../app/queries";
import { useQuietValue } from "../../../app/use-quiet-value";
import { InboxLinkTo, type InboxLinkToResult } from "../../../screens/inbox/inbox-link-to";
import { MAX_LINK_TO_RESULTS, linkToThingsQuery } from "./-inbox-link-to-results";

/** How long typing stops before the search is read, in milliseconds. */
const QUIET_MS = 150;

/**
 * Renders "Link to..." for one thing or one group, and searches the Inbox
 * for what to link it to.
 *
 * - `fromRef` is the ref of the thing, or the label ref of the group, that
 *   is being linked. `fromLabel` names it in the field ("#6213").
 * - `memberRefs` are the refs of a group's members. Neither they nor
 *   `fromRef` are offered, because linking them changes nothing.
 * - The popover opens with a small first page of Everything. Typing narrows
 *   it by text; the read waits for a short quiet, and sets no timer while
 *   nothing is typed. At most 6 things are shown. A group's member that
 *   does not answer the typed text is not offered (`listLinkableThings`), and
 *   a push on the Inbox does not read the results again while the popover is
 *   open (`linkToThingsQuery`).
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
  const excluded = useMemo(() => new Set([fromRef, ...memberRefs]), [fromRef, memberRefs]);
  const { data: things = [] } = useQuery({
    ...linkToThingsQuery(client, fromRef, text, excluded),
    placeholderData: keepPreviousData,
  });

  // The read left these out already; a thing of an older read may have joined the group since.
  const results: InboxLinkToResult[] = things
    .filter((thing) => !excluded.has(thing.ref))
    .slice(0, MAX_LINK_TO_RESULTS)
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
