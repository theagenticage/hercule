import { useEffect, useRef, useState, type JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  EMPTY_INBOX_SEARCH,
  addInboxClause,
  changeInboxSelection,
  listCardOffers,
  moveInboxCurrent,
  nameInboxScope,
  typeInboxSearch,
  type InboxScope,
  type InboxSearch,
} from "@hercule/client-core/inbox";
import type { InboxClause, InboxThing } from "@hercule/contract";
import { acknowledgeInboxArrival } from "../../../app/inbox-arrival";
import { WORKFLOW_TOPICS, useScreenTopicsLive } from "../../../app/live";
import { useQuietValue } from "../../../app/use-quiet-value";
import { inboxCountQuery, userQuery } from "../../../app/queries";
import { describeUndoKey } from "../../../app/primary-modifier";
import { useOfflineSince } from "../../../app/use-offline-since";
import type { SavedController } from "../../../app/context";
import { KeysSheet, UndoLine } from "../../../screens/desk";
import { InboxFrame } from "../../../screens/inbox/inbox-frame";
import { buildInboxKeyRows, type InboxKeyAction } from "../../../screens/inbox/inbox-keys";
import { focusNextInboxRegion } from "../../../screens/inbox/inbox-regions";
import type { InboxRowActions } from "../../../screens/inbox/inbox-row";
import type { InboxListHandle } from "../../../screens/inbox/inbox-list";
import type { RailFacetScope } from "../../../screens/inbox/inbox-rail";
import type { InboxSearchHandle } from "../../../screens/inbox/inbox-search";
import { InboxOfflinePill, InboxPaneSkeleton } from "../../../screens/inbox/inbox-states";
import type { InboxLeaveHow } from "../../../screens/inbox/use-inbox-list-motion";
import { useInboxPaneWidth } from "../../../screens/inbox/use-inbox-pane-width";
import { useInboxClock } from "./-inbox-clock";
import { useHeldInboxList } from "./-inbox-held-list";
import { InboxHandMenuPart } from "./-inbox-hand-part";
import { InboxListPart } from "./-inbox-list-part";
import { useInboxMoves, type InboxMoveMotion } from "./-inbox-moves";
import { useInboxKeys } from "./-use-inbox-keys";
import { InboxPaneHeadPart, InboxPanePart } from "./-inbox-pane-part";
import { InboxRailPart } from "./-inbox-rail-part";
import { InboxSearchPart } from "./-inbox-search-part";
import {
  DEFAULT_INBOX_QUERY_ID,
  EVERYTHING_INBOX_SCOPE,
  EVERYTHING_QUERY_ID,
  buildInboxList,
  buildInboxQuery,
  buildInboxScopeParams,
  isSearching,
  type InboxNarrowing,
} from "./-inbox-scope";

/** How long typing in the search stops before the list reads for it, in milliseconds. */
const SEARCH_QUIET_MS = 200;

const NO_REFS: ReadonlyArray<string> = [];

/** How the rows of a list change when no move of the user made the change: they leave and come as they are. */
const STILL_MOTION: InboxMoveMotion = {
  leaveHow: "taken" satisfies InboxLeaveHow,
  returning: NO_REFS,
};

/** The hand-off menu that is open: the thing it hands, and the element it opens under. */
interface HandMenu {
  readonly thing: InboxThing;
  readonly anchor: HTMLElement;
}

