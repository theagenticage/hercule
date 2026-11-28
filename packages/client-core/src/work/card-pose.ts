import type { WorkCard } from "@hercule/contract";

/** How the colleague behind a card stands: a plaster for a failure, a raised palm for a question, typing at work. */
export type CardPose = "failed" | "waiting" | "working";

/** The pose of the colleague behind a card, and the session whose face and seed it takes. */
export interface CardColleaguePose {
  readonly pose: CardPose;
  readonly sessionId: string;
}

/**
 * Returns the pose of the colleague standing behind the top edge of `card`
 * and the session it belongs to, or `null` when nobody stands there. The three
 * facts of a card are independent, and the pose follows the one that matters
 * most: a failure, then a question, then a live session. The session is the
 * one the pose belongs to; a failed card with no live session falls back to
 * the session that asked, then to the card's newest.
 */
export const chooseCardColleaguePose = (card: WorkCard): CardColleaguePose | null => {
  const [pose, sessionId] =
    card.failure !== undefined
      ? ([
          "failed",
          card.workingSessionId ?? card.openQuestion?.sessionId ?? card.openSessionId,
        ] as const)
      : card.openQuestion !== undefined
        ? (["waiting", card.openQuestion.sessionId] as const)
        : (["working", card.workingSessionId] as const);
  return sessionId === undefined ? null : { pose, sessionId };
};
