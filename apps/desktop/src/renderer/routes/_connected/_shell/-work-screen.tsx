import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { dropEmptyValues, filterItems } from "@hercule/client-core/desk";
import {
  buildLanes,
  buildWorkFacets,
  chooseLaneId,
  countCardsByStage,
  findCardsByTitle,
  listShownCardIds,
  NO_PROJECT_LANE_ID,
  NO_PROJECT_LANE_NAME,
  STAGE_NAMES,
} from "@hercule/client-core/work";
import { BOARD_STAGES, MAX_BOARD_CARDS, type WorkCard } from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import { useMediaQueryMatch } from "../../../app/appearance";
import { projectsQuery, userQuery } from "../../../app/queries";
import { describeUndoKey } from "../../../app/primary-modifier";
import { useOfflineSince } from "../../../app/use-offline-since";
import { UndoLine } from "../../../screens/desk";
import { DRAFT_MESSAGE_ID } from "../../../screens/new-thread/draft-composer";
import { OverviewPill } from "../../../screens/overview/overview-pill";
import { AddTaskSheet, type AddTaskLane } from "../../../screens/work/add-task-sheet";
import { arrangeLanes, listShownCards } from "../../../screens/work/arrange-lanes";
import { BoardDesk, type DeskState } from "../../../screens/work/board-desk";
import { DeskClear, FirstRun, NoMatch, ReadFailure } from "../../../screens/work/board-empty";
import { BoardLane } from "../../../screens/work/board-lane";
import { BoardLoading } from "../../../screens/work/board-loading";
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
 * - Filtering and Find run over the board already read, in the client.
 * - A card opens its newest Thread. A Task with no Thread opens nothing yet,
 *   and the undo line says so, because there is no details pane to show it in.
 */
export function WorkScreen({ controller }: { readonly controller: SavedController }): JSX.Element {
  const { client, url, live, undoStack } = controller;
  const navigate = useNavigate();
  const { data: projects } = useSuspenseQuery(projectsQuery(client));
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

  // The lanes of the whole board, for the Filter menu: a Project the filter
  // hides stays in the menu to be chosen again.
  const allLanes = buildLanes({ cards }, projects);
  const facets = buildWorkFacets(allLanes);

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
  const lanes = buildLanes({ cards: visibleCards }, projects);
  const arrangedLanes = arrangeLanes(lanes, {
    foldedLaneIds: view.foldedLaneIds,
    openedCellIds: view.openedCellIds,
    isFiltering: view.isFiltering,
  });
  const shownIds = listShownCardIds(listShownCards(arrangedLanes));
  const firstShownId = shownIds[0] ?? null;
  const tabStopCardId =
    view.currentCardId !== null && shownIds.includes(view.currentCardId)
      ? view.currentCardId
      : firstShownId;

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
  const addOpener = useRef<HTMLElement | null>(null);
  const openAddSheet = (lane: AddTaskLane): void => {
    addOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAddResult(null);
    setAddLane(lane);
  };
  const closeAddSheet = (): void => {
    setAddLane(null);
    addOpener.current?.focus({ preventScroll: true });
  };
  const toAddLane = (laneId: string): AddTaskLane => {
    const lane = allLanes.find((each) => each.id === laneId);
    return lane === undefined
      ? { id: NO_PROJECT_LANE_ID, name: NO_PROJECT_LANE_NAME, projectId: null }
      : { id: lane.id, name: lane.name, projectId: lane.projectId };
  };
  /** Returns the lane the toolbar's Add opens in: the current card's, else the first on screen, else No project. */
  const chooseAddLane = (): AddTaskLane => {
    const projectIds = new Set(projects.map((project) => project.id));
    const current = cards.find((card) => card.id === tabStopCardId);
    const laneId =
      current === undefined
        ? (lanes[0]?.id ?? NO_PROJECT_LANE_ID)
        : chooseLaneId(current, projectIds);
    return toAddLane(laneId);
  };
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
    projects,
    arrangedLanes,
    moveCard: moves.moveCard,
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
    onAdd: () => {
      openAddSheet(chooseAddLane());
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
            tabStopCardId={tabStopCardId}
            isStill={view.display.isStill}
            onToggleLane={view.toggleLane}
            onToggleCell={view.toggleCell}
            onAddTask={(laneId) => {
              openAddSheet(toAddLane(laneId));
            }}
            onOpenCard={openCard}
            onFocusCard={view.setCurrentCardId}
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
      stageCounts={shownBoard === undefined ? null : countCardsByStage(visibleCards)}
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
