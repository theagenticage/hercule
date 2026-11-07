/**
 * What the Add to Work sheet needs to know before it asks a source anything:
 * which sources it can search, which contexts of a source narrow a search,
 * and whether typed text is a pasted link.
 */
import type { EntityPlace, EntitySearchQuery, PluginDetail } from "@hercule/contract";
import { lowerFirst } from "../intake";
import { parsePluginId } from "../plugin-id";

/** The part of a plugin that decides whether it is a source: what `plugin.query` returns. */
export type SourcePlugin = Pick<
  PluginDetail,
  "id" | "displayName" | "enabled" | "status" | "entityKinds"
>;

/** One source the sheet can search: the plugin's id, and the name on its tab. */
export interface AddSource {
  readonly id: string;
  readonly name: string;
}

/**
 * Returns the sources of the sheet's segmented control, ordered by name: the
 * plugins that are enabled and running and declare at least one kind of
 * External Entity.
 *
 * A plugin may declare kinds and still have no lookup, because `plugin.query`
 * does not say which plugins can search. Such a source answers its search
 * with `source-unavailable`, and the sheet says so.
 */
export const listAddSources = (plugins: ReadonlyArray<SourcePlugin>): readonly AddSource[] =>
  plugins
    .filter(
      (plugin) =>
        plugin.enabled && plugin.status._tag === "active" && plugin.entityKinds.length > 0,
    )
    .map((plugin) => ({ id: plugin.id, name: plugin.displayName }))
    .toSorted((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));

/** One context the scope select offers. */
export interface ScopeOption {
  readonly ref: string;
  /** What the select shows, such as "Web (team)". */
  readonly label: string;
  /** The context's own title, which the sentences about the scope use. */
  readonly title: string;
}

/**
 * Returns the places of all `lists` with one place per ref, in the order each
 * ref first appears. When a ref is in several lists, the place of the last
 * list wins, so put the freshest list last.
 */
export const mergePlaces = (
  ...lists: ReadonlyArray<ReadonlyArray<EntityPlace>>
): readonly EntityPlace[] => [
  ...new Map(lists.flatMap((list) => list.map((place) => [place.ref, place] as const))).values(),
];

/**
 * Returns the contexts of `sourceId` that can narrow a search, ordered by
 * title: the stored places of that plugin whose kind can group things
 * (a Linear team, a GitHub repository). `places` are the ones the sheet already
 * holds (the Work board's, the suggestions' and the Inbox's), so the select
 * needs no read of its own. A place the user
 * cannot read has no title and cannot be named, so it is left out.
 */
export const listScopeOptions = (
  places: ReadonlyArray<EntityPlace>,
  sourceId: string,
): readonly ScopeOption[] =>
  places
    .flatMap((place) =>
      place.caption !== undefined &&
      !place.restricted &&
      place.title !== undefined &&
      parsePluginId(place.kind) === sourceId
        ? [
            {
              ref: place.ref,
              title: place.title,
              label: `${place.title} (${lowerFirst(place.noun)})`,
            },
          ]
        : [],
    )
    .toSorted((a, b) => a.title.localeCompare(b.title) || (a.ref < b.ref ? -1 : 1));

/**
 * Returns whether `text` is one pasted web link and nothing else. A link
 * names its own source, so the controller reads it with whichever plugin
 * recognizes it, whatever tab the sheet is on.
 */
export const isPastedLink = (text: string): boolean => /^https?:\/\/\S+$/i.test(text.trim());

/**
 * Returns the search for `words` in `source`, narrowed to `scopeRef` unless
 * that is empty, or `null` when nothing is typed. A pasted link is never
 * narrowed: it names its own source and its own thing.
 */
export const buildEntitySearch = (
  words: string,
  source: string,
  scopeRef: string,
): EntitySearchQuery | null => {
  const text = words.trim();
  if (text === "") return null;
  return { source, text, ...(scopeRef === "" || isPastedLink(text) ? {} : { scopeRef }) };
};
