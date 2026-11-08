/**
 * The rows that draw the outside graph on both Overview pages: Work's details
 * pane and the Inbox. A row is the source's mark, the title, and what the place
 * says about itself (its kind, its status, and its progress only when the
 * source reports it). A place no Connection can read is a locked row with no
 * title.
 *
 * `part of` is a graph, not a chain: a thing can have many parents. The rows
 * of a thing list every place above it on every path, each place once, so a
 * list never shows one parent as if it were the only one.
 */
import type {
  EntityEdge,
  EntityHint,
  EntityLink,
  EntityPeer,
  EntityPlace,
  EntityReason,
  EntityStatus,
} from "@hercule/contract";
import { lowerFirst, type PluginName } from "../intake";
import { readEntityPluginId } from "./entity-words";
import { describeClaim, describeHint } from "./link-claim";
import { readOtherRef } from "./link-ends";

/** The records and the `part of` steps a reply carries, which are all the rows are built from. */
export interface RelationGraph {
  readonly places: readonly EntityPlace[];
  readonly edges: readonly EntityEdge[];
}

/** How far along the source says a place is. Nothing here is worked out from the cards. */
export interface RelationProgress {
  /** From 0 to 1, for the width of the 4px bar. */
  readonly fraction: number;
  /** "4 of 9", only when the source reports both numbers. */
  readonly words?: string;
}

/**
 * What a row that draws a linked thing knows of the link that brought it.
 *
 * - `confirmed`: a source or a person says the two are linked. It shows with
 *   its status.
 * - `hint`: a reference found in text. It proves nothing, so it shows with
 *   the words that say where it was found, and a button to link the two.
 */
export interface RowLink {
  readonly kind: "confirmed" | "hint";
  /** Who says the two are linked, in words, such as "Linear reports this". */
  readonly claimWords: string;
  /**
   * True when the user has made a claim on the link, so they can remove it,
   * even when a source reports the same link as well. A source's own claim is
   * never removed.
   */
  readonly canUnlink: boolean;
}

/** The newest thing that changed at a row's source, in finished words. */
export interface RowChange {
  readonly say: string;
  readonly tone: EntityReason["tone"];
}

/** A place that no Connection can read: it has a kind and a noun, and no title. */
export interface LockedPlaceRow {
  readonly isLocked: true;
  readonly ref: string;
  /** The qualified kind word, such as `sentry/issue`. */
  readonly kind: string;
  /** The plugin whose mark the row shows. */
  readonly pluginId: string;
  /** The word for one, such as "Error". */
  readonly noun: string;
  /** Set on a row that draws a linked thing. */
  readonly link?: RowLink;
}

/** A place with a title. */
export interface OpenPlaceRow {
  readonly isLocked: false;
  readonly ref: string;
  readonly kind: string;
  readonly pluginId: string;
  readonly noun: string;
  /** The words for its kind when the kind can group things, such as "Linear project". */
  readonly caption?: string;
  /** The place's title, or its noun when the source reports no title. */
  readonly title: string;
  /** How the source names it, such as "SHOP-123", when it has one. */
  readonly identifier?: string;
  readonly status?: EntityStatus;
  readonly progress?: RelationProgress;
  /** An ISO timestamp the source reports. Write it with `formatTargetDate`. */
  readonly targetDate?: string;
  /** The latest change at the source, when something changed since the thing was first seen. */
  readonly latestChange?: RowChange;
  /** Set on a row that draws a linked thing. */
  readonly link?: RowLink;
}

export type PlaceRow = LockedPlaceRow | OpenPlaceRow;

/** A place above a thing, and how many steps up it is by the shortest path. */
export type AncestorRow = PlaceRow & { readonly depth: number };

/** Returns how far along a source says a place is, as the bar and its words need it. */
export const buildRelationProgress = (
  progress: NonNullable<EntityPlace["progress"]>,
): RelationProgress => ({
  fraction: progress.fraction,
  ...(progress.done !== undefined && progress.total !== undefined
    ? { words: `${String(progress.done)} of ${String(progress.total)}` }
    : {}),
});

