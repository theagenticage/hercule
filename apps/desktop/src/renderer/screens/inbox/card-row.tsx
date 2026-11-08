import { memo, type JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { OpenPlaceRow } from "@hercule/client-core/desk";
import { formatTargetDate } from "@hercule/client-core/desk";
import {
  decideCardDraw,
  describeCardAloud,
  type CardBundle,
  type CardOffers,
} from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import { PluginMark } from "../../marks";
import { CardHolderMark, CardMoves } from "./card-moves";
import { CardFactText, CardStatus, CardWaitFigure, NewMark } from "./card-parts";
import { buildCardPropsComparer } from "./card-props";
import { LinkLines } from "./link-lines";
import { TuckedParts } from "./tucked-parts";
import { useCardTime } from "./use-card-time";

interface CardRowProps {
  readonly card: InboxCard;
  readonly near: readonly OpenPlaceRow[];
  readonly bundle: CardBundle;
  /** The cards a signal just landed on. The row and the cards that ride on it show the new mark. */
  readonly freshIds: ReadonlySet<string>;
  readonly offers: CardOffers;
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

/** The layout builds a new `near` list on each read, so it is compared by what it draws. */
const arePropsEqual = buildCardPropsComparer<CardRowProps>({
  near: (before, after) => isSameNear(before.near, after.near),
});

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
 *   holds the card. A card a workflow is working on (`card.liveWorkflows`)
 *   shows the colleague there instead, and its sentence reads "Agent review
 *   has it". `offers` are the workflows its Hand to move offers.
 * - `bundle` is what rides on the card and the hints under it. Parts and hints
 *   stand as siblings of the row inside one `.inbox-bundle`, under the row's
 *   title, so what the row says and where it lies never depend on them. The
 *   row's hover fill covers the row only.
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
  bundle,
  freshIds,
  offers,
  plugins,
  showMark,
  showStatus,
  monogram,
  step,
}: CardRowProps): JSX.Element {
  const { face, wait, trust, signalAge, holder } = decideCardDraw(card, useCardTime(card));
  return (
    <div className="inbox-bundle" style={{ "--arrive-step": step }}>
      <div
        className="inbox-row"
        role="listitem"
        data-card-id={card.id}
        data-access={card.access === "ok" ? undefined : card.access}
        data-has-task={holder === undefined ? undefined : ""}
        tabIndex={-1}
        aria-label={describeCardAloud(face, wait, bundle.riders.length)}
      >
        <span className="card-body">
          <span className="row-rail">
            {showMark && (
              <span className="row-mark" data-hand-off-mark>
                <PluginMark pluginId={face.pluginId} plugins={plugins} size={15} />
              </span>
            )}
            {showStatus && face.status !== undefined && (
              <CardStatus status={face.status} size={15} />
            )}
          </span>
          <span className="row-main">
            <p className="row-title" title={face.title}>
              {face.title}
            </p>
            <span className="row-context" data-landing-line>
              {freshIds.has(card.id) && <NewMark />}
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
                <span className="row-news" data-landing-sentence data-tone={face.sentence.tone}>
                  {face.sentence.text}
                  {signalAge !== undefined && (
                    <>
                      {" "}
                      <small>{signalAge}</small>
                    </>
                  )}
                </span>
              )}
            </span>
            {trust !== undefined && <span className="row-trust">{trust}</span>}
          </span>
          <span className="row-end">
            <span className="row-id">{face.identifier}</span>
            {wait !== null && <CardWaitFigure wait={wait} />}
            <CardHolderMark holder={holder} monogram={monogram} />
          </span>
          <CardMoves card={card} offers={offers} />
        </span>
      </div>
      {bundle.parts.length > 0 && (
        <TuckedParts
          leadId={card.id}
          leadTitle={face.title}
          parts={bundle.parts}
          plugins={plugins}
          freshIds={freshIds}
        />
      )}
      <LinkLines
        leadId={card.id}
        leadIdentifier={face.identifier}
        lines={bundle.lines}
        plugins={plugins}
      />
    </div>
  );
}

export const CardRow = memo(CardRowView, arePropsEqual);
