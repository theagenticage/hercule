import { memo, type JSX } from "react";
import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import {
  chooseCardColleaguePose,
  chooseCardSecondLine,
  type CardInLane,
  describeCardForReader,
  isLoudCard,
} from "@hercule/client-core/work";
import { findNextDeskAgeChange } from "@hercule/client-core/desk";
import type { WorkCard } from "@hercule/contract";
import { useClockValue } from "../../app/age-clock";
import { buildLook } from "../../faces";
import { PluginMark } from "../../marks";
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

/** Returns the plugins that own the outside things a card's Task links, each once, in the order of the card's marks. */
const listSourcePluginIds = (card: WorkCard): readonly string[] => [
  ...new Set(card.entityMarks.map((mark) => mark.plugin)),
];

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
 *   screen reader whether it is pressed (`aria-pressed`), and draws its check
 *   (hidden until selected). With no card selected, no card has a check.
 * - Beside the age, the card shows a mark for each source its Task links
 *   outside (`entityMarks`), drawn by the plugin's own mark in `plugins`.
 * - `laneId` is the lane the card stands in. A Task under two outside places
 *   has a card in each lane, and `alsoWords` ("In 2 repositories") and
 *   `alsoNames` (their names, for the hover) say so on each of those cards.
 * - `onPress` is called with the card and the keys held when it is clicked.
 *   The screen opens the card, or selects it when the keys say so.
 * - `onFocus` is called with the card and its lane when it takes the focus.
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
  laneId,
  plugins,
  alsoWords,
  alsoNames,
  isTabStop,
  isStill,
  canWriteSummaries,
  isSelected,
  isSelecting,
  onPress,
  onFocus,
}: {
  readonly card: WorkCard;
  readonly laneId: string;
  readonly plugins: readonly PluginIdentity[];
  readonly alsoWords: string | undefined;
  readonly alsoNames: string | undefined;
  readonly isTabStop: boolean;
  readonly isStill: boolean;
  readonly canWriteSummaries: boolean;
  readonly isSelected: boolean;
  readonly isSelecting: boolean;
  readonly onPress: (card: WorkCard, keys: PressedKeys) => void;
  readonly onFocus: (at: CardInLane) => void;
}): JSX.Element {
  const age = useDeskAgeLabel(card.lastActivityAt, true);
  const reading = useClockValue(card.lastActivityAt, true, findNextDeskAgeChange, (now) =>
    describeCardForReader(card, now, canWriteSummaries),
  );
  const label = alsoWords === undefined ? reading : `${reading} ${alsoWords}.`;
  const secondLine = chooseCardSecondLine(card, canWriteSummaries);
  return (
    <Card
      role="button"
      tabIndex={isTabStop ? 0 : -1}
      aria-label={label}
      aria-pressed={isSelecting ? isSelected : undefined}
      data-card-id={card.id}
      data-stage={card.stage}
      title={card.title}
      now={secondLine?.text}
      nowTone={secondLine?.tone}
      colleague={buildColleague(card, isStill)}
      landed={card.stage === "landed" && !isLoudCard(card)}
      selected={isSelecting ? isSelected : undefined}
      {...(alsoWords === undefined || alsoNames === undefined
        ? {}
        : { also: { words: alsoWords, names: alsoNames } })}
      meta={
        <>
          {listSourcePluginIds(card).map((pluginId) => (
            <span key={pluginId} className="card-src" title={namePlugin(pluginId, plugins)}>
              <PluginMark pluginId={pluginId} plugins={plugins} size={13} />
            </span>
          ))}
          <time dateTime={card.lastActivityAt}>{age}</time>
        </>
      }
      onClick={(event) => {
        onPress(card, event);
      }}
      onFocus={() => {
        onFocus({ laneId, cardId: card.id });
      }}
    />
  );
});
