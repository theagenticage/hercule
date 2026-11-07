import type { TaskDetail, WorkCard } from "@hercule/contract";

/**
 * Returns the card to read the Task `taskId` from: the board's card when the
 * board has it, else the card of the Task's `detail`, else `undefined`. The
 * board's card is the newer of the two, because it shows a move the controller
 * has not answered yet, so the title, the stage and the failure never lag
 * behind the board.
 */
export const chooseTaskCard = (
  boardCards: readonly WorkCard[],
  taskId: string,
  detail: Pick<TaskDetail, "card"> | undefined,
): WorkCard | undefined => boardCards.find((card) => card.id === taskId) ?? detail?.card;
