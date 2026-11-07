/**
 * What the details pane's answer and Try again buttons do on the Work screen,
 * and how the board shows the answers the user gave.
 *
 * - An answer waits in the pending intents for the undo line, and the card
 *   shows the question as answered meanwhile (`answerFromPane`).
 * - Try again sends `run.rerun`, closes the pane, and plays the hand-off on
 *   the card once the board shows the failure gone (`useTryAgain`).
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@hercule/client-core";
import {
  describeEndWhileTryingAgain,
  showHeldAnswers,
  type EndStage,
} from "@hercule/client-core/work";
import type { TaskDetail, WorkCard } from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import type { PendingIntent } from "../../../app/pending-intents";
import { usePendingIntents } from "../../../app/use-pending-intents";
import { playHandOff, playHandOffBack } from "../../../screens/work/board-flights";
import type { TaskPaneChanges } from "../../../screens/work/task-pane";
import type { CardMoves } from "./-card-moves";
import { answerFromPane } from "./-pane-answers";
import { isTryAgainStarting, useTryAgain, type FailedCard } from "./-try-again";

/** The buttons of the pane that `usePaneChanges` wires. */
export type PaneChanges = Pick<
  TaskPaneChanges,
  "onTryAgain" | "onAnswer" | "onSendAnswerAgain" | "onDiscardAnswer"
>;

/** What `usePaneChanges` returns. */
export interface PaneChangesState {
  /** `boardCards`, with the question taken off each card whose answer is held. */
  readonly cards: readonly WorkCard[];
  /** Every intent the app holds, which the pane shows as said or as not sent. */
  readonly intents: readonly PendingIntent[];
  readonly changes: PaneChanges;
  /**
   * Checks whether Done or Drop may go ahead on the Task `taskId`. When a Try
   * again is still starting its run, says on the undo line that it must wait
   * and returns `true`: the caller then does nothing. A retry that is still
   * starting could otherwise be racing the end of the Task.
   */
  readonly refuseEndWhileTryingAgain: (taskId: string, stage: EndStage) => boolean;
}

/**
 * Wires the details pane's answer and Try again buttons for the Task
 * `openTaskId`, and returns the cards to draw. `boardCards` are the cards the
 * board shows. `moves` shows the undo line and keeps the undo stack,
 * `scrollRef` is the element that scrolls the board, and `closePane` closes the
 * pane.
 */
export const usePaneChanges = ({
  controller,
  username,
  boardCards,
  moves,
  openTaskId,
  scrollRef,
  closePane,
}: {
  readonly controller: SavedController;
  readonly username: string;
  readonly boardCards: readonly WorkCard[];
  readonly moves: Pick<CardMoves, "sayWithUndo" | "sayWithoutUndo">;
  readonly openTaskId: string | null;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly closePane: () => void;
}): PaneChangesState => {
  const queryClient = useQueryClient();
  const { store, intents } = usePendingIntents(controller, username);

  const heldAnswers = useMemo(
    () =>
      intents.filter(
        (intent): intent is PendingIntent & { readonly kind: "answer" } =>
          intent.kind === "answer" && intent.state !== "failed",
      ),
    [intents],
  );
  const cards = useMemo(() => showHeldAnswers(boardCards, heldAnswers), [boardCards, heldAnswers]);

  // The Tasks whose Try again was accepted and whose card has not shown the
  // plaster going yet. The hand-off plays once it does: when the board
  // changes, or at once when the board already changed before the answer came.
  const startedTaskIds = useRef(new Set<string>());
  const shownCards = useRef(cards);
  const findCardElement = useCallback(
    (taskId: string) => scrollRef.current?.querySelector<HTMLElement>(`[data-card-id="${taskId}"]`),
    [scrollRef],
  );
  const playHandOffsOfShownCards = useCallback(() => {
    for (const taskId of startedTaskIds.current) {
      const card = shownCards.current.find((each) => each.id === taskId);
      if (card === undefined) {
        startedTaskIds.current.delete(taskId);
      } else if (card.failure === undefined) {
        startedTaskIds.current.delete(taskId);
        const element = findCardElement(taskId);
        if (element != null) playHandOff(element);
      }
    }
  }, [findCardElement]);
  useEffect(() => {
    shownCards.current = cards;
    playHandOffsOfShownCards();
  }, [cards, playHandOffsOfShownCards]);
  const tryAgain = useTryAgain(controller.client, {
    sayWithUndo: moves.sayWithUndo,
    sayWithoutUndo: moves.sayWithoutUndo,
    onStarted: (taskId) => {
      startedTaskIds.current.add(taskId);
      playHandOffsOfShownCards();
    },
    onUndone: (taskId) => {
      // A hand-off still waiting never played, so there is nothing to play back.
      if (startedTaskIds.current.delete(taskId)) return;
      const element = findCardElement(taskId);
      if (element != null) playHandOffBack(element);
    },
  });

  const readFailedCard = (taskId: string): FailedCard | null => {
    const card =
      cards.find((each) => each.id === taskId) ??
      queryClient.getQueryData<TaskDetail>(queryKeys.taskDetail(taskId))?.card;
    return card?.failure === undefined
      ? null
      : { id: card.id, title: card.title, failure: card.failure };
  };

  return {
    cards,
    intents,
    refuseEndWhileTryingAgain: (taskId, stage) => {
      const failed = readFailedCard(taskId);
      if (failed === null || !isTryAgainStarting(queryClient, taskId, failed.failure.runId)) {
        return false;
      }
      moves.sayWithoutUndo(describeEndWhileTryingAgain(failed.title, stage));
      return true;
    },
    changes: {
      onTryAgain: () => {
        const failed = openTaskId === null ? null : readFailedCard(openTaskId);
        if (failed !== null && tryAgain(failed)) closePane();
      },
      onAnswer: (answer) => {
        if (openTaskId === null) return;
        answerFromPane(queryClient, store, openTaskId, answer, {
          sayWithUndo: moves.sayWithUndo,
          sayWithoutUndo: moves.sayWithoutUndo,
          closePane,
        });
      },
      onSendAnswerAgain: (intentId) => {
        void store.retry(intentId);
      },
      onDiscardAnswer: (intentId) => {
        store.discard(intentId);
      },
    },
  };
};
