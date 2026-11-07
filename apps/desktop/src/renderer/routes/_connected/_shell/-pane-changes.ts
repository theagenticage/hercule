/**
 * What the details pane's answer and Try again buttons do on the Work screen,
 * and how the board shows the answers the user gave.
 *
 * - An answer waits in the pending intents for the undo line, and the card
 *   shows the question as answered meanwhile (`answerFromPane`).
 * - Try again sends `run.rerun`, closes the pane, and plays the hand-off on
 *   the card once the board shows the failure gone (`useTryAgain`).
 */
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@hercule/client-core";
import {
  chooseTaskCard,
  decideQuestionAnswers,
  describeEndWhileTryingAgain,
  listTaskActions,
  showHeldAnswers,
  type EndStage,
} from "@hercule/client-core/work";
import type { TaskDetail, WorkCard } from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import {
  listFailedAnswers,
  listHeldAnswers,
  type PendingIntent,
} from "../../../app/pending-intents";
import { usePendingIntents } from "../../../app/use-pending-intents";
import { settleUnsentAnswers } from "../../../app/unsent-answers";
import { playHandOffBack } from "../../../screens/work/board-flights";
import { useHandOffs } from "../../../screens/work/use-hand-offs";
import type { TaskPaneChanges } from "../../../screens/work/task-pane";
import type { CardMoves } from "./-card-moves";
import { answerFromPane } from "./-pane-answers";
import { isTryAgainStarting, useTryAgain, type FailedCard } from "./-try-again";

/**
 * How long after the pane shows another Task the Return key does nothing, in
 * milliseconds. A Return pressed just as the Task changed may have been meant
 * for the Task before, and Return can send an answer.
 */
const RETURN_QUIET_MS = 250;

/** The buttons of the pane that `usePaneChanges` wires. */
export type PaneChanges = Pick<
  TaskPaneChanges,
  "onTryAgain" | "onAnswer" | "onSendAnswerAgain" | "onDiscardAnswer" | "onReturn"
>;

