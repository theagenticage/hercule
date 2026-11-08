import { memo, type JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { decideCardFace, describeCardAloud, type CardBundle } from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import { PluginMark } from "../../marks";
import { StatusShape } from "../desk";
import "../desk/card.css";
import { CardMonogram, CardMoves } from "./card-moves";
import { CardWaitFigure, NewMark } from "./card-parts";
import { buildCardPropsComparer } from "./card-props";
import { LinkLines } from "./link-lines";
import { useCardTime } from "./use-card-time";

interface RequestCardProps {
  readonly card: InboxCard;
  readonly homeName: string | undefined;
  readonly bundle: CardBundle;
  /** The cards a signal just landed on. The request shows the new mark when its id is in it. */
  readonly freshIds: ReadonlySet<string>;
  readonly plugins: readonly PluginIdentity[];
  readonly monogram: string;
  readonly step: number;
}

const arePropsEqual = buildCardPropsComparer<RequestCardProps>();

/**
 * Renders a small request as a card of its own, in the narrow column: the
 * plugin's mark at muted strength, the title up to two lines, the wait at the
 * top right, and one line under the title with who asked, what is unusual and
 * where it lies. It has a quiet surface at rest, half way from the desk to the
 * stock, with a hairline, and rises to the stock under the pointer.
 *
 * - `homeName` is the title of the card's first home, from the layout.
 * - A status shape shows only when the card's status is not the usual one of
 *   its kind (`decideCardFace` leaves it out otherwise). `yours` shows beside
 *   the place.
 * - `monogram` is the user's, which takes the place of the wait once a Task
 *   holds the card.
 * - `bundle` holds the lines under the card: a reference found in text that
 *   the user can link ("Mentions OPS-47"), and what it is linked to ("Linked to
 *   #6263"). They stand under the card in one `.inbox-bundle`, and are not part
 *   of the card.
 * - `freshIds` are the cards a signal just landed on. The request shows the new mark when it is one.
 * - `step` is the card's place in its list, which sets when its words arrive
 *   after the first read.
 *
 * It stands as one stable element, `.inbox-request[data-card-id]`, with its
 * sheet (`.card-stock`) and its words (`.card-body`) as children, so what is
 * added to a request (its moves, its open sheet) does not move it. The moves
 * lie over the end of the second line, whose words end with an ellipsis before
 * them, and show while the page marks the request as the current card
 * (`data-current`, set by the page's pointer and keys). A card with a Task,
 * which lies under With someone else, is drawn in the same shape.
 */
function RequestCardView({
  card,
  homeName,
  bundle,
  freshIds,
  plugins,
  monogram,
  step,
}: RequestCardProps): JSX.Element {
  const { wait, trust } = useCardTime(card);
  const face = decideCardFace(card);
  const where = [homeName, card.card === "compact" ? face.whose : undefined]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <div className="inbox-bundle" style={{ "--arrive-step": step }}>
      <div
        className="inbox-request"
        role="listitem"
        data-card-id={card.id}
        data-access={card.access === "ok" ? undefined : card.access}
        data-has-task={card.taskId === undefined ? undefined : ""}
        tabIndex={-1}
        aria-label={describeCardAloud(face, wait, 0)}
      >
        <i className="card-stock" />
        <span className="card-body">
          <span className="request-mark">
            <PluginMark pluginId={face.pluginId} plugins={plugins} size={16} />
          </span>
          <p className="request-title" title={face.title}>
            {face.title}
          </p>
          {wait !== null && <CardWaitFigure wait={wait} />}
          {card.taskId !== undefined && <CardMonogram monogram={monogram} />}
          <span className="request-under" data-landing-line>
            {freshIds.has(card.id) && <NewMark />}
            {face.status !== undefined && (
              <span className="request-shape">
                <StatusShape shape={face.status.shape} tone={face.status.tone} size={13} />
              </span>
            )}
            {face.sentence !== undefined && (
              <span className="request-said" data-landing-sentence data-tone={face.sentence.tone}>
                {face.sentence.text}
              </span>
            )}
            {where !== "" && <span className="request-where">{where}</span>}
          </span>
          {trust !== undefined && <span className="request-trust">{trust}</span>}
          <CardMoves card={card} />
        </span>
      </div>
      <LinkLines
        leadId={card.id}
        leadIdentifier={face.identifier}
        lines={bundle.lines}
        plugins={plugins}
      />
    </div>
  );
}

export const RequestCard = memo(RequestCardView, arePropsEqual);
