import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { dropEmptyValues, filterItems } from "@hercule/client-core/desk";
import {
  arrangeBoard,
  buildLanes,
  buildWorkFacets,
  chooseAddOpening,
  chooseLaneId,
  chooseLaneProject,
  describeCardMove,
  type EndStage,
  findCards,
  NO_PROJECT_LANE_ID,
  NO_PROJECT_LANE_NAME,
  PROJECT_FACET_ID,
  STAGE_NAMES,
  type AddOpening,
  type WorkInitiative,
} from "@hercule/client-core/work";
import {
  BOARD_STAGES,
  MAX_BOARD_CARDS,
  type BoardStage,
  type ControllerInfo,
  type EntityPlace,
  type WorkCard,
} from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import { useMediaQueryMatch } from "../../../app/appearance";
import { INITIATIVE_TOPICS, useScreenTopicsLive } from "../../../app/live";
import { controllerQuery, pluginsQuery, projectsQuery, userQuery } from "../../../app/queries";
import { describeUndoKey, isPrimaryModifierHeld } from "../../../app/primary-modifier";
import { useFirstArrival } from "../../../app/use-first-arrival";
import { useOfflineSince } from "../../../app/use-offline-since";
import { ReadFailure, UndoLine } from "../../../screens/desk";
import { DRAFT_MESSAGE_ID } from "../../../screens/new-thread/draft-composer";
import { OverviewPill } from "../../../screens/overview/overview-pill";
import { AddFromSource } from "../../../screens/work/add-from-source";
import { AddTaskSheet, type AddTaskLane } from "../../../screens/work/add-task-sheet";
import { BoardDesk, type DeskState } from "../../../screens/work/board-desk";
import { DeskClear, FirstRun, NoMatch } from "../../../screens/work/board-empty";
import { BoardBody } from "../../../screens/work/board-body";
import { BoardLoading } from "../../../screens/work/board-loading";
import { isSameCardInLane, readCardInLane } from "../../../screens/work/card-in-lane";
import { keepCardInView } from "../../../screens/work/keep-in-view";
import { KeysSheet } from "../../../screens/work/keys-sheet";
import { SelectionBar } from "../../../screens/work/selection-bar";
import { useBeadSlide } from "../../../screens/work/use-bead-slide";
import { useBoardDrag } from "../../../screens/work/use-board-drag";
import { useBoardKeys } from "../../../screens/work/use-board-keys";
import { useCardSelection } from "../../../screens/work/use-card-selection";
import { useMergePick } from "../../../screens/work/use-merge-pick";
import { useBoardReads } from "../../../screens/work/use-board-reads";
import { usePausePawsOffScreen } from "../../../screens/work/use-pause-paws";
import { useViewMotion } from "../../../screens/work/use-view-motion";
import { useFailedArrival } from "../../../screens/work/use-failed-arrival";
import { useWorkView } from "../../../screens/work/use-work-view";
import type { PressedKeys } from "../../../screens/work/work-card";
import { buildBoardSnapshotKey } from "../../../screens/work/board-snapshot-storage";
import { SinceLine } from "../../../screens/work/since-line";
import { buildWorkViewKey } from "../../../screens/work/work-view-storage";
import { WorkToolbar } from "../../../screens/work/work-toolbar";
import { useCardMoves } from "./-card-moves";
import { useInitiativeSheet } from "./-initiative-sheet";
import { useLogicalBoard } from "./-logical-board";
import { useMergeCards } from "./-merge-cards";
import { useStopRun } from "./-stop-run";
import { usePaneChanges } from "./-pane-changes";
import { useTaskThreads } from "./-task-threads";
import { WorkPane } from "./-work-pane";
import { hasAnyTaskQuery, useWorkBoard, useWorkInitiatives } from "./-work-board";

/** Below this window width, lanes are bands: side labels would cost the cards 210px. */
const SIDE_LABELS_FROM_PX = 1320;

/** How many lanes the loading state draws, before the board says which there are. */
const LOADING_LANES = 3;

const EMPTY_CARDS: readonly WorkCard[] = [];
const EMPTY_PLACES: readonly EntityPlace[] = [];
const EMPTY_INITIATIVES: readonly WorkInitiative[] = [];

