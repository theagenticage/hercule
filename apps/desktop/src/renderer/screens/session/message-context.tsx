/**
 * What a user message shows under its bubble when it carried context: the
 * things it was about as live cards in two columns, then "Context sent with
 * it", folded, which opens in place to the block as it was sent (spec 17,
 * "Starting a thread").
 */
import { memo, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import {
  describeContextCard,
  describeContextCardFromBlock,
  type ContextCardFace,
} from "@hercule/client-core/inbox";
import type { EntityCard, PromptContextBlock } from "@hercule/contract";
import { entityCardsQuery, pluginsQuery } from "../../app/queries";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { LockIcon } from "../../icons/lock";
import { PluginMark } from "../../marks";
import { EntityStatusIcon } from "../desk/status-shape";
import "./message-context.css";

/** What the cards draw with before the plugins are read, and when that read fails. One shared list. */
const NO_PLUGINS: ReadonlyArray<PluginIdentity> = [];

/** One thing a context block names. */
type ContextThing = PromptContextBlock["things"][number];

/**
 * Renders the end of a card's status line, a live fact or a place. A fact
 * that changes while the card is on screen ticks: it is drawn again from
 * 4px low as it fades in, which Reduce motion turns off in the stylesheet.
 * The tick restarts through the element's key, so it needs no timer or effect.
 */
function CardTrailing({
  trailing,
}: {
  readonly trailing: NonNullable<ContextCardFace["trailing"]>;
}): JSX.Element {
  const [seen, setSeen] = useState({ text: trailing.text, ticks: 0 });
  // Adjusting state while rendering is React's way to answer a change in a prop without an effect.
  if (seen.text !== trailing.text) setSeen({ text: trailing.text, ticks: seen.ticks + 1 });
  if (trailing.kind === "place") return <span>{trailing.text}</span>;
  return (
    <span
      key={seen.ticks}
      className={seen.ticks === 0 ? "msg-card-live" : "msg-card-live is-ticked"}
    >
      {trailing.text}
    </span>
  );
}

/**
 * Renders one card from its words: the source's mark and name with the thing's
 * noun and identifier, the title, and the status with what ends its line. A
 * card that could not be read has only the source and the title.
 */
function ContextCardView({
  face,
  sourceName,
  plugins,
}: {
  readonly face: ContextCardFace;
  readonly sourceName: string;
  readonly plugins: ReadonlyArray<PluginIdentity>;
}): JSX.Element {
  const { status, trailing } = face;
  return (
    <li className={face.isLocked === true ? "msg-card is-locked" : "msg-card"}>
      <p className="msg-card-top">
        <PluginMark pluginId={face.pluginId} plugins={plugins} size={14} />
        <span>{face.noun === undefined ? sourceName : `${sourceName} · ${face.noun}`}</span>
        {face.identifier === undefined ? null : <b>{face.identifier}</b>}
      </p>
      <p className="msg-card-title">
        {face.isLocked === true ? <LockIcon size={13} /> : null}
        {face.title}
      </p>
      {status === undefined && trailing === undefined ? null : (
        <p className="msg-card-status">
          {status === undefined ? null : (
            <>
              <EntityStatusIcon status={status} size={12} />
              <span>{status.label}</span>
            </>
          )}
          {trailing === undefined ? null : <CardTrailing trailing={trailing} />}
        </p>
      )}
    </li>
  );
}

/**
 * Renders the card of `thing` from `card`, the thing's light read. Without it
 * (the read has not answered, or the reply left the thing out because it was
 * pruned) the card draws what the block kept: the source and the title.
 *
 * It is `memo`: Query keeps a card that did not change as the same object, so
 * when one card of a message changes, only that card draws again.
 */
const ContextCard = memo(function ContextCard({
  thing,
  card,
  plugins,
}: {
  readonly thing: ContextThing;
  readonly card: EntityCard | undefined;
  readonly plugins: ReadonlyArray<PluginIdentity>;
}): JSX.Element {
  const face = card === undefined ? describeContextCardFromBlock(thing) : describeContextCard(card);
  return (
    <ContextCardView
      face={face}
      sourceName={namePlugin(face.pluginId, plugins)}
      plugins={plugins}
    />
  );
});

/**
 * Renders the fold: a button that reads "Context sent with it" and the block's
 * line count, and under it, while open, the block as sent in the mono face.
 * It is folded when it mounts, and, like a collapsed message, folded again
 * when the transcript scrolls it out of view and back.
 */
function ContextFold({ context }: { readonly context: PromptContextBlock }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="msg-ctx"
        data-holds-place=""
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <ChevronRightIcon size={12} />
        Context sent with it<span>{String(context.lineCount)} lines</span>
      </button>
      {open ? <pre className="msg-ctx-body">{context.text}</pre> : null}
    </>
  );
}

/**
 * Renders what hangs under a bubble whose message carried `context`: a card
 * for each thing the block names, then the fold with the block itself. It is
 * the one reader of the cards: one request for the whole message, which never
 * suspends, so the transcript draws at once with the block's own words.
 *
 * The read answers with a card for every thing that still exists and that the
 * user may see, so it fails only on a dropped connection or a server error. A
 * failed refresh keeps the cards of the last good read. The cards fall back to
 * the block's words only while there is no read at all.
 */
export function MessageContext({ context }: { readonly context: PromptContextBlock }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: plugins } = useQuery(pluginsQuery(client));
  const { data: cards } = useQuery(
    entityCardsQuery(
      client,
      context.things.map((thing) => thing.entityId),
    ),
  );
  return (
    <>
      <ul className="msg-cards">
        {context.things.map((thing) => (
          <ContextCard
            key={thing.entityId}
            thing={thing}
            card={cards?.get(thing.entityId)}
            plugins={plugins ?? NO_PLUGINS}
          />
        ))}
      </ul>
      <ContextFold context={context} />
    </>
  );
}
