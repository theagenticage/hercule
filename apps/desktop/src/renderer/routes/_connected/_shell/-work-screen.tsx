import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { dropEmptyValues, filterItems } from "@hercule/client-core/desk";
import {
  buildLanes,
  buildWorkFacets,
  chooseLaneId,
  findCardsByTitle,
  NO_PROJECT_LANE_ID,
  NO_PROJECT_LANE_NAME,
  STAGE_NAMES,
} from "@hercule/client-core/work";
import { BOARD_STAGES, MAX_BOARD_CARDS, type BoardStage, type WorkCard } from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import { useMediaQueryMatch } from "../../../app/appearance";
import { projectsQuery, userQuery } from "../../../app/queries";
import { UndoLine } from "../../../screens/desk";
import { DRAFT_MESSAGE_ID } from "../../../screens/new-thread/draft-composer";
import { OverviewPill } from "../../../screens/overview/overview-pill";
import { AddTaskSheet, type AddTaskLane } from "../../../screens/work/add-task-sheet";
import { arrangeLanes, listShownCards } from "../../../screens/work/arrange-lanes";
import { BoardDesk, type DeskState } from "../../../screens/work/board-desk";
import { DeskClear, FirstRun, NoMatch } from "../../../screens/work/board-empty";
import { BoardLane } from "../../../screens/work/board-lane";
import { BoardLoading } from "../../../screens/work/board-loading";
import { KeysSheet } from "../../../screens/work/keys-sheet";
import { useBoardDrag } from "../../../screens/work/use-board-drag";
import { useBoardKeys } from "../../../screens/work/use-board-keys";
import { useBoardMotion } from "../../../screens/work/use-board-motion";
import { useOfflineSince } from "../../../screens/work/use-offline-since";
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

/** Returns how many of `cards` stand at each stage. */
const countByStage = (cards: readonly WorkCard[]): Readonly<Record<BoardStage, number>> => {
  const counts = Object.fromEntries(BOARD_STAGES.map((stage) => [stage, 0])) as Record<
    BoardStage,
    number
  >;
  for (const card of cards) counts[card.stage] += 1;
  return counts;
};

/** Returns the line that says since when the controller cannot be reached. */
const describeOffline = (since: Date): string =>
  `Offline since ${since.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

/**
 * The Work screen: the board of cards by stage and lane, with the toolbar
 * over it. It reads the board, holds what the user does with it (the filter,
 * Find, folds, the Display choices, the current card), moves cards, and owns
 * Add to Work. What it draws is in `screens/work/`.
 *
 * - The board is read while the window is visible, and read again on every
 *   `task` push. A move shows at once and is sent in order (`useCardMoves`).
 * - Filtering and Find run over the board already read, in the client.
 * - A card opens its newest Thread. A Task with no Thread opens nothing: the
 *   details pane that would show it comes in a later slice.
 */
export function WorkScreen({ controller }: { readonly controller: SavedController }): JSX.Element {
  const { client, url, live, undoStack } = controller;
  const navigate = useNavigate();
  const { data: projects } = useSuspenseQuery(projectsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const board = useWorkBoard(client);
  const moves = useCardMoves({ client, undoStack, serverBoard: board.data });
  const savedView = useWorkView(buildWorkViewKey(url, username));
  const isNarrow = useMediaQueryMatch(`(max-width: ${String(SIDE_LABELS_FROM_PX - 0.02)}px)`);
  const offlineSince = useOfflineSince(live);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  // The board's motion: what the user does to the view plays as motion, and a
  // Task that arrives or a run that fails waits for a still hand.
  const motion = useBoardMotion({
    board: moves.board,
    serverBoard: board.data,
    view: savedView,
    scrollRef,
  });
  const view = motion.view;
  const shownBoard = motion.board;
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
  const arranged = arrangeLanes(lanes, view);
  const shownIds = listShownCards(arranged);
  const firstShownId = shownIds.flat(2)[0] ?? null;
  const tabStopCardId =
    view.currentCardId !== null && shownIds.flat(2).includes(view.currentCardId)
      ? view.currentCardId
      : firstShownId;

  const isBoardEmpty = shownBoard !== undefined && cards.length === 0;
  const { data: hasAnyTask } = useQuery({ ...hasAnyTaskQuery(client), enabled: isBoardEmpty });

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
    if (card.openSessionId === undefined) return;
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
  /** The lane the toolbar's Add opens in: the current card's, else the first on screen, else No project. */
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
      motion.noteAddedTask(task.id);
    },
    onError: (error) => {
      setAddResult(null);
      moves.sayFailure(`Could not add the Task: ${readErrorMessage(error)}`);
    },
  });

  // ---------- Dragging ----------
  const drag = useBoardDrag({
    scrollRef,
    cards,
    projects,
    arranged,
    moveCard: moves.moveCard,
  });

  // ---------- Keys ----------
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });
  const keys = useBoardKeys({
    view,
    cards,
    arranged,
    findMatches: found.topMatches,
    projects,
    platform: bridge.platform,
    moves,
    isCarrying: drag.isCarrying,
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
      <p className="board-note" role="alert">
        The board could not be read: {readErrorMessage(board.error)}
        <button
          type="button"
          onClick={() => {
            void board.refetch();
          }}
        >
          Try again
        </button>
      </p>
    ) : (
      <BoardLoading laneNames={projects.slice(0, LOADING_LANES).map((project) => project.name)} />
    );
  } else if (isBoardEmpty) {
    state = hasAnyTask === false ? "first-run" : hasAnyTask === true ? "clear" : "board";
    body =
      hasAnyTask === false ? (
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
  } else if (arranged.length === 0) {
    body = <NoMatch />;
  } else {
    body = (
      <div className="board-lanes">
        {arranged.map((each) => (
          <BoardLane
            key={each.lane.id}
            arranged={each}
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
          onAdd={() => {
            openAddSheet(chooseAddLane());
          }}
          line={offlineSince === null ? motion.note : describeOffline(offlineSince)}
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
            isShown={moves.line.isShown}
          />
        </>
      }
      stageCounts={shownBoard === undefined ? null : countByStage(visibleCards)}
      laneLabels={isNarrow ? "bands" : view.display.laneLabels}
      isOffline={offlineSince !== null}
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
