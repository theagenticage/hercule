import { useEffect, useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  EMPTY_INBOX_SEARCH,
  addInboxClause,
  changeInboxSelection,
  listCardOffers,
  moveInboxCurrent,
  typeInboxSearch,
  type InboxListState,
  type InboxSearch,
} from "@hercule/client-core/inbox";
import type { InboxClause, InboxThing } from "@hercule/contract";
import { acknowledgeInboxArrival } from "../../../app/inbox-arrival";
import { inboxCountQuery, userQuery } from "../../../app/queries";
import { describeUndoKey } from "../../../app/primary-modifier";
import { useOfflineSince } from "../../../app/use-offline-since";
import type { SavedController } from "../../../app/context";
import { KeysSheet, UndoLine } from "../../../screens/desk";
import { InboxFrame } from "../../../screens/inbox/inbox-frame";
import { buildInboxKeyRows, type InboxKeyAction } from "../../../screens/inbox/inbox-keys";
import { focusNextInboxRegion } from "../../../screens/inbox/inbox-regions";
import type { InboxRowActions } from "../../../screens/inbox/inbox-row";
import type { RailEntry, RailFacetScope } from "../../../screens/inbox/inbox-rail";
import type { InboxSearchHandle } from "../../../screens/inbox/inbox-search";
import { InboxOfflinePill, InboxPaneSkeleton } from "../../../screens/inbox/inbox-states";
import { useInboxPaneWidth } from "../../../screens/inbox/use-inbox-pane-width";
import { useInboxClock } from "./-inbox-clock";
import { useHeldInboxList } from "./-inbox-held-list";
import { InboxHandMenuPart } from "./-inbox-hand-part";
import { InboxListPart } from "./-inbox-list-part";
import { useInboxMoves } from "./-inbox-moves";
import { useInboxKeys } from "./-use-inbox-keys";
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
  isSearching,
  nameInboxScope,
} from "./-inbox-scope";

/** The hand-off menu that is open: the thing it hands, and the element it opens under. */
interface HandMenu {
  readonly thing: InboxThing;
  readonly anchor: HTMLElement;
}

/**
 * Renders the Inbox screen: the page frame with its rail, search, list and
 * pane. It owns what the user chose, which is the scope (a saved query or a
 * Browse value), the search over it, and the pane's width and whether the
 * pane lies open over the list. The list itself is the held list
 * (`useHeldInboxList`), and the parts draw it where they read their data.
 *
 * It also holds what the keys and the moves share: the keys (`useInboxKeys`
 * names an action, and `performKey` does it), the moves (`useInboxMoves`) and
 * where the keyboard focus goes after a move.
 */
