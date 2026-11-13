/**
 * What a user message shows under its bubble when it carried context: the
 * things it was about as live cards in two columns, then "Context sent with
 * it", folded, which opens in place to the block as it was sent (spec 17,
 * "Starting a thread").
 */
import { useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { formatContextLineCount, namePlugin, type PluginIdentity } from "@hercule/client-core";
import {
  describeContextCard,
  describeContextCardFromBlock,
  shouldRetryCardRead,
  type ContextCardFace,
} from "@hercule/client-core/inbox";
import type { PromptContextBlock } from "@hercule/contract";
import { entityQuery, pluginsQuery } from "../../app/queries";
import { ChevronRightIcon } from "../../icons/chevron-right";
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
    <li className="msg-card">
      <p className="msg-card-top">
        <PluginMark pluginId={face.pluginId} plugins={plugins} size={14} />
        <span>{face.noun === undefined ? sourceName : `${sourceName} · ${face.noun}`}</span>
        {face.identifier === undefined ? null : <b>{face.identifier}</b>}
      </p>
      <p className="msg-card-title">{face.title}</p>
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
 * Renders the card of `thing`. It reads the thing where it draws it, so a live
 * update of one thing draws that card again and no other. While the read is
 * out, and when it fails (a thing that is gone, or one the user cannot read),
 * the card draws what the block kept: the source and the title.
 */
function ContextCard({ thing }: { readonly thing: ContextThing }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: plugins } = useQuery(pluginsQuery(client));
  const read = useQuery({
    ...entityQuery(client, thing.entityId),
    retry: shouldRetryCardRead,
  });
  // After a failed refresh Query still holds the last answer, which is stale
  // now (the thing was pruned, or the user lost access), so an error wins.
  const face =
    read.isError || read.data === undefined
      ? describeContextCardFromBlock(thing)
      : describeContextCard(read.data);
  const installed = plugins ?? NO_PLUGINS;
  return (
    <ContextCardView
      face={face}
      sourceName={namePlugin(face.pluginId, installed)}
      plugins={installed}
    />
  );
}

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
        Context sent with it<span>{formatContextLineCount(context)}</span>
      </button>
      {open ? <pre className="msg-ctx-body">{context.text}</pre> : null}
    </>
  );
}

/**
 * Renders what hangs under a bubble whose message carried `context`: a live
 * card for each thing the block names, then the fold with the block itself.
 */
export function MessageContext({ context }: { readonly context: PromptContextBlock }): JSX.Element {
  return (
    <>
      {context.things.length === 0 ? null : (
        <ul className="msg-cards">
          {context.things.map((thing) => (
            <ContextCard key={thing.entityId} thing={thing} />
          ))}
        </ul>
      )}
      <ContextFold context={context} />
    </>
  );
}
