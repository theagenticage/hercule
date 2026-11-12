/**
 * The Inbox's held list: the one place the list on screen is kept. A read of
 * the Inbox never changes what the user sees by itself. This hook owns the
 * state of `@hercule/client-core/inbox`'s `inbox-list` and decides when a
 * reply may be applied to it (spec 17 §Inbox, "The list holds still").
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  /**
   * Reads the first page again and takes in the arrivals that wait behind
   * "N new". When the read fails, takes in the arrivals already held.
   */
  readonly showArrivals: () => void;
  /** Reads the next page, when one follows the rows held. Safe to call again for the same end. */
  readonly loadNextPage: () => void;
  /**
   * Replaces the list by the result of a transition (a move, a selection, a
   * step of the current row), applied to the newest list held, and returns
   * that result. Returns `null`, calling nothing, when no list is held.
   */
  readonly change: (
    transition: (list: InboxListState<InboxThing>) => InboxListState<InboxThing>,
  ) => InboxListState<InboxThing> | null;
  /** Returns the newest list held and the offers of its pages, or `null` when none is held. */
  readonly readLatest: () => { list: InboxListState<InboxThing>; offerSets: OfferSets } | null;
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
 * Returns `before` with the arrivals taken in, and the refs of the rows that
 * came in so the list can bring them down. Returns `before` when none wait.
 */
const takeInArrivals = (before: Held): Held =>
  before.list.arrivals.length === 0
    ? before
    : {
        ...before,
        list: showInboxArrivals(before.list),
        arrived: before.list.arrivals.map((row) => row.ref),
      };

/**
 * Holds the list for `query` (its scope and search). The first page is read
 * while the window is visible, and a live push on the Inbox's keys reads it
 * again. Nothing a read returns is drawn until it is applied here:
 *
 * - A new `query` starts a new list, but only from a first page read after
 *   the list was asked for, never from an older copy in the cache. Until it
 *   arrives the previous list stays on screen, so the list never flashes a
 *   skeleton between two lists.
 * - A later read of the first page is one refresh: the held rows the page does
 *   not carry are read by `refs` (at most 200 per read), and only when every
 *   read has succeeded is the refresh applied, once. A refresh that a newer
 *   one has overtaken is dropped.
 * - The next page continues from the frontier of the rows held. A reply that
 *   belongs to a list the user has left since is ignored.
 *
 * The newest list lives in a ref that every change reads and writes at once,
 * so two changes in the same tick, or a reply that arrives between two
 * renders, always build on the latest list and never on a stale copy. The
 * state only makes the screen draw it.
 */
