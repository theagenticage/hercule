import { queryOptions } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { InboxFirstPage, InboxNextPage, InboxThing } from "@hercule/contract";

/** How many things the first read of "Link to..." asks for: enough to fill the popover after the things that cannot be offered are left out. */
const FIRST_PAGE_LIMIT = 12;

/** How many results the popover shows at most. */
export const MAX_LINK_TO_RESULTS = 6;

/**
 * Returns the things of `page` that "Link to..." can offer: a thing on its own,
 * or a member of a group that answers the search. A member that is only in
 * the page because its group answers the search is not offered, since the user
 * did not search for it. Things in `excluded` are left out too.
 */
export const listLinkableThings = (
  page: Pick<InboxFirstPage | InboxNextPage, "things" | "groups">,
  excluded: ReadonlySet<string>,
): InboxThing[] => {
  const quietMembers = new Set(
    page.groups.flatMap((group) =>
      group.members.filter((member) => !member.matches).map((member) => member.ref),
    ),
  );
  return page.things.filter((thing) => !excluded.has(thing.ref) && !quietMembers.has(thing.ref));
};

/**
 * Reads the things "Link to..." offers for `text` (no text narrows nothing)
 * from the Inbox's Everything list, at most `MAX_LINK_TO_RESULTS`. It reads a
 * small first page, and the next page while everything on the pages so far is
 * left out (`listLinkableThings`), so the popover is never empty only because
 * the first things were the ones that cannot be linked.
 */
const readLinkToThings = async (
  client: HerculeClient,
  text: string,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<readonly InboxThing[]> => {
  const first = await client.externalEntity.queryInbox(
    {
      payload: {
        mode: "first",
        list: { savedQuery: "everything" },
        limit: FIRST_PAGE_LIMIT,
        ...(text === "" ? {} : { text }),
      },
    },
    { signal },
  );
  if (first.mode !== "first") {
    throw new Error(`The Inbox answered a read in first mode in ${first.mode} mode.`);
  }
  let page: InboxFirstPage | InboxNextPage = first;
  let things = listLinkableThings(page, excluded);
  while (things.length === 0 && page.nextCursor !== undefined) {
    const next = await client.externalEntity.queryInbox(
      {
        payload: {
          mode: "next",
          list: { savedQuery: "everything" },
          after: page.nextCursor,
          ...(text === "" ? {} : { text }),
        },
      },
      { signal },
    );
    if (next.mode !== "next") {
      throw new Error(`The Inbox answered a read in next mode in ${next.mode} mode.`);
    }
    page = next;
    things = listLinkableThings(page, excluded);
  }
  return things.slice(0, MAX_LINK_TO_RESULTS);
};

/**
 * Returns the read of what "Link to..." offers for `text` when linking from
 * `fromRef`, leaving out `excluded`. A newer text replaces an older read,
 * which aborts, and the previous results stay in view until the new ones
 * arrive.
 *
 * Its key is not under the Inbox's, so a push on the Inbox never reads it
 * again while the popover is open: the results are a snapshot of the moment
 * the user searched, and a row must not change under the user's pointer. It
 * is read afresh each time the popover opens.
 */
export const linkToThingsQuery = (
  client: HerculeClient,
  fromRef: string,
  text: string,
  excluded: ReadonlySet<string>,
) =>
  queryOptions({
    queryKey: ["inbox-link-to", fromRef, text],
    queryFn: ({ signal }) => readLinkToThings(client, text, excluded, signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 30_000,
  });
