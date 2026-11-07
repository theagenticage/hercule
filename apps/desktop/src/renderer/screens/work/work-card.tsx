import type { JSX } from "react";
import { describeCardFailure, describeCardForReader, isLoudCard } from "@hercule/client-core/work";
import { findNextDeskAgeChange } from "@hercule/client-core/desk";
import type { WorkCard } from "@hercule/contract";
import { useClockValue, useDeskAgeLabel } from "../../app/age-clock";
import { buildLook } from "../../faces";
import { Card, type CardColleague, type CardNowTone } from "../desk";

/**
 * Returns the colleague standing behind the top edge of `card`, or `null` when
 * nobody does. The three facts of a card are independent, and the pose follows
 * the one that matters most: a failure (a plaster, no paws), then a question
 * (a raised palm), then a live session (typing). The face is the session's:
 * the one the pose belongs to, else the card's newest.
 */
const chooseColleague = (card: WorkCard, isStill: boolean): CardColleague | null => {
  const [pose, sessionId] =
    card.failure !== undefined
      ? ([
          "failed",
          card.workingSessionId ?? card.openQuestion?.sessionId ?? card.openSessionId,
        ] as const)
      : card.openQuestion !== undefined
        ? (["waiting", card.openQuestion.sessionId] as const)
        : (["working", card.workingSessionId] as const);
  if (sessionId === undefined) return null;
  return { look: buildLook(sessionId), pose, seed: sessionId, still: isStill };
};

/** Returns the second line of `card` and how it reads, or nothing when the card has none. */
const chooseSecondLine = (
  card: WorkCard,
): { readonly now: string; readonly tone: CardNowTone } | null => {
  if (card.failure !== undefined)
    return { now: describeCardFailure(card.failure).text, tone: "failed" };
  if (card.openQuestion !== undefined) return { now: card.openQuestion.text, tone: "question" };
  return null;
};

/**
 * Renders one card of the board: its title, what it asks or what broke on the
 * second line, its age, and the colleague behind its top edge. A card in
 * Landed with nothing to say is only words.
 *
 * - `isTabStop` makes this the one card the Tab key leads onto. The arrows
 *   walk the rest from there, so every other card has `tabIndex` -1.
 * - `onOpen` is called with the card when it is pressed: it opens the card's
 *   newest Thread.
 * - `onFocus` is called with the card's id when it takes the focus.
 *
 * The card is named for a screen reader in the order a person needs: title,
 * what broke, what it asks, stage and age (`describeCardForReader`).
 *
 * The element carries `data-card-id` and `data-stage`, which drag and keyboard
 * code find it by.
 */
export function WorkCardView({
  card,
  isTabStop,
  isStill,
  onOpen,
  onFocus,
}: {
  readonly card: WorkCard;
  readonly isTabStop: boolean;
  readonly isStill: boolean;
  readonly onOpen: (card: WorkCard) => void;
  readonly onFocus: (cardId: string) => void;
}): JSX.Element {
  const age = useDeskAgeLabel(card.lastActivityAt, true);
  const reading = useClockValue(card.lastActivityAt, true, findNextDeskAgeChange, (now) =>
    describeCardForReader(card, now),
  );
  const secondLine = chooseSecondLine(card);
  return (
    <Card
      role="button"
      tabIndex={isTabStop ? 0 : -1}
      aria-label={reading}
      data-card-id={card.id}
      data-stage={card.stage}
      title={card.title}
      now={secondLine?.now}
      nowTone={secondLine?.tone ?? "plain"}
      colleague={chooseColleague(card, isStill)}
      landed={card.stage === "landed" && !isLoudCard(card)}
      meta={<time dateTime={card.lastActivityAt}>{age}</time>}
      onClick={() => {
        onOpen(card);
      }}
      onFocus={() => {
        onFocus(card.id);
      }}
    />
  );
}
