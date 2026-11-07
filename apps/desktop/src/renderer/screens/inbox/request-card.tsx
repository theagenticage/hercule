import { memo, type JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import {
  decideCardFace,
  describeCardAloud,
  describeCardTrust,
  describeCardWait,
  isCardTimeDependent,
} from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import { PluginMark } from "../../marks";
import { StatusShape } from "../desk";
import "../desk/card.css";
import { CardWaitFigure } from "./card-parts";
import { useMinuteClock } from "./use-minute-clock";

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
 * - `step` is the card's place in its list, which sets when its words arrive
 *   after the first read.
 *
 * It stands as one stable element, `.inbox-request[data-card-id]`, with its
 * sheet (`.card-stock`) and its words (`.card-body`) as children, so what is
 * added to a request later (its moves, its open sheet) does not move it. A
 * card with a Task, which lies under With someone else, is drawn in the same
 * shape.
 */
export const RequestCard = memo(function RequestCard({
  card,
  homeName,
  plugins,
  step,
}: {
  readonly card: InboxCard;
  readonly homeName: string | undefined;
  readonly plugins: readonly PluginIdentity[];
  readonly step: number;
}): JSX.Element {
  const now = useMinuteClock(isCardTimeDependent(card));
  const face = decideCardFace(card);
  const wait = describeCardWait(card, now);
  const trust = describeCardTrust(card, now);
  const where = [homeName, card.card === "compact" ? face.whose : undefined]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <div
      className="inbox-request"
      role="listitem"
      data-card-id={card.id}
      data-access={card.access === "ok" ? undefined : card.access}
      aria-label={describeCardAloud(face, wait)}
      style={{ "--arrive-step": step }}
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
        <span className="request-under">
          {face.status !== undefined && (
            <span className="request-shape">
              <StatusShape shape={face.status.shape} tone={face.status.tone} size={13} />
            </span>
          )}
          {face.sentence !== undefined && (
            <span className="request-said" data-tone={face.sentence.tone}>
              {face.sentence.text}
            </span>
          )}
          {where !== "" && <span className="request-where">{where}</span>}
        </span>
        {trust !== undefined && <span className="request-trust">{trust}</span>}
      </span>
    </div>
  );
});
