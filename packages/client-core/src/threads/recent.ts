import { Option, Schema } from "effect";

/**
 * The last three (instance, model) pairs the user picked, newest first. The
 * client keeps this list itself: the API does not store it, and the model menu
 * only uses it to show what was picked recently.
 */
export interface RecentModel {
  readonly instanceId: string;
  readonly model: string;
}

const LIMIT = 3;

/** Returns `recent` with `pair` moved or added to the front, trimmed to three. */
export const pushRecent = (
  recent: readonly RecentModel[],
  pair: RecentModel,
): readonly RecentModel[] =>
  [
    pair,
    ...recent.filter((each) => each.instanceId !== pair.instanceId || each.model !== pair.model),
  ].slice(0, LIMIT);

/** The stored form of the Recent list: the JSON text of its pairs, in order. */
const StoredRecentModels = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ instanceId: Schema.String, model: Schema.String })),
);
const decodeStoredRecentModels = Schema.decodeUnknownOption(StoredRecentModels);

/**
 * Parses the Recent list a client stored as JSON text, trimmed to three.
 * Returns an empty list when nothing is stored or the text does not parse to
 * a list of (instance, model) pairs: a Recent list that cannot be read only
 * costs the user the Recent lane, so it is not an error.
 */
export const parseRecentModels = (stored: string | null): readonly RecentModel[] =>
  stored === null
    ? []
    : Option.getOrElse(decodeStoredRecentModels(stored), () => []).slice(0, LIMIT);
