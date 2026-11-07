import { memo, type JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { OpenPlaceRow } from "@hercule/client-core/desk";
import { formatTargetDate } from "@hercule/client-core/desk";
import { decideCardFace, describeCardAloud } from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import { PluginMark } from "../../marks";
import { CardMonogram, CardMoves } from "./card-moves";
import { CardFactText, CardStatus, CardWaitFigure } from "./card-parts";
import { useCardTime } from "./use-card-time";

interface CardRowProps {
  readonly card: InboxCard;
  readonly near: readonly OpenPlaceRow[];
  readonly plugins: readonly PluginIdentity[];
  readonly showMark: boolean;
  readonly showStatus: boolean;
  readonly monogram: string;
  readonly step: number;
}

const isSameNear = (before: readonly OpenPlaceRow[], after: readonly OpenPlaceRow[]): boolean =>
  before.length === after.length &&
  before.every((place, index) => {
    const other = after[index];
    return (
      other !== undefined &&
      place.ref === other.ref &&
      place.title === other.title &&
      place.targetDate === other.targetDate
    );
  });

/**
 * Checks whether two sets of props draw the same row. The layout builds a new
 * `near` list on each read, so the lists are compared by what they draw, and
 * every other prop by identity.
 */
const arePropsEqual = (before: CardRowProps, after: CardRowProps): boolean =>
  (Object.keys(after) as (keyof CardRowProps)[]).every((key) =>
    key === "near" ? isSameNear(before.near, after.near) : Object.is(before[key], after[key]),
  );

/**
 * Renders a card of lasting work as a row on the surface of its place: its
 * status first, in a column of its own; then the title and, under it, whose
 * it is, the places near it, its facts and why it is here; then its
 * identifier, quiet, and the wait of a fast kind.
 *
 * - `near` are the places the row names beside its title, such as its
 *   milestone, with their dates.
 * - `showMark` is false when the place above already shows the plugin's mark.
 *   `showStatus` is false when the surface is a status, whose head already
 *   says it, so the column closes up.
 * - `monogram` is the user's, which takes the place of the wait once a Task
 *   holds the card.
 * - `step` is the card's place in its surface, which sets when its words
 *   arrive after the first read.
 * - A card whose facts may be old says so in a quiet line, and a card that
 *   lost access keeps its last known words.
 *
 * The row has no sheet: it lies on the place's. It stands as one stable
 * element, `.inbox-row[data-card-id]`, and its words are its `.card-body`, so
 * what is added to a row (its moves, its open sheet) does not move it. The
 * moves lie over the end of the first line and show while the page marks the
 * row as the current card (`data-current`, set by the page's pointer and keys).
 * It is memoized: it draws again only when its own values change, or when its
 * wait or the age of its facts changes (`useCardTime`).
 */
function CardRowView({
  card,
  near,
  plugins,
  showMark,
  showStatus,
  monogram,
  step,
}: CardRowProps): JSX.Element {
  const { wait, trust } = useCardTime(card);
  const face = decideCardFace(card);
  return (
    <div
      className="inbox-row"
      role="listitem"
      data-card-id={card.id}
      data-access={card.access === "ok" ? undefined : card.access}
      data-has-task={card.taskId === undefined ? undefined : ""}
      tabIndex={-1}
      aria-label={describeCardAloud(face, wait)}
      style={{ "--arrive-step": step }}
    >
      <span className="card-body">
        <span className="row-rail">
          {showMark && (
            <span className="row-mark">
              <PluginMark pluginId={face.pluginId} plugins={plugins} size={15} />
            </span>
          )}
          {showStatus && face.status !== undefined && <CardStatus status={face.status} size={15} />}
        </span>
        <span className="row-main">
          <p className="row-title" title={face.title}>
            {face.title}
          </p>
          <span className="row-context">
            {face.whose !== undefined && <span>{face.whose}</span>}
            {near.map((place) => (
              <span key={place.ref}>
                {place.targetDate === undefined
                  ? place.title
                  : `${place.title}, ${formatTargetDate(place.targetDate)}`}
              </span>
            ))}
            {face.facts.map((fact, index) => (
              <CardFactText key={index} fact={fact} />
            ))}
            {face.sentence !== undefined && (
              <span className="row-news" data-tone={face.sentence.tone}>
                {face.sentence.text}
              </span>
            )}
          </span>
          {trust !== undefined && <span className="row-trust">{trust}</span>}
        </span>
        <span className="row-end">
          <span className="row-id">{face.identifier}</span>
          {wait !== null && <CardWaitFigure wait={wait} />}
          {card.taskId !== undefined && <CardMonogram monogram={monogram} />}
        </span>
        <CardMoves card={card} />
      </span>
    </div>
  );
}

export const CardRow = memo(CardRowView, arePropsEqual);
