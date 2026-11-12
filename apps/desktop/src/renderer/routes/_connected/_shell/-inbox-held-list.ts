/**
 * The Inbox's held list: the one place the list on screen is kept. A read of
 * the Inbox never changes what the user sees by itself. This hook owns the
 * state of `@hercule/client-core/inbox`'s `inbox-list` and decides when a
 * reply may be applied to it (spec 17 §Inbox, "The list holds still").
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  applyInboxNextPage,
  applyInboxRefresh,
  showInboxArrivals,
  startInboxList,
  type InboxListState,
} from "@hercule/client-core/inbox";
import {
  MAX_INBOX_PAGE,
  type InboxFacet,
  type InboxOrder,
  type InboxPage,
  type InboxQuery,
  type InboxThing,
} from "@hercule/contract";
import { inboxPartialPageQuery, inboxQuery } from "../../../app/queries";
import { useWindowVisible } from "../../../app/window-visibility";

type OfferSets = InboxPage["offerSets"];

/** What the screen holds for one list: the rows and what the latest first page said beside them. */
interface Held {
  /** Names the list (scope and search). A reply for another list is ignored. */
  readonly listId: string;
  readonly list: InboxListState<InboxThing>;
  /** The result's size, from the latest first page applied. `undefined` when that page did not say. */
  readonly total: number | undefined;
  readonly order: InboxOrder;
  readonly facets: readonly InboxFacet[];
  /** The offers of every page read for this list, by `offerSetId`. */
  readonly offerSets: OfferSets;
  /** When the first page read that this state last took in was made, so the same read is taken in once. */
  readonly firstPageReadAt: number;
  /** The refs that "Show" last took in, so the rows can come down. */
  readonly arrived: readonly string[];
}

/** The held list as the screen draws it. */
export interface HeldInboxList {
  /** `loading` until the first page of this list is in, `failed` when it could not be read, else `ready`. */
  readonly status: "loading" | "failed" | "ready";
  readonly error: unknown;
  /** The rows, the arrivals, the current row and the selection. `null` until `ready`. */
  readonly list: InboxListState<InboxThing> | null;
  readonly total: number | undefined;
  readonly order: InboxOrder | undefined;
  readonly facets: readonly InboxFacet[];
  readonly offerSets: OfferSets;
  /** The refs the last "Show" took in. */
  readonly arrived: readonly string[];
  /** Takes in the arrivals that wait behind "N new". */
  readonly showArrivals: () => void;
  /** Reads the next page, when one follows the rows held. Safe to call again for the same end. */
  readonly loadNextPage: () => void;
  /** Replaces the list by the result of a transition (a move, a selection, a step of the current row). */
  readonly change: (
    transition: (list: InboxListState<InboxThing>) => InboxListState<InboxThing>,
  ) => void;
  /** Reads the first page again after it failed. */
  readonly retry: () => void;
}

/**
 * Returns the size of the result a first page reports, or `undefined` for a
 * page that does not carry it (only a first page does).
 */
const readTotal = (page: { readonly total?: number | undefined }): number | undefined => page.total;

/** Returns `known` with the offers of each page added, a later page winning for a set both name. */
const mergeOfferSets = (known: OfferSets, pages: ReadonlyArray<InboxPage>): OfferSets => {
  let merged = known;
  for (const page of pages) merged = { ...merged, ...page.offerSets };
  return merged;
};

const NO_FACETS: readonly InboxFacet[] = [];
const NO_OFFERS: OfferSets = {};

const startHeld = (listId: string, page: InboxPage, readAt: number): Held => ({
  listId,
  list: startInboxList(listId, page.things, page.nextCursor),
  total: readTotal(page),
  order: page.order,
  facets: page.facets ?? NO_FACETS,
  offerSets: page.offerSets,
  firstPageReadAt: readAt,
  arrived: [],
});

/**
 * Reads the first page again and, with `refs`, every held row the first page
 * does not carry, then returns what the held list needs to apply the refresh.
 * Rejects when any read fails, so a row missing from a read that did not
 * happen is never taken for a row that left.
 */
async function readRefreshReplies(
  queryClient: QueryClient,
  client: HerculeClient,
  query: InboxQuery,
  heldRefs: readonly InboxThing["ref"][],
  firstPage: InboxPage,
): Promise<{ askedRefs: InboxThing["ref"][]; reads: InboxPage[] }> {
  const onFirstPage = new Set(firstPage.things.map((thing) => thing.ref));
  const askedRefs = heldRefs.filter((ref) => !onFirstPage.has(ref));
  const batches: InboxThing["ref"][][] = [];
  for (let at = 0; at < askedRefs.length; at += MAX_INBOX_PAGE) {
    batches.push(askedRefs.slice(at, at + MAX_INBOX_PAGE));
  }
  const reads = await Promise.all(
    batches.map((refs) =>
      queryClient.fetchQuery(inboxPartialPageQuery(client, { ...query, refs })),
    ),
  );
  return { askedRefs, reads };
}

