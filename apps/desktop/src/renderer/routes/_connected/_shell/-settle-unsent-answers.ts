/**
 * Keeps the unsent answers of a Task the board no longer shows reachable (see
 * `settleUnsentAnswers`): they move to the Task it was merged into, or go when
 * it was deleted.
 */
import { useEffect, useRef } from "react";
import type { HerculeClient } from "@hercule/client-core";
import type { WorkCard } from "@hercule/contract";
import {
  listFailedAnswers,
  type PendingIntent,
  type PendingIntents,
} from "../../../app/pending-intents";
import { settleUnsentAnswers } from "../../../app/unsent-answers";

/**
 * Settles the unsent answers of each Task that `intents` hold answers for and
 * `boardCards` does not show, once the board was read (`isBoardRead`).
 *
 * It reads when the set of those Tasks changes. When a read got no answer
 * from the controller, it reads again after the next board read, which is
 * `boardReadAt` changing: a board read arriving means the controller is
 * reachable again. It never reads in a loop: once every read was answered, a
 * board read starts no read.
 */
export const useSettleUnsentAnswers = ({
  client,
  store,
  intents,
  boardCards,
  isBoardRead,
  boardReadAt,
}: {
  readonly client: HerculeClient;
  readonly store: PendingIntents;
  readonly intents: readonly PendingIntent[];
  readonly boardCards: readonly WorkCard[];
  readonly isBoardRead: boolean;
  /** When the board was last read, in milliseconds (`dataUpdatedAt`). */
  readonly boardReadAt: number;
}): void => {
  const missingTaskIds = isBoardRead
    ? [
        ...new Set(
          listFailedAnswers(intents)
            .map((intent) => intent.taskId)
            .filter((taskId) => !boardCards.some((card) => card.id === taskId)),
        ),
      ]
    : [];
  // A key of the ids, so a board read that changes nothing here starts no read.
  const missingTaskKey = missingTaskIds.join(",");
  // The key that a read has answered fully. Two reads that overlap do no
  // harm: settling is repeatable.
  const settledKey = useRef("");
  useEffect(() => {
    if (missingTaskKey === "" || settledKey.current === missingTaskKey) return;
    void settleUnsentAnswers(client, store, missingTaskKey.split(",")).then((isSettled) => {
      if (isSettled) settledKey.current = missingTaskKey;
    });
    // `boardReadAt` is a trigger only: it tries again after a failed read.
  }, [client, store, missingTaskKey, boardReadAt]);
};