/** What `usePaneChanges` returns. */
export interface PaneChangesState {
  /** `boardCards`, with the question taken off each card whose answer is held. */
  readonly cards: readonly WorkCard[];
  /** Every intent the app holds, which the pane shows as said or as not sent. */
  readonly intents: readonly PendingIntent[];
  readonly changes: PaneChanges;
  /**
   * Handles Return pressed on the board's card `taskId`. When the pane is open
   * for that Task, does what Return does in the pane and returns `true`.
   * Otherwise does nothing and returns `false`, and the card is opened.
   */
  readonly pressReturn: (taskId: string) => boolean;
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
 * board shows, and `isBoardRead` says the board was read. `moves` shows the
 * undo line and keeps the undo stack, `scrollRef` is the element that scrolls
 * the board, and `closePane` closes the pane.
 *
 * An answer that was not sent belongs to the Task it was given on. When the
 * board no longer shows that Task, the Task is read to see whether it was
 * merged into another (the answer then shows on that one), finished or
 * deleted (the answer is discarded): see `settleUnsentAnswers`.
 */
export const usePaneChanges = ({
  controller,
  username,
  boardCards,
  isBoardRead,
  moves,
  openTaskId,
  scrollRef,
  closePane,
}: {
  readonly controller: SavedController;
  readonly username: string;
  readonly boardCards: readonly WorkCard[];
  readonly isBoardRead: boolean;
  readonly moves: Pick<CardMoves, "sayWithUndo" | "sayWithoutUndo">;
  readonly openTaskId: string | null;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly closePane: () => void;
}): PaneChangesState => {
  const queryClient = useQueryClient();
  const { store, intents } = usePendingIntents(controller, username);

  const heldAnswers = useMemo(() => listHeldAnswers(intents), [intents]);
  const cards = useMemo(() => showHeldAnswers(boardCards, heldAnswers), [boardCards, heldAnswers]);

  // The Tasks of unsent answers that the board does not show. A key of their
  // ids, so a board read that changes nothing here starts no reads.
  const missingTaskIds = isBoardRead
    ? [
        ...new Set(
          listFailedAnswers(intents)
            .map((intent) => intent.taskId)
            .filter((taskId) => !boardCards.some((card) => card.id === taskId)),
        ),
      ]
    : [];
  const missingTaskKey = missingTaskIds.join(",");
  useEffect(() => {
    if (missingTaskKey === "") return;
    void settleUnsentAnswers(controller.client, store, missingTaskKey.split(","));
  }, [controller.client, store, missingTaskKey]);

  // A Try again that was accepted plays its hand-off once the board stops
  // showing the card's failure, or at once when it already stopped.
  const { noteHandOff, forgetHandOff } = useHandOffs(scrollRef, cards);
  const tryAgain = useTryAgain(controller.client, {
    sayWithUndo: moves.sayWithUndo,
    sayWithoutUndo: moves.sayWithoutUndo,
    onStarted: (taskId) => {
      noteHandOff(taskId, "failure-clears");
    },
    onUndone: (taskId) => {
      // A hand-off still waiting never played, so there is nothing to play back.
      if (forgetHandOff(taskId)) return;
      const element = scrollRef.current?.querySelector<HTMLElement>(`[data-card-id="${taskId}"]`);
      if (element != null) playHandOffBack(element);
    },
  });

  // When the pane started to show this Task, for the Return key's quiet moment.
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = performance.now();
  }, [openTaskId]);

  const readFailedCard = (taskId: string): FailedCard | null => {
    const card = chooseTaskCard(
      cards,
      taskId,
      queryClient.getQueryData<TaskDetail>(queryKeys.taskDetail(taskId)),
    );
    return card?.failure === undefined
      ? null
      : { id: card.id, title: card.title, failure: card.failure };
  };

  /** Tries again the failed run of the Task `taskId`, and closes the pane when it started. */
  const tryAgainTask = (taskId: string): void => {
    const failed = readFailedCard(taskId);
    if (failed !== null && tryAgain(failed)) closePane();
  };

  /**
   * Does what Return does for the open Task: tries a failed run again, else
   * sends the suggested answer of a question the pane can answer. A failure
   * leads, as in the pane (`listTaskActions`). Does nothing in the quiet moment
   * after the pane showed the Task.
   */
  const doReturnKey = (taskId: string): void => {
    if (performance.now() - shownAt.current < RETURN_QUIET_MS) return;
    const detail = queryClient.getQueryData<TaskDetail>(queryKeys.taskDetail(taskId));
    const card = chooseTaskCard(cards, taskId, detail);
    if (card === undefined) return;
    // The failure is the card's, the newest word of the board. The question
    // is the details': a card whose answer is held has had its question taken off.
    const question = detail === undefined ? null : decideQuestionAnswers(detail);
    const { returnKey } = listTaskActions({ failure: card.failure, question });
    if (returnKey === "try-again") {
      tryAgainTask(taskId);
      return;
    }
    const suggested =
      returnKey === "send-suggested-answer" && question?.kind === "answerable"
        ? question.chips.find((chip) => chip.suggested)
        : undefined;
    if (question?.kind === "answerable" && suggested !== undefined) {
      answerFromPane(
        queryClient,
        store,
        taskId,
        question,
        { kind: "chip", label: suggested.label },
        { sayWithUndo: moves.sayWithUndo, sayWithoutUndo: moves.sayWithoutUndo, closePane },
      );
    }
  };

  return {
    cards,
    intents,
    pressReturn: (taskId) => {
      if (taskId !== openTaskId) return false;
      doReturnKey(taskId);
      return true;
    },
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
        if (openTaskId !== null) tryAgainTask(openTaskId);
      },
      onReturn: () => {
        if (openTaskId !== null) doReturnKey(openTaskId);
      },
      onAnswer: (answer, question) => {
        if (openTaskId === null) return;
        answerFromPane(queryClient, store, openTaskId, question, answer, {
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
