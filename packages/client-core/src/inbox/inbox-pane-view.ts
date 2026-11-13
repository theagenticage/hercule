/**
 * What the Inbox pane draws for one thing besides its asks: the meta line under
 * the title, the things linked to it, and what happened to it. Each function
 * returns finished words and values from the read of the thing
 * (`externalEntity.read`), so the pane only draws them.
 */
import type { EntityRecord, EntityStatus, ExternalEntityDetail } from "@hercule/contract";
import { buildLinkedRows, type PlaceRow } from "../desk/relation-rows";
import type { PluginName } from "../intake";
import { describeAge, formatAge } from "../threads/age";
import { decideOpenCardFace, type CardFact } from "./card-face";

/** One item of the meta line, in the order the line shows them. */
export type PaneMetaItem =
  | { readonly kind: "status"; readonly status: EntityStatus }
  | { readonly kind: "words"; readonly words: string }
  | { readonly kind: "fact"; readonly fact: CardFact };

/** What the meta line adds to the facts the record holds. */
export interface PaneMetaContext {
  /** The moment the "updated" age is counted back from. */
  readonly now: Date;
  /** The account the thing is seen through, given only when the source has several. */
  readonly account?: string | undefined;
  /** Why a dismissed thing is back (`describeDismissalReturn`), when it is. */
  readonly dismissalReturn?: string | undefined;
}

/**
 * Returns the words about who the thing is to the user: "Assigned to you",
 * "You opened it", or the name of the person it belongs to, such as "Mei’s".
 * Returns `undefined` when the record names no one. An assignment shows here
 * because a thing that only concerns the user, and asks nothing, has no ask
 * section to say so.
 */
const describeWho = (record: EntityRecord): string | undefined => {
  if (record.concerns.includes("assigned")) return "Assigned to you";
  if (record.concerns.includes("opened")) return "You opened it";
  if (record.person !== undefined && !record.yours) return `${record.person.name}’s`;
  return undefined;
};

/**
 * Returns the items of the meta line of `record`: its status (left out for
 * the usual state of a request), who the thing is to the user and when the
 * source last changed it, its facts, "in <account>" and the words about a
 * dismissal that came back. The priority-bars fact is left out, because only
 * the open card draws it.
 */
export const describePaneMeta = (
  record: EntityRecord,
  context: PaneMetaContext,
): readonly PaneMetaItem[] => {
  const face = decideOpenCardFace(record);
  const who = describeWho(record);
  const updated = `Updated ${describeAge(record.sourceUpdatedAt, context.now)}`;
  return [
    ...(face.status === undefined ? [] : [{ kind: "status", status: face.status } as const]),
    ...(who === undefined ? [] : [{ kind: "words", words: who } as const]),
    { kind: "words", words: updated } as const,
    ...face.facts
      .filter((fact) => fact.form !== "bars")
      .map((fact) => ({ kind: "fact", fact }) as const),
    ...(context.account === undefined
      ? []
      : [{ kind: "words", words: `in ${context.account}` } as const]),
    ...(context.dismissalReturn === undefined
      ? []
      : [{ kind: "words", words: context.dismissalReturn } as const]),
  ];
};

/** One thing linked to the open thing, for the Linked section. `claim` says who claims the link. */
export interface PaneLink {
  readonly ref: string;
  readonly pluginId: string;
  readonly title: string;
  readonly identifier?: string | undefined;
  readonly claim: string;
}

const buildPaneLink = (row: PlaceRow): PaneLink => ({
  ref: row.ref,
  pluginId: row.pluginId,
  title: row.isLocked ? row.noun : row.title,
  identifier: row.isLocked ? undefined : row.identifier,
  claim: row.link?.kind === "confirmed" ? row.link.claimWords : "",
});

/**
 * Returns the confirmed links of `detail` as rows, titled from the places and
 * peers the read already holds. A link whose far end the read holds no record
 * for is left out, and so is a hint, which proves nothing.
 */
export const listPaneLinks = (
  detail: Pick<ExternalEntityDetail, "ref" | "links" | "places" | "peers">,
  plugins: ReadonlyArray<PluginName>,
): readonly PaneLink[] =>
  buildLinkedRows({ ...detail, hints: [], plugins }).confirmed.map(buildPaneLink);

/** One line of What happened: how long ago, and the sentence. */
export interface PaneHistoryLine {
  readonly when: string;
  readonly sentence: string;
}

/** Returns what changed at the source of `detail`, newest first, with each time as an age such as "2h". */
export const listPaneHistory = (
  detail: Pick<ExternalEntityDetail, "timeline">,
  now: Date,
): readonly PaneHistoryLine[] =>
  detail.timeline.toReversed().map((change) => ({
    when: formatAge(change.at, now),
    sentence: change.sentence.say,
  }));

/** Returns the one quiet line the pane shows when the source of the thing could not be read for its blocks. */
export const describeBlocksUnreadable = (sourceName: string): string =>
  `${sourceName} couldn't be read just now.`;
