import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { dropEmptyValues, filterItems } from "@hercule/client-core/desk";
import {
  arrangeLanes,
  buildLanes,
  chooseAddOpening,
  buildWorkFacets,
  countCardsByStage,
  findCardsByTitle,
  groupBoardByContext,
  listBoardGroupings,
  listShownCards,
  NO_PROJECT_LANE_ID,
  NO_PROJECT_LANE_NAME,
  PROJECT_FACET_ID,
  STAGE_NAMES,
  type AddOpening,
} from "@hercule/client-core/work";
import { BOARD_STAGES, MAX_BOARD_CARDS, type EntityPlace, type WorkCard } from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import { useMediaQueryMatch } from "../../../app/appearance";
import { pluginsQuery, projectsQuery, userQuery } from "../../../app/queries";
import { describeUndoKey } from "../../../app/primary-modifier";
import { useOfflineSince } from "../../../app/use-offline-since";
import { UndoLine } from "../../../screens/desk";
import { DRAFT_MESSAGE_ID } from "../../../screens/new-thread/draft-composer";
import { OverviewPill } from "../../../screens/overview/overview-pill";
import { AddFromSource } from "../../../screens/work/add-from-source";
import { AddTaskSheet, type AddTaskLane } from "../../../screens/work/add-task-sheet";
import { BoardDesk, type DeskState } from "../../../screens/work/board-desk";
import { DeskClear, FirstRun, NoMatch, ReadFailure } from "../../../screens/work/board-empty";
import { BoardLane } from "../../../screens/work/board-lane";
import { BoardLoading } from "../../../screens/work/board-loading";
import { isSameCardInLane, readCardInLane } from "../../../screens/work/card-in-lane";
import { keepCardInView } from "../../../screens/work/keep-in-view";
import { KeysSheet } from "../../../screens/work/keys-sheet";
import { useBoardDrag } from "../../../screens/work/use-board-drag";
import { useBoardKeys } from "../../../screens/work/use-board-keys";
import { useBoardReads } from "../../../screens/work/use-board-reads";
import { usePausePawsOffScreen } from "../../../screens/work/use-pause-paws";
import { useViewMotion } from "../../../screens/work/use-view-motion";
import { useWorkView } from "../../../screens/work/use-work-view";
import { buildWorkViewKey } from "../../../screens/work/work-view-storage";
import { WorkToolbar } from "../../../screens/work/work-toolbar";
import { useCardMoves } from "./-card-moves";
import { hasAnyTaskQuery, useWorkBoard } from "./-work-board";

/** Below this window width, lanes are bands: side labels would cost the cards 210px. */
const SIDE_LABELS_FROM_PX = 1320;

/** How long the first board's words take to fade in, which is when the screen stops marking it as arriving. */
const ARRIVAL_MS = 1_200;

/** How many lanes the loading state draws, before the board says which there are. */
const LOADING_LANES = 3;

const EMPTY_CARDS: readonly WorkCard[] = [];
const EMPTY_PLACES: readonly EntityPlace[] = [];

