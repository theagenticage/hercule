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
import type { EntityEdge, EntityPlace, EntityStatus } from "@hercule/contract";
import { readEntityPluginId } from "./entity-words";

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
  readonly status?: EntityStatus;
  readonly progress?: RelationProgress;
  /** An ISO timestamp the source reports. Write it with `formatTargetDate`. */
  readonly targetDate?: string;
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
    ...(place.caption === undefined ? {} : { caption: place.caption }),
    ...(place.status === undefined ? {} : { status: place.status }),
    ...(place.progress === undefined ? {} : { progress: buildRelationProgress(place.progress) }),
    ...(place.targetDate === undefined ? {} : { targetDate: place.targetDate }),
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

/** Returns `word` with its first letter in lower case, unless the word starts with an acronym ("PR"). */
export const lowerFirst = (word: string): string =>
  /^[A-Z]{2}/.test(word) ? word : word.charAt(0).toLowerCase() + word.slice(1);

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
