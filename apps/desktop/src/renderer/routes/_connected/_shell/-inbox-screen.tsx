import { useEffect, useRef, useState, type JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { buildInitials, readErrorMessage } from "@hercule/client-core";
import {
  buildInboxFacets,
  decideEmptyInbox,
  describeFailingSources,
  describeTruncatedInbox,
  listCardOffers,
  listRailTargets,
  listRiders,
  nameLinkEnd,
  NO_OFFERS,
} from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import { acknowledgeInboxArrival } from "../../../app/inbox-arrival";
import { useScreenTopicsLive, WORKFLOW_TOPICS } from "../../../app/live";
import { connectionsQuery, pluginsQuery, userQuery } from "../../../app/queries";
import { describeUndoKey } from "../../../app/primary-modifier";
import { useFirstArrival } from "../../../app/use-first-arrival";
import { useOfflineSince } from "../../../app/use-offline-since";
import { useWindowVisible } from "../../../app/window-visibility";
import { IconPill, KeysSheet, ReadFailure, UndoLine, type KeyRow } from "../../../screens/desk";
import { HandToMenu } from "../../../screens/inbox/hand-to-menu";
import { InboxDesk, type InboxDeskState } from "../../../screens/inbox/inbox-desk";
import { InboxLoading } from "../../../screens/inbox/inbox-loading";
import { InboxPill } from "../../../screens/inbox/inbox-pill";
import { AllClear, FirstRun } from "../../../screens/inbox/inbox-states";
import { InboxToolbar } from "../../../screens/inbox/inbox-toolbar";
import { buildInboxViewKey } from "../../../screens/inbox/inbox-view-storage";
import { OngoingSide } from "../../../screens/inbox/ongoing-side";
import { InboxOpenCard } from "../../../screens/inbox/open-card";
import { Rail } from "../../../screens/inbox/rail";
import { RequestsSide } from "../../../screens/inbox/requests-side";
import { useCurrentCard } from "../../../screens/inbox/use-current-card";
import { useInboxCarry } from "../../../screens/inbox/use-inbox-carry";
import { useInboxPage, type HandOffCandidate } from "../../../screens/inbox/use-inbox-page";
import { useInboxView } from "../../../screens/inbox/use-inbox-view";
import { useInboxVisit, useVisitHistory } from "../../../screens/inbox/use-inbox-visit";
import { useOpenCard } from "../../../screens/inbox/use-open-card";
import { useInboxMoves } from "./-inbox-moves";
import { useInbox } from "./-inbox-read";

/** The keys of the Inbox page and what each does, as its sheet lists them. */
const KEY_ROWS: readonly KeyRow[] = [
  ["↑ ↓ ← →", "Move through the page"],
  ["J K", "Next, previous"],
  ["Space Return", "Open the card"],
  ["H", "Hand to an agent"],
  ["T", "Take it"],
  ["E", "Dismiss"],
  ["G", "See its Task on Work"],
];

/** The offers of an Inbox that has none, so the cards have the same object to compare each time. */
const NO_OFFER_SETS = {};

/** The Hand to menu while it is open: the card it is for, what it opens under, and how the user asked. */
interface HandMenuTarget {
  readonly cardId: string;
  readonly anchor: HTMLElement;
  readonly by: "keys" | "pointer";
}

/** Returns the line that says since when the controller cannot be reached, and what that means for moves. */
const describeOffline = (since: Date): string =>
  `Offline. What you see is from ${since.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. A move fails until you are back.`;

/**
 * Renders the Inbox screen: the cards that concern the user, on the wide side
 * as rows on the surface of their place and in the narrow column as small
 * requests, with the toolbar over them. It reads the Inbox, holds what the user
 * chose (Group by, Filter and the order of Requests), asks the visit what the
 * page draws (`useInboxVisit`: where each card lies, what waits for a still
 * hand), and hands the page to `screens/inbox/`.
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
 * - The user's moves are here: Take it, Hand to, Dismiss and Undo
 *   (`useInboxMoves`), the pointer and the keys that drive them
 *   (`useCurrentCard`, `useInboxPage`), the open card, and See its Task, which
 *   goes to Work. Hand to hands a card to the one workflow that can take it,
 *   or opens a menu of them; the offers follow the workflows, so the screen
 *   holds the `workflow` topic.
 * - Carrying a card with the pointer raises the rail, whose targets are the
 *   workflows that can take it, Take it and Dismiss. Letting go on another
 *   card links the two, as `Link them` does. A card that arrives meanwhile
 *   waits until the card is let go.
 */
export function InboxScreen({ controller }: { readonly controller: SavedController }): JSX.Element {
  const { client, url, live } = controller;
  const scope = controller.accountScopes.read();
  const navigate = useNavigate();
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });
  const queryClient = useQueryClient();
  // The offers of every card depend on the workflows, which the shell does not hold.
  useScreenTopicsLive(live, queryClient, WORKFLOW_TOPICS);
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { data: connections } = useSuspenseQuery(connectionsQuery(client));
  const scrollRef = useRef<HTMLDivElement>(null);
  const read = useInbox(client);
  const visitHistory = useVisitHistory();
  const moves = useInboxMoves({
    client,
    scope,
    serverInbox: read.data,
    visit: visitHistory,
    scrollRef,
    // Read when a card arrives or Undo is pressed, long after the carry below has been made.
    isCarrying: () => readIsCarrying(),
    openTask: (taskId) => {
      void navigate({ to: "/work", search: { task: taskId } });
    },
  });
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
  const {
    inbox,
    layout,
    groupings,
    heldArrivals,
    emptiedByMove,
    isWaitingForSunrise,
    freshIds,
    clearFresh,
    announcement,
  } = useInboxVisit({
    step: {
      received: moves.inbox,
      view: { grouping: view.grouping, filter: view.filter, requestsOrder: view.requestsOrder },
      isFresh: hasOwnReply,
      hasUserMove: moves.hasPendingEdits,
    },
    visit: visitHistory,
    scrollRef,
    // Read when a card arrives or Undo is pressed, long after the carry below has been made.
    isCarrying: () => readIsCarrying(),
  });
  const hasWords = inbox !== undefined && !isHolding;
  const isArriving = useFirstArrival(inbox === undefined || read.isFetching, hasWords);

  // The new mark goes when a reply is really shown: its words are in view and no card of it is held back.
  const newestArrival =
    hasWords && heldArrivals.length === 0 ? inbox.counts.newestArrival : undefined;
  useEffect(() => {
    if (newestArrival !== undefined && isVisible) {
      acknowledgeInboxArrival(url, username, newestArrival);
    }
  }, [url, username, newestArrival, isVisible]);

  const empty = inbox === undefined ? null : decideEmptyInbox(inbox, connections, plugins);
  const failingSources = describeFailingSources(connections, plugins);
  const truncated = inbox === undefined ? undefined : describeTruncatedInbox(inbox);

  // ---------- Moves, keys and the open card ----------
  const current = useCurrentCard(scrollRef, clearFresh);
  const openCard = useOpenCard();
  // A card that opens is reached too: its new mark goes.
  const openedId = openCard.shown?.kind === "card" ? openCard.shown.id : undefined;
  useEffect(() => {
    if (openedId !== undefined) clearFresh(openedId);
  }, [openedId, clearFresh]);
  const findCard = (id: string): InboxCard | undefined =>
    inbox?.cards.find((card) => card.id === id);
  const readOffers = (card: InboxCard) =>
    inbox === undefined ? NO_OFFERS : listCardOffers(card, inbox.offerSets);
  const handOffs = { offerSets: inbox?.offerSets ?? NO_OFFER_SETS, handed: moves.handed };
  const seeTask = (card: InboxCard): void => {
    if (card.taskId === undefined) return;
    void navigate({ to: "/work", search: { task: card.taskId } });
  };
  // Dismissing a card lets what rides on it stand alone, and the undo line says so.
  const dismissWithRiders = (card: InboxCard, stepsAside = true): void => {
    moves.dismiss(card, layout === undefined ? [] : listRiders(layout, card.id), stepsAside);
  };
  const linkCards = (fromRef: string, toRef: string): void => {
    if (inbox === undefined) return;
    moves.link({
      fromRef,
      toRef,
      fromName: nameLinkEnd(inbox, fromRef),
      toName: nameLinkEnd(inbox, toRef),
    });
  };
  const [handMenu, setHandMenu] = useState<HandMenuTarget | null>(null);
  // What the open sheet can hand to a workflow, which the sheet keeps up to date and the page's keys read.
  const sheetHand = useRef<HandOffCandidate | null>(null);
  const page = useInboxPage({
    scrollRef,
    current,
    findCard,
    open: openCard,
    sheetHand,
    moves: {
      take: moves.take,
      dismiss: dismissWithRiders,
      seeTask,
      link: linkCards,
      say: moves.sayWithoutUndo,
      readOffers,
      hand: moves.handOff,
      openHandMenu: (card, anchor, by) => {
        setHandMenu({ cardId: card.id, anchor, by });
      },
    },
  });
  const handMenuCard = handMenu === null ? undefined : findCard(handMenu.cardId);

  // ---------- Carrying a card ----------
  const { rail, attachRail, readIsCarrying } = useInboxCarry({
    pageRef: scrollRef,
    disabled: openCard.isOpen,
    canCarry: (cardId) => findCard(cardId) !== undefined,
    readRailTargets: (cardId) => {
      const card = findCard(cardId);
      if (card === undefined) return [];
      return listRailTargets(card, readOffers(card), moves.handed.has(card.id));
    },
    onDropOnTarget: (cardId, target) => {
      const card = findCard(cardId);
      if (card === undefined) return;
      if (target.kind === "hand") page.handCard(card, target.workflowId, undefined, "pointer");
      else if (target.kind === "take") moves.take(card);
      else dismissWithRiders(card, false);
    },
    onDropOnCard: (cardId, ontoCardId) => {
      const card = findCard(cardId);
      const onto = findCard(ontoCardId);
      if (card !== undefined && onto !== undefined) linkCards(card.ref, onto.ref);
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
    body = isWaitingForSunrise ? null : <AllClear isStill={!emptiedByMove.everything} />;
  } else {
    body = (
      <>
        <OngoingSide
          layout={layout}
          plugins={plugins}
          monogram={monogram}
          freshIds={freshIds}
          handOffs={handOffs}
          note={truncated === undefined ? null : <p className="inbox-note">{truncated}</p>}
        />
        <RequestsSide
          layout={layout}
          requestsOrder={view.requestsOrder}
          onOrderChange={view.setRequestsOrder}
          plugins={plugins}
          monogram={monogram}
          freshIds={freshIds}
          handOffs={handOffs}
          isSunriseStill={!emptiedByMove.requests}
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
            platform={bridge.platform}
            onLink={moves.link}
            onUnlink={moves.unlink}
            onSeeInIntake={(entityId) => {
              openCard.close();
              void navigate({ to: "/intake", search: { entity: entityId } });
            }}
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
                  dismissWithRiders(card);
                });
              }
            }}
            handRef={sheetHand}
            onHand={(candidate, workflowId, by) => {
              // By keys the sheet walks on to the next card and the chain plays behind it. By pointer it folds home first.
              if (by === "keys") page.handFromSheet(candidate, workflowId, by);
              else {
                openCard.closeThen(() => {
                  page.handFromSheet(candidate, workflowId, by);
                });
              }
            }}
            onSeeTask={(taskId) => {
              openCard.close();
              void navigate({ to: "/work", search: { task: taskId } });
            }}
          />
          {handMenu !== null && handMenuCard !== undefined && (
            <HandToMenu
              offers={readOffers(handMenuCard)}
              openKinds={handMenuCard.signals.kinds}
              actingConnections={handMenuCard.actingConnections}
              onHand={(workflowId, connectionId) => {
                setHandMenu(null);
                page.handCard(handMenuCard, workflowId, connectionId, handMenu.by);
              }}
              onClose={() => {
                setHandMenu(null);
              }}
              anchor={handMenu.anchor}
            />
          )}
          {rail !== null && <Rail ref={attachRail} targets={rail.targets} monogram={monogram} />}
          {page.isKeysSheetOpen && <KeysSheet rows={KEY_ROWS} platform={bridge.platform} />}
          <UndoLine
            text={moves.line.text}
            onUndo={moves.line.canUndo ? moves.undoLastMove : null}
            action={moves.line.action}
            undoKey={describeUndoKey(bridge.platform)}
            isShown={moves.line.isShown}
          />
        </>
      }
      state={state}
      isHolding={isHolding && inbox !== undefined}
      isArriving={isArriving}
      isOffline={offlineSince !== null}
      announcement={announcement}
      scrollRef={scrollRef}
    >
      {body}
    </InboxDesk>
  );
}