/** Returns the line that says since when the controller cannot be reached. */
const describeOffline = (since: Date): string =>
  `Offline since ${since.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

/**
 * Renders the Work screen: the board of cards by stage and lane, with the
 * toolbar over it. It reads the board, holds what the user does with it (the
 * filter, Find, folds, the Display choices, the current card), moves cards,
 * and owns Add to Work. What it draws is in `screens/work/`.
 *
 * - The board is read while the window is visible, and read again on every
 *   `task` push. A move shows at once and is sent in order (`useCardMoves`).
 * - Filtering, Find and grouping by an outside place run over the board
 *   already read, in the client. A grouping the board no longer offers is
 *   drawn as Project.
 * - A card opens its newest Thread. A Task with no Thread opens nothing yet,
 *   and the undo line says so, because there is no details pane to show it in.
 * - `taskToShow` is a Task the URL names, such as when the Inbox's See its
 *   Task comes here: its card is brought into view and takes the keyboard,
 *   once, and the name leaves the URL.
 */
export function WorkScreen({
  controller,
  taskToShow,
}: {
  readonly controller: SavedController;
  readonly taskToShow: string | undefined;
}): JSX.Element {
  const { client, url, live, undoStack } = controller;
  const navigate = useNavigate();
  const { data: projects } = useSuspenseQuery(projectsQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const board = useWorkBoard(client);
  const scrollRef = useRef<HTMLDivElement>(null);
  const moves = useCardMoves({ client, undoStack, serverBoard: board.data, scrollRef });
  const savedView = useWorkView(buildWorkViewKey(url, username));
  const isNarrow = useMediaQueryMatch(`(max-width: ${String(SIDE_LABELS_FROM_PX - 0.02)}px)`);
  const offlineSince = useOfflineSince(live);
  const findRef = useRef<HTMLInputElement>(null);

  // Whether a card is in the hand of a drag. The drag sets it; the reads wait
  // for it, the keys stand still for it, and the desk draws it for the stylesheet.
  const [isCarrying, setIsCarrying] = useState(false);

  // The board's motion: what the user does to the view plays as motion, a
  // Task that arrives or a run that fails waits for a still hand, and a
  // working colleague whose card is scrolled out of view stops tapping.
  const reads = useBoardReads({
    board: moves.board,
    serverBoard: board.data,
    projects,
    isCarrying,
    scrollRef,
  });
  const view = useViewMotion(savedView, scrollRef);
  usePausePawsOffScreen(scrollRef);
  const shownBoard = reads.board;
  const cards = shownBoard?.cards ?? EMPTY_CARDS;
  const places = shownBoard?.places ?? EMPTY_PLACES;
  const groupings = listBoardGroupings({ groupings: shownBoard?.groupings ?? [] });
  // A saved grouping whose kind the board no longer has (its plugin was
  // removed, or none of its places is on the board) is drawn as Project, and
  // stays saved in case the kind comes back.
  const groupBy = groupings.some((grouping) => grouping.kind === view.groupBy)
    ? view.groupBy
    : PROJECT_FACET_ID;

  // The lanes of the whole board, for the Filter menu: a Project the filter
  // hides stays in the menu to be chosen again.
  const allLanes = buildLanes({ cards }, projects);
  const facets = buildWorkFacets(
    allLanes,
    { cards, places, groupings: shownBoard?.groupings ?? [] },
    plugins,
  );

  // Failed and Has a question lift themselves once no card has them, so an
  // empty page never says nothing. Only a board that was read can say so.
  // This lifts the filter after a read, not on a user's event, so it uses the
  // view without motion.
  const { filter, setFilter } = savedView;
  useEffect(() => {
    if (shownBoard === undefined) return;
    const next = dropEmptyValues(filter, facets, shownBoard.cards);
    if (next !== filter) setFilter(next);
  }, [shownBoard, facets, filter, setFilter]);

  const found = findCardsByTitle(cards, view.findText);
  const visibleCards = filterItems(found.matches, view.filter, facets);
  const lanes =
    groupBy === PROJECT_FACET_ID
      ? buildLanes({ cards: visibleCards }, projects)
      : groupBoardByContext(
          { cards: visibleCards, places, groupings: shownBoard?.groupings ?? [] },
          groupBy,
        );
  const arrangedLanes = arrangeLanes(lanes, {
    foldedLaneIds: view.foldedLaneIds,
    openedCellIds: view.openedCellIds,
    isFiltering: view.isFiltering,
  });
  const shownCards = listShownCards(arrangedLanes);
  const tabStop =
    shownCards.find((card) => isSameCardInLane(card, view.currentCard)) ?? shownCards[0] ?? null;

  const isBoardEmpty = shownBoard !== undefined && cards.length === 0;
  const hasAnyTaskRead = useQuery({ ...hasAnyTaskQuery(client), enabled: isBoardEmpty });
  const hasAnyTask = hasAnyTaskRead.data;

  // The first board fades its words in from the top left, once.
  const [startedLoading] = useState(board.data === undefined);
  const [arrivalOver, setArrivalOver] = useState(false);
  const hasBoard = shownBoard !== undefined;
  useEffect(() => {
    if (!startedLoading || !hasBoard) return;
    const timer = setTimeout(() => {
      setArrivalOver(true);
    }, ARRIVAL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [startedLoading, hasBoard]);

  // A Task the URL names is shown once the board is on screen, and then forgotten.
  const showTaskOnce = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (taskToShow === undefined || !hasBoard || showTaskOnce.current === taskToShow) return;
    showTaskOnce.current = taskToShow;
    const scroller = scrollRef.current;
    const element = scroller?.querySelector<HTMLElement>(
      `[data-card-id="${CSS.escape(taskToShow)}"]`,
    );
    const at = element === null || element === undefined ? null : readCardInLane(element);
    if (scroller === null || element === null || element === undefined || at === null) {
      moves.sayWithoutUndo("That Task is not shown on the board now. Its lane may be folded.");
    } else {
      element.focus({ preventScroll: true });
      keepCardInView(scroller, element);
      view.setCurrentCard(at);
    }
    void navigate({ to: "/work", search: {}, replace: true });
  }, [taskToShow, hasBoard, moves, view, navigate]);

  const openCard = (card: WorkCard): void => {
    if (card.openSessionId === undefined) {
      moves.sayWithoutUndo("This Task has no Thread yet.");
      return;
    }
    void navigate({ to: "/threads/$sessionId", params: { sessionId: card.openSessionId } });
  };

  // ---------- Add to Work ----------
  const [addLane, setAddLane] = useState<AddTaskLane | null>(null);
  const [addResult, setAddResult] = useState<string | null>(null);
  const [addOpening, setAddOpening] = useState<AddOpening>({});
  const addOpener = useRef<HTMLElement | null>(null);
  /**
   * Opens the sheet. `fromLaneId` is the lane whose `+` or key opened it, when
   * one did: From a source then opens on that lane's context, and otherwise on
   * the context the filter is on.
   */
  const openAddSheet = (lane: AddTaskLane, fromLaneId?: string): void => {
    addOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAddResult(null);
    setAddOpening(
      chooseAddOpening({
        places,
        filter: view.filter,
        lane: fromLaneId === undefined ? undefined : lanes.find((each) => each.id === fromLaneId),
      }),
    );
    setAddLane(lane);
  };
  const closeAddSheet = (): void => {
    setAddLane(null);
    addOpener.current?.focus({ preventScroll: true });
  };
  const toAddLane = (laneId: string): AddTaskLane => {
    const lane =
      lanes.find((each) => each.id === laneId) ?? allLanes.find((each) => each.id === laneId);
    return lane === undefined
      ? { id: NO_PROJECT_LANE_ID, name: NO_PROJECT_LANE_NAME, projectId: null }
      : { id: lane.id, name: lane.name, projectId: lane.projectId };
  };
  /** Returns the lane the toolbar's Add opens in: the current card's, else the first on screen, else No project. */
  const chooseAddLane = (): AddTaskLane =>
    toAddLane(tabStop?.laneId ?? lanes[0]?.id ?? NO_PROJECT_LANE_ID);
  const { mutateAsync: createTask } = useMutation({
    mutationFn: ({ title, lane }: { readonly title: string; readonly lane: AddTaskLane }) =>
      client.task.create({
        payload: {
          title,
          description: "",
          // A Task added on the board starts in Exploring. Without a stage the
          // controller would file it as Planned.
          stage: "exploring",
          ...(lane.projectId === null ? {} : { projectId: lane.projectId }),
        },
      }),
    onSuccess: (task, { lane }) => {
      const stage = BOARD_STAGES.find((each) => each === task.stage);
      const where = stage === undefined ? task.stage : STAGE_NAMES[stage];
      setAddResult(`Added to ${where}${lane.projectId === null ? "" : ` in ${lane.name}`}.`);
      reads.noteAddedTask(task.id);
    },
    onError: (error) => {
      setAddResult(null);
      moves.sayWithoutUndo(`Could not add the Task: ${readErrorMessage(error)}`);
    },
  });

  // ---------- Dragging ----------
  useBoardDrag({
    scrollRef,
    cards,
    currentCards: moves.board?.cards ?? EMPTY_CARDS,
    projects,
    arrangedLanes,
    moveCard: moves.moveCard,
    say: moves.sayWithoutUndo,
    onCarryingChange: setIsCarrying,
  });

  // ---------- Keys ----------
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });
  const keys = useBoardKeys({
    view,
    cards,
    arrangedLanes,
    findMatches: found.topMatches,
    projects,
    platform: bridge.platform,
    moves,
    isCarrying,
    scrollRef,
    findRef,
    onOpenCard: openCard,
    onAdd: (laneId) => {
      openAddSheet(laneId === undefined ? chooseAddLane() : toAddLane(laneId), laneId);
    },
    addSheet: { isOpen: addLane !== null, close: closeAddSheet },
  });

  // ---------- What the screen draws ----------
  let state: DeskState = "board";
  let body: JSX.Element | null;
  if (shownBoard === undefined) {
    state = "loading";
    body = board.isError ? (
      <ReadFailure
        what="The board"
        reason={readErrorMessage(board.error)}
        onRetry={() => {
          void board.refetch();
        }}
      />
    ) : (
      <BoardLoading laneNames={projects.slice(0, LOADING_LANES).map((project) => project.name)} />
    );
  } else if (isBoardEmpty) {
    state = hasAnyTask === false ? "first-run" : hasAnyTask === true ? "clear" : "board";
    body = hasAnyTaskRead.isError ? (
      <ReadFailure
        what="Whether you have any Task"
        reason={readErrorMessage(hasAnyTaskRead.error)}
        onRetry={() => {
          void hasAnyTaskRead.refetch();
        }}
      />
    ) : hasAnyTask === false ? (
      <FirstRun
        onStartThread={() => {
          void navigate({ to: "/", search: {} }).then(() => {
            document.getElementById(DRAFT_MESSAGE_ID)?.focus();
          });
        }}
      />
    ) : hasAnyTask === true ? (
      <DeskClear />
    ) : null;
  } else if (arrangedLanes.length === 0) {
    body = <NoMatch />;
  } else {
    body = (
      <div className="board-lanes">
        {arrangedLanes.map((each) => (
          <BoardLane
            key={each.lane.id}
            arrangedLane={each}
            plugins={plugins}
            tabStop={tabStop}
            isStill={view.display.isStill}
            onToggleLane={view.toggleLane}
            onToggleCell={view.toggleCell}
            onAddTask={(laneId) => {
              openAddSheet(toAddLane(laneId), laneId);
            }}
            onOpenCard={openCard}
            onFocusCard={view.setCurrentCard}
          />
        ))}
      </div>
    );
  }

  return (
    <BoardDesk
      toolbar={
        <WorkToolbar
          pill={<OverviewPill />}
          groupings={groupings}
          groupBy={groupBy}
          onGroupByChange={(next) => {
            if (next !== groupBy) view.setGroupBy(next);
          }}
          plugins={plugins}
          facets={facets}
          filter={view.filter}
          onFilterChange={view.setFilter}
          cards={found.matches}
          find={{
            value: view.findText,
            onChange: view.setFindText,
            inputRef: findRef,
            onKeyDown: keys.handleFindKeys,
            matches: found.topMatches,
            totalCount: found.matches.length,
            activeId: keys.activeFindId,
            onOpen: (id) => {
              const card = cards.find((each) => each.id === id);
              if (card !== undefined) openCard(card);
            },
          }}
          display={view.display}
          onDisplayChange={view.setDisplay}
          onFoldEverything={() => {
            view.foldEverything(lanes.map((lane) => lane.id));
          }}
          onShowKeys={keys.showKeysSheet}
          onAdd={() => {
            openAddSheet(chooseAddLane());
          }}
          line={offlineSince === null ? reads.note : describeOffline(offlineSince)}
        />
      }
      overlays={
        <>
          {addLane !== null && (
            <AddTaskSheet
              lane={addLane}
              result={addResult}
              onClose={closeAddSheet}
              onCreate={async (title) => {
                await createTask({ title, lane: addLane });
              }}
              fromSource={
                <AddFromSource
                  key={`${addOpening.sourceId ?? ""}|${addOpening.scopeRef ?? ""}`}
                  client={client}
                  places={places}
                  opening={addOpening}
                  isOffline={offlineSince !== null}
                  onAdded={({ taskId, line, gesture }) => {
                    if (gesture === undefined) {
                      moves.sayWithoutUndo(line);
                      return;
                    }
                    reads.noteAddedTask(taskId);
                    moves.recordGesture(gesture, line);
                  }}
                  onFailed={moves.sayWithoutUndo}
                  onOpenTask={(taskId) => {
                    const card = cards.find((each) => each.id === taskId);
                    if (card === undefined) moves.sayWithoutUndo("That Task is not on this board.");
                    else openCard(card);
                  }}
                />
              }
            />
          )}
          {keys.isKeysSheetOpen && <KeysSheet platform={bridge.platform} />}
          <UndoLine
            text={moves.line.text}
            onUndo={moves.line.canUndo ? moves.undoLastMove : null}
            undoKey={describeUndoKey(bridge.platform)}
            isShown={moves.line.isShown}
          />
        </>
      }
      stageCounts={shownBoard === undefined ? null : countCardsByStage(arrangedLanes)}
      laneLabels={isNarrow ? "bands" : view.display.laneLabels}
      isOffline={offlineSince !== null}
      isCarrying={isCarrying}
      hasSheet={addLane !== null}
      isArriving={startedLoading && hasBoard && !arrivalOver}
      state={state}
      scrollRef={scrollRef}
    >
      {body}
      {shownBoard?.truncated === true && (
        <p className="board-note" role="status">
          The board shows the first {MAX_BOARD_CARDS.toLocaleString("en")} Tasks, and more exist.
          Finish or drop some to bring the rest in.
        </p>
      )}
    </BoardDesk>
  );
}
