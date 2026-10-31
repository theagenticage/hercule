import { Option, Schema } from "effect";
import type { ThreadPicks } from "./config";
import type { ResolvedThread } from "./resolve-thread";

/**
 * One of the entries the user picked lately, newest first: the Provider
 * Account, the harness it ran in and the model. The three together identify an
 * entry of a Model Profile, because one model may be offered in two harnesses.
 * The client keeps this list itself: the API does not store it. The model menu
 * shows the last three of each profile, and a new thread in a project with a
 * profile starts on the newest one the profile holds.
 */
export interface RecentModel {
  readonly providerAccountId: string;
  /** The qualified id of the harness the entry runs in. */
  readonly harnessId: string;
  readonly model: string;
}

/**
 * How many picks the list keeps. The menu shows three per profile, and one
 * profile's picks must not push out another's, so the list holds more than
 * three.
 */
const LIMIT = 24;

/** Returns `recent` with `entry` moved or added to the front, trimmed to the list's limit. */
export const pushRecent = (
  recent: readonly RecentModel[],
  entry: RecentModel,
): readonly RecentModel[] =>
  [
    entry,
    ...recent.filter(
      (each) =>
        each.providerAccountId !== entry.providerAccountId ||
        each.harnessId !== entry.harnessId ||
        each.model !== entry.model,
    ),
  ].slice(0, LIMIT);

/**
 * Returns the entry to add to the Recent list once a submission succeeds, or
 * `null` when the user made no model choice or the thread has no model.
 * `picks` are the raw picks the submission was sent with: Recent holds the
 * models the user picked, never a default. The entry itself is the account,
 * harness and model the thread resolved to, which is what was sent.
 */
export const buildRecentModel = (
  picks: ThreadPicks,
  resolved: ResolvedThread,
): RecentModel | null => {
  const { providerAccountId, model } = resolved.config;
  const { resolvedHarnessId } = resolved;
  return picks.model == null ||
    providerAccountId === null ||
    resolvedHarnessId === null ||
    model === null
    ? null
    : { providerAccountId, harnessId: resolvedHarnessId, model };
};

/**
 * The stored form of the Recent list: the JSON text of its entries, in order.
 * Lists written before Provider Accounts name the account `instanceId`. An
 * instance became the account with the same id, so the old key is read as
 * `providerAccountId` and nobody loses their Recent lane in the upgrade. Lists
 * written before entries named a harness have no `harnessId`.
 */
const StoredRecentModels = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      providerAccountId: Schema.optionalKey(Schema.String),
      instanceId: Schema.optionalKey(Schema.String),
      harnessId: Schema.optionalKey(Schema.String),
      model: Schema.String,
    }),
  ),
);
const decodeStoredRecentModels = Schema.decodeUnknownOption(StoredRecentModels);

/**
 * Parses the Recent list a client stored as JSON text, trimmed to the list's
 * limit. A list stored when the limit was three parses as it is.
 * Returns an empty list when nothing is stored or the text does not parse to
 * a list of (account, model) entries: a Recent list that cannot be read only
 * costs the user the Recent lane, so it is not an error. An entry that names
 * its account with the old key `instanceId` is read as `providerAccountId`.
 * An entry with no harness is dropped, because without it the menu cannot tell
 * which of a model's entries was picked.
 */
export const parseRecentModels = (stored: string | null): readonly RecentModel[] => {
  if (stored === null) return [];
  const entries = Option.getOrElse(decodeStoredRecentModels(stored), () => []);
  const parsed = entries.map(({ providerAccountId, instanceId, harnessId, model }) => {
    const accountId = providerAccountId ?? instanceId;
    return accountId === undefined ? null : { accountId, harnessId, model };
  });
  // One entry without an account means the text is not a Recent list at all.
  if (!parsed.every((entry) => entry !== null)) return [];
  return parsed
    .flatMap(({ accountId, harnessId, model }) =>
      harnessId === undefined ? [] : [{ providerAccountId: accountId, harnessId, model }],
    )
    .slice(0, LIMIT);
};
