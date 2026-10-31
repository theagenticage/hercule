/**
 * Reads the entries of Model Profiles. Every place that needs the entry a
 * thread runs on, or a profile's default entry, finds it here, so none of them
 * holds its own rule for what makes two entries the same.
 */
import type {
  Harness,
  ModelProfile,
  ModelProfileEntry,
  ResolvedModelProfileAccount,
  ResolvedModelProfileEntry,
} from "@hercule/contract";

/**
 * What identifies an entry in a profile: its account, the harness it runs in
 * (the resolved one, never the stored `null` that follows the section) and
 * its model.
 */
export interface ProfileEntryKey {
  readonly providerAccountId: string;
  readonly harnessId: string;
  readonly model: string;
}

/**
 * Checks that two entries are the same stored entry: the same account, the
 * same model, and the same `harnessId` as stored, where `null` (follow the
 * section) differs from a harness named outright. This is how a profile's
 * `defaultEntry` names an entry, and how a write finds the entry to change.
 * Use `isSameProfileEntry` to ask whether two entries run in the same harness.
 */
export const isSameStoredEntry = (a: ModelProfileEntry, b: ModelProfileEntry): boolean =>
  a.providerAccountId === b.providerAccountId && a.model === b.model && a.harnessId === b.harnessId;

/** Checks that two keys name the same entry. */
export const isSameProfileEntry = (a: ProfileEntryKey, b: ProfileEntryKey): boolean =>
  a.providerAccountId === b.providerAccountId && a.harnessId === b.harnessId && a.model === b.model;

/** Returns `key` as one string, such as a form control holds for its choice. */
export const formatProfileEntryKey = (key: ProfileEntryKey): string =>
  [key.providerAccountId, key.harnessId, key.model].join("/");

/** Returns the key of `entry`. */
export const buildProfileEntryKey = (entry: ResolvedModelProfileEntry): ProfileEntryKey => ({
  providerAccountId: entry.providerAccountId,
  harnessId: entry.resolvedHarnessId,
  model: entry.model,
});

/** Returns the display name of the harness `harnessId`, or the id itself when no harness has it. */
export const findHarnessName = (harnesses: readonly Harness[], harnessId: string): string =>
  harnesses.find((harness) => harness.id === harnessId)?.displayName ?? harnessId;

/**
 * Returns the name of the harness `entry` runs in when that is not the harness
 * of its `section`, such as "pi"; else `null`.
 */
export const findOtherHarnessName = (
  harnesses: readonly Harness[],
  section: ResolvedModelProfileAccount,
  entry: ResolvedModelProfileEntry,
): string | null =>
  entry.resolvedHarnessId === section.resolvedHarnessId
    ? null
    : findHarnessName(harnesses, entry.resolvedHarnessId);

/** Returns every entry of `profile`, section by section, in menu order. */
export const listProfileEntries = (profile: ModelProfile): readonly ResolvedModelProfileEntry[] =>
  profile.accounts.flatMap((section) => section.entries);

/**
 * Returns the first entry matching `key` in `profiles`, searching the
 * profiles and their sections in order, or `undefined` when no profile holds
 * it.
 */
export const findProfileEntry = (
  profiles: readonly ModelProfile[],
  key: ProfileEntryKey,
): ResolvedModelProfileEntry | undefined => {
  for (const profile of profiles) {
    const found = listProfileEntries(profile).find((entry) =>
      isSameProfileEntry(buildProfileEntryKey(entry), key),
    );
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * Returns the entry a new thread starts on in `profile`: its default entry,
 * else its first entry, else `undefined` for a profile with no entries. The
 * first entry stands in because the controller sets the default when it fills
 * a profile, so a profile without one is only seen between a write and the
 * next read.
 */
export const findProfileDefaultEntry = (
  profile: ModelProfile,
): ResolvedModelProfileEntry | undefined => {
  const entries = listProfileEntries(profile);
  const { defaultEntry } = profile;
  return (
    (defaultEntry === null
      ? undefined
      : entries.find((entry) => isSameStoredEntry(entry, defaultEntry))) ?? entries[0]
  );
};

/**
 * Returns the entry a new thread on the account `providerAccountId` starts
 * on in `profile`: the profile's default entry when it belongs to the
 * account, else the account's first entry, else `undefined` when the profile
 * holds none of the account's.
 */
export const findAccountDefaultEntry = (
  profile: ModelProfile,
  providerAccountId: string,
): ResolvedModelProfileEntry | undefined => {
  const own = listProfileEntries(profile).filter(
    (entry) => entry.providerAccountId === providerAccountId,
  );
  return own.find((entry) => entry === findProfileDefaultEntry(profile)) ?? own[0];
};
