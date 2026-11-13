import { useEffect, useRef, useState, type JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { namePlugin } from "@hercule/client-core";
import {
  EMPTY_INBOX_SEARCH,
  addInboxClause,
  nameInboxScope,
  typeInboxSearch,
  type InboxScope,
  type InboxSearch,
} from "@hercule/client-core/inbox";
import type { InboxClause } from "@hercule/contract";
import { acknowledgeInboxArrival } from "../../../app/inbox-arrival";
import { WORKFLOW_TOPICS, useScreenTopicsLive } from "../../../app/live";
import { useQuietValue } from "../../../app/use-quiet-value";
import { inboxCountQuery, inboxOutlineQuery, pluginsQuery, userQuery } from "../../../app/queries";
import { describeUndoKey } from "../../../app/primary-modifier";
import { useOfflineSince } from "../../../app/use-offline-since";
import type { SavedController } from "../../../app/context";
import { KeysSheet, UndoLine } from "../../../screens/desk";
import { InboxFrame } from "../../../screens/inbox/inbox-frame";
import { INBOX_PANE_ID } from "../../../screens/inbox/inbox-pane-frame";
import { buildInboxKeyRows, type InboxKeyAction } from "../../../screens/inbox/inbox-keys";
import { focusNextInboxRegion } from "../../../screens/inbox/inbox-regions";
import type { InboxRowActions } from "../../../screens/inbox/inbox-row";
import type { InboxListHandle } from "../../../screens/inbox/inbox-list";
import type { RailFacetScope } from "../../../screens/inbox/inbox-rail";
import type { InboxSearchHandle } from "../../../screens/inbox/inbox-search";
import { InboxOfflinePill, InboxPaneSkeleton } from "../../../screens/inbox/inbox-states";
import { useInboxPaneWidth } from "../../../screens/inbox/use-inbox-pane-width";
import { useInboxClock } from "./-inbox-clock";
import { useInboxVisit, type InboxListRow } from "./-inbox-visit";
import { InboxHandMenuPart } from "./-inbox-hand-part";
import { InboxListPart } from "./-inbox-list-part";
import { useInboxAnswers } from "./-inbox-answers";
import { useInboxMoves } from "./-inbox-moves";
import { useInboxKeys } from "./-use-inbox-keys";
import { InboxPaneHeadPart, InboxPanePart, type InboxPaneHandle } from "./-inbox-pane-part";
import { InboxRailPart } from "./-inbox-rail-part";
import { InboxSearchPart, type SearchTie } from "./-inbox-search-part";
import {
  DEFAULT_INBOX_QUERY_ID,
  EVERYTHING_INBOX_SCOPE,
  EVERYTHING_QUERY_ID,
  buildInboxList,
  buildInboxSelection,
  buildInboxScopeParams,
  isSearching,
  type InboxNarrowing,
} from "./-inbox-scope";

/** How long typing in the search stops before the list reads for it, in milliseconds. */
const SEARCH_QUIET_MS = 200;

const NO_KINDS: readonly string[] = [];

/** The hand-off menu that is open: the thing it hands, and the element it opens under. */
interface HandMenu {
  readonly thing: InboxListRow;
  readonly anchor: HTMLElement;
}

/**
 * Renders the Inbox screen: the page frame with its rail, search, list and
 * pane. It owns what the user chose: the search over the scope, the pane's
 * width and whether the pane lies open over the list. The scope (a saved
 * query or a Browse value) is the route's, read from the URL and given as
 * `scope`, and picking another navigates to it. The list itself is the visit
 * (`useInboxVisit`), and the parts draw it where they read their data.
 *
 * The list reads for the search only after typing has paused, so a word typed
 * at speed sends one read and not one for each letter.
 *
 * It also holds what the keys and the moves share: the keys (`useInboxKeys`
 * names an action, and `performKey` does it), the moves (`useInboxMoves`) and
 * where the keyboard focus goes after a move.
 */
export function InboxScreen({
  controller,
  scope,
}: {
  readonly controller: SavedController;
  readonly scope: InboxScope;
}): JSX.Element {
  const { client, live, url } = controller;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The workflows' pushes change who has a thing, which the rows say.
  useScreenTopicsLive(live, queryClient, WORKFLOW_TOPICS);
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });
  const outline = useSuspenseQuery(inboxOutlineQuery(client)).data;
  const { newestArrival } = useSuspenseQuery(inboxCountQuery(client)).data;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const formatClock = useInboxClock(client);
  const offlineSince = useOfflineSince(live);
  const [search, setSearch] = useState<InboxSearch>(EMPTY_INBOX_SEARCH);
  // The source and account a "Search the other N" row tied the clause being typed to.
  const [searchTie, setSearchTie] = useState<SearchTie | null>(null);
  const [paneWidth, setPaneWidth] = useInboxPaneWidth();
  const [isPaneOpen, setIsPaneOpen] = useState(false);
  const [isStacked, setIsStacked] = useState(false);
  const [isKeysOpen, setIsKeysOpen] = useState(false);
  const [isNarrowOpen, setIsNarrowOpen] = useState(false);
  const [handMenu, setHandMenu] = useState<HandMenu | null>(null);
  const [listFocusRequest, setListFocusRequest] = useState(0);
  const [headingFocusRequest, setHeadingFocusRequest] = useState(0);
  const searchRef = useRef<InboxSearchHandle>(null);
  const listRef = useRef<InboxListHandle>(null);
  const paneRef = useRef<InboxPaneHandle>(null);

  // The field shows every letter at once, but the list reads for the text that has held still.
  const quietText = useQuietValue(search.text, SEARCH_QUIET_MS);
  const searched: InboxNarrowing = {
    clauses: search.clauses,
    text: search.text.trim() === "" ? "" : quietText,
  };
  const { visit, snapshot } = useInboxVisit(client, buildInboxSelection(scope, searched));
  const isReady = snapshot.status === "ready";
  const scopeTitle = nameInboxScope(scope, outline);
  const currentThing = isReady
    ? snapshot.rows.find((row) => row.ref === snapshot.current)
    : undefined;
  // Two or more selected things, or one that is not the current row, show the pane of the selection.
  const selectedRows = isReady
    ? snapshot.rows.filter((row) => snapshot.selection.has(row.ref))
    : [];
  const isShowingSelection =
    selectedRows.length >= 2 ||
    (selectedRows.length === 1 && selectedRows[0]!.ref !== snapshot.current);
  // The ask of the saved query's kind unfolds first; a search or a Browse value has no kind.
  const savedQueryKinds =
    scope.kind === "saved-query" && !isSearching(searched)
      ? (outline.savedQueries.find((query) => query.id === scope.id)?.signalKinds ?? [])
      : NO_KINDS;

  // What the waits list shows is what the sidebar's dot has been told about.
  const isShowingWaits =
    scope.kind === "saved-query" && scope.id === DEFAULT_INBOX_QUERY_ID && !isSearching(searched);
  useEffect(() => {
    if (isShowingWaits && isReady) acknowledgeInboxArrival(url, username, newestArrival);
  }, [isShowingWaits, isReady, url, username, newestArrival]);

  const focusList = (): void => {
    setListFocusRequest((request) => request + 1);
  };
  const isPaneVisible = !isStacked || isPaneOpen;
  // A pane that lies over the list is the one place the keys work in then, so the focus stays in it.
  const isPaneHoldingFocus = isStacked && isPaneOpen;
  /**
   * Moves the focus after a move: to the new current row, which takes the
   * focus and scrolls into view; to the empty state's heading when nothing is
   * current any more, with the pane stepped aside first.
   */
  const followMove = (next: { readonly rows: ReadonlyArray<InboxListRow> }): void => {
    if (next.rows.length === 0) {
      setIsPaneOpen(false);
      setHeadingFocusRequest((request) => request + 1);
    } else if (!isPaneHoldingFocus) {
      focusList();
    }
  };
  const accountScope = controller.accountScopes.read();
  const moves = useInboxMoves({
    client,
    scope: accountScope,
    visit,
    isOffline: offlineSince !== null,
    openTask: (taskId) => {
      void navigate({ to: "/work", search: { task: taskId } });
    },
    onMoved: followMove,
  });
  const answers = useInboxAnswers({
    client,
    scope: accountScope,
    visit,
    moves,
    isOffline: offlineSince !== null,
  });
  // A hand-off from the keys or the pane's own button opens its menu under the pane's button while the pane shows.
  const openHandMenu = (thing: InboxListRow | null, ref: string | undefined): void => {
    if (thing === null) return;
    const paneAnchor =
      ref === undefined && isPaneVisible
        ? document.getElementById(INBOX_PANE_ID)?.querySelector<HTMLElement>("[data-hand-anchor]")
        : null;
    const anchor = paneAnchor ?? listRef.current?.findHandAnchor(ref ?? snapshot.current ?? "");
    if (anchor !== null && anchor !== undefined) setHandMenu({ thing, anchor });
  };
  const startHandOff = (ref: string | undefined): void => {
    openHandMenu(moves.startHandOff(ref), ref);
  };
  /** Slides the pane away first when it lies over the list, for what is about the list. */
  const slidePaneAside = (): void => {
    if (isPaneHoldingFocus) setIsPaneOpen(false);
  };
  /** Takes in what arrived, which is what both the `.` key and the "N new" pill do. */
  const showNew = (): void => {
    slidePaneAside();
    visit.show();
    focusList();
  };
  const openScope = (entry: InboxScope): void => {
    void navigate({ to: "/inbox", search: buildInboxScopeParams(entry), replace: true });
    setSearch(EMPTY_INBOX_SEARCH);
    setIsPaneOpen(false);
    setIsNarrowOpen(false);
    focusList();
  };
  const performKey = (action: InboxKeyAction): void => {
    switch (action.kind) {
      case "step":
        visit.step(action.by, action.extend);
        if (!isPaneHoldingFocus) focusList();
        return;
      case "toggleSelect":
        if (snapshot.current !== null) visit.select({ kind: "toggle", ref: snapshot.current });
        return;
      case "selectAll":
        visit.select({ kind: "all" });
        return;
      case "stepBack":
        if (isKeysOpen) setIsKeysOpen(false);
        else if (isPaneHoldingFocus) {
          setIsPaneOpen(false);
          focusList();
        } else if (isReady && snapshot.selection.size > 0) {
          visit.select({ kind: "clear" });
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
        showNew();
        return;
      case "pickList": {
        const query = outline.savedQueries[action.index];
        if (query !== undefined) openScope({ kind: "saved-query", id: query.id });
        return;
      }
      case "search":
        slidePaneAside();
        searchRef.current?.focus();
        return;
      case "narrow":
        slidePaneAside();
        // The list head hides Narrow while the list holds nothing, and so does the key.
        if (isReady && (snapshot.rows.length > 0 || snapshot.arrivals > 0)) {
          setIsNarrowOpen((isOpen) => !isOpen);
        }
        return;
      case "toggleKeys":
        setIsKeysOpen((isOpen) => !isOpen);
        return;
      case "nextRegion":
        focusNextInboxRegion(action.backwards, { isStacked, isPaneOpen });
        return;
      case "activate":
        if (isStacked && !isPaneOpen) {
          if (isReady && snapshot.current !== null) setIsPaneOpen(true);
        } else paneRef.current?.answerCurrentAsk();
        return;
      case "stepAsk":
        paneRef.current?.stepAsk(action.by);
        return;
      case "scrollPane":
        paneRef.current?.scrollPage(action.back);
        return;
    }
  };
  useInboxKeys(performKey);
  const rowActions: InboxRowActions = {
    onPick: (ref, modifiers) => {
      visit.select(
        modifiers.shiftKey
          ? { kind: "extendTo", ref }
          : modifiers.metaKey || modifiers.ctrlKey
            ? { kind: "toggle", ref }
            : { kind: "focus", ref },
      );
      setIsPaneOpen(true);
    },
    onToggleSelect: (ref) => {
      visit.select({ kind: "toggle", ref });
    },
    onTakeOn: moves.takeOn,
    onHandOff: (ref) => {
      startHandOff(ref);
    },
    onGoToTask: moves.goToTask,
    onDismiss: moves.dismiss,
  };
  /**
   * Starts a search in Everything for a value of the facet that the rail does
   * not list. The clause being typed keeps the facet's source and account, so
   * its suggestions and its results come from that account only.
   */
  const searchMore = (facet: RailFacetScope): void => {
    const tie = {
      key: facet.key,
      source: facet.source,
      ...(facet.connectionId === undefined ? {} : { connectionId: facet.connectionId }),
    };
    setSearchTie(tie);
    setSearch(
      typeInboxSearch(EMPTY_INBOX_SEARCH, `${facet.key}:`, {
        fields: outline.fields,
        suggestedValues: {},
        tie,
      }),
    );
    widenToEverything();
    searchRef.current?.focus();
  };
  const widenToEverything = (): void => {
    void navigate({
      to: "/inbox",
      search: buildInboxScopeParams(EVERYTHING_INBOX_SCOPE),
      replace: true,
    });
  };
  const resultsText =
    isSearching(searched) && snapshot.total !== undefined
      ? `${String(snapshot.total)} ${snapshot.total === 1 ? "thing matches" : "things match"} in ${scopeTitle}.`
      : "";

  return (
    <InboxFrame
      rail={
        <InboxRailPart
          client={client}
          current={isSearching(search) ? null : scope}
          isLoading={snapshot.status === "loading"}
          onPick={openScope}
          onSearchMore={searchMore}
          onSaveFailed={moves.say}
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
          tie={searchTie}
          onChange={(next) => {
            setSearch(next);
            // The tie ends with the clause it was made for.
            if (next.open?.key !== searchTie?.key) setSearchTie(null);
          }}
          onWiden={widenToEverything}
          onLeaveToResults={focusList}
          onLeave={focusList}
        />
      }
      list={
        <InboxListPart
          client={client}
          snapshot={snapshot}
          visit={visit}
          scope={scope}
          scopeTitle={scopeTitle}
          search={searched}
          rowActions={rowActions}
          focusRequest={listFocusRequest}
          headingFocusRequest={headingFocusRequest}
          isNarrowOpen={isNarrowOpen}
          ref={listRef}
          onNarrowOpenChange={setIsNarrowOpen}
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
          onShowNew={showNew}
          onOpenScope={openScope}
          onSearchEverything={widenToEverything}
          onClearSearch={() => {
            setSearch(EMPTY_INBOX_SEARCH);
          }}
        />
      }
      paneHead={
        currentThing === undefined ? null : (
          <InboxPaneHeadPart
            client={client}
            thing={currentThing}
            selection={isShowingSelection ? selectedRows : null}
          />
        )
      }
      pane={
        currentThing === undefined ? (
          snapshot.status === "loading" ? (
            <InboxPaneSkeleton />
          ) : null
        ) : (
          <InboxPanePart
            ref={paneRef}
            client={client}
            scope={accountScope}
            thing={currentThing}
            selection={isShowingSelection ? selectedRows : null}
            order={snapshot.order ?? "waiting"}
            isActive={isPaneVisible}
            isHandMenuOpen={handMenu !== null}
            savedQueryKinds={savedQueryKinds}
            answers={answers}
            moves={{
              onTakeOn: () => {
                moves.takeOn();
              },
              onDismiss: () => {
                moves.dismiss();
              },
              onGoToTask: () => {
                moves.goToTask();
              },
              onGoTo: (ref) => {
                if (snapshot.rows.some((row) => row.ref === ref)) {
                  visit.select({ kind: "focus", ref });
                } else moves.say("That thing is not in this list.");
              },
              onHandOff: () => {
                startHandOff(undefined);
              },
            }}
            onWalk={(ref) => {
              visit.select({ kind: "focus", ref });
            }}
            onDismissSelection={() => {
              moves.dismiss();
            }}
          />
        )
      }
      offlinePill={
        offlineSince === null ? null : <InboxOfflinePill sinceLabel={formatClock(offlineSince)} />
      }
      isPaneShown={currentThing !== undefined || snapshot.status === "loading"}
      isPaneOpen={isPaneOpen}
      paneWidth={paneWidth}
      onPaneWidthChange={setPaneWidth}
      onClosePane={() => {
        setIsPaneOpen(false);
        focusList();
      }}
      onOpenAtSource={
        currentThing === undefined || currentThing.url === "" || isShowingSelection
          ? undefined
          : moves.openAtSource
      }
      openAtSourceWords={
        currentThing === undefined || isShowingSelection
          ? undefined
          : `Open on ${namePlugin(currentThing.source, plugins)}`
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
              offers={handMenu.thing.offers}
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
