/**
 * What the open card of the Inbox says about one entity: its face, how long it
 * has waited, why it may be out of date, every place above it, and which moves
 * it offers. Everything is worked out from the record `externalEntity.read`
 * returns (or the same fields on an Inbox card), so no kind is named here.
 */
import type { EntityReason, EntityRecord } from "@hercule/contract";
import { readAncestorRows, type AncestorRow, type RelationGraph } from "../desk/relation-rows";
import { decideCardFace, type CardFace } from "./card-face";
import { describeCardTrust, describeCardWait, type CardWait } from "./card-wait";

/**
 * Which moves the open card offers:
 *
 * - `free`: Take on and Dismiss.
 * - `task`: the card has a Task, so its only move is to see that Task.
 * - `off`: the card's plugin is not active, so no move can run. `reason` says
 *   why, in words for the card.
 */
export type OpenCardMoves =
  | { readonly _tag: "free" }
  | { readonly _tag: "task"; readonly taskId: string }
  | { readonly _tag: "off"; readonly reason: string };

/** What the open card draws. */
export interface OpenCardWords {
  readonly face: CardFace;
  /** The small line under the title: the noun, the identifier, who it is about, and `yours`. */
  readonly meta: readonly string[];
  /** Why the card is on the Inbox, in full: a request's sentence is not cut down to the person's name here. */
  readonly reason: { readonly text: string; readonly tone: EntityReason["tone"] } | undefined;
  /** How long the card has waited, or `null` for a kind with no clock or a card a Task holds. */
  readonly wait: CardWait | null;
  /** The line that says the facts may be old, or `undefined` when they are as fresh as can be. */
  readonly trust: string | undefined;
  /** Every place above the card, on every path, each once, nearest first. */
  readonly places: readonly AncestorRow[];
  readonly moves: OpenCardMoves;
}

/** The words that say a card's moves are off because its plugin is not active. */
export const KIND_UNAVAILABLE_REASON =
  "Its plugin is turned off, so there is nothing to do with this card here. It shows what was read last.";

const decideMoves = (record: EntityRecord, kindAvailable: boolean): OpenCardMoves => {
  if (record.taskId !== undefined) return { _tag: "task", taskId: record.taskId };
  return kindAvailable ? { _tag: "free" } : { _tag: "off", reason: KIND_UNAVAILABLE_REASON };
};

/**
 * Returns what the open card draws for `record`. `graph` holds the places and
 * `part of` steps that stand above it, `kindAvailable` is false when the
 * catalog no longer has an active kind for it, and `now` is the time the
 * wait and the age of the facts are counted to.
 */
export const decideOpenCard = (
  record: EntityRecord,
  graph: RelationGraph,
  kindAvailable: boolean,
  now: Date,
): OpenCardWords => {
  const face = decideCardFace(record);
  return {
    face,
    meta: [
      record.noun,
      record.identifier,
      ...(record.person === undefined ? [] : [record.person.name]),
      ...(record.yours ? ["yours"] : []),
    ],
    reason:
      record.reason === undefined
        ? undefined
        : { text: record.reason.say, tone: record.reason.tone },
    wait: describeCardWait(record, now),
    trust: describeCardTrust(record, now),
    places: readAncestorRows(record.ref, graph),
    moves: decideMoves(record, kindAvailable),
  };
};
