import { Option, Schema } from "effect";
import type { ThreadPicks } from "./config";
import type { ResolvedThread } from "./resolve-thread";

/**
 * The last three (account, model) pairs the user picked, newest first. The
 * client keeps this list itself: the API does not store it, and the model menu
 * only uses it to show what was picked recently.
 */
export interface RecentModel {
  readonly providerAccountId: string;
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
    ...recent.filter(
      (each) => each.providerAccountId !== pair.providerAccountId || each.model !== pair.model,
    ),
  ].slice(0, LIMIT);

/**
 * Returns the pair to add to the Recent list once a submission succeeds, or
 * `null` when the user made no model choice or the thread has no model.
 * `picks` are the raw picks the submission was sent with: Recent holds the
 * models the user picked, never a default. The pair itself is the account and
 * model the thread resolved to, which is what was sent.
 */
export const buildRecentModel = (
  picks: ThreadPicks,
  resolved: ResolvedThread,
): RecentModel | null => {
  const { providerAccountId, model } = resolved.config;
  return picks.model == null || providerAccountId === null || model === null
    ? null
    : { providerAccountId, model };
};

/** The stored form of the Recent list: the JSON text of its pairs, in order. */
const StoredRecentModels = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ providerAccountId: Schema.String, model: Schema.String })),
);
const decodeStoredRecentModels = Schema.decodeUnknownOption(StoredRecentModels);

/**
 * Parses the Recent list a client stored as JSON text, trimmed to three.
 * Returns an empty list when nothing is stored or the text does not parse to
 * a list of (account, model) pairs: a Recent list that cannot be read only
 * costs the user the Recent lane, so it is not an error.
 */
export const parseRecentModels = (stored: string | null): readonly RecentModel[] =>
  stored === null
    ? []
    : Option.getOrElse(decodeStoredRecentModels(stored), () => []).slice(0, LIMIT);
