import { useEffect, useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import {
  buildInboxFacets,
  decideEmptyInbox,
  describeFailingSources,
  describeTruncatedInbox,
  HOME_GROUPING,
  layOutInbox,
  listInboxGroupings,
  type InboxGrouping,
} from "@hercule/client-core/inbox";
import type { SavedController } from "../../../app/context";
import { acknowledgeInboxArrival } from "../../../app/inbox-arrival";
import { connectionsQuery, pluginsQuery, userQuery } from "../../../app/queries";
import { useOfflineSince } from "../../../app/use-offline-since";
import { useWindowVisible } from "../../../app/window-visibility";
import { InboxDesk, type InboxDeskState } from "../../../screens/inbox/inbox-desk";
import { InboxLoading } from "../../../screens/inbox/inbox-loading";
import { InboxPill } from "../../../screens/inbox/inbox-pill";
import { AllClear, FirstRun, ReadFailure } from "../../../screens/inbox/inbox-states";
import { InboxToolbar } from "../../../screens/inbox/inbox-toolbar";
import { buildInboxViewKey } from "../../../screens/inbox/inbox-view-storage";
import { OngoingSide } from "../../../screens/inbox/ongoing-side";
import { RequestsSide } from "../../../screens/inbox/requests-side";
import { useHeldSides } from "../../../screens/inbox/use-held-sides";
import { useInboxView } from "../../../screens/inbox/use-inbox-view";
import { useInbox } from "./-inbox-read";

/** How long the first read's words take to fade in, which is when the screen stops marking the page as arriving. */
const ARRIVAL_MS = 1_200;

/** The Group by menu of a page that has not been read: Place alone, so the toolbar keeps its shape. */
const GROUPINGS_BEFORE_READ: readonly InboxGrouping[] = [{ id: HOME_GROUPING, name: "Place" }];

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
 */
export function InboxScreen({ controller }: { readonly controller: SavedController }): JSX.Element {
  const { client, url, live } = controller;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { data: connections } = useSuspenseQuery(connectionsQuery(client));
  const read = useInbox(client);
  const inbox = read.data;
  const isVisible = useWindowVisible();
  const offlineSince = useOfflineSince(live);
  const view = useInboxView(buildInboxViewKey(url, username));
  const heldSides = useHeldSides(inbox);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The words of the last visit's cards wait while this visit's read is on its way.
  const [isHolding, setIsHolding] = useState(read.isFetching);
  if (isHolding && !read.isFetching) setIsHolding(false);
  const [startedWithoutWords] = useState(inbox === undefined || read.isFetching);
  const [arrivalOver, setArrivalOver] = useState(false);
  const hasWords = inbox !== undefined && !isHolding;
  useEffect(() => {
    if (!startedWithoutWords || !hasWords) return;
    const timer = setTimeout(() => {
      setArrivalOver(true);
    }, ARRIVAL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [startedWithoutWords, hasWords]);

  // The new mark goes when a reply is really shown.
  const newestArrival = inbox?.counts.newestArrival;
  useEffect(() => {
    if (newestArrival !== undefined && isVisible) {
      acknowledgeInboxArrival(url, username, newestArrival);
    }
  }, [url, username, newestArrival, isVisible]);

  const layout =
    inbox === undefined
      ? undefined
      : layOutInbox(inbox, {
          grouping: view.grouping,
          filter: view.filter,
          requestsOrder: view.requestsOrder,
          heldSides,
        });
  const empty = inbox === undefined ? null : decideEmptyInbox(inbox, connections, plugins);
  const failingSources = describeFailingSources(connections, plugins);
  const truncated = inbox === undefined ? undefined : describeTruncatedInbox(inbox);

  let state: InboxDeskState = "board";
  let body: JSX.Element;
  if (inbox === undefined || layout === undefined) {
    state = "loading";
    body = read.isError ? (
      <ReadFailure
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
    body = <AllClear isStill />;
  } else {
    body = (
      <>
        <OngoingSide
          layout={layout}
          plugins={plugins}
          note={truncated === undefined ? null : <p className="inbox-note">{truncated}</p>}
        />
        <RequestsSide
          layout={layout}
          requestsOrder={view.requestsOrder}
          onOrderChange={view.setRequestsOrder}
          plugins={plugins}
        />
      </>
    );
  }

  const notice =
    offlineSince !== null ? (
      <div className="inbox-notice" role="status">
        <i className="notice-dot" />
        <span>{describeOffline(offlineSince)}</span>
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
          groupings={inbox === undefined ? GROUPINGS_BEFORE_READ : listInboxGroupings(inbox)}
          grouping={layout?.grouping ?? view.grouping}
          onGroupingChange={view.setGrouping}
          facets={inbox === undefined ? [] : buildInboxFacets(inbox)}
          filter={view.filter}
          cards={inbox?.cards ?? []}
          onFilterChange={view.setFilter}
          plugins={plugins}
          showsControls={empty === null}
          notice={notice}
          end={null}
        />
      }
      overlays={null}
      state={state}
      isHolding={isHolding && inbox !== undefined}
      isArriving={startedWithoutWords && hasWords && !arrivalOver}
      isOffline={offlineSince !== null}
      scrollRef={scrollRef}
    >
      {body}
    </InboxDesk>
  );
}
