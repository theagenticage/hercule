import type { JSX } from "react";
import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import { describeClaim, describeLockedRow } from "@hercule/client-core/desk";
import {
  decideAskingSentence,
  decideCardFace,
  decideHandedSentence,
  listCardOffers,
  type AskingPart,
  type LockedPart,
  type QuietPart,
  type TuckedPart,
} from "@hercule/client-core/inbox";
import { LockIcon } from "../../icons/lock";
import { PluginMark } from "../../marks";
import { StatusShape } from "../desk";
import { CardColleague, CardMoves } from "./card-moves";
import { CardWaitFigure, NewMark } from "./card-parts";
import type { CardHandOffs } from "./card-props";
import { useCardTime } from "./use-card-time";

/**
 * Renders a card that rides on its lead and asks something of the user, as
 * one part of the lead's tucked sheet: the plugin's mark, what it asks first
 * ("Ines asked for your review") with its wait at the end, and under that what
 * it is: its status shape when that is not the usual one, its title, and its
 * identifier with the title of its first home. It is a card of its own
 * (`data-card-id`), so it has Take it, Dismiss and Hand to like any card, a
 * click opens it, and the keys stop on it. The words of the link are its
 * tooltip. Once the user hands it off, the colleague who has it stands where
 * its wait was, and what it asks reads "Agent review has it".
 */
function AskingPartRow({
  part,
  leadId,
  plugins,
  isFresh,
  handOffs,
}: {
  readonly part: AskingPart;
  readonly leadId: string;
  readonly plugins: readonly PluginIdentity[];
  readonly isFresh: boolean;
  readonly handOffs: CardHandOffs;
}): JSX.Element {
  const { card } = part;
  const { wait } = useCardTime(card);
  const handed = handOffs.handed.get(card.id);
  const face = decideCardFace(card);
  const sentence = handed === undefined ? decideAskingSentence(card) : decideHandedSentence(handed);
  const claimWords = part.claim === undefined ? undefined : describeClaim(part.claim, plugins);
  const where = [face.identifier, part.homeName].filter((each) => each !== undefined).join(" ");
  return (
    <div
      className="inbox-part is-asking"
      data-landing-part
      role="button"
      tabIndex={-1}
      data-card-id={card.id}
      data-lead-id={leadId}
      data-access={card.access === "ok" ? undefined : card.access}
      data-has-task={handed === undefined ? undefined : ""}
      title={claimWords}
      aria-description={claimWords}
    >
      <span className="part-mark" data-hand-off-mark>
        <PluginMark pluginId={face.pluginId} plugins={plugins} size={14} />
      </span>
      <span className="part-ask">
        {isFresh && <NewMark />}
        {sentence !== undefined && (
          <span className="part-said" data-landing-line data-tone={sentence.tone}>
            {sentence.text}
          </span>
        )}
      </span>
      {handed !== undefined ? (
        <CardColleague workflow={handed} />
      ) : (
        wait !== null && <CardWaitFigure wait={wait} />
      )}
      <span className="part-line" data-landing-line>
        {face.status !== undefined && (
          <StatusShape shape={face.status.shape} tone={face.status.tone} size={12} />
        )}
        <span className="part-title" title={face.title}>
          {face.title}
        </span>
        <span className="part-id">
          {where}
          {card.yours ? " · yours" : ""}
        </span>
      </span>
      <CardMoves card={card} offers={listCardOffers(card, handOffs.offerSets)} />
    </div>
  );
}

/**
 * Renders a thing that is linked to the lead and asks nothing of the user
 * here, as one quiet line: its mark, its title in muted ink, and at the end
 * its status word (or "You took it on" for a card a Task holds). A click opens
 * the card or the record behind it. A thing with nothing to open is a plain
 * line. It is not a card: no moves, and the keys do not stop on it.
 */
function QuietPartRow({
  part,
  leadId,
  plugins,
  isFresh,
}: {
  readonly part: QuietPart;
  readonly leadId: string;
  readonly plugins: readonly PluginIdentity[];
  readonly isFresh: boolean;
}): JSX.Element {
  const claimWords = part.claim === undefined ? undefined : describeClaim(part.claim, plugins);
  return (
    <div
      className="inbox-part is-quiet"
      data-landing-part
      role={part.openId === undefined ? undefined : "button"}
      tabIndex={part.openId === undefined ? undefined : -1}
      data-lead-id={leadId}
      data-part-ref={part.ref}
      data-open-id={part.openId}
      title={claimWords}
      aria-description={claimWords}
    >
      <span className="part-mark">
        <PluginMark pluginId={part.pluginId} plugins={plugins} size={14} />
      </span>
      <span className="part-title" title={part.title}>
        {part.title}
      </span>
      <span className="part-said" data-landing-line>
        {isFresh && <NewMark />}
        {part.statusWords}
      </span>
    </div>
  );
}

/**
 * Renders a thing the user cannot read, linked to the lead, as one faint line
 * with a lock and its noun: "A Sentry issue you cannot open". It shows no
 * title, even in its tooltip, which holds only the words of the link.
 */
function LockedPartRow({
  part,
  leadId,
  plugins,
}: {
  readonly part: LockedPart;
  readonly leadId: string;
  readonly plugins: readonly PluginIdentity[];
}): JSX.Element {
  const claimWords = describeClaim(part.claim, plugins);
  return (
    <div
      className="inbox-part is-locked"
      data-lead-id={leadId}
      data-part-ref={part.ref}
      title={claimWords}
      aria-description={claimWords}
    >
      <span className="part-mark">
        <LockIcon size={13} />
      </span>
      <span className="part-title">
        {describeLockedRow(part, namePlugin(part.pluginId, plugins))}
      </span>
    </div>
  );
}

/**
 * Renders the sheet of what rides on a lead, set in under the lead's title: a
 * part for each card that rides on it and for each linked thing that does not.
 * It is a group named "Riding on" and the lead's title, for a screen reader.
 *
 * - `leadId` is the id of the lead's card, which the parts carry so the page's
 *   motion can tell one lead's parts from another's.
 * - `freshIds` are the cards a signal just landed on, which show the new mark.
 * - `handOffs` are what the parts that ask need to draw a hand-off.
 */
export function TuckedParts({
  leadId,
  leadTitle,
  parts,
  plugins,
  freshIds,
  handOffs,
}: {
  readonly leadId: string;
  readonly leadTitle: string;
  readonly parts: readonly TuckedPart[];
  readonly plugins: readonly PluginIdentity[];
  readonly freshIds: ReadonlySet<string>;
  readonly handOffs: CardHandOffs;
}): JSX.Element {
  return (
    <div className="inbox-tucked" role="group" aria-label={`Riding on ${leadTitle}`}>
      {parts.map((part) => {
        switch (part._tag) {
          case "asking":
            return (
              <AskingPartRow
                key={part.card.id}
                part={part}
                leadId={leadId}
                plugins={plugins}
                isFresh={freshIds.has(part.card.id)}
                handOffs={handOffs}
              />
            );
          case "quiet":
            return (
              <QuietPartRow
                key={part.ref}
                part={part}
                leadId={leadId}
                plugins={plugins}
                isFresh={part.cardId !== undefined && freshIds.has(part.cardId)}
              />
            );
          case "locked":
            return <LockedPartRow key={part.ref} part={part} leadId={leadId} plugins={plugins} />;
        }
      })}
    </div>
  );
}