/** Returns whether Text Generation can run on `controllerInfo`, so that a summary can be written. */
const canTextGenerationRun = (controllerInfo: ControllerInfo): boolean =>
  controllerInfo.textGeneration.unavailableReason === null;

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
 * - A card opens its details on a sheet over the board. Which Task is open
 *   is in the address (`openTaskId`), so the screen only asks to change it.
 * - A Task the address names when the screen opens, such as when the Inbox's
 *   See its Task comes here, has its card brought into view and made the
 *   current card, once.
 * - Opened from the sidebar's failed-run dot (`isOpeningOnFailed`), it shows
 *   only the cards that failed, with the first in view.
 */
export function WorkScreen({
  controller,
  openTaskId,
  onChangeOpenTask,
  isOpeningOnFailed,
  onOpenedOnFailed,
}: {
  readonly controller: SavedController;
  /** The Task whose details are open, from the address, or `null` when none is. */
  readonly openTaskId: string | null;
  /** Puts a Task's id in the address to open its details, or `null` to close them. */
  readonly onChangeOpenTask: (taskId: string | null) => void;
  /** Whether the address asks to open on what failed. */
  readonly isOpeningOnFailed: boolean;
  /** Takes that request out of the address once the screen has acted on it. */
  readonly onOpenedOnFailed: () => void;
}): JSX.Element {
  const { client, url, live } = controller;
  const scope = controller.accountScopes.read();
  const navigate = useNavigate();
  const { data: projects } = useSuspenseQuery(projectsQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const board = useWorkBoard(client);
  // The Initiatives are read with the board, kept current by their own topic, held only while Work is open.
  const queryClient = useQueryClient();
  useScreenTopicsLive(live, queryClient, INITIATIVE_TOPICS);
  const initiativesRead = useWorkInitiatives(client);
  const initiatives = initiativesRead.data ?? EMPTY_INITIATIVES;
  // Until the controller's record is read, nothing says a summary is coming, so no card promises one.
  const canWriteSummaries =
    useQuery({ ...controllerQuery(client), select: canTextGenerationRun }).data === true;
  const scrollRef = useRef<HTMLDivElement>(null);
  // A card that Undo or a refused update brings back is let in at once by the
  // board's reads, which are made after the moves, so the moves call it through this.
  const noteReturnedTask = useRef<(taskId: string, how: EndStage) => void>(() => undefined);
  // The logical board is what is true now, and every action reads it. The
  // drawn board (below) is the same board with arrivals and failures held
  // back for a still hand, and only what is drawn reads that.
  const logical = useLogicalBoard({ scope, serverBoard: board.data });
  const logicalCards = logical.board?.cards ?? EMPTY_CARDS;
  // Whether a card is in the hand of a drag. The drag sets it; the reads wait
  // for it, Undo and the keys stand still for it, and the desk draws it for the stylesheet.
  const [isCarrying, setIsCarrying] = useState(false);
  const moves = useCardMoves({
    client,
    scope,
    readBoard: logical.readBoardNow,
    scrollRef,
    onCardReturning: (taskId, how) => {
      noteReturnedTask.current(taskId, how);
    },
    isCarrying,
  });
  // The sheet that makes or changes an Initiative. It shares the right-hand side with Add to
  // Work and the details, so each of the three closes the other two when it opens.
  const initiativeSheet = useInitiativeSheet({
    client,
    scope,
    sayWithUndo: moves.sayWithUndo,
    sayWithoutUndo: moves.sayWithoutUndo,
  });
  const savedView = useWorkView(
    buildWorkViewKey(url, username),
    initiativesRead.data?.map((initiative) => initiative.id),
  );
  const isNarrow = useMediaQueryMatch(`(max-width: ${String(SIDE_LABELS_FROM_PX - 0.02)}px)`);
  const offlineSince = useOfflineSince(live);
  const findRef = useRef<HTMLInputElement>(null);

  // The board's motion: what the user does to the view plays as motion, a
  // Task that arrives or a run that fails waits for a still hand, and a
  // working colleague whose card is scrolled out of view stops tapping.
  const snapshotKey = buildBoardSnapshotKey(url, username);
  const reads = useBoardReads({
    logicalBoard: logical.board,
    hiddenIds: logical.hiddenIds,
    movedIds: logical.movedIds,
    serverBoard: board.data,
    snapshotKey,
    projects,
    groupBy: savedView.groupBy,
    isCarrying,
    scrollRef,
  });
  useLayoutEffect(() => {
    noteReturnedTask.current = reads.noteReturnedTask;
  });
  usePausePawsOffScreen(scrollRef);
  // The board is not drawn until the Initiatives are in: cards of an Initiative would
  // first show in their lanes, and then jump onto their rows.
  const drawnBoard = initiativesRead.data === undefined ? undefined : reads.drawnBoard;
  const drawnCards = drawnBoard?.cards ?? EMPTY_CARDS;
  const places = drawnBoard?.places ?? EMPTY_PLACES;
  // The answers the user gave from the pane and the app still holds show on
  // their cards as answered; the pane's answer and Try again buttons act here.
  const pane = usePaneChanges({
    client,
    scope,
    boardCards: logicalCards,
    isBoardRead: logical.board !== undefined,
    boardReadAt: board.dataUpdatedAt,
    moves,
    openTaskId,
    scrollRef,
    closePane: () => {
      onChangeOpenTask(null);
    },
  });
  // A merge held for the undo line hides the card that merges away.
  const merging = useMergeCards({
    client,
    scope,
    readBoard: logical.readBoardNow,
    isBoardRead: logical.board !== undefined,
    moves,
    scrollRef,
    openTaskId,
    closePane: () => {
      onChangeOpenTask(null);
    },
  });

  // The lanes of the whole board, for the Filter menu: a Project the filter
  // hides stays in the menu to be chosen again.
  const allLanes = buildLanes({ cards: drawnCards }, projects);
  const facets = buildWorkFacets(
    allLanes,
    { cards: drawnCards, places, groupings: drawnBoard?.groupings ?? [] },
    initiatives,
    plugins,
  );

  // Failed and Has a question lift themselves once no card has them, so an
  // empty page never says nothing. Only a board that was read can say so.
  // This lifts the filter after a read, not on a user's event, so it uses the
  // view without motion.
  const { filter, setFilter } = savedView;
  useEffect(() => {
    if (drawnBoard === undefined) return;
    const next = dropEmptyValues(filter, facets, drawnCards);
    if (next !== filter) setFilter(next);
  }, [drawnBoard, drawnCards, facets, filter, setFilter]);

  const found = findCards(drawnCards, savedView.findText);
  const visibleCards = filterItems(found.matches, savedView.filter, facets);
  // Everything the board draws, worked out once: the lanes and rows under the folds, what is on
  // screen, the counts over the stages and the words under each row. The facts are counted from
  // the logical board and the lanes from the drawn one, so a held-back arrival still counts.
  const arrangement = arrangeBoard({
    logicalBoard: logical.board,
    drawnBoard,
    visibleCards,
    projects,
    initiatives,
    requestedGroupBy: savedView.groupBy,
    place: savedView.display.initiativePlace,
    folds: savedView.folds,
    openedCellIds: savedView.openedCellIds,
    openedStackIds: savedView.openedStackIds,
  });
  // What the user does to the view plays as motion, and a fold reads the rows it moves from the arrangement.
  const view = useViewMotion(savedView, scrollRef, arrangement);
  const { groupBy, groupings } = arrangement;
  // A card under any grouping but Project draws the small flag of its Initiative. The map keeps
  // its identity until the Initiatives or the grouping change, so the cards stay as drawn.
  const initiativeFlags = useMemo(
    () =>
      groupBy === PROJECT_FACET_ID
        ? undefined
        : new Map(initiatives.map((initiative) => [initiative.id, initiative])),
    [initiatives, groupBy],
  );
  // The rows a fold hides are not on screen, so nothing that walks, selects or drops sees them.
  const arrangedLanes = arrangement.drawnLanes;
  const { shownCards } = arrangement;
  // Which cards are selected. A card the board stops drawing leaves the selection.
  const selection = useCardSelection(shownCards.map((card) => card.cardId));
  const tabStop =
    shownCards.find((card) => isSameCardInLane(card, view.currentCard)) ?? shownCards[0] ?? null;

  const isBoardEmpty = arrangement.isEmpty;
  const hasAnyTaskRead = useQuery({ ...hasAnyTaskQuery(client), enabled: isBoardEmpty });
  const hasAnyTask = hasAnyTaskRead.data;

  // The first board fades its words in from the top left, once.
  const hasBoard = drawnBoard !== undefined;
  const isArriving = useFirstArrival(board.data === undefined, hasBoard);

  // The Task the address names when the screen opens is brought into view
  // once the board is on screen, so closing its details leaves the user there.
  // Only that one: a Task opened later was chosen on a card the user can see.
  const [taskNamedOnOpen] = useState(openTaskId);
  const hasShownNamedTask = useRef(false);
  const { setCurrentCard } = view;
  useEffect(() => {
    if (taskNamedOnOpen === null || !hasBoard || hasShownNamedTask.current) return;
    hasShownNamedTask.current = true;
    const scroller = scrollRef.current;
    const element = scroller?.querySelector<HTMLElement>(
      `[data-card-id="${CSS.escape(taskNamedOnOpen)}"]`,
    );
    const at = element === null || element === undefined ? null : readCardInLane(element);
    if (scroller === null || element === null || element === undefined || at === null) return;
    keepCardInView(scroller, element);
    setCurrentCard(at);
  }, [taskNamedOnOpen, hasBoard, setCurrentCard]);

  useFailedArrival({
    isRequested: isOpeningOnFailed,
    hasBoard,
    filter: savedView.filter,
    scrollRef,
    setFilter: savedView.setFilter,
    setFindText: savedView.setFindText,
    setCurrentCard,
    onArrived: onOpenedOnFailed,
  });

  // Merging by key: `M` or the details' Merge picks a card, and choosing
  // another card (Return, or a click) merges the first into it.
  const mergePick = useMergePick({
    scrollRef,
    cards: logicalCards,
    initiatives,
    merge: merging.mergeCard,
    checkMerge: merging.checkMerge,
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
    if (card.id === openTaskId) return;
    // Two sheets would cover each other at the right.
    if (initiativeSheet.isOpen) initiativeSheet.close();
    onChangeOpenTask(card.id);
  };

  const stopRun = useStopRun({ client, scope, say: moves.sayWithoutUndo });

  // Starting a Thread from a card, and moving a Thread to a new Task.
  const threads = useTaskThreads({
    client,
    scope,
    cards: logicalCards,
    readCard: pane.readCard,
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
    moves.moveCardWithMotion(move, describeCardMove(card, move, projects, initiatives));
  };

  /**
   * Shows only the Tasks that are part of the place, from a row of Part of in
   * the details. The filter and the Find text give way to it, so that all the
   * place's Tasks show, and the details close to let the board be seen.
   */
  const filterByPlace = (placeRef: string): void => {
    const place = places.find((each) => each.ref === placeRef);
    if (place === undefined) {
      moves.sayWithoutUndo("That place is not on this board now.");
      return;
    }
    view.setFilter({ [place.kind]: [placeRef] });
    view.setFindText("");
    onChangeOpenTask(null);
  };

  // ---------- Add to Work ----------
  const [addLane, setAddLane] = useState<AddTaskLane | null>(null);
  const [addResult, setAddResult] = useState<string | null>(null);
  const [addOpening, setAddOpening] = useState<AddOpening>({});
  // The Project a thing added from a source joins: the lane's, when a Project lane's `+` opened the sheet.
  const [addProjectId, setAddProjectId] = useState<string | null>(null);
  const addOpener = useRef<HTMLElement | null>(null);
  /**
   * Opens the sheet. `fromLaneId` is the lane whose `+` or key opened it, when
   * one did: From a source then opens on that lane's context, and otherwise on
   * the context the filter is on.
   */
  const openAddSheet = (lane: AddTaskLane, fromLaneId?: string): void => {
    // Closing the Initiative sheet first gives the focus back to what it came from, which is
    // then where this sheet gives it back to.
    if (initiativeSheet.isOpen) initiativeSheet.close();
    addOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAddResult(null);
    setAddOpening(
      chooseAddOpening({
        places,
        filter: view.filter,
        lane: fromLaneId === undefined ? undefined : arrangement.findLane(fromLaneId)?.lane,
      }),
    );
    setAddProjectId(fromLaneId === undefined ? null : lane.projectId);
    setAddLane(lane);
    // Two sheets would cover each other at the right.
    if (openTaskId !== null) onChangeOpenTask(null);
  };
  const closeAddSheet = (): void => {
    setAddLane(null);
    addOpener.current?.focus({ preventScroll: true });
  };
  const toAddLane = (laneId: string): AddTaskLane => {
    const lane = arrangement.findLane(laneId)?.lane ?? allLanes.find((each) => each.id === laneId);
    if (lane === undefined) {
      return { id: NO_PROJECT_LANE_ID, name: NO_PROJECT_LANE_NAME, projectId: null };
    }
    // A Task added on an Initiative joins it, and the Initiative's Project, as a card dropped there would.
    if (lane.initiative !== undefined) {
      const { initiativeId } = lane.initiative;
      const projectId = initiatives.find((each) => each.id === initiativeId)?.projectId;
      return {
        id: lane.id,
        name: lane.name,
        projectId: projects.some((project) => project.id === projectId)
          ? (projectId ?? null)
          : null,
        initiativeId,
      };
    }
    // A lane for an outside place has no Project of its own: a Task added
    // there joins the Project most of its cards are in, and the sheet names it.
    const projectId = chooseLaneProject(lane, new Set(projects.map((project) => project.id)));
    const project = projects.find((each) => each.id === projectId);
    return { id: lane.id, name: project?.name ?? lane.name, projectId };
  };
  /**
   * Returns the lane the toolbar's Add opens in: the current card's, else the
   * first on screen, else No project. A card on an Initiative row stands in
   * no Project lane, so its own Project's lane is the one: the toolbar's Add
   * does not put a Task on an Initiative, only a key or a lane's `+` that
   * names one does.
   */
  const chooseAddLane = (): AddTaskLane => {
    const stopLane = arrangement.findLane(tabStop?.laneId ?? "")?.lane;
    if (stopLane?.initiative?.isRow === true) {
      const card = logicalCards.find((each) => each.id === tabStop?.cardId);
      const projectIds = new Set(projects.map((project) => project.id));
      return toAddLane(card === undefined ? NO_PROJECT_LANE_ID : chooseLaneId(card, projectIds));
    }
    const firstLane = arrangement.lanes[0];
    return toAddLane(tabStop?.laneId ?? firstLane?.lane.id ?? NO_PROJECT_LANE_ID);
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
          ...(lane.initiativeId === undefined ? {} : { initiativeId: lane.initiativeId }),
        },
      }),
    onSuccess: (task, { lane }) => {
      const stage = BOARD_STAGES.find((each) => each === task.stage);
      const where = stage === undefined ? task.stage : STAGE_NAMES[stage];
      const isInNamedLane = lane.projectId !== null || lane.initiativeId !== undefined;
      setAddResult(`Added to ${where}${isInNamedLane ? ` in ${lane.name}` : ""}.`);
      reads.noteAddedTask(task.id);
    },
    onError: (error) => {
      setAddResult(null);
      moves.sayWithoutUndo(`Could not add the Task: ${readErrorMessage(error)}`);
    },
  });

  // ---------- Dragging ----------
  // A card in the hand of a drag and a bead in the hand of a slide are the same to the screen.
  const onCarryingChange = (isCarryingNow: boolean): void => {
    setIsCarrying(isCarryingNow);
    // Something in the hand ends the key flow of a merge.
    if (isCarryingNow) mergePick.cancel();
  };
  useBoardDrag({
    scrollRef,
    cards: logicalCards,
    projects,
    initiatives,
    arrangedLanes,
    selectedIds: selection.selectedIds,
    moveCard: moves.moveCard,
    moveCards: (cardMoves, describe, note) => {
      moves.moveCards(cardMoves, describe, note);
      // The selection was carried and has landed.
      selection.clear();
    },
    say: moves.sayWithoutUndo,
    settleMerge: merging.settleMerge,
    checkMerge: merging.checkMerge,
    onCarryingChange,
  });

  // Sliding a bead along a folded Initiative line, or moving it a stage by key, moves its Task.
  useBeadSlide({
    scrollRef,
    cards: logicalCards,
    projects,
    initiatives,
    moveCard: moves.moveCardWithMotion,
    onCarryingChange,
    isCarrying,
  });

  /** Closes the details and Add to Work, which would cover the Initiative sheet at the right. */
  const clearRightSide = (): void => {
    if (addLane !== null) closeAddSheet();
    if (openTaskId !== null) onChangeOpenTask(null);
  };

  /**
   * Opens the sheet that edits the Initiative `initiativeId`, from the edit
   * button in a row's head.
   */
  const editInitiative = (initiativeId: string): void => {
    clearRightSide();
    initiativeSheet.openEdit(initiativeId);
  };

  /**
   * Opens the sheet that makes a new Initiative, from "New initiative" in Add
   * to Work, which starts it in `fromProjectId`'s lane.
   */
  const createInitiativeFromAddSheet = (fromProjectId: string | null): void => {
    clearRightSide();
    initiativeSheet.openNew(fromProjectId);
  };

  /**
   * Opens the sheet that makes a new Initiative, from "New initiative…" in the
   * details of a Task, which starts it in the Task's Project. The Task's card
   * takes the focus first: the details close, and the sheet gives the focus
   * back to what had it when it opened.
   */
  const createInitiativeFromPane = (): void => {
    const card = logicalCards.find((each) => each.id === openTaskId);
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(openTaskId ?? "")}"]`)
      ?.focus({ preventScroll: true });
    clearRightSide();
    initiativeSheet.openNew(card?.projectId ?? null);
  };

  /** Opens the Task of a bead on an Initiative's line, as a click on its card does. */
  const pressBead = (taskId: string): void => {
    const card = logicalCards.find((each) => each.id === taskId);
    if (card !== undefined) openCard(card);
  };

  // ---------- Keys ----------
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });

  // A click opens the card, or selects it with ⌘ (Ctrl on Linux) held. While a
  // card is picked to merge, every click chooses the card to merge into.
  const pressCardNow = (card: WorkCard, keys: PressedKeys): void => {
    if (mergePick.sourceId === null && isPrimaryModifierHeld(keys, bridge.platform)) {
      selection.toggle(card.id);
    } else {
      openCard(card);
    }
  };
  // The cards get one function for the life of the screen that calls the newest
  // `pressCardNow`. A function that changed with every read or every open
  // sheet would draw every card again, and a card is drawn again only when its
  // own values change.
  const latestPressCard = useRef(pressCardNow);
  useLayoutEffect(() => {
    latestPressCard.current = pressCardNow;
  });
  const pressCard = useCallback((card: WorkCard, keys: PressedKeys): void => {
    latestPressCard.current(card, keys);
  }, []);
  const keys = useBoardKeys({
    view,
    cards: logicalCards,
    arrangedLanes,
    findMatches: found.topMatches,
    projects,
    initiatives,
    moves,
    isCarrying,
    scrollRef,
    findRef,
    onOpenCard: openCard,
    onEndCard: (card, stage) => {
      endTask(card.id, stage);
    },
    onStartThread: threads.askThread,
    selection: {
      count: selection.selectedIds.size,
      toggle: (card) => {
        selection.toggle(card.id);
      },
      clear: selection.clear,
    },
    mergePick,
    onAdd: (laneId) => {
      openAddSheet(laneId === undefined ? chooseAddLane() : toAddLane(laneId), laneId);
    },
    addSheet: { isOpen: addLane !== null, close: closeAddSheet },
    initiativeSheet: { isOpen: initiativeSheet.isOpen, close: initiativeSheet.close },
    taskPane: {
      isOpen: openTaskId !== null,
      close: () => {
        onChangeOpenTask(null);
      },
      pressReturn: (card) => pane.pressReturn(card.id),
    },
  });

  // ---------- What the screen draws ----------
  const toggleFold = (laneId: string): void => {
    const lane = arrangement.findLane(laneId)?.lane;
    if (lane !== undefined) view.toggleFold(lane);
  };
  let state: DeskState = "board";
  let body: JSX.Element | null;
  if (drawnBoard === undefined) {
    state = "loading";
    body = board.isError ? (
      <ReadFailure
        what="The board"
        reason={readErrorMessage(board.error)}
        onRetry={() => {
          void board.refetch();
        }}
      />
    ) : initiativesRead.isError ? (
      <ReadFailure
        what="The initiatives"
        reason={readErrorMessage(initiativesRead.error)}
        onRetry={() => {
          void initiativesRead.refetch();
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
  } else if (arrangement.everyLane.length === 0) {
    body = <NoMatch />;
  } else {
    body = (
      <BoardBody
        arrangement={arrangement}
        plugins={plugins}
        initiativeFlags={initiativeFlags}
        tabStop={tabStop}
        isStill={view.display.isStill}
        canWriteSummaries={canWriteSummaries}
        selectedIds={selection.selectedIds}
        onToggleBlock={view.toggleInitiativeBlock}
        onToggleFold={toggleFold}
        onEditInitiative={editInitiative}
        onPressBead={pressBead}
        onToggleCell={view.toggleCell}
        onToggleStack={view.toggleStack}
        onAddTask={(laneId) => {
          openAddSheet(toAddLane(laneId), laneId);
        }}
        onPressCard={pressCard}
        onFocusCard={view.setCurrentCard}
      />
    );
  }

  return (
    <BoardDesk
      toolbar={
        <WorkToolbar
          pill={<OverviewPill />}
          hasInitiatives={initiatives.length > 0}
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
              const card = logicalCards.find((each) => each.id === id);
              if (card !== undefined) openCard(card);
            },
          }}
          display={view.display}
          onDisplayChange={view.setDisplay}
          onFoldEverything={() => {
            view.foldEverything(arrangement.everyLane.map((each) => each.lane));
          }}
          onShowKeys={keys.showKeysSheet}
          onAdd={() => {
            openAddSheet(chooseAddLane());
          }}
          line={
            offlineSince !== null
              ? describeOffline(offlineSince)
              : (reads.note ??
                (reads.sinceLastLook === null ? null : (
                  <SinceLine text={reads.sinceLastLook} onReplay={reads.playReplayAgain} />
                )))
          }
        />
      }
      overlays={
        <>
          {addLane !== null && (
            <AddTaskSheet
              lane={addLane}
              result={addResult}
              onClose={closeAddSheet}
              onNewInitiative={() => {
                createInitiativeFromAddSheet(addLane.projectId);
              }}
              onCreate={async (title) => {
                await createTask({ title, lane: addLane });
              }}
              fromSource={
                <AddFromSource
                  key={`${addOpening.sourceId ?? ""}|${addOpening.scopeRef ?? ""}`}
                  client={client}
                  places={places}
                  opening={addOpening}
                  projectId={addProjectId}
                  isOffline={offlineSince !== null}
                  reserveGesture={moves.reserveGesture}
                  onAdded={({ taskId, line, wasCreated, gesture }) => {
                    if (!wasCreated) {
                      moves.sayWithoutUndo(line);
                      return;
                    }
                    reads.noteAddedTask(taskId);
                    moves.sayWithReservedUndo(line, gesture);
                  }}
                  onFailed={moves.sayWithoutUndo}
                  onOpenTask={(taskId) => {
                    const card = logicalCards.find((each) => each.id === taskId);
                    if (card === undefined) {
                      moves.sayWithoutUndo("That Task is not on this board.");
                      return;
                    }
                    // Two sheets would cover each other at the right.
                    closeAddSheet();
                    openCard(card);
                  }}
                />
              }
            />
          )}
          <WorkPane
            client={client}
            taskId={openTaskId}
            cards={logicalCards}
            projects={projects}
            scrollRef={scrollRef}
            drawnLanes={arrangedLanes}
            isStill={view.display.isStill}
            intents={pane.intents}
            threadPromptWords={threads.threadPromptWords}
            changes={{
              ...pane.changes,
              onMerge: () => {
                const card = logicalCards.find((each) => each.id === openTaskId);
                if (card !== undefined) mergePick.start(card);
              },
              ...threads.changes,
              onStopRun: (runId, workflowName) => {
                if (openTaskId !== null) stopRun(openTaskId, runId, workflowName);
              },
              onDone: () => {
                if (openTaskId !== null) endTask(openTaskId, "done");
              },
              onDrop: () => {
                if (openTaskId !== null) endTask(openTaskId, "dropped");
              },
            }}
            moveToStage={moveCardToStage}
            onFilterByPlace={filterByPlace}
            onCreateInitiative={createInitiativeFromPane}
            onShown={pane.onPaneShown}
            onChangeTask={onChangeOpenTask}
          />
          {initiativeSheet.sheet}
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
            action={moves.line.action}
            undoKey={describeUndoKey(bridge.platform)}
            isShown={moves.line.isShown}
          />
        </>
      }
      stageCounts={arrangement.stageCounts}
      laneLabels={isNarrow ? "bands" : view.display.laneLabels}
      isOffline={offlineSince !== null}
      isCarrying={isCarrying}
      hasSheet={addLane !== null || openTaskId !== null || initiativeSheet.isOpen}
      isArriving={isArriving}
      state={state}
      scrollRef={scrollRef}
    >
      {body}
      {drawnBoard?.truncated === true && (
        <p className="board-note" role="status">
          The board shows the first {MAX_BOARD_CARDS.toLocaleString("en")} Tasks, and more exist.
          Finish or drop some to bring the rest in.
        </p>
      )}
    </BoardDesk>
  );
}
