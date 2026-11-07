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

/** The keys held while a card was clicked, which is how the screen tells a selecting click from an opening one. */
export interface PressedKeys {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

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
 * Renders one card of the board: its title, on the second line what broke,
 * what it asks, what the user answered while that answer is held, or else its
 * summary ("Writing a summary" until there is one),
 * its age, and the colleague behind its top edge. A card in
 * Landed is only words.
 *
 * - `isTabStop` makes this the one card the Tab key leads onto. The arrows
 *   walk the rest from there, so every other card has `tabIndex` -1.
 * - `canWriteSummaries` is whether Text Generation can run. When it cannot, a
 *   card with no summary has no second line (see `chooseCardSecondLine`).
 * - `isSelected` is whether the card is one of the selected cards, and
 *   `isSelecting` whether any card is: while some are, every card tells a
 *   screen reader whether it is pressed (`aria-pressed`).
 * - `onPress` is called with the card and the keys held when it is clicked.
 *   The screen opens the card, or selects it when the keys say so.
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
 * `onPress` and `onFocus` keep their identity between renders.
 */
export const WorkCardView = memo(function WorkCardView({
  card,
  isTabStop,
  isStill,
  canWriteSummaries,
  isSelected,
  isSelecting,
  onPress,
  onFocus,
}: {
  readonly card: WorkCard;
  readonly isTabStop: boolean;
  readonly isStill: boolean;
  readonly canWriteSummaries: boolean;
  readonly isSelected: boolean;
  readonly isSelecting: boolean;
  readonly onPress: (card: WorkCard, keys: PressedKeys) => void;
  readonly onFocus: (cardId: string) => void;
}): JSX.Element {
  const age = useDeskAgeLabel(card.lastActivityAt, true);
  const reading = useClockValue(card.lastActivityAt, true, findNextDeskAgeChange, (now) =>
    describeCardForReader(card, now, canWriteSummaries),
  );
  const secondLine = chooseCardSecondLine(card, canWriteSummaries);
  return (
    <Card
      role="button"
      tabIndex={isTabStop ? 0 : -1}
      aria-label={reading}
      aria-pressed={isSelecting ? isSelected : undefined}
      data-card-id={card.id}
      data-stage={card.stage}
      title={card.title}
      now={secondLine?.text}
      nowTone={secondLine?.tone}
      colleague={buildColleague(card, isStill)}
      landed={card.stage === "landed" && !isLoudCard(card)}
      selected={isSelected}
      meta={<time dateTime={card.lastActivityAt}>{age}</time>}
      onClick={(event) => {
        onPress(card, event);
      }}
      onFocus={() => {
        onFocus(card.id);
      }}
    />
  );
});
