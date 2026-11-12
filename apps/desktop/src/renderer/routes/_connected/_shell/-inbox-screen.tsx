import { useEffect, useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  EMPTY_INBOX_SEARCH,
  addInboxClause,
  changeInboxSelection,
  moveInboxCurrent,
  typeInboxSearch,
  type InboxSearch,
} from "@hercule/client-core/inbox";
import type { InboxClause } from "@hercule/contract";
import { acknowledgeInboxArrival } from "../../../app/inbox-arrival";
import { inboxCountQuery, userQuery } from "../../../app/queries";
import { useOfflineSince } from "../../../app/use-offline-since";
import type { SavedController } from "../../../app/context";
import { InboxFrame } from "../../../screens/inbox/inbox-frame";
import type { InboxRowActions } from "../../../screens/inbox/inbox-row";
import type { RailEntry, RailFacetScope } from "../../../screens/inbox/inbox-rail";
import type { InboxSearchHandle } from "../../../screens/inbox/inbox-search";
import { InboxOfflinePill, InboxPaneSkeleton } from "../../../screens/inbox/inbox-states";
import { useInboxPaneWidth } from "../../../screens/inbox/use-inbox-pane-width";
import { useHeldInboxList } from "./-inbox-held-list";
import { InboxListPart } from "./-inbox-list-part";
import { InboxPaneHeadPart, InboxPanePart } from "./-inbox-pane-part";
import { InboxRailPart } from "./-inbox-rail-part";
import { InboxSearchPart } from "./-inbox-search-part";
import {
  DEFAULT_INBOX_QUERY_ID,
  DEFAULT_INBOX_SCOPE,
  EVERYTHING_INBOX_SCOPE,
  EVERYTHING_QUERY_ID,
  buildInboxList,
  buildInboxQuery,
  formatInboxClock,
  isSearching,
  nameInboxScope,
} from "./-inbox-scope";

/**
 * The moves of a thing (Take on, hand-off, Dismiss, Go to its Task) come with
 * the screen's keys and moves. Until then their buttons call this and do nothing.
 */
const MOVE_NOT_YET_WIRED = (): void => undefined;

/**
 * Renders the Inbox screen: the page frame with its rail, search, list and
 * pane. It owns what the user chose, which is the scope (a saved query or a
 * Browse value), the search over it, and the pane's width and whether the
 * pane lies open over the list. The list itself is the held list
 * (`useHeldInboxList`), and the parts draw it where they read their data.
 */
