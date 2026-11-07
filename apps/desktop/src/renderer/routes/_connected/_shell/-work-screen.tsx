import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { dropEmptyValues, filterItems } from "@hercule/client-core/desk";
import {
  arrangeLanes,
  buildLanes,
  buildWorkFacets,
  chooseLaneId,
  countCardsByStage,
  describeCardMove,
  type EndStage,
  findCards,
  listShownCardIds,
  NO_PROJECT_LANE_ID,
  NO_PROJECT_LANE_NAME,
  STAGE_NAMES,
} from "@hercule/client-core/work";
import {
  BOARD_STAGES,
  MAX_BOARD_CARDS,
  type BoardStage,
  type ControllerInfo,
  type WorkCard,
} from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import { useMediaQueryMatch } from "../../../app/appearance";
import { controllerQuery, projectsQuery, userQuery } from "../../../app/queries";
import { describeUndoKey, isPrimaryModifierHeld } from "../../../app/primary-modifier";
import { useOfflineSince } from "../../../app/use-offline-since";
import { UndoLine } from "../../../screens/desk";
import { DRAFT_MESSAGE_ID } from "../../../screens/new-thread/draft-composer";
import { OverviewPill } from "../../../screens/overview/overview-pill";
import { AddTaskSheet, type AddTaskLane } from "../../../screens/work/add-task-sheet";
import type { TaskPaneChanges } from "../../../screens/work/task-pane";
import { BoardDesk, type DeskState } from "../../../screens/work/board-desk";
import { DeskClear, FirstRun, NoMatch, ReadFailure } from "../../../screens/work/board-empty";
import { BoardLane } from "../../../screens/work/board-lane";
import { BoardLoading } from "../../../screens/work/board-loading";
import { KeysSheet } from "../../../screens/work/keys-sheet";
import { SelectionBar } from "../../../screens/work/selection-bar";
import { useBoardDrag } from "../../../screens/work/use-board-drag";
import { useBoardKeys } from "../../../screens/work/use-board-keys";
import { useCardSelection } from "../../../screens/work/use-card-selection";
import { useMergePick } from "../../../screens/work/use-merge-pick";
import { useBoardReads } from "../../../screens/work/use-board-reads";
import { usePausePawsOffScreen } from "../../../screens/work/use-pause-paws";
import { useViewMotion } from "../../../screens/work/use-view-motion";
import { useWorkView } from "../../../screens/work/use-work-view";
import type { PressedKeys } from "../../../screens/work/work-card";
import { buildWorkViewKey } from "../../../screens/work/work-view-storage";
import { WorkToolbar } from "../../../screens/work/work-toolbar";
import { useCardMoves } from "./-card-moves";
import { useMergeCards } from "./-merge-cards";
import { usePaneChanges } from "./-pane-changes";
import { useTaskThreads } from "./-task-threads";
import { WorkPane } from "./-work-pane";
import { hasAnyTaskQuery, useWorkBoard } from "./-work-board";

/** Below this window width, lanes are bands: side labels would cost the cards 210px. */
const SIDE_LABELS_FROM_PX = 1320;

/** How long the first board's words take to fade in, which is when the screen stops marking it as arriving. */
const ARRIVAL_MS = 1_200;

/** How many lanes the loading state draws, before the board says which there are. */
const LOADING_LANES = 3;

const EMPTY_CARDS: readonly WorkCard[] = [];

/** Returns whether Text Generation can run on `controllerInfo`, so that a summary can be written. */
const canTextGenerationRun = (controllerInfo: ControllerInfo): boolean =>
  controllerInfo.textGeneration.unavailableReason === null;

/**
 * What the details pane's buttons that change something do for now: nothing.
 * THE NEXT SLICE STEP WIRES THESE. Each one is called with only what the user
 * chose, and the screen sends it and says what happened (see
 * `TaskPaneChanges` in `screens/work/task-pane.tsx`). Until then the buttons
 * draw and press, and nothing happens.
 */
const TASK_PANE_CHANGES_NOT_WIRED: Pick<
  TaskPaneChanges,
  "onTryAgain" | "onAnswer" | "onSendAnswerAgain" | "onDiscardAnswer"
> = {
  onTryAgain: () => undefined,
  onAnswer: () => undefined,
  onSendAnswerAgain: () => undefined,
  onDiscardAnswer: () => undefined,
};

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
 * - A card opens its details on a sheet over the board. Which Task is open
 *   is in the address (`openTaskId`), so the screen only asks to change it.
 */
