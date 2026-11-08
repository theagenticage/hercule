/**
 * What the details pane's answer and Try again buttons do on the Work screen,
 * and how the board shows the answers the user gave.
 *
 * - An answer waits in the pending intents for the undo line, and the card
 *   shows the question as answered meanwhile (`answerFromPane`).
 * - Try again sends `run.rerun`, closes the pane, and plays the hand-off on
 *   the card once the board shows the failure gone (`useTryAgain`).
 * - Link and Unlink on Linked send `task.linkEntity` and `task.unlinkEntity`
 *   for the Task the pane shows, with an Undo (`useTaskLinks`).
 */
import { useEffect, useRef, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { nameLinkedThing } from "@hercule/client-core/desk";
import {
  describeEndWhileTryingAgain,
  type EndStage,
  type TaskPaneContent,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import type { HerculeClient } from "@hercule/client-core";
import type { AccountScope } from "../../../app/account-scope";
import type { PendingIntent } from "../../../app/pending-intents";
import { usePendingIntents } from "../../../app/use-pending-intents";
import { playHandOffBack } from "../../../screens/work/board-flights";
import { useHandOffs } from "../../../screens/work/use-hand-offs";
import type { TaskPaneChanges } from "../../../screens/work/task-pane";
import type { CardMoves } from "./-card-moves";
import { answerFromPane } from "./-pane-answers";
import { useSettleUnsentAnswers } from "./-settle-unsent-answers";
import { useTaskLinks } from "./-task-links";
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
  | "onTryAgain"
  | "onAnswer"
  | "onSendAnswerAgain"
  | "onDiscardAnswer"
  | "onReturn"
  | "onLinkEntity"
  | "onUnlinkEntity"
>;

/** What `usePaneChanges` returns. */
export interface PaneChangesState {
  /** Every intent the app holds, which the pane shows as said or as not sent. */
  readonly intents: readonly PendingIntent[];
  /**
   * Takes what the open sheet shows (`null` when it is gone). The pane's
   * buttons and the Return key act on the last value given, so they act on
   * what is on screen.
   */
  readonly onPaneShown: (pane: TaskPaneContent | null) => void;
  /**
   * Returns the card of the Task `taskId`: the one the open pane shows when
   * it is for that Task, else the board's.
   */
  readonly readCard: (taskId: string) => WorkCard | undefined;
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
 * `openTaskId`. `boardCards` are the cards of the logical board, which
 * already show a held answer as answered (`buildLogicalBoard`), `isBoardRead` says the board was read, and `boardReadAt` is when. `moves` shows the
 * undo line and keeps the undo stack, `scrollRef` is the element that scrolls
 * the board, and `closePane` closes the pane.
 *
 * An answer that was not sent belongs to the Task it was given on. When the
 * board no longer shows that Task, the Task is read to see whether it was
 * merged into another (the answer then shows on that one), finished or
 * deleted (the answer is discarded): see `useSettleUnsentAnswers`.
 */
export const usePaneChanges = ({
  client,
  scope,
  boardCards,
  isBoardRead,
  boardReadAt,
  moves,
  openTaskId,
  scrollRef,
  closePane,
}: {
  readonly client: HerculeClient;
  /** The signed-in user's scope, which holds the intents and says whether a request is still theirs. */
  readonly scope: AccountScope;
  readonly boardCards: readonly WorkCard[];
  readonly isBoardRead: boolean;
  /** When the board was last read, in milliseconds, which tells an unsent answer's Task to be looked up again. */
  readonly boardReadAt: number;
  readonly moves: Pick<
    CardMoves,
    "sayWithUndo" | "sayWithoutUndo" | "reserveGesture" | "sayWithReservedUndo"
  >;
  readonly openTaskId: string | null;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly closePane: () => void;
}): PaneChangesState => {
  const queryClient = useQueryClient();
  // What the open sheet shows. A ref, because only a click or a key reads it.
  const shownPane = useRef<TaskPaneContent | null>(null);
  const { store, intents } = usePendingIntents(scope);

  useSettleUnsentAnswers({
    client,
    store,
    intents,
    boardCards,
    isBoardRead,
    boardReadAt,
  });

  // A Try again that was accepted plays its hand-off once the board stops
  // showing the card's failure, or at once when it already stopped.
  const { noteHandOff, forgetHandOff } = useHandOffs(scrollRef, boardCards);
  const tryAgain = useTryAgain(client, scope, {
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

  const taskLinks = useTaskLinks({ client, scope, moves });

  // When the pane started to show this Task, for the Return key's quiet moment.
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = performance.now();
  }, [openTaskId]);

  const readCard = (taskId: string): WorkCard | undefined =>
    shownPane.current?.taskId === taskId
      ? shownPane.current.card
      : boardCards.find((each) => each.id === taskId);

  const buildFailedCard = (card: WorkCard | undefined): FailedCard | null =>
    card?.failure === undefined ? null : { id: card.id, title: card.title, failure: card.failure };

  /** Tries again the failed run of the card of `pane`, and closes the pane when it started. */
  const tryAgainPane = (pane: TaskPaneContent): void => {
    const failed = buildFailedCard(pane.card);
    if (failed !== null && tryAgain(failed)) closePane();
  };

  const answerCallbacks = {
    sayWithUndo: moves.sayWithUndo,
    sayWithoutUndo: moves.sayWithoutUndo,
    closePane,
  };

  /**
   * Does what Return does in `pane`: tries a failed run again, else sends the
   * suggested answer of a question the pane can answer (`returnAction`). Does
   * nothing in the quiet moment after the pane showed the Task.
   */
  const doReturnKey = (pane: TaskPaneContent): void => {
    if (performance.now() - shownAt.current < RETURN_QUIET_MS) return;
    const action = pane.actions?.returnAction;
    if (action?.kind === "try-again") {
      tryAgainPane(pane);
    } else if (action?.kind === "send-suggested-answer") {
      answerFromPane(store, pane.taskId, action.question, action.answer, answerCallbacks);
    }
  };

  return {
    intents,
    onPaneShown: (pane) => {
      shownPane.current = pane;
    },
    readCard,
    pressReturn: (taskId) => {
      if (taskId !== openTaskId) return false;
      if (shownPane.current?.taskId === taskId) doReturnKey(shownPane.current);
      return true;
    },
    refuseEndWhileTryingAgain: (taskId, stage) => {
      const failed = buildFailedCard(readCard(taskId));
      if (failed === null || !isTryAgainStarting(queryClient, taskId, failed.failure.runId)) {
        return false;
      }
      moves.sayWithoutUndo(describeEndWhileTryingAgain(failed.title, stage));
      return true;
    },
    changes: {
      onTryAgain: () => {
        if (shownPane.current !== null) tryAgainPane(shownPane.current);
      },
      onReturn: () => {
        if (shownPane.current !== null) doReturnKey(shownPane.current);
      },
      onAnswer: (answer) => {
        const pane = shownPane.current;
        if (pane?.question?.kind !== "answerable") return;
        answerFromPane(store, pane.taskId, pane.question, answer, answerCallbacks);
      },
      onSendAnswerAgain: (intentId) => {
        void store.retry(intentId);
      },
      onDiscardAnswer: (intentId) => {
        store.discard(intentId);
      },
      onLinkEntity: (row) => {
        const pane = shownPane.current;
        if (pane?.card === undefined) return;
        taskLinks.link({
          taskId: pane.taskId,
          taskTitle: pane.card.title,
          ref: row.ref,
          // A search row always has an identifier, so this names it the way a linked row is named.
          thingName: nameLinkedThing({ ...row, noun: row.title }),
        });
      },
      onUnlinkEntity: (row) => {
        const pane = shownPane.current;
        if (pane?.card === undefined) return;
        taskLinks.unlink({
          taskId: pane.taskId,
          taskTitle: pane.card.title,
          ref: row.ref,
          thingName: nameLinkedThing(row),
        });
      },
    },
  };
};
