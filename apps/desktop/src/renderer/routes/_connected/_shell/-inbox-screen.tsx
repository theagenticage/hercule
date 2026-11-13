import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { namePlugin } from "@hercule/client-core";
import {
  EMPTY_INBOX_SEARCH,
  NO_LINE_TO_LINK_FROM,
  OPEN_AT_SOURCE_NEEDS_ONE_THING,
  THING_NOT_IN_LIST,
  addInboxClause,
  decideInboxActivation,
  findPaneSubject,
  nameInboxScope,
  planInboxDrop,
  typeInboxSearch,
  type InboxLinkEnd,
  type InboxLinkPick,
  type InboxScope,
  type InboxSearch,
} from "@hercule/client-core/inbox";
import type { InboxClause } from "@hercule/contract";
import { acknowledgeInboxArrival } from "../../../app/inbox-arrival";
import { WORKFLOW_TOPICS, useScreenTopicsLive } from "../../../app/live";
import { useQuietValue } from "../../../app/use-quiet-value";
import { useStableCallback } from "../../../app/use-stable-callback";
import { inboxCountQuery, inboxOutlineQuery, pluginsQuery, userQuery } from "../../../app/queries";
import { describeUndoKey } from "../../../app/primary-modifier";
import { useOfflineSince } from "../../../app/use-offline-since";
import type { SavedController } from "../../../app/context";
import { KeysSheet, UndoLine } from "../../../screens/desk";
import { InboxFrame } from "../../../screens/inbox/inbox-frame";
import type { InboxClickModifiers } from "../../../screens/inbox/inbox-row";
import { buildInboxKeyRows, type InboxKeyAction } from "../../../screens/inbox/inbox-keys";
import { focusNextInboxRegion } from "../../../screens/inbox/inbox-regions";
import type { InboxListActions, InboxListHandle } from "../../../screens/inbox/inbox-list";
import type { RailFacetScope } from "../../../screens/inbox/inbox-rail";
import type { InboxSearchHandle } from "../../../screens/inbox/inbox-search";
import { InboxOfflinePill, InboxPaneSkeleton } from "../../../screens/inbox/inbox-states";
import { useInboxPaneWidth } from "../../../screens/inbox/use-inbox-pane-width";
import { useInboxClock } from "./-inbox-clock";
import { useInboxVisit, type InboxListRow } from "./-inbox-visit";
import { InboxHandMenuPart } from "./-inbox-hand-part";
import { InboxListPart } from "./-inbox-list-part";
import { useInboxAnswers } from "./-inbox-answers";
import {
  InboxGroupHeadPart,
  InboxGroupPanePart,
  type InboxGroupPaneMoves,
} from "./-inbox-group-pane-part";
import { InboxLinkToPart } from "./-inbox-link-to-part";
import { useInboxMoves } from "./-inbox-moves";
import { useInboxKeys } from "./-use-inbox-keys";
import {
  InboxPaneHeadPart,
  InboxPanePart,
  type InboxPaneHandle,
  type InboxPaneMoves,
} from "./-inbox-pane-part";
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

