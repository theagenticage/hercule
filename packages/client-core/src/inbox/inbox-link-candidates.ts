/**
 * What "Link to..." offers: the things of the Inbox a thing or a group can be
 * linked to, read from the Everything list.
 */
import type { InboxFirstPage, InboxNextPage, InboxThing } from "@hercule/contract";
import type { HerculeClient } from "../client";

/** How many things the first read asks for: enough to fill "Link to..." after the things that cannot be offered are left out. */
const FIRST_PAGE_LIMIT = 12;

/** How many things "Link to..." offers at most. */
const MAX_LINK_CANDIDATES = 6;

/**
 * Returns the things of `page` that "Link to..." can offer: a thing on its own,
 * or a member of a group that answers the search. A member that is only in
 * the page because its group answers the search is not offered, since the user
 * did not search for it. Things in `excluded` are left out too.
 */
const listLinkableThings = (
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
 * when linking from `fromRef`, at most six. Neither `fromRef` nor
 * `excludedRefs` (the members of its group) are offered, because linking them
 * changes nothing.
 *
 * It reads a small first page of the Inbox's Everything list, and the next
 * page while everything on the pages so far is left out, so the result is
 * never empty only because the first things were the ones that cannot be
 * linked. Fails when a read fails or answers in another mode.
 */
export async function readLinkCandidates(
  client: HerculeClient,
  input: {
    readonly text: string;
    readonly fromRef: string;
    readonly excludedRefs: readonly string[];
  },
  signal: AbortSignal,
): Promise<readonly InboxThing[]> {
  const excluded = new Set([input.fromRef, ...input.excludedRefs]);
  const search = input.text === "" ? {} : { text: input.text };
  const list = { savedQuery: "everything" };
  const first = await client.externalEntity.queryInbox(
    { payload: { mode: "first", list, limit: FIRST_PAGE_LIMIT, ...search } },
    { signal },
  );
  if (first.mode !== "first") {
    throw new Error(`The Inbox answered a read in first mode in ${first.mode} mode.`);
  }
  let page: InboxFirstPage | InboxNextPage = first;
  let things = listLinkableThings(page, excluded);
  while (things.length === 0 && page.nextCursor !== undefined) {
    const next = await client.externalEntity.queryInbox(
      { payload: { mode: "next", list, after: page.nextCursor, ...search } },
      { signal },
    );
    if (next.mode !== "next") {
      throw new Error(`The Inbox answered a read in next mode in ${next.mode} mode.`);
    }
    page = next;
    things = listLinkableThings(page, excluded);
  }
  return things.slice(0, MAX_LINK_CANDIDATES);
}
