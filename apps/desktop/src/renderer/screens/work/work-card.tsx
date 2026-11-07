import { memo, type JSX } from "react";
import {
  chooseCardColleaguePose,
  chooseCardSecondLine,
  describeCardForReader,
  isLoudCard,
} from "@hercule/client-core/work";
import { findNextDeskAgeChange } from "@hercule/client-core/desk";
import type { WorkCard } from "@hercule/contract";
import { useClockValue } from "../../app/age-clock";
import { buildLook } from "../../faces";
import { Card, useDeskAgeLabel, type CardColleague } from "../desk";

/** Returns the colleague standing behind the top edge of `card`, or `null` when nobody does. */
const buildColleague = (card: WorkCard, isStill: boolean): CardColleague | null => {
  const colleague = chooseCardColleaguePose(card);
  return colleague === null
    ? null
    : {
        look: buildLook(colleague.sessionId),
        pose: colleague.pose,
        seed: colleague.sessionId,
        still: isStill,
      };
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
 *
 * The card is memoized, so a read that changes other cards, or a move of the
 * focus, draws only the cards whose own values changed. That holds only while
 * `onOpen` and `onFocus` keep their identity between renders.
 */
export const WorkCardView = memo(function WorkCardView({
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
  const secondLine = chooseCardSecondLine(card);
  return (
    <Card
      role="button"
      tabIndex={isTabStop ? 0 : -1}
      aria-label={reading}
      data-card-id={card.id}
      data-stage={card.stage}
      title={card.title}
      now={secondLine?.text}
      nowTone={secondLine?.tone ?? "plain"}
      colleague={buildColleague(card, isStill)}
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
});