/**
 * Renders the Inbox screen: the page frame with its rail, search, list and
 * pane. It owns what the user chose: the search over the scope, the pane's
 * width and whether the pane lies open over the list. The scope (a saved
 * query or a Browse value) is the route's, read from the URL and given as
 * `scope`, and picking another navigates to it. The list itself is the held
 * list (`useHeldInboxList`), and the parts draw it where they read their data.
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
  const counts = useSuspenseQuery(inboxCountQuery(client)).data;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const formatClock = useInboxClock(client);
  const offlineSince = useOfflineSince(live);
  const [search, setSearch] = useState<InboxSearch>(EMPTY_INBOX_SEARCH);
  const [paneWidth, setPaneWidth] = useInboxPaneWidth();
  const [isPaneOpen, setIsPaneOpen] = useState(false);
  const [isStacked, setIsStacked] = useState(false);
  const [isKeysOpen, setIsKeysOpen] = useState(false);
  const [isNarrowOpen, setIsNarrowOpen] = useState(false);
  const [handMenu, setHandMenu] = useState<HandMenu | null>(null);
  // How the rows of the last move went, which holds only for the rows that move left.
  const [lastMove, setLastMove] = useState<{
    readonly rows: ReadonlyArray<InboxThing>;
    readonly motion: InboxMoveMotion;
  } | null>(null);
  // The list the user's own move emptied: the empty state's sunrise rises only for it.
  const [emptiedListId, setEmptiedListId] = useState<string | null>(null);
  const [listFocusRequest, setListFocusRequest] = useState(0);
  const [headingFocusRequest, setHeadingFocusRequest] = useState(0);
  const searchRef = useRef<InboxSearchHandle>(null);
  const listRef = useRef<InboxListHandle>(null);

  // The field shows every letter at once, but the list reads for the text that has held still.
  const quietText = useQuietValue(search.text, SEARCH_QUIET_MS);
  const searched: InboxNarrowing = {
    clauses: search.clauses,
    text: search.text.trim() === "" ? "" : quietText,
  };
  const held = useHeldInboxList(client, buildInboxQuery(scope, searched));
  const { list } = held;
  const isLastMoveShown = lastMove !== null && list?.rows === lastMove.rows;
  const motion = isLastMoveShown ? lastMove.motion : STILL_MOTION;
  // Once rows are back or another list shows, the list is no longer the one the move emptied.
  if (
    emptiedListId !== null &&
    list !== null &&
    (list.rows.length > 0 || list.listId !== emptiedListId)
  ) {
    setEmptiedListId(null);
  }
  const scopeTitle = nameInboxScope(scope, counts);
  const currentThing = list?.rows.find((row) => row.ref === list.current);

  // What the waits list shows is what the sidebar's dot has been told about.
  const isShowingWaits =
    scope.kind === "saved-query" && scope.id === DEFAULT_INBOX_QUERY_ID && !isSearching(searched);
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
  const followMove = (next: { readonly rows: ReadonlyArray<InboxThing> }): void => {
    if (next.rows.length === 0) {
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
    onMoved: (next, moved) => {
      setLastMove({ rows: next.rows, motion: moved });
      setEmptiedListId(next.rows.length === 0 ? next.listId : null);
      followMove(next);
    },
  });
  const openHandMenu = (thing: InboxThing | null, ref: string): void => {
    if (thing === null) return;
    const anchor = listRef.current?.findHandAnchor(ref);
    if (anchor !== null && anchor !== undefined) setHandMenu({ thing, anchor });
  };
  const startHandOff = (ref: string | undefined): void => {
    openHandMenu(moves.startHandOff(ref), ref ?? list?.current ?? "");
  };
  /** Slides the pane away first when it lies over the list, for what is about the list. */
  const slidePaneAside = (): void => {
    if (isPaneHoldingFocus) setIsPaneOpen(false);
  };
  /** Takes in what arrived, which is what both the `.` key and the "N new" pill do. */
  const showNew = (): void => {
    slidePaneAside();
    held.showArrivals();
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
        showNew();
        return;
      case "pickList": {
        const query = counts.savedQueries[action.index];
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
        if (list !== null && (list.rows.length > 0 || list.arrivals.length > 0)) {
          setIsNarrowOpen((isOpen) => !isOpen);
        }
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
  const widenToEverything = (): void => {
    void navigate({
      to: "/inbox",
      search: buildInboxScopeParams(EVERYTHING_INBOX_SCOPE),
      replace: true,
    });
  };
  const resultsText =
    isSearching(searched) && held.total !== undefined
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
          onChange={setSearch}
          onWiden={widenToEverything}
          onLeaveToResults={focusList}
          onLeave={focusList}
        />
      }
      list={
        <InboxListPart
          client={client}
          held={held}
          scope={scope}
          scopeTitle={scopeTitle}
          search={searched}
          rowActions={rowActions}
          readHandedThing={moves.readHandedThing}
          focusRequest={listFocusRequest}
          headingFocusRequest={headingFocusRequest}
          leaveHow={motion.leaveHow}
          returning={motion.returning}
          isRising={list !== null && list.listId === emptiedListId}
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
              onSeeInIntake: () => {
                void navigate({ to: "/intake", search: { entity: currentThing.id } });
              },
              onHandOff: (offer, connectionId) => {
                moves.handOff(undefined, offer, connectionId);
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
