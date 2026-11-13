/**
 * What a card under a message draws for a thing that was sent to an agent as
 * context: the live thing when it could be read, and what the context block
 * kept of it when it could not.
 */
import type { EntityFieldValue, EntityStatus, ExternalEntityDetail } from "@hercule/contract";
import { ApiError } from "../errors";
import { decideOpenCardFace } from "./card-face";

/** How many times a card's read is tried again after it fails for a reason that may pass. */
const MAX_CARD_READ_RETRIES = 3;

/**
 * Decides whether a card's read of its thing is tried again after it failed
 * `failureCount` times with `error`. A thing that is gone (`not_found`) or
 * that the user may not read (`forbidden`) will not change by asking again, so
 * the card draws what the block kept at once. Any other failure, such as a
 * connection that dropped, is tried again up to three times.
 */
export const shouldRetryCardRead = (failureCount: number, error: unknown): boolean => {
  if (error instanceof ApiError && (error.code === "not_found" || error.code === "forbidden")) {
    return false;
  }
  return failureCount < MAX_CARD_READ_RETRIES;
};

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
  readonly status?: EntityStatus;
  /**
   * What ends the status line: a live `fact` such as "1,211 events", which a
   * card draws at its right edge, or the `place` the thing lives in, such as
   * "Storefront", which a card draws beside the status.
   */
  readonly trailing?: { readonly kind: "fact" | "place"; readonly text: string };
}

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
 * title and status, and at the end of the status line the face's fact (the
 * live number, such as "1,211 events") or, when it has none, the place the
 * thing lives in.
 */
export const describeContextCard = (detail: ExternalEntityDetail): ContextCardFace => {
  const face = decideOpenCardFace(detail);
  const fact = readFaceWords(detail.face?.fact);
  const place = readFaceWords(detail.face?.place);
  const trailing =
    fact !== undefined
      ? ({ kind: "fact", text: fact } as const)
      : place === undefined
        ? undefined
        : ({ kind: "place", text: place } as const);
  return {
    pluginId: face.pluginId,
    noun: face.noun,
    identifier: face.identifier,
    title: face.title,
    ...(face.status === undefined ? {} : { status: face.status }),
    ...(trailing === undefined ? {} : { trailing }),
  };
};

/**
 * Returns the card drawn from what the context block kept of a thing, for when
 * the live read of the thing is missing: not answered yet, or failed (the
 * thing is gone, or the user cannot read it). It has the source, taken from
 * the ref (`linear:issue:...` is Linear's), and the title the block kept
 * exactly as it was written, or the ref itself when the block kept none.
 */
export const describeContextCardFromBlock = (thing: {
  readonly ref: string;
  readonly title?: string | undefined;
}): ContextCardFace => ({
  pluginId: guessPluginIdFromRef(thing.ref),
  title: thing.title === undefined || thing.title === "" ? thing.ref : thing.title,
});