/**
 * Holds the list for `query` (its scope and search). The first page is read
 * while the window is visible, and a live push on the Inbox's keys reads it
 * again. Nothing a read returns is drawn until it is applied here:
 *
 * - A new `query` starts a new list from its first page.
 * - A later read of the first page is one refresh: the held rows the page does
 *   not carry are read by `refs` (at most 200 per read), and only when every
 *   read has succeeded is the refresh applied, once. A refresh that a newer
 *   one has overtaken is dropped.
 * - The next page continues from the frontier of the rows held.
 */
export function useHeldInboxList(client: HerculeClient, query: InboxQuery): HeldInboxList {
  const queryClient = useQueryClient();
  const isVisible = useWindowVisible();
  const first = useQuery({ ...inboxQuery(client, query), enabled: isVisible });
  const listId = JSON.stringify(query);
  const [held, setHeld] = useState<Held | null>(null);
  const heldRef = useRef<Held | null>(null);
  const refreshId = useRef(0);
  const nextPageAfter = useRef<string | null>(null);

  // A first page for a list not held yet starts it. Held rows of another list are not drawn.
  if (first.data !== undefined && held?.listId !== listId) {
    setHeld(startHeld(listId, first.data, first.dataUpdatedAt));
  }
  const current = held?.listId === listId ? held : null;

  useEffect(() => {
    heldRef.current = held;
  }, [held]);

  const firstPage = first.data;
  const firstPageReadAt = first.dataUpdatedAt;
  useEffect(() => {
    const now = heldRef.current;
    if (firstPage === undefined || now === null || now.listId !== listId) return;
    if (firstPageReadAt <= now.firstPageReadAt) return;
    refreshId.current += 1;
    const id = refreshId.current;
    const heldRefs = now.list.rows.map((row) => row.ref);
    readRefreshReplies(queryClient, client, query, heldRefs, firstPage).then(
      ({ askedRefs, reads }) => {
        if (id !== refreshId.current) return;
        setHeld((before) => {
          if (before === null || before.listId !== listId) return before;
          return {
            ...before,
            list: applyInboxRefresh(before.list, {
              listId,
              firstPage: firstPage.things,
              askedRefs,
              refsReads: reads.flatMap((page) => page.things),
            }),
            total: readTotal(firstPage) ?? before.total,
            order: firstPage.order,
            facets: firstPage.facets ?? before.facets,
            offerSets: mergeOfferSets(before.offerSets, [firstPage, ...reads]),
            firstPageReadAt,
          };
        });
      },
      () => {
        // The refresh is not applied: a row missing from a failed read would look like one that left.
        // The next push reads again.
      },
    );
  }, [firstPage, firstPageReadAt, listId, queryClient, client, query]);

  const loadNextPage = (): void => {
    const now = heldRef.current;
    const after = now?.list.frontier;
    if (now === null || now.listId !== listId || after === undefined) return;
    if (nextPageAfter.current === after) return;
    nextPageAfter.current = after;
    queryClient.fetchQuery(inboxPartialPageQuery(client, { ...query, cursor: after })).then(
      (page) => {
        setHeld((before) =>
          before === null || before.listId !== listId
            ? before
            : {
                ...before,
                list: applyInboxNextPage(before.list, {
                  listId,
                  after,
                  rows: page.things,
                  ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
                }),
                offerSets: { ...before.offerSets, ...page.offerSets },
              },
        );
      },
      () => {
        // Let the next time the list nears its end read this page again.
        nextPageAfter.current = null;
      },
    );
  };

  return {
    status: current !== null ? "ready" : first.isError ? "failed" : "loading",
    error: first.error,
    list: current?.list ?? null,
    total: current?.total,
    order: current?.order,
    facets: current?.facets ?? NO_FACETS,
    offerSets: current?.offerSets ?? NO_OFFERS,
    arrived: current?.arrived ?? [],
    showArrivals: () => {
      setHeld((before) => {
        if (before === null || before.listId !== listId) return before;
        const list = showInboxArrivals(before.list);
        return { ...before, list, arrived: before.list.arrivals.map((row) => row.ref) };
      });
    },
    loadNextPage,
    change: (transition) => {
      setHeld((before) =>
        before === null || before.listId !== listId
          ? before
          : { ...before, list: transition(before.list), arrived: [] },
      );
    },
    retry: () => {
      void first.refetch();
    },
  };
}
