/**
 * What a card under a message draws for a thing that was sent to an agent as
 * context: the live thing when it could be read, and what the context block
 * kept of it when it could not.
 */
import type { EntityCard, EntityFieldValue, EntityStatus } from "@hercule/contract";
import { readEntityPluginId } from "../desk/entity-words";
import { describeLockedRow } from "../desk/relation-rows";
import { decideShownStatus } from "./card-face";

/**
 * Returns the system of an External Ref (`linear` for `linear:issue:...`),
 * as a best guess of the plugin that owns the thing. It is used only by the
 * card drawn from the block, when the live read is missing and the ref is all
 * that is known: a system can be named differently from its plugin. A card
 * that was read takes its plugin from the thing's kind instead.
 */
const guessPluginIdFromRef = (ref: string): string => ref.split(":")[0] ?? ref;

/**
 * The words and marks of one context card. `noun`, `identifier`, `status` and
 * `trailing` are absent when nothing is known for them.
 */
export interface ContextCardFace {
  /** The plugin whose mark and name the card shows: the thing's own plugin, or a guess from its ref when the thing was not read. */
  readonly pluginId: string;
  /** The word for one, such as "Issue". */
  readonly noun?: string;
  /** How the source names it, such as `SHOP-142`. */
  readonly identifier?: string;
  readonly title: string;
  /** True for a thing no Connection of the user can read: the card is locked, and its title only says so. */
  readonly isLocked?: true;
  readonly status?: EntityStatus;
  /**
   * What ends the status line: a live `fact` such as "1,211 events", which a
   * card draws at its right edge, or the `place` the thing lives in, such as
   * "Storefront", which a card draws beside the status.
   */
  readonly trailing?: { readonly kind: "fact" | "place"; readonly text: string };
  /**
   * Present when the thing lost access: the words that say its facts are the
   * last known ones, such as "Last known state - you can no longer open it".
   * A card draws them under the status line.
   */
  readonly lastKnownNote?: string;
}

/**
 * Returns the words that qualify the facts of a thing that lost access, or
 * `undefined` for a thing that can be read. `deleted` is worded as a fact
 * only because a source said so for certain; any other lost access is that
 * the user's Connections can no longer open the thing.
 */
const describeLostAccess = (access: EntityCard["access"]): string | undefined => {
  switch (access) {
    case "inaccessible":
      return "Last known state - you can no longer open it";
    case "deleted":
      return "Last known state - deleted at the source";
    case "ok":
    case undefined:
      return undefined;
  }
};

/**
 * Returns the words of a field of the card's face, or `undefined` when the
 * field has none to draw. Text, a person and an enum are their text. A number
 * is written whole with its label ("1,211 events"), so a count that changes
 * by a few still shows the change. Every other type is left out: an age
 * changes with the clock, and a card has no timer to redraw it.
 */
const readFaceWords = (field: EntityFieldValue | undefined): string | undefined => {
  if (field === undefined) return undefined;
  switch (field.type) {
    case "text":
    case "person":
    case "enum":
      return field.text === "" ? undefined : field.text;
    case "number":
      return `${field.number.toLocaleString("en-GB")} ${field.label.toLowerCase()}`;
    case "money":
    case "age":
    case "bool":
      return undefined;
  }
};

/**
 * Returns the card of a thing that was read: its source, noun, identifier,
 * title and status (left out on a compact card when it is of the `norm` tone,
 * as on the Inbox's cards), and at the end of the status line the face's fact (the
 * live number, such as "1,211 events") or, when it has none, the place the
 * thing lives in. A restricted thing (no Connection can read it) is a locked
 * card with only its source and noun, worded like the locked rows of a pane:
 * its title is never drawn. A thing that lost access keeps its last known
 * facts and carries a `lastKnownNote` that says they are not current.
 */
export const describeContextCard = (card: EntityCard): ContextCardFace => {
  const pluginId = readEntityPluginId(card.kind);
  if (card.restricted) {
    return { pluginId, noun: card.noun, title: describeLockedRow(card), isLocked: true };
  }
  const status = decideShownStatus(card.card, card.status);
  const fact = readFaceWords(card.face?.fact);
  const place = readFaceWords(card.face?.place);
  const trailing =
    fact !== undefined
      ? ({ kind: "fact", text: fact } as const)
      : place === undefined
        ? undefined
        : ({ kind: "place", text: place } as const);
  const lastKnownNote = describeLostAccess(card.access);
  return {
    pluginId,
    noun: card.noun,
    ...(card.identifier === undefined ? {} : { identifier: card.identifier }),
    title: card.title ?? card.ref,
    ...(status === undefined ? {} : { status }),
    ...(trailing === undefined ? {} : { trailing }),
    ...(lastKnownNote === undefined ? {} : { lastKnownNote }),
  };
};

/**
 * Returns the card drawn from what the context block kept of a thing, for when
 * the live read has no card for it: the read has not answered yet or failed,
 * or the thing was pruned (the reply leaves out an id that names nothing).
 * The card has the source, taken from the ref (`linear:issue:...` is
 * Linear's), and the title the block kept exactly as it was written, or the
 * ref itself when the block kept none.
 */
export const describeContextCardFromBlock = (thing: {
  readonly ref: string;
  readonly title?: string | undefined;
}): ContextCardFace => ({
  pluginId: guessPluginIdFromRef(thing.ref),
  title: thing.title === undefined || thing.title === "" ? thing.ref : thing.title,
});