export function InboxScreen({ controller }: { readonly controller: SavedController }): JSX.Element {
  const { client, live, url } = controller;
  const navigate = useNavigate();
  const counts = useSuspenseQuery(inboxCountQuery(client)).data;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const offlineSince = useOfflineSince(live);
  const [scope, setScope] = useState<RailEntry>(DEFAULT_INBOX_SCOPE);
  const [search, setSearch] = useState<InboxSearch>(EMPTY_INBOX_SEARCH);
  const [paneWidth, setPaneWidth] = useInboxPaneWidth();
  const [isPaneOpen, setIsPaneOpen] = useState(false);
  const [listFocusRequest, setListFocusRequest] = useState(0);
  const searchRef = useRef<InboxSearchHandle>(null);

  const held = useHeldInboxList(client, buildInboxQuery(scope, search));
  const { list } = held;
  const scopeTitle = nameInboxScope(scope, counts);
  const currentThing = list?.rows.find((row) => row.ref === list.current);

  // What the waits list shows is what the sidebar's dot has been told about.
  const isShowingWaits =
    scope.kind === "saved-query" && scope.id === DEFAULT_INBOX_QUERY_ID && !isSearching(search);
  const isReady = held.status === "ready";
  useEffect(() => {
    if (isShowingWaits && isReady) acknowledgeInboxArrival(url, username, counts.newestArrival);
  }, [isShowingWaits, isReady, url, username, counts.newestArrival]);

  const focusList = (): void => {
    setListFocusRequest((request) => request + 1);
  };
  const openScope = (entry: RailEntry): void => {
    setScope(entry);
    setSearch(EMPTY_INBOX_SEARCH);
    setIsPaneOpen(false);
    focusList();
  };
  const rowActions: InboxRowActions = {
    onPick: (ref, modifiers) => {
      held.change((state) =>
        modifiers.shiftKey
          ? changeInboxSelection(state, { kind: "extendTo", ref })
          : modifiers.metaKey || modifiers.ctrlKey
            ? changeInboxSelection(state, { kind: "toggle", ref })
            : moveInboxCurrent(state, { to: ref }),
      );
      setIsPaneOpen(true);
    },
    onToggleSelect: (ref) => {
      held.change((state) => changeInboxSelection(state, { kind: "toggle", ref }));
    },
    onTakeOn: MOVE_NOT_YET_WIRED,
    onHandOff: MOVE_NOT_YET_WIRED,
    onGoToTask: MOVE_NOT_YET_WIRED,
    onDismiss: MOVE_NOT_YET_WIRED,
  };
  const searchMore = (facet: RailFacetScope): void => {
    setSearch(
      typeInboxSearch(EMPTY_INBOX_SEARCH, `${facet.key}:`, {
        fields: counts.fields,
        suggestedValues: {},
      }),
    );
    searchRef.current?.focus();
  };
  const widen = (): void => {
    setScope(EVERYTHING_INBOX_SCOPE);
  };
  const resultsText =
    isSearching(search) && held.total !== undefined
      ? `${String(held.total)} ${held.total === 1 ? "thing matches" : "things match"} in ${scopeTitle}.`
      : "";

  return (
    <InboxFrame
      rail={
        <InboxRailPart
          client={client}
          current={isSearching(search) ? null : scope}
          onPick={openScope}
          onSearchMore={searchMore}
        />
      }
      scopeName={scopeTitle}
      search={
        <InboxSearchPart
          ref={searchRef}
          client={client}
          list={buildInboxList(scope)}
          scopeTitle={scopeTitle}
          isScopeEverything={scope.kind === "saved-query" && scope.id === EVERYTHING_QUERY_ID}
          search={search}
          resultsText={resultsText}
          onChange={setSearch}
          onWiden={widen}
          onLeaveToResults={focusList}
          onLeave={focusList}
        />
      }
      listHead={null}
      list={
        <InboxListPart
          client={client}
          held={held}
          scope={scope}
          scopeTitle={scopeTitle}
          search={search}
          rowActions={rowActions}
          focusRequest={listFocusRequest}
          onNarrowPick={(clause: InboxClause) => {
            setSearch((before) => addInboxClause(before, clause));
          }}
          onOpenScope={openScope}
          onSearchEverything={widen}
          onClearSearch={() => {
            setSearch(EMPTY_INBOX_SEARCH);
          }}
        />
      }
      paneHead={
        currentThing === undefined ? null : (
          <InboxPaneHeadPart client={client} thing={currentThing} />
        )
      }
      pane={
        currentThing === undefined ? (
          held.status === "loading" ? (
            <InboxPaneSkeleton />
          ) : null
        ) : (
          <InboxPanePart
            key={currentThing.id}
            client={client}
            thing={currentThing}
            moves={{
              onTakeOn: MOVE_NOT_YET_WIRED,
              onDismiss: MOVE_NOT_YET_WIRED,
              onGoToTask: MOVE_NOT_YET_WIRED,
              onClose: () => {
                setIsPaneOpen(false);
                focusList();
              },
            }}
          />
        )
      }
      offlinePill={
        offlineSince === null ? null : (
          <InboxOfflinePill sinceLabel={formatInboxClock(offlineSince)} />
        )
      }
      isPaneShown={currentThing !== undefined || held.status === "loading"}
      isPaneOpen={isPaneOpen}
      paneWidth={paneWidth}
      onPaneWidthChange={setPaneWidth}
      onClosePane={() => {
        setIsPaneOpen(false);
        focusList();
      }}
      onOpenAtSource={
        currentThing === undefined || currentThing.url === ""
          ? undefined
          : () => {
              window.open(currentThing.url, "_blank", "noreferrer");
            }
      }
      onOpenIntake={() => {
        void navigate({ to: "/intake" });
      }}
      onOpenKeys={MOVE_NOT_YET_WIRED}
      isKeysOpen={false}
    />
  );
}