export function useHeldInboxList(client: HerculeClient, query: InboxQuery): HeldInboxList {
  const queryClient = useQueryClient();
  const isVisible = useWindowVisible();
  // `staleTime: 0` makes opening a list read its first page again, so a cached page is never the start.
  const first = useQuery({ ...inboxQuery(client, query), staleTime: 0, enabled: isVisible });
  const listId = JSON.stringify(query);
  const [held, setHeld] = useState<Held | null>(null);
  const heldRef = useRef<Held | null>(null);
  const latestQuery = useRef(query);
  const refreshId = useRef(0);
  // Counts the lists started, so the reply of a list the user has left is told apart.
  const visit = useRef(0);
  const nextPage = useRef<{ readonly visit: number; readonly after: string } | null>(null);
  const showAfterRefresh = useRef(false);
  useLayoutEffect(() => {
    latestQuery.current = query;
  });

  /** Applies `transition` to the newest list held, and returns the result, or `null` when none is held. */
  const update = useCallback((transition: (before: Held) => Held): Held | null => {
    const before = heldRef.current;
    if (before === null) return null;
    const next = transition(before);
    if (next !== before) {
      heldRef.current = next;
      setHeld(next);
    }
    return next;
  }, []);

  const firstPage = first.data;
  const firstPageReadAt = first.dataUpdatedAt;
  const isFresh = first.isFetchedAfterMount;

  // A first page read since this list was asked for starts it. A layout effect, so the list is
  // drawn in the same frame and no skeleton shows between the page arriving and the list.
  useLayoutEffect(() => {
    if (!isFresh || firstPage === undefined || heldRef.current?.listId === listId) return;
    visit.current += 1;
    refreshId.current += 1;
    nextPage.current = null;
    showAfterRefresh.current = false;
    const started = startHeld(listId, firstPage, firstPageReadAt);
    heldRef.current = started;
    setHeld(started);
  }, [isFresh, firstPage, firstPageReadAt, listId]);

  useEffect(() => {
    const now = heldRef.current;
    if (firstPage === undefined || now === null || now.listId !== listId) return;
    if (firstPageReadAt <= now.firstPageReadAt) return;
    refreshId.current += 1;
    const id = refreshId.current;
    const heldRefs = now.list.rows.map((row) => row.ref);
    readRefreshReplies(queryClient, client, latestQuery.current, heldRefs, firstPage).then(
      ({ askedRefs, reads }) => {
        if (id !== refreshId.current) return;
        update((before) => {
          if (before.listId !== listId) return before;
          const refreshed: Held = {
            ...before,
            list: applyInboxRefresh(before.list, {
              listId,
              firstPage: firstPage.things,
              firstPageHasMore: firstPage.nextCursor !== undefined,
              askedRefs,
              refsReads: reads.flatMap((page) => page.things),
            }),
            total: readTotal(firstPage) ?? before.total,
            order: firstPage.order,
            facets: firstPage.facets ?? before.facets,
            offerSets: mergeOfferSets(before.offerSets, [firstPage, ...reads]),
            firstPageReadAt,
          };
          if (!showAfterRefresh.current) return refreshed;
          showAfterRefresh.current = false;
          return takeInArrivals(refreshed);
        });
      },
      () => {
        // The refresh is not applied: a row missing from a failed read would look like one that left.
        // The next push reads again. A "Show" that waited for it takes in what is held instead.
        if (id !== refreshId.current || !showAfterRefresh.current) return;
        showAfterRefresh.current = false;
        update(takeInArrivals);
      },
    );
  }, [firstPage, firstPageReadAt, listId, queryClient, client, update]);

  const loadNextPage = (): void => {
    const now = heldRef.current;
    if (now === null || now.listId !== listId) return;
    const after = now.list.frontier;
    if (after === undefined) return;
    const pending = nextPage.current;
    if (pending !== null && pending.visit === visit.current && pending.after === after) return;
    const startedVisit = visit.current;
    nextPage.current = { visit: startedVisit, after };
    queryClient.fetchQuery(inboxPartialPageQuery(client, { ...query, cursor: after })).then(
      (page) => {
        if (startedVisit !== visit.current) return;
        nextPage.current = null;
        update((before) =>
          before.listId !== listId
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
        if (startedVisit === visit.current) nextPage.current = null;
      },
    );
  };

  const isSwitching = held !== null && held.listId !== listId;
  const status =
    held === null
      ? first.isError
        ? "failed"
        : "loading"
      : isSwitching && first.isError
        ? "failed"
        : "ready";
  return {
    status,
    error: first.error,
    list: status === "ready" ? (held?.list ?? null) : null,
    total: held?.total,
    order: held?.order,
    facets: held?.facets ?? NO_FACETS,
    offerSets: held?.offerSets ?? NO_OFFERS,
    arrived: held?.arrived ?? [],
    showArrivals: () => {
      showAfterRefresh.current = true;
      void first.refetch().then((result) => {
        if (!result.isError || !showAfterRefresh.current) return;
        showAfterRefresh.current = false;
        update(takeInArrivals);
      });
    },
    loadNextPage,
    change: (transition) => {
      const next = update((before) => ({ ...before, list: transition(before.list), arrived: [] }));
      return next?.list ?? null;
    },
    readLatest: () => {
      const latest = heldRef.current;
      return latest === null ? null : { list: latest.list, offerSets: latest.offerSets };
    },
    retry: () => {
      void first.refetch();
    },
  };
}