export function WorkScreen({
  controller,
  openTaskId,
  onChangeOpenTask,
}: {
  readonly controller: SavedController;
  /** The Task whose details are open, from the address, or `null` when none is. */
  readonly openTaskId: string | null;
  /** Puts a Task's id in the address to open its details, or `null` to close them. */
  readonly onChangeOpenTask: (taskId: string | null) => void;
}): JSX.Element {
  const { client, url, live, undoStack, pendingCardMoves } = controller;
  const navigate = useNavigate();
  const { data: projects } = useSuspenseQuery(projectsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const board = useWorkBoard(client);
  // Until the controller's record is read, nothing says a summary is coming, so no card promises one.
  const canWriteSummaries =
    useQuery({ ...controllerQuery(client), select: canTextGenerationRun }).data === true;
  const scrollRef = useRef<HTMLDivElement>(null);
  // A card that Undo or a refused update brings back is let in at once by the
  // board's reads, which are made after the moves, so the moves call it through this.
  const noteReturnedTask = useRef<(taskId: string, how: EndStage) => void>(() => undefined);
  const moves = useCardMoves({
    client,
    undoStack,
    pendingMoves: pendingCardMoves,
    serverBoard: board.data,
    scrollRef,
    onCardReturning: (taskId, how) => {
      noteReturnedTask.current(taskId, how);
    },
  });
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
  useLayoutEffect(() => {
    noteReturnedTask.current = reads.noteReturnedTask;
  });
  const view = useViewMotion(savedView, scrollRef);
  usePausePawsOffScreen(scrollRef);
  const shownBoard = reads.board;
  // The answers the user gave from the pane and the app still holds show on
  // their cards as answered; the pane's answer and Try again buttons act here.
  const pane = usePaneChanges({
    controller,
    username,
    boardCards: shownBoard?.cards ?? EMPTY_CARDS,
    moves,
    openTaskId,
    scrollRef,
    closePane: () => {
      onChangeOpenTask(null);
    },
  });
  // A merge held for the undo line hides the card that merges away.
  const merging = useMergeCards({
    controller,
    username,
    boardCards: pane.cards,
    isBoardRead: shownBoard !== undefined,
    moves,
    scrollRef,
    openTaskId,
    closePane: () => {
      onChangeOpenTask(null);
    },
  });
  const { cards } = merging;

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

  const found = findCards(cards, view.findText);
  const visibleCards = filterItems(found.matches, view.filter, facets);
  const lanes = buildLanes({ cards: visibleCards }, projects);
  const arrangedLanes = arrangeLanes(lanes, {
    foldedLaneIds: view.foldedLaneIds,
    openedCellIds: view.openedCellIds,
    isFiltering: view.isFiltering,
  });
  const shownIds = listShownCardIds(arrangedLanes);
  // Which cards are selected. A card the board stops drawing leaves the selection.
  const selection = useCardSelection(shownIds);
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

  // Merging by key: `M` or the details' Merge picks a card, and choosing
  // another card (Return, or a click) merges the first into it.
  const mergePick = useMergePick({
    scrollRef,
    cards,
    merge: merging.mergeCard,
    say: moves.sayWithoutUndo,
    onStart: () => {
      onChangeOpenTask(null);
    },
  });

  // A card opens its details. Choosing another card while the sheet is open
  // swaps the Task it shows, and choosing the one that is open does nothing.
  // While a card is picked to merge, choosing a card merges into it instead.
  const openCard = (card: WorkCard): void => {
    if (mergePick.sourceId !== null) {
      mergePick.confirm(card.id);
      return;
    }
    if (card.id !== openTaskId) onChangeOpenTask(card.id);
  };

  // Starting a Thread from a card, and moving a Thread to a new Task.
  const threads = useTaskThreads({
    client,
    cards,
    openTaskId,
    scrollRef,
    say: moves.sayWithoutUndo,
    openPane: openCard,
    closePane: () => {
      onChangeOpenTask(null);
    },
  });

  /**
   * Marks a Task Done or Dropped from a key or the details' foot. The card
   * leaves the board, and the details close when they show that Task. It
   * does nothing but say so while a Try again is still starting the Task's
   * run, because ending the Task then would race that run.
   */
  const endTask = (taskId: string, stage: EndStage): void => {
    if (pane.refuseEndWhileTryingAgain(taskId, stage)) return;
    moves.endCard(taskId, stage);
    if (taskId === openTaskId) onChangeOpenTask(null);
  };

  /**
   * Marks every selected card Done or Dropped, each by `endTask`, as one
   * gesture with one Undo, and empties the selection.
   */
  const endSelectedTasks = (stage: EndStage): void => {
    const taskIds = selection.listSelected();
    moves.endCardsTogether(stage, () => {
      for (const taskId of taskIds) endTask(taskId, stage);
    });
    selection.clear();
  };

  /** Moves a card to a stage from the details' stage path, as the number keys do. */
  const moveCardToStage = (card: WorkCard, stage: BoardStage): void => {
    const move = { taskId: card.id, stage };
    moves.moveCardWithMotion(move, describeCardMove(card, move, projects));
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
    // Two sheets would cover each other at the right.
    if (openTaskId !== null) onChangeOpenTask(null);
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
    currentCards: moves.board?.cards ?? EMPTY_CARDS,
    projects,
    arrangedLanes,
    selectedIds: selection.selectedIds,
    moveCard: moves.moveCard,
    moveCards: (cardMoves, describe, note) => {
      moves.moveCards(cardMoves, describe, note);
      // The selection was carried and has landed.
      selection.clear();
    },
    say: moves.sayWithoutUndo,
    holdMerge: merging.holdMerge,
    onCarryingChange: (isCarryingNow) => {
      setIsCarrying(isCarryingNow);
      // A card in the hand ends the key flow of a merge.
      if (isCarryingNow) mergePick.cancel();
    },
  });

  // ---------- Keys ----------
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });

  // A click opens the card, or selects it with ⌘ (Ctrl on Linux) held. While a
  // card is picked to merge, every click chooses the card to merge into.
  const pressCard = (card: WorkCard, keys: PressedKeys): void => {
    if (mergePick.sourceId === null && isPrimaryModifierHeld(keys, bridge.platform)) {
      selection.toggle(card.id);
    } else {
      openCard(card);
    }
  };
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
    onEndCard: (card, stage) => {
      endTask(card.id, stage);
    },
    onStartThread: threads.askThread,
    onToggleSelectCard: (card) => {
      selection.toggle(card.id);
    },
    selection: { count: selection.selectedIds.size, clear: selection.clear },
    mergePick,
    onAdd: (laneId) => {
      openAddSheet(laneId === undefined ? chooseAddLane() : toAddLane(laneId));
    },
    addSheet: { isOpen: addLane !== null, close: closeAddSheet },
    taskPane: {
      isOpen: openTaskId !== null,
      close: () => {
        onChangeOpenTask(null);
      },
      pressReturn: (card) => pane.pressReturn(card.id),
    },
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
            canWriteSummaries={canWriteSummaries}
            selectedIds={selection.selectedIds}
            onToggleLane={view.toggleLane}
            onToggleCell={view.toggleCell}
            onAddTask={(laneId) => {
              openAddSheet(toAddLane(laneId));
            }}
            onPressCard={pressCard}
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
          <WorkPane
            client={client}
            taskId={openTaskId}
            cards={cards}
            projects={projects}
            scrollRef={scrollRef}
            isStill={view.display.isStill}
            intents={pane.intents}
            threadPromptWords={threads.threadPromptWords}
            changes={{
              ...TASK_PANE_CHANGES_NOT_WIRED,
              ...pane.changes,
              onMerge: () => {
                const card = cards.find((each) => each.id === openTaskId);
                if (card !== undefined) mergePick.start(card);
              },
              ...threads.changes,
              onDone: () => {
                if (openTaskId !== null) endTask(openTaskId, "done");
              },
              onDrop: () => {
                if (openTaskId !== null) endTask(openTaskId, "dropped");
              },
            }}
            moveToStage={moveCardToStage}
            onChangeTask={onChangeOpenTask}
          />
          {keys.isKeysSheetOpen && <KeysSheet platform={bridge.platform} />}
          <SelectionBar
            count={selection.selectedIds.size}
            onDone={() => {
              endSelectedTasks("done");
            }}
            onDrop={() => {
              endSelectedTasks("dropped");
            }}
            onClear={selection.clear}
          />
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
      hasSheet={addLane !== null || openTaskId !== null}
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