/** Returns the row that draws `place`. */
export const buildPlaceRow = (place: EntityPlace): PlaceRow => {
  const base = {
    ref: place.ref,
    kind: place.kind,
    pluginId: readEntityPluginId(place.kind),
    noun: place.noun,
  };
  if (place.restricted) return { ...base, isLocked: true };
  return {
    ...base,
    isLocked: false,
    title: place.title ?? place.noun,
    ...(place.identifier === undefined ? {} : { identifier: place.identifier }),
    ...(place.caption === undefined ? {} : { caption: place.caption }),
    ...(place.status === undefined ? {} : { status: place.status }),
    ...(place.progress === undefined ? {} : { progress: buildRelationProgress(place.progress) }),
    ...(place.targetDate === undefined ? {} : { targetDate: place.targetDate }),
    ...(place.latestChange === undefined
      ? {}
      : {
          latestChange: {
            say: place.latestChange.sentence.say,
            tone: place.latestChange.sentence.tone,
          },
        }),
  };
};

/**
 * Returns the row that draws `peer`, a linked thing with no card of its own.
 * A restricted peer is a locked row. Its title is its noun when the source
 * reports none.
 */
export const buildPeerRow = (peer: EntityPeer): PlaceRow => {
  const base = {
    ref: peer.ref,
    kind: peer.kind,
    pluginId: readEntityPluginId(peer.kind),
    noun: peer.noun,
  };
  if (peer.restricted) return { ...base, isLocked: true };
  return {
    ...base,
    isLocked: false,
    title: peer.title ?? peer.noun,
    ...(peer.identifier === undefined ? {} : { identifier: peer.identifier }),
    ...(peer.status === undefined ? {} : { status: peer.status }),
    ...(peer.latestChange === undefined
      ? {}
      : {
          latestChange: {
            say: peer.latestChange.sentence.say,
            tone: peer.latestChange.sentence.tone,
          },
        }),
  };
};

/** What `readAncestorRows` walks: each ref's parents in the order of the edges, and each ref's record. */
export interface RelationIndex {
  readonly parents: ReadonlyMap<string, readonly string[]>;
  readonly placeByRef: ReadonlyMap<string, EntityPlace>;
}

/** Returns the lookups over `graph` that `readAncestorRows` walks. Build it once for many walks over one graph. */
export const indexRelationGraph = (graph: RelationGraph): RelationIndex => {
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const known = parents.get(edge.fromRef);
    if (known === undefined) parents.set(edge.fromRef, [edge.toRef]);
    else known.push(edge.toRef);
  }
  return { parents, placeByRef: new Map(graph.places.map((place) => [place.ref, place])) };
};

/**
 * Returns every place above `ref`, each once, nearest first. A place two
 * parents lead to comes once, at its shortest distance, and parents of the
 * same distance keep the order of `edges`. A ref whose record `places` does
 * not hold has no row (the reply's `contextComplete` says when that happens).
 * A loop in the edges cannot repeat a place, and a thing is never its own
 * ancestor.
 *
 * `index` is the lookups of `graph`. A caller that walks many refs of one
 * graph passes it, so the graph is indexed once and not for every walk.
 */
export const readAncestorRows = (
  ref: string,
  graph: RelationGraph,
  index: RelationIndex = indexRelationGraph(graph),
): readonly AncestorRow[] => {
  const seen = new Set([ref]);
  const rows: AncestorRow[] = [];
  let level = [ref];
  for (let depth = 1; level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const child of level) {
      for (const parentRef of index.parents.get(child) ?? []) {
        if (seen.has(parentRef)) continue;
        seen.add(parentRef);
        next.push(parentRef);
        const place = index.placeByRef.get(parentRef);
        if (place !== undefined) rows.push({ ...buildPlaceRow(place), depth });
      }
    }
    level = next;
  }
  return rows;
};

