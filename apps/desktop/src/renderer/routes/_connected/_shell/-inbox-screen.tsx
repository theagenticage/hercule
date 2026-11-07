import { useEffect, useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { buildInitials, readErrorMessage } from "@hercule/client-core";
import {
  buildInboxFacets,
  decideEmptyInbox,
  describeFailingSources,
  describeTruncatedInbox,
  type InboxLayout,
} from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import { acknowledgeInboxArrival } from "../../../app/inbox-arrival";
import { connectionsQuery, pluginsQuery, userQuery } from "../../../app/queries";
import { describeUndoKey } from "../../../app/primary-modifier";
import { useFirstArrival } from "../../../app/use-first-arrival";
import { useOfflineSince } from "../../../app/use-offline-since";
import { useWindowVisible } from "../../../app/window-visibility";
import { IconPill, KeysSheet, ReadFailure, UndoLine, type KeyRow } from "../../../screens/desk";
import { InboxDesk, type InboxDeskState } from "../../../screens/inbox/inbox-desk";
import { InboxLoading } from "../../../screens/inbox/inbox-loading";
import { InboxPill } from "../../../screens/inbox/inbox-pill";
import { AllClear, FirstRun } from "../../../screens/inbox/inbox-states";
import { InboxToolbar } from "../../../screens/inbox/inbox-toolbar";
import { buildInboxViewKey } from "../../../screens/inbox/inbox-view-storage";
import { OngoingSide } from "../../../screens/inbox/ongoing-side";
import { InboxOpenCard } from "../../../screens/inbox/open-card";
import { RequestsSide } from "../../../screens/inbox/requests-side";
import { useCurrentCard } from "../../../screens/inbox/use-current-card";
import { useInboxArrivals } from "../../../screens/inbox/use-inbox-arrivals";
import { useInboxGroupings } from "../../../screens/inbox/use-inbox-groupings";
import { useInboxLayout } from "../../../screens/inbox/use-inbox-layout";
import { useInboxPage } from "../../../screens/inbox/use-inbox-page";
import { useInboxView } from "../../../screens/inbox/use-inbox-view";
import { useOpenCard } from "../../../screens/inbox/use-open-card";
import { useInboxMoves } from "./-inbox-moves";
import { useInbox } from "./-inbox-read";

/** How long the sunrise waits after the user's own move empties the Inbox, which is the time the last card takes to step aside. */
const SUNRISE_DELAY_MS = 320;

/** The keys of the Inbox page and what each does, as its sheet lists them. */
const KEY_ROWS: readonly KeyRow[] = [
  ["↑ ↓ ← →", "Move through the page"],
  ["J K", "Next, previous"],
  ["Space Return", "Open the card"],
  ["T", "Take it"],
  ["E", "Dismiss"],
  ["G", "See its Task on Work"],
];

/** Returns whether the card `id` is the only request the layout draws, so a dismissal leaves the column empty. */
const isLastRequest = (layout: InboxLayout, id: string): boolean => {
  const rows = layout.requests.groups.flatMap((group) => group.rows);
  return rows.length === 1 && rows[0]?.card.id === id;
};

/** Returns the line that says since when the controller cannot be reached, and what that means for moves. */
const describeOffline = (since: Date): string =>
  `Offline. What you see is from ${since.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. A move fails until you are back.`;

/**
 * Renders the Inbox screen: the cards that concern the user, on the wide side
 * as rows on the surface of their place and in the narrow column as small
 * requests, with the toolbar over them. It reads the Inbox, holds what the user
 * chose (Group by, Filter and the order of Requests) and what the visit holds
 * in place (each card's side), and hands the page to `screens/inbox/`.
 *
 * - The Inbox is read while the window is visible, and read again on each
 *   push. Group by, Filter and the order run in client-core over the read, so
 *   they cost no read and change no number in the sidebar.
 * - The first read of a visit holds the words of the cards of the last visit
 *   back, and fades them in. With nothing known yet, quiet bars stand in.
 * - When the page is really shown, the newest arrival it knows is acknowledged,
 *   which takes the sidebar's new mark away.
 * - Offline, or with a source that cannot be read, one line in the bar says
 *   what that means. A read that fails says why, with a Try again button.
 * - The user's moves are here: Take it, Dismiss and Undo (`useInboxMoves`),
 *   the pointer and the keys that drive them (`useCurrentCard`,
 *   `useInboxPage`), the open card, and See its Task, which goes to Work.
 */
export function InboxScreen({ controller }: { readonly controller: SavedController }): JSX.Element {
  const { client, url, live, undoStack } = controller;
  const navigate = useNavigate();
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { data: connections } = useSuspenseQuery(connectionsQuery(client));
  const scrollRef = useRef<HTMLDivElement>(null);
  const read = useInbox(client);
  const moves = useInboxMoves({ client, undoStack, serverInbox: read.data, scrollRef });
  const isVisible = useWindowVisible();
  const offlineSince = useOfflineSince(live);
  const view = useInboxView(buildInboxViewKey(url, username));
  const monogram = buildInitials(username);

  // The words of the last visit's cards wait while this visit's read is on its way.
  const [isHolding, setIsHolding] = useState(read.isFetching);
  if (isHolding && !read.isFetching) setIsHolding(false);
  // The cards the cache kept from the last visit stand in until this visit's own reply comes. Only
  // that reply decides where cards lie and which are new, so a card that changed meanwhile does not
  // keep the place it had.
  const [hasOwnReply, setHasOwnReply] = useState(false);
  if (!hasOwnReply && read.data !== undefined && !isHolding && !read.isError) setHasOwnReply(true);
  const { inbox, hasHeldArrivals } = useInboxArrivals({
    inbox: moves.inbox,
    isFresh: hasOwnReply,
    scrollRef,
  });
  const hasWords = inbox !== undefined && !isHolding;
  const isArriving = useFirstArrival(inbox === undefined || read.isFetching, hasWords);

  // The new mark goes when a reply is really shown: its words are in view and no card of it is held back.
  const newestArrival = hasWords && !hasHeldArrivals ? inbox.counts.newestArrival : undefined;
  useEffect(() => {
    if (newestArrival !== undefined && isVisible) {
      acknowledgeInboxArrival(url, username, newestArrival);
    }
  }, [url, username, newestArrival, isVisible]);

  const layout = useInboxLayout(
    inbox,
    { grouping: view.grouping, filter: view.filter, requestsOrder: view.requestsOrder },
    hasOwnReply,
  );
  const empty = inbox === undefined ? null : decideEmptyInbox(inbox, connections, plugins);
  const groupings = useInboxGroupings(inbox, layout?.grouping);
  const failingSources = describeFailingSources(connections, plugins);
  const truncated = inbox === undefined ? undefined : describeTruncatedInbox(inbox);

  // The sunrises play only when the user's own move leaves nothing: a page that opens empty shows them at rest.
  const [isClearedByMove, setIsClearedByMove] = useState(false);
  const [areRequestsClearedByMove, setAreRequestsClearedByMove] = useState(false);
  if (isClearedByMove && inbox !== undefined && inbox.cards.length > 0) setIsClearedByMove(false);
  if (areRequestsClearedByMove && layout !== undefined && !layout.requests.isEmpty) {
    setAreRequestsClearedByMove(false);
  }
  const [hasWaitedForSunrise, setHasWaitedForSunrise] = useState(false);
  useEffect(() => {
    if (!isClearedByMove) return;
    const timer = setTimeout(() => {
      setHasWaitedForSunrise(true);
    }, SUNRISE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isClearedByMove]);
  if (!isClearedByMove && hasWaitedForSunrise) setHasWaitedForSunrise(false);

  // ---------- Moves, keys and the open card ----------
  const current = useCurrentCard(scrollRef);
  const openCard = useOpenCard();
  const findCard = (id: string): InboxCard | undefined =>
    inbox?.cards.find((card) => card.id === id);
  const dismissCard = (card: InboxCard): void => {
    if (inbox?.cards.length === 1) setIsClearedByMove(true);
    if (layout !== undefined && isLastRequest(layout, card.id)) setAreRequestsClearedByMove(true);
    moves.dismiss(card);
  };
  const seeTask = (card: InboxCard): void => {
    if (card.taskId === undefined) return;
    void navigate({ to: "/work", search: { task: card.taskId } });
  };
  const page = useInboxPage({
    scrollRef,
    platform: bridge.platform,
    current,
    findCard,
    open: openCard,
    moves: {
      take: moves.take,
      dismiss: dismissCard,
      seeTask,
      undoLastMove: moves.undoLastMove,
      say: moves.sayWithoutUndo,
    },
  });

  let state: InboxDeskState = "board";
  let body: JSX.Element | null;
  if (inbox === undefined || layout === undefined) {
    state = "loading";
    body = read.isError ? (
      <ReadFailure
        what="The Inbox"
        reason={readErrorMessage(read.error)}
        onRetry={() => {
          void read.refetch();
        }}
      />
    ) : (
      <InboxLoading />
    );
  } else if (empty?._tag === "first-run") {
    state = "first-run";
    body = <FirstRun offers={empty.offers} plugins={plugins} />;
  } else if (empty?._tag === "all-clear") {
    state = "clear";
    // The sunrise plays only when the user's own action empties the Inbox. A page that opens empty shows it at rest.
    body = isClearedByMove && !hasWaitedForSunrise ? null : <AllClear isStill={!isClearedByMove} />;
  } else {
    body = (
      <>
        <OngoingSide
          layout={layout}
          plugins={plugins}
          monogram={monogram}
          note={truncated === undefined ? null : <p className="inbox-note">{truncated}</p>}
        />
        <RequestsSide
          layout={layout}
          requestsOrder={view.requestsOrder}
          onOrderChange={view.setRequestsOrder}
          plugins={plugins}
          monogram={monogram}
          isSunriseStill={!areRequestsClearedByMove}
        />
      </>
    );
  }

  // A read that fails while the page holds cards keeps them and says so here. With no cards the body says it.
  const readFailure =
    read.isError && inbox !== undefined
      ? `The Inbox could not be read: ${readErrorMessage(read.error).replace(/\.+$/, "")}. What you see is from earlier.`
      : undefined;
  const notice =
    offlineSince !== null ? (
      <div className="inbox-notice" role="status">
        <i className="notice-dot" />
        <span>{describeOffline(offlineSince)}</span>
      </div>
    ) : readFailure !== undefined ? (
      <div className="inbox-notice" role="alert">
        <i className="notice-dot" />
        <span title={readFailure}>{readFailure}</span>
        <button
          type="button"
          onClick={() => {
            void read.refetch();
          }}
        >
          Try again
        </button>
      </div>
    ) : failingSources !== undefined ? (
      <div className="inbox-notice" role="status">
        <i className="notice-dot" />
        <span>{failingSources}</span>
        <Link to="/settings/connections">Connections</Link>
      </div>
    ) : null;

  return (
    <InboxDesk
      toolbar={
        <InboxToolbar
          pill={<InboxPill />}
          groupings={groupings}
          grouping={layout?.grouping ?? view.grouping}
          onGroupingChange={view.setGrouping}
          facets={inbox === undefined ? [] : buildInboxFacets(inbox)}
          filter={view.filter}
          cards={inbox?.cards ?? []}
          onFilterChange={view.setFilter}
          plugins={plugins}
          showsControls={empty === null}
          notice={notice}
          end={
            <IconPill label="Show the keys" title="Keys (?)" onClick={page.toggleKeysSheet}>
              ?
            </IconPill>
          }
        />
      }
      overlays={
        <>
          <InboxOpenCard
            openCard={openCard}
            client={client}
            inbox={inbox}
            plugins={plugins}
            onTake={(cardId) => {
              const card = findCard(cardId);
              if (card !== undefined) {
                openCard.closeThen(() => {
                  moves.take(card);
                });
              }
            }}
            onDismiss={(cardId) => {
              const card = findCard(cardId);
              if (card !== undefined) {
                openCard.closeThen(() => {
                  dismissCard(card);
                });
              }
            }}
            onSeeTask={(taskId) => {
              openCard.close();
              void navigate({ to: "/work", search: { task: taskId } });
            }}
          />
          {page.isKeysSheetOpen && <KeysSheet rows={KEY_ROWS} platform={bridge.platform} />}
          <UndoLine
            text={moves.line.text}
            onUndo={moves.line.canUndo ? moves.undoLastMove : null}
            undoKey={describeUndoKey(bridge.platform)}
            isShown={moves.line.isShown}
          />
        </>
      }
      state={state}
      isHolding={isHolding && inbox !== undefined}
      isArriving={isArriving}
      isOffline={offlineSince !== null}
      scrollRef={scrollRef}
    >
      {body}
    </InboxDesk>
  );
}