export function InboxScreen({ controller }: { readonly controller: SavedController }): JSX.Element {
  const { client, live, url } = controller;
  const navigate = useNavigate();
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });
  const counts = useSuspenseQuery(inboxCountQuery(client)).data;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const formatClock = useInboxClock(client);
  const offlineSince = useOfflineSince(live);
  const [scope, setScope] = useState<RailEntry>(DEFAULT_INBOX_SCOPE);
  const [search, setSearch] = useState<InboxSearch>(EMPTY_INBOX_SEARCH);
  const [paneWidth, setPaneWidth] = useInboxPaneWidth();
  const [isPaneOpen, setIsPaneOpen] = useState(false);
  const [isStacked, setIsStacked] = useState(false);
  const [isKeysOpen, setIsKeysOpen] = useState(false);
  const [handMenu, setHandMenu] = useState<HandMenu | null>(null);
  const [listFocusRequest, setListFocusRequest] = useState(0);
  const [headingFocusRequest, setHeadingFocusRequest] = useState(0);
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
  // A pane that lies over the list is the one place the keys work in then, so the focus stays in it.
  const isPaneHoldingFocus = isStacked && isPaneOpen;
  /**
   * Moves the focus after a move: to the new current row, which takes the
   * focus and scrolls into view; to the empty state's heading when nothing is
   * current any more, with the pane stepped aside first.
   */
  const followMove = (next: InboxListState<InboxThing>): void => {
    if (next.rows.length === 0 && next.arrivals.length === 0) {
      setIsPaneOpen(false);
      setHeadingFocusRequest((request) => request + 1);
    } else if (!isPaneHoldingFocus) {
      focusList();
    }
  };
  const moves = useInboxMoves({
    client,
    scope: controller.accountScopes.read(),
    held,
    isOffline: offlineSince !== null,
    openTask: (taskId) => {
      void navigate({ to: "/work", search: { task: taskId } });
    },
    onMoved: followMove,
  });
  const openHandMenu = (thing: InboxThing | null, ref: string): void => {
    if (thing === null) return;
    const row = document.querySelector<HTMLElement>(`.ib-rows [data-ref="${CSS.escape(ref)}"]`);
    const anchor = row?.querySelector<HTMLElement>(".ib-row-act--named") ?? row;
    if (anchor !== null && anchor !== undefined) setHandMenu({ thing, anchor });
  };
  const startHandOff = (ref: string | undefined): void => {
    openHandMenu(moves.startHandOff(ref), ref ?? list?.current ?? "");
  };
  /** Slides the pane away first when it lies over the list, for what is about the list. */
  const clearPaneAway = (): void => {
    if (isPaneHoldingFocus) setIsPaneOpen(false);
  };
  const openScope = (entry: RailEntry): void => {
    setScope(entry);
    setSearch(EMPTY_INBOX_SEARCH);
    setIsPaneOpen(false);
    focusList();
  };
  const performKey = (action: InboxKeyAction): void => {
    switch (action.kind) {
      case "step":
        held.change((state) => moveInboxCurrent(state, { by: action.by, extend: action.extend }));
        if (!isPaneHoldingFocus) focusList();
        return;
      case "toggleSelect":
        if (list?.current != null) {
          const ref = list.current;
          held.change((state) => changeInboxSelection(state, { kind: "toggle", ref }));
        }
        return;
      case "selectAll":
        held.change((state) => changeInboxSelection(state, { kind: "all" }));
        return;
      case "stepBack":
        if (isKeysOpen) setIsKeysOpen(false);
        else if (isPaneHoldingFocus) {
          setIsPaneOpen(false);
          focusList();
        } else if (list !== null && list.selection.size > 0) {
          held.change((state) => changeInboxSelection(state, { kind: "clear" }));
        } else if (isSearching(search)) setSearch(EMPTY_INBOX_SEARCH);
        return;
      case "focusList":
        focusList();
        return;
      case "dismiss":
        moves.dismiss();
        return;
      case "takeOn":
        moves.takeOn();
        return;
      case "handOff":
        startHandOff(undefined);
        return;
      case "goToTask":
        moves.goToTask();
        return;
      case "openAtSource":
        moves.openAtSource();
        return;
      case "showArrivals":
        clearPaneAway();
        held.showArrivals();
        focusList();
        return;
      case "pickList": {
        const query = counts.savedQueries[action.index];
        if (query !== undefined) openScope({ kind: "saved-query", id: query.id });
        return;
      }
      case "search":
        clearPaneAway();
        searchRef.current?.focus();
        return;
      case "narrow":
        clearPaneAway();
        // The list head's own button opens the menu under itself.
        document.querySelector<HTMLElement>(".ib-list .ib-narrow")?.click();
        return;
      case "toggleKeys":
        setIsKeysOpen((isOpen) => !isOpen);
        return;
      case "nextRegion":
        focusNextInboxRegion(action.backwards, { isStacked, isPaneOpen });
        return;
      case "openPane":
        if (isStacked && !isPaneOpen && list?.current != null) setIsPaneOpen(true);
        return;
    }
  };
  useInboxKeys(performKey);
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
    onTakeOn: moves.takeOn,
    onHandOff: (ref) => {
      startHandOff(ref);
    },
    onGoToTask: moves.goToTask,
    onDismiss: moves.dismiss,
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
          isLoading={held.status === "loading"}
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
          readHandedThing={moves.readHandedThing}
          focusRequest={listFocusRequest}
          headingFocusRequest={headingFocusRequest}
          undoLine={
            <UndoLine
              text={moves.line.text}
              title={moves.line.title}
              onUndo={moves.line.canUndo ? moves.undoLastMove : null}
              action={moves.line.action}
              undoKey={describeUndoKey(bridge.platform)}
              isShown={moves.line.isShown}
              onHoldChange={moves.holdLine}
            />
          }
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
            offers={listCardOffers(currentThing, held.offerSets)}
            moves={{
              onTakeOn: () => {
                moves.takeOn();
              },
              onDismiss: () => {
                moves.dismiss();
              },
              onGoToTask: (taskId) => {
                void navigate({ to: "/work", search: { task: taskId } });
              },
              onHandOff: (offer, connectionId) => {
                moves.handOffTarget(offer, connectionId);
              },
              onClose: () => {
                setIsPaneOpen(false);
                focusList();
              },
            }}
          />
        )
      }
      offlinePill={
        offlineSince === null ? null : <InboxOfflinePill sinceLabel={formatClock(offlineSince)} />
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
        currentThing === undefined || currentThing.url === "" ? undefined : moves.openAtSource
      }
      onOpenIntake={() => {
        void navigate({ to: "/intake" });
      }}
      onOpenKeys={() => {
        setIsKeysOpen((isOpen) => !isOpen);
      }}
      isKeysOpen={isKeysOpen}
      onStackedChange={setIsStacked}
      overlays={
        <>
          {isKeysOpen && (
            <KeysSheet rows={buildInboxKeyRows(bridge.platform)} platform={bridge.platform} />
          )}
          {handMenu !== null && (
            <InboxHandMenuPart
              thing={handMenu.thing}
              offers={listCardOffers(handMenu.thing, held.offerSets)}
              anchor={handMenu.anchor}
              onHand={(offer, connectionId) => {
                moves.handOff(handMenu.thing.ref, offer, connectionId);
              }}
              onClose={() => {
                setHandMenu(null);
              }}
            />
          )}
        </>
      }
    />
  );
}