/**
 * Returns the words for a place no Connection can read, such as "A Sentry
 * issue you cannot open". `place` is a locked row or a place record: only its
 * `noun` is used, and never a title, because a title learned through someone
 * else's read must not leak. `pluginName` is the plugin's display name; leave
 * it out where it is not at hand ("An issue you cannot open"). This is the one
 * place that words it, so every screen agrees on the article and the case.
 */
export const describeLockedRow = (
  place: { readonly noun: string },
  pluginName?: string,
): string => {
  const kind = lowerFirst(place.noun);
  const named = pluginName === undefined ? kind : `${pluginName} ${kind}`;
  return `${/^[aeiou]/i.test(named) ? "An" : "A"} ${named} you cannot open`;
};

/** What `buildLinkedRows` is built from: one thing's links, and the records at their far ends. */
export interface LinkedThings {
  /** The ref of the thing whose links these are. */
  readonly ref: string;
  readonly links: readonly EntityLink[];
  readonly hints: readonly EntityHint[];
  /** Where a link's far end is found first. */
  readonly places: readonly EntityPlace[];
  /** Where it is found when `places` has no record for it. */
  readonly peers: readonly EntityPeer[];
  /** For the plugin names in the words of a claim. */
  readonly plugins: ReadonlyArray<PluginName>;
}

/** The record at the far end of a link, and whether it came as a place or as a peer. */
type FarEnd =
  | { readonly _tag: "place"; readonly place: EntityPlace }
  | { readonly _tag: "peer"; readonly peer: EntityPeer };

/** The rows of the Linked section: what is linked for sure, and what only text says. */
export interface LinkedRows {
  readonly confirmed: readonly PlaceRow[];
  readonly hints: readonly PlaceRow[];
}

/**
 * Returns the rows of a thing's links and hints, each in the order given. A
 * link or hint whose far end no record is held for has no row, and neither has
 * a hint whose far end the user cannot open. Each row carries the words of its
 * claim (`describeClaim`, `describeHint`) and whether the user can remove it.
 * A hint made by the text of the far end names that thing's identifier ("Found
 * in the description of #6263"); a hint found in this thing's own text names
 * only the text.
 */
export const buildLinkedRows = ({
  ref,
  links,
  hints,
  places,
  peers,
  plugins,
}: LinkedThings): LinkedRows => {
  // One lookup by ref: a place when the reply holds one, else the peer. A far end in neither has no row.
  const farEnds = new Map<string, FarEnd>([
    ...peers.map((peer) => [peer.ref, { _tag: "peer", peer }] as const),
    ...places.map((place) => [place.ref, { _tag: "place", place }] as const),
  ]);
  const buildFarEndRow = (pair: Pick<EntityLink, "fromRef" | "toRef">): PlaceRow | undefined => {
    const farEnd = farEnds.get(readOtherRef(pair, ref));
    if (farEnd === undefined) return undefined;
    return farEnd._tag === "peer" ? buildPeerRow(farEnd.peer) : buildPlaceRow(farEnd.place);
  };
  const confirmed: PlaceRow[] = [];
  for (const link of links) {
    const row = buildFarEndRow(link);
    if (row === undefined) continue;
    confirmed.push({
      ...row,
      link: {
        kind: "confirmed",
        claimWords: describeClaim(link.claim, plugins),
        canUnlink: link.hasPersonClaim,
      },
    });
  }
  const hintRows: PlaceRow[] = [];
  for (const hint of hints) {
    const row = buildFarEndRow(hint);
    // A hint is offered to be linked, which nobody does to a thing they cannot even name.
    if (row === undefined || row.isLocked) continue;
    const mentioner = hint.fromRef === ref ? undefined : row.identifier;
    hintRows.push({
      ...row,
      link: { kind: "hint", claimWords: describeHint(hint, mentioner), canUnlink: false },
    });
  }
  return { confirmed, hints: hintRows };
};
