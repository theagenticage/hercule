import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { isNotFound, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import { findNextAgeChange } from "@hercule/client-core";
import {
  buildCellId,
  buildTaskPane,
  chooseLaneId,
  describeSummaryStanding,
  type ArrangedLane,
  type SummaryStanding,
  type TaskPaneContent,
} from "@hercule/client-core/work";
import type { BoardStage, Project, WorkCard } from "@hercule/contract";
import { useClockValue } from "../../../app/age-clock";
import {
  listHeldAnswers,
  listUnsentAnswers,
  type PendingIntent,
} from "../../../app/pending-intents";
import { controllerQuery, pluginsQuery } from "../../../app/queries";
import { useWindowVisible } from "../../../app/window-visibility";
import { LinkSearch, OpeningSheet, type SheetPlaces } from "../../../screens/desk";
import { markCardDent, readSheetOrigin } from "../../../screens/work/pane-anchor";
import { computeTaskPaneRect } from "../../../screens/work/task-pane-rect";
import {
  TaskPane,
  TaskPaneColleague,
  type TaskPaneActions,
  type TaskPaneChanges,
  type TaskPaneRead,
} from "../../../screens/work/task-pane";
import { taskDetailQuery } from "./-work-board";

/** How long the line "This Task no longer exists." shows before the pane closes, in milliseconds. */
const GONE_LINE_MS = 1_600;

/** What Text Generation says when the controller has not been read yet: that it can run, so no note says summaries are off. */
const TEXT_GENERATION_UNKNOWN = { unavailableReason: null } as const;

/**
 * Renders the details of the Task whose id is in the address, on the sheet
 * that opens out of its card, and closes back into it. It reads the Task's
 * details when it opens and keeps them current from the live pushes. It
 * owns:
 *
 * - Which Task the sheet shows. The address says which Task is wanted
 *   (`taskId`); the sheet shows the one it last had until it has closed all
 *   the way, so it never disappears in the middle of closing.
 * - The Task's place on the board: the sheet grows from its card, from the
 *   line that holds it, or from nothing when the board has neither, and the
 *   card's place stays open as a dent while the sheet is up.
 * - A Task that was merged into another: the read answers with the survivor,
 *   and the address takes the survivor's id in place, so the sheet stays open
 *   and shows it.
 * - A Task that was deleted, also after its details were read: a line says
 *   so, and the sheet closes.
 *
 * `drawnLanes` are the lanes the board draws now. The dent is put on the card
 * again whenever they change, because a card the board draws again is a new
 * element. `threadPromptWords` turns the pane's foot into the line that asks what a new
 * Thread should do, starting with those words; `null` leaves the foot as it is.
 * `intents` are the answers the app holds, which the pane shows as said or
 * as not sent. `onShown` is told the pane's content after every draw, and
 * with `null` when the sheet is gone, so that the keys act on the content
 * that is on screen. `changes` are the pane's buttons that change something. `moveToStage` is how a
 * click on the stage path moves the card, through the board's own moves.
 * `onFilterByPlace` is what a click on a row of Part of does: it filters the
 * board to that place. `onChangeTask` changes the address: a Task's id to show it, `null` to close.
 */
export function WorkPane({
  client,
  taskId,
  cards,
  projects,
  scrollRef,
  drawnLanes,
  isStill,
  intents,
  threadPromptWords,
  changes,
  moveToStage,
  onFilterByPlace,
  onShown,
  onChangeTask,
}: {
  readonly client: HerculeClient;
  readonly taskId: string | null;
  readonly cards: readonly WorkCard[];
  readonly projects: readonly Project[];
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly drawnLanes: readonly ArrangedLane[];
  readonly isStill: boolean;
  readonly intents: readonly PendingIntent[];
  readonly threadPromptWords: string | null;
  readonly changes: TaskPaneChanges;
  readonly moveToStage: (card: WorkCard, stage: BoardStage) => void;
  readonly onFilterByPlace: (placeRef: string) => void;
  readonly onShown: (pane: TaskPaneContent | null) => void;
  readonly onChangeTask: (taskId: string | null) => void;
}): JSX.Element | null {
  const [presentedId, setPresentedId] = useState(taskId);
  if (taskId !== null && taskId !== presentedId) setPresentedId(taskId);
  const wantedId = useRef(taskId);
  useLayoutEffect(() => {
    wantedId.current = taskId;
  });

  // The dent stays on the card of the Task the sheet shows. A card the board
  // draws again is a new element, so it is marked again whenever the lanes change.
  useLayoutEffect(() => {
    markCardDent(scrollRef.current, presentedId);
  }, [scrollRef, presentedId, drawnLanes]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    return () => {
      markCardDent(scroller, null);
    };
  }, [scrollRef]);

  // Closing hands the focus back to the card, so the keys go on from it.
  useLayoutEffect(() => {
    if (taskId !== null || presentedId === null) return;
    const inSheet = document.activeElement?.closest(".opening-sheet") != null;
    if (!inSheet) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-card-id="${presentedId}"]`)
      ?.focus({ preventScroll: true });
    // Only the moment the address clears matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  if (presentedId === null) return null;
  return (
    <PresentedTask
      client={client}
      presentedId={presentedId}
      isWanted={taskId !== null}
      cards={cards}
      projects={projects}
      scrollRef={scrollRef}
      isStill={isStill}
      intents={intents}
      threadPromptWords={threadPromptWords}
      changes={changes}
      moveToStage={moveToStage}
      onFilterByPlace={onFilterByPlace}
      onShown={onShown}
      onChangeTask={onChangeTask}
      onClosed={() => {
        // A sheet that was opened again while it closed has an id to show.
        if (wantedId.current === null) setPresentedId(null);
      }}
    />
  );
}

/** Renders the sheet for the Task `presentedId`. It reads that Task's details, so it exists only while a Task is shown. */
function PresentedTask({
  client,
  presentedId,
  isWanted,
  cards,
  projects,
  scrollRef,
  isStill,
  intents,
  threadPromptWords,
  changes,
  moveToStage,
  onFilterByPlace,
  onShown,
  onChangeTask,
  onClosed,
}: {
  readonly client: HerculeClient;
  readonly presentedId: string;
  readonly isWanted: boolean;
  readonly cards: readonly WorkCard[];
  readonly projects: readonly Project[];
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly isStill: boolean;
  readonly intents: readonly PendingIntent[];
  readonly threadPromptWords: string | null;
  readonly changes: TaskPaneChanges;
  readonly moveToStage: (card: WorkCard, stage: BoardStage) => void;
  readonly onFilterByPlace: (placeRef: string) => void;
  readonly onShown: (pane: TaskPaneContent | null) => void;
  readonly onChangeTask: (taskId: string | null) => void;
  readonly onClosed: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isVisible = useWindowVisible();
  const detail = useQuery({ ...taskDetailQuery(client, presentedId), enabled: isVisible });
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const controller = useQuery(controllerQuery(client));
  const textGeneration = controller.data?.textGeneration ?? TEXT_GENERATION_UNKNOWN;
  const summary = detail.data?.card.summary;

  // The note under "where it stands" counts the age of the summary.
  const nowMs = useClockValue(
    summary?.generatedAt ?? "",
    summary !== undefined,
    findNextAgeChange,
    (now) => now.getTime(),
  );
  const standing: SummaryStanding | null =
    detail.data === undefined
      ? null
      : describeSummaryStanding(summary, new Date(nowMs), textGeneration);

  // A read that says the Task is gone wins over the details kept from before:
  // the cache keeps the old data after a failed refetch, and a deleted Task
  // must not stay actionable.
  const isGone = detail.isError && isNotFound(detail.error);

  // Everything the sheet shows and does, worked out once. The buttons and the
  // Return key act on this same value, through `onShown`.
  const pane = buildTaskPane({
    taskId: presentedId,
    boardCards: cards,
    detail: detail.data,
    isGone,
    heldAnswers: listHeldAnswers(intents),
    unsentAnswers: listUnsentAnswers(intents, presentedId),
  });
  const card = pane.card;
  useLayoutEffect(() => {
    onShown(pane);
  });
  useLayoutEffect(
    () => () => {
      onShown(null);
    },
    [onShown],
  );
  // A Task with no Project has an empty crumb.
  const projectName =
    card?.projectId === undefined
      ? null
      : (projects.find((each) => each.id === card.projectId)?.name ?? null);

  // A merged Task answers with the survivor: the address takes its id in
  // place, and the survivor's read is the one just made.
  const survivorId = detail.data?.task.id;
  useEffect(() => {
    if (survivorId === undefined || survivorId === presentedId || !isWanted) return;
    queryClient.setQueryData(taskDetailQuery(client, survivorId).queryKey, detail.data);
    onChangeTask(survivorId);
  }, [survivorId, presentedId, isWanted, queryClient, client, detail.data, onChangeTask]);

  useEffect(() => {
    if (!isGone || !isWanted) return;
    const timer = setTimeout(() => {
      onChangeTask(null);
    }, GONE_LINE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isGone, isWanted, onChangeTask]);

  let read: TaskPaneRead;
  if (isGone) {
    read = { status: "gone" };
  } else if (detail.data !== undefined && standing !== null && survivorId === presentedId) {
    read = { status: "ready", detail: detail.data, standing };
  } else if (detail.isError) {
    read = { status: "failed", message: readErrorMessage(detail.error) };
  } else {
    read = { status: "loading" };
  }

  const actions: TaskPaneActions = {
    ...changes,
    onMoveToStage: (stage) => {
      if (card !== undefined) moveToStage(card, stage);
    },
    onOpenRun: (runId) => {
      void navigate({ to: "/runs/$runId", params: { runId } });
    },
    onOpenThread: (sessionId) => {
      void navigate({ to: "/threads/$sessionId", params: { sessionId } });
    },
    onFilterByPlace,
    onOpenTextGeneration: () => {
      void navigate({ to: "/settings/system" });
    },
    onRetryRead: () => {
      void detail.refetch();
    },
    onStepBack: () => {
      onChangeTask(null);
    },
  };

  const readPlaces = (): SheetPlaces => {
    const scroller = scrollRef.current;
    const desk = scroller?.closest(".work-desk")?.getBoundingClientRect();
    const destination = computeTaskPaneRect(
      desk ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
    );
    const boardCard = cards.find((each) => each.id === presentedId);
    if (boardCard === undefined)
      return { origin: readSheetOrigin(scroller ?? null, null), destination };
    const laneId = chooseLaneId(boardCard, new Set(projects.map((each) => each.id)));
    const origin = readSheetOrigin(scroller ?? null, {
      taskId: boardCard.id,
      laneId,
      cellId: buildCellId(laneId, boardCard.stage),
      stage: boardCard.stage,
    });
    return { origin, destination };
  };

  return (
    <OpeningSheet
      isOpen={isWanted}
      contentKey={presentedId}
      label={card?.title ?? "Task details"}
      readPlaces={readPlaces}
      onClosed={onClosed}
      className="task-sheet"
      behind={<div className="task-sheet-dim" aria-hidden="true" />}
      head={<TaskPaneColleague card={card} isStill={isStill} />}
    >
      <TaskPane
        pane={pane}
        projectName={projectName}
        read={read}
        plugins={plugins}
        threadPromptWords={threadPromptWords}
        linkSearch={
          read.status === "ready" ? (
            <LinkSearch
              client={client}
              size="tall"
              excludedRefs={read.detail.entities.map((entity) => entity.ref)}
              onPick={changes.onLinkEntity}
            />
          ) : null
        }
        actions={actions}
      />
    </OpeningSheet>
  );
}