/** "Link to..." while it is open: what it links from, and the element it opens under. */
interface LinkMenu {
  readonly pick: InboxLinkPick;
  readonly anchor: HTMLElement;
}

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
  const [linkMenu, setLinkMenu] = useState<LinkMenu | null>(null);
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
  const rowsByRef = useMemo(
    () => new Map(snapshot.rows.map((row) => [row.ref, row])),
    [snapshot.rows],
  );
  const paneSubject = findPaneSubject(snapshot);
  const isShowingSelection = paneSubject.kind === "selection";
  const paneSelection = paneSubject.kind === "selection" ? paneSubject.rows : null;
  // The thing the pane is about. The pane of a selection is drawn around one thing too.
  const paneThing =
    paneSubject.kind === "thing" || paneSubject.kind === "selection"
      ? paneSubject.thing
      : undefined;
  const currentGroupMember = paneSubject.kind === "group" ? paneSubject.labelRef : undefined;
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
  /** Makes `ref` the one thing the pane shows: ends a selection, opens the group that holds it, and slides the pane over the list when it lies closed. */
  const showThing = (ref: string): void => {
    visit.select({ kind: "clear" });
    visit.reveal(ref);
    setIsPaneOpen(true);
  };
  const answers = useInboxAnswers({
    client,
    scope: accountScope,
    visit,
    moves,
    isOffline: offlineSince !== null,
    showThing,
  });
  // A hand-off from the keys or the pane's own button opens its menu under the pane's button while the pane shows.
  const openHandMenu = (thing: InboxListRow | null, ref: string | undefined): void => {
    if (thing === null) return;
    const paneAnchor =
      ref === undefined && isPaneVisible ? paneRef.current?.findHandAnchor() : null;
    const anchor = paneAnchor ?? listRef.current?.findHandAnchor(ref ?? snapshot.current ?? "");
    if (anchor !== null && anchor !== undefined) setHandMenu({ thing, anchor });
  };
  const startHandOff = (ref: string | undefined): void => {
    openHandMenu(moves.startHandOff(ref), ref);
  };
  /**
   * Opens "Link to..." under the line the pick names (`anchorKey`), whether
   * the keys or the pane's Link button asked for it. The line is scrolled into
   * view first (it may be far from the view, and then not drawn), so the
   * popover has a line to sit under. When the list draws no such line, the
   * undo line says so.
   */
  const openLinkMenu = (pick: InboxLinkPick | null): void => {
    if (pick === null) return;
    void listRef.current?.revealLine(pick.anchorKey).then((anchor) => {
      if (anchor === null) moves.say(NO_LINE_TO_LINK_FROM);
      else setLinkMenu({ pick, anchor });
    });
  };
  const startLink = (ref: string | undefined): void => {
    openLinkMenu(moves.startLink(ref));
  };
  /**
   * Makes the line of `ref` current so the pane and the keys follow it, opening
   * the group that holds it (and its "Show N more") when it is not drawn.
   * Says so when the list does not hold the thing.
   */
  const walkTo = (ref: string): void => {
    if (!visit.reveal(ref)) moves.say(THING_NOT_IN_LIST);
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
  /** Does what Return does on the current line (see `decideInboxActivation`). */
  const activate = (): void => {
    switch (decideInboxActivation(snapshot, isStacked && !isPaneOpen)) {
      case "openGroup":
        visit.fold({ kind: "open" });
        return;
      case "showMore":
        visit.fold({ kind: "showMore" });
        return;
      case "showPane":
        setIsPaneOpen(true);
        return;
      case "answerAsk":
        paneRef.current?.answerCurrentAsk();
        return;
      case "none":
        return;
    }
  };
  const performKey = (action: InboxKeyAction): void => {
    switch (action.kind) {
      case "step":
        visit.step(action.by, action.extend);
        if (!isPaneHoldingFocus) focusList();
        return;
      case "toggleSelect":
        if (snapshot.current !== null) {
          visit.select({ kind: "toggle", ref: snapshot.current, whole: action.whole });
        }
        return;
      case "fold":
        visit.fold({ kind: action.fold });
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
      case "link":
        startLink(undefined);
        return;
      case "openAtSource":
        // The pane shows the selection, not the current row, so O would open a thing the user is not looking at.
        if (isShowingSelection) {
          moves.say(OPEN_AT_SOURCE_NEEDS_ONE_THING);
        } else moves.openAtSource();
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
        activate();
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
  // The pane's callbacks keep their identity, so a render of the screen that changed nothing in the pane leaves it alone.
  const takeOnInPane = useStableCallback(() => {
    moves.takeOn();
  });
  const dismissInPane = useStableCallback(() => {
    moves.dismiss();
  });
  const goToTaskInPane = useStableCallback(() => {
    moves.goToTask();
  });
  const goToInPane = useStableCallback((ref: string) => {
    walkTo(ref);
  });
  const handOffInPane = useStableCallback(() => {
    startHandOff(undefined);
  });
  const walkInPane = useStableCallback(showThing);
  const linkInPane = useStableCallback(() => {
    startLink(undefined);
  });
  const unlinkInPane = useStableCallback((first: InboxLinkEnd, second: InboxLinkEnd) => {
    moves.unlink(first, second);
  });
  const paneMoves: InboxPaneMoves = {
    onTakeOn: takeOnInPane,
    onDismiss: dismissInPane,
    onGoToTask: goToTaskInPane,
    onGoTo: goToInPane,
    onHandOff: handOffInPane,
    onLink: linkInPane,
  };
  const groupPaneMoves: InboxGroupPaneMoves = {
    onWalkTo: walkInPane,
    onUnlink: unlinkInPane,
    onTakeOn: takeOnInPane,
    onLink: linkInPane,
    onDismiss: dismissInPane,
  };
  /** A click on a line of the list (a thing's row or a group's head): Shift extends the selection, Command or Control toggles the line in it, else the line becomes current. */
  const pickLine = (key: string, modifiers: InboxClickModifiers): void => {
    visit.select(
      modifiers.shiftKey
        ? { kind: "extendTo", ref: key }
        : modifiers.metaKey || modifiers.ctrlKey
          ? { kind: "toggle", ref: key }
          : { kind: "focus", ref: key },
    );
    setIsPaneOpen(true);
  };
  const rowActions: InboxListActions = {
    onPick: pickLine,
    onToggleSelect: (ref) => {
      visit.select({ kind: "toggle", ref });
    },
    onTakeOn: moves.takeOn,
    onHandOff: (ref) => {
      startHandOff(ref);
    },
    onGoToTask: moves.goToTask,
    onDismiss: moves.dismiss,
    onPickGroup: pickLine,
    onToggleGroupSelect: (key, whole) => {
      visit.select({ kind: "toggle", ref: key, whole });
    },
    onToggleGroupOpen: (key) => {
      visit.fold({ kind: "toggle", key });
    },
    onShowMore: (key) => {
      visit.fold({ kind: "showMore", key });
    },
    onLinkThings: async (carriedKey, targetKey) => {
      const plan = planInboxDrop(visit.getSnapshot().entries, carriedKey, targetKey);
      if (plan?.kind === "refuse") moves.say(plan.reason);
      return plan?.kind === "link" && (await moves.linkTo(plan.from, plan.to));
    },
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
        paneThing === undefined ? (
          currentGroupMember === undefined ? null : (
            <InboxGroupHeadPart
              client={client}
              memberRef={currentGroupMember}
              isActive={isPaneVisible}
            />
          )
        ) : (
          <InboxPaneHeadPart client={client} thing={paneThing} selection={paneSelection} />
        )
      }
      pane={
        paneThing === undefined ? (
          currentGroupMember !== undefined ? (
            <InboxGroupPanePart
              client={client}
              memberRef={currentGroupMember}
              rows={rowsByRef}
              isActive={isPaneVisible}
              moves={groupPaneMoves}
            />
          ) : snapshot.status === "loading" ? (
            <InboxPaneSkeleton />
          ) : null
        ) : (
          <InboxPanePart
            ref={paneRef}
            client={client}
            scope={accountScope}
            thing={paneThing}
            selection={paneSelection}
            order={snapshot.order ?? "waiting"}
            isActive={isPaneVisible}
            isHandMenuOpen={handMenu !== null}
            savedQueryKinds={savedQueryKinds}
            answers={answers}
            moves={paneMoves}
            onWalk={walkInPane}
            onDismissSelection={dismissInPane}
            onTakeOnSelection={takeOnInPane}
            onLinkSelection={linkInPane}
          />
        )
      }
      offlinePill={
        offlineSince === null ? null : <InboxOfflinePill sinceLabel={formatClock(offlineSince)} />
      }
      isPaneShown={
        paneThing !== undefined || currentGroupMember !== undefined || snapshot.status === "loading"
      }
      isPaneOpen={isPaneOpen}
      paneWidth={paneWidth}
      onPaneWidthChange={setPaneWidth}
      onClosePane={() => {
        setIsPaneOpen(false);
        focusList();
      }}
      onOpenAtSource={
        paneThing === undefined || paneThing.url === "" || isShowingSelection
          ? undefined
          : moves.openAtSource
      }
      openAtSourceWords={
        paneThing === undefined || isShowingSelection
          ? undefined
          : `Open on ${namePlugin(paneThing.source, plugins)}`
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
          {linkMenu !== null && (
            <InboxLinkToPart
              client={client}
              anchor={linkMenu.anchor}
              fromRef={linkMenu.pick.from.ref}
              fromLabel={linkMenu.pick.fromLabel}
              excludedRefs={linkMenu.pick.excludedRefs}
              onLink={(_fromRef, to) => {
                void moves.linkTo(linkMenu.pick.from, to);
              }}
              onClose={() => {
                setLinkMenu(null);
                focusList();
              }}
            />
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
