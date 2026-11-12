/**
 * The Inbox visit as the screen uses it: the reader that asks the controller
 * for the pages, and the hook that gives a React screen the visit of
 * `@hercule/client-core/inbox` (spec 17 §Inbox, "The list holds still").
 * Ordering, held rows and moves all live in the visit; nothing here decides
 * when a reply may be drawn.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  createInboxVisit,
  listCardOffers,
  type CardOffers,
  type FirstPage,
  type InboxReader,
  type InboxVisit,
  type InboxVisitSnapshot,
} from "@hercule/client-core/inbox";
import type { InboxFirstPage, InboxQuery, InboxReply, InboxThing } from "@hercule/contract";
import { listenForInboxPushes } from "../../../app/live";
import type { InboxSelection } from "../../../app/queries";
import { isWindowVisible, useWindowVisible } from "../../../app/window-visibility";

/** A thing as the list holds it: the workflows it can be handed to are attached. */
export type InboxListRow = InboxThing & { readonly offers: CardOffers };

/** The visit of one list, whose rows are `InboxListRow`s. */
export type InboxListVisit = InboxVisit<InboxListRow, InboxSelection>;

/** What the screen draws of the visit. */
export type InboxListSnapshot = InboxVisitSnapshot<InboxListRow, InboxSelection>;

/** Returns the things of a reply with their offers attached, read from the reply's `offerSets`. */
const attachOffers = (
  things: readonly InboxThing[],
  offerSets: InboxFirstPage["offerSets"],
): InboxListRow[] =>
  things.map((thing) => ({ ...thing, offers: listCardOffers(thing, offerSets) }));

const readFirstPage = (page: InboxFirstPage): FirstPage<InboxListRow> => ({
  rows: attachOffers(page.things, page.offerSets),
  nextCursor: page.nextCursor,
  total: page.total,
  order: page.order,
  facets: page.facets,
});

/**
 * Builds the reader of the visit for `client`: each of the visit's four reads
 * is one `queryInbox` mode, sent with the visit's abort signal. It only
 * translates; the visit decides what to read and when.
 */
export function buildInboxReader(client: HerculeClient): InboxReader<InboxListRow, InboxSelection> {
  const read = async <Mode extends InboxReply["mode"]>(
    mode: Mode,
    payload: InboxQuery,
    signal: AbortSignal,
  ): Promise<Extract<InboxReply, { mode: Mode }>> => {
    const reply = await client.externalEntity.queryInbox({ payload }, { signal });
    if (reply.mode !== mode) {
      throw new Error(`The Inbox answered a read in ${mode} mode in ${reply.mode} mode.`);
    }
    return reply as Extract<InboxReply, { mode: Mode }>;
  };
  return {
    readFirst: async (selection, signal) =>
      readFirstPage(await read("first", { mode: "first", ...selection }, signal)),
    readNext: async (selection, after, signal) => {
      const page = await read("next", { mode: "next", ...selection, after }, signal);
      return { rows: attachOffers(page.things, page.offerSets), nextCursor: page.nextCursor };
    },
    refresh: async (selection, held, signal) => {
      const reply = await read(
        "refresh",
        { mode: "refresh", ...selection, held: [...held] },
        signal,
      );
      return {
        firstPage: readFirstPage(reply.first),
        heldRows: attachOffers(reply.held.things, reply.held.offerSets),
      };
    },
    readRows: async (selection, held, signal) => {
      const reply = await read("rows", { mode: "rows", ...selection, held: [...held] }, signal);
      return attachOffers(reply.things, reply.offerSets);
    },
  };
}

/**
 * Visits the list of `selection` for as long as the screen is mounted, and
 * returns the visit with its snapshot, which the screen draws.
 *
 * - A new `selection` opens a new list; the previous rows stay until its
 *   first page arrives.
 * - Every push for the Inbox is one `pushArrived`. While the window is hidden
 *   nothing is read: the push is remembered, and the window showing again
 *   delivers it.
 * - Unmounting closes the visit, which cancels its reads.
 */
export function useInboxVisit(
  client: HerculeClient,
  selection: InboxSelection,
): { readonly visit: InboxListVisit; readonly snapshot: InboxListSnapshot } {
  const queryClient = useQueryClient();
  const isVisible = useWindowVisible();
  const [visit] = useState<InboxListVisit>(() => createInboxVisit(buildInboxReader(client)));
  const snapshot = useSyncExternalStore(visit.subscribe, visit.getSnapshot);

  useEffect(
    () => () => {
      visit.close();
    },
    [visit],
  );

  // The selection is compared by its content: the screen builds a new object on every render.
  const selectionKey = JSON.stringify(selection);
  const latestSelection = useRef(selection);
  useLayoutEffect(() => {
    latestSelection.current = selection;
  });
  useEffect(() => {
    visit.open(latestSelection.current);
  }, [visit, selectionKey]);

  const hasMissedPush = useRef(false);
  useEffect(
    () =>
      listenForInboxPushes(queryClient, () => {
        if (isWindowVisible()) visit.pushArrived();
        else hasMissedPush.current = true;
      }),
    [queryClient, visit],
  );
  useEffect(() => {
    if (!isVisible || !hasMissedPush.current) return;
    hasMissedPush.current = false;
    visit.pushArrived();
  }, [isVisible, visit]);

  return { visit, snapshot };
}
