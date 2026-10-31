/**
 * Turns one change the user makes to a Model Profile into the
 * `ModelProfileUpdateInput` that writes it. `modelProfile.update` replaces the
 * whole profile, so every function here starts from the profile as it was read
 * (`ModelProfile`) and returns the whole profile in the write shape, with the
 * one change applied. The result carries the revision that was read, so the
 * controller refuses it with `conflict` when the profile has changed since; the
 * caller then reads the profile again and applies the change again.
 *
 * The write shape sends the stored entries of every section, and each entry
 * keeps its stored `harnessId` (`null` follows the section's harness), never
 * the resolved harness. The exception is a section still waiting for its
 * account's first Model Catalog read (`selectionPending`): it is sent with no
 * `entries`, which keeps it waiting for its Default Selection instead of
 * freezing it empty.
 *
 * A function here returns the profile unchanged, in write shape, when the
 * change does not apply (an unknown entry or account, or a move to where the
 * entry already is).
 */
import type {
  ModelProfile,
  ModelProfileAccountInput,
  ModelProfileEntry,
  ModelProfileUpdateInput,
  ResolvedModelProfileAccount,
  ResolvedModelProfileEntry,
} from "@hercule/contract";
import { isSameStoredEntry } from "./profile-entries";

/** The stored form of a resolved entry: the three fields a write carries. */
const toStoredEntry = (entry: ModelProfileEntry): ModelProfileEntry => ({
  providerAccountId: entry.providerAccountId,
  model: entry.model,
  harnessId: entry.harnessId,
});

const toAccountInput = (section: ResolvedModelProfileAccount): ModelProfileAccountInput =>
  section.selectionPending
    ? { providerAccountId: section.providerAccountId, harnessId: section.harnessId }
    : {
        providerAccountId: section.providerAccountId,
        harnessId: section.harnessId,
        entries: section.entries.map(toStoredEntry),
      };

/** Returns `profile` in the write shape, unchanged. */
const toUpdateInput = (profile: ModelProfile): ModelProfileUpdateInput => ({
  expectedRevision: profile.revision,
  name: profile.name,
  accounts: profile.accounts.map(toAccountInput),
  defaultEntry: profile.defaultEntry,
  dismissedNewModels: profile.dismissedNewModels,
});

const holdsEntry = (input: ModelProfileUpdateInput, entry: ModelProfileEntry): boolean =>
  input.accounts.some((section) =>
    (section.entries ?? []).some((each) => isSameStoredEntry(each, entry)),
  );

/** Returns `list` with the item at `from` moved to `to`, both clamped into the list. */
const moveItem = <T>(list: readonly T[], from: number, to: number): T[] => {
  const moved = [...list];
  const [item] = moved.splice(from, 1);
  if (item === undefined) return moved;
  moved.splice(Math.max(0, Math.min(to, moved.length)), 0, item);
  return moved;
};

/**
 * Returns the profile with `entry` moved to position `toIndex` within its
 * own account's section (0 is the top). The index is clamped to the section.
 * An entry in a section that is still pending cannot move, because it has no
 * entries yet.
 */
export const moveModelProfileEntry = (
  profile: ModelProfile,
  entry: ModelProfileEntry,
  toIndex: number,
): ModelProfileUpdateInput => {
  const input = toUpdateInput(profile);
  return {
    ...input,
    accounts: input.accounts.map((section) => {
      if (section.providerAccountId !== entry.providerAccountId || section.entries === undefined) {
        return section;
      }
      const from = section.entries.findIndex((each) => isSameStoredEntry(each, entry));
      return from === -1
        ? section
        : { ...section, entries: moveItem(section.entries, from, toIndex) };
    }),
  };
};

/** Returns the profile with the section of `providerAccountId` moved to position `toIndex` (0 is the top), clamped to the list. */
export const moveModelProfileAccount = (
  profile: ModelProfile,
  providerAccountId: string,
  toIndex: number,
): ModelProfileUpdateInput => {
  const input = toUpdateInput(profile);
  const from = input.accounts.findIndex(
    (section) => section.providerAccountId === providerAccountId,
  );
  return from === -1 ? input : { ...input, accounts: moveItem(input.accounts, from, toIndex) };
};

/** Returns the profile with `entry` as its default entry. The entry must be one the profile holds. */
export const makeDefaultModelProfileEntry = (
  profile: ModelProfile,
  entry: ModelProfileEntry,
): ModelProfileUpdateInput => {
  const input = toUpdateInput(profile);
  return holdsEntry(input, entry) ? { ...input, defaultEntry: toStoredEntry(entry) } : input;
};

/**
 * Returns the profile without `entry`. The model is added to
 * `dismissedNewModels`, so the profile does not announce it as new again
 * (spec 06 §17.5). When the entry was the default, the default becomes the
 * first entry left in the profile, or `null` when none is left.
 */
export const takeOutModelProfileEntry = (
  profile: ModelProfile,
  entry: ModelProfileEntry,
): ModelProfileUpdateInput => {
  const input = toUpdateInput(profile);
  if (!holdsEntry(input, entry)) return input;
  const accounts = input.accounts.map((section) =>
    section.providerAccountId === entry.providerAccountId && section.entries !== undefined
      ? { ...section, entries: section.entries.filter((each) => !isSameStoredEntry(each, entry)) }
      : section,
  );
  const wasDefault = input.defaultEntry !== null && isSameStoredEntry(input.defaultEntry, entry);
  const alreadyDismissed = input.dismissedNewModels.some(
    (each) => each.providerAccountId === entry.providerAccountId && each.model === entry.model,
  );
  return {
    ...input,
    accounts,
    defaultEntry: wasDefault
      ? (accounts.flatMap((section) => section.entries ?? [])[0] ?? null)
      : input.defaultEntry,
    dismissedNewModels: alreadyDismissed
      ? input.dismissedNewModels
      : [
          ...input.dismissedNewModels,
          { providerAccountId: entry.providerAccountId, model: entry.model },
        ],
  };
};

/**
 * Returns the profile with the section of `providerAccountId` running its
 * models in `harnessId`; `null` is "same as the account", which follows the
 * account's default harness. The entries keep their stored `harnessId`, so an
 * entry that names a harness stays there and one that follows the section
 * moves with it. An account the profile does not hold changes nothing.
 */
export const setModelProfileAccountHarness = (
  profile: ModelProfile,
  providerAccountId: string,
  harnessId: string | null,
): ModelProfileUpdateInput => {
  const input = toUpdateInput(profile);
  return {
    ...input,
    accounts: input.accounts.map((section) =>
      section.providerAccountId === providerAccountId ? { ...section, harnessId } : section,
    ),
  };
};

/**
 * Returns the profile with `entry` running in `harnessId`; `null` makes it
 * follow its section's harness. When `entry` is the profile's default, the
 * default moves with it. An entry the profile no longer holds (another
 * window changed it first) changes nothing, so applying the move again to a
 * fresher profile is safe.
 */
export const moveModelProfileEntryToHarness = (
  profile: ModelProfile,
  entry: ResolvedModelProfileEntry,
  harnessId: string | null,
): ModelProfileUpdateInput => {
  const input = toUpdateInput(profile);
  if (!holdsEntry(input, entry)) return input;
  const moved: ModelProfileEntry = { ...toStoredEntry(entry), harnessId };
  return {
    ...input,
    accounts: input.accounts.map((section) =>
      section.providerAccountId === entry.providerAccountId && section.entries !== undefined
        ? {
            ...section,
            entries: section.entries.map((each) => (isSameStoredEntry(each, entry) ? moved : each)),
          }
        : section,
    ),
    defaultEntry:
      input.defaultEntry !== null && isSameStoredEntry(input.defaultEntry, entry)
        ? moved
        : input.defaultEntry,
  };
};

/**
 * Returns the profile with the model of `entry` also offered in `harnessId`
 * (`null` follows the section's harness), as a second entry right after
 * `entry`. Nothing changes when the section already holds the model in that
 * harness, whether an entry follows the section or names it outright, because
 * the controller refuses two entries of one model in one harness. Nothing
 * changes either for an entry the profile no longer holds.
 */
export const offerModelProfileEntryIn = (
  profile: ModelProfile,
  entry: ResolvedModelProfileEntry,
  harnessId: string | null,
): ModelProfileUpdateInput => {
  const input = toUpdateInput(profile);
  const resolved = profile.accounts.find(
    (section) => section.providerAccountId === entry.providerAccountId,
  );
  if (resolved === undefined) return input;
  const offeredIn = harnessId ?? resolved.resolvedHarnessId;
  const alreadyHeld = resolved.entries.some(
    (each) => each.model === entry.model && each.resolvedHarnessId === offeredIn,
  );
  if (alreadyHeld) return input;
  const offered: ModelProfileEntry = { ...toStoredEntry(entry), harnessId };
  return {
    ...input,
    accounts: input.accounts.map((section) => {
      if (section.providerAccountId !== entry.providerAccountId || section.entries === undefined) {
        return section;
      }
      const at = section.entries.findIndex((each) => isSameStoredEntry(each, entry));
      return at === -1
        ? section
        : { ...section, entries: section.entries.toSpliced(at + 1, 0, offered) };
    }),
  };
};

/**
 * Returns the profile with `models` added at the end of the account's
 * section, each as an entry that follows the section's harness. A model the
 * section already holds in that harness is not added twice, whether the held
 * entry follows the section's harness or names it outright, because the
 * controller refuses two entries of one model in one harness. A section still
 * pending stays pending: it will be filled with its Default Selection, which
 * the picker cannot have shown models for.
 *
 * When the profile has no default entry (it was emptied), the first model
 * added becomes the default, because the controller refuses a profile that
 * holds entries but no default.
 */
export const addModelProfileEntries = (
  profile: ModelProfile,
  providerAccountId: string,
  models: readonly string[],
): ModelProfileUpdateInput => {
  const input = toUpdateInput(profile);
  const resolved = profile.accounts.find(
    (section) => section.providerAccountId === providerAccountId,
  );
  if (resolved === undefined || resolved.selectionPending) return input;
  const heldModels = new Set(
    resolved.entries
      .filter((entry) => entry.resolvedHarnessId === resolved.resolvedHarnessId)
      .map((entry) => entry.model),
  );
  const added = [...new Set(models)]
    .filter((model) => !heldModels.has(model))
    .map((model): ModelProfileEntry => ({ providerAccountId, model, harnessId: null }));
  return {
    ...input,
    accounts: input.accounts.map((section) =>
      section.providerAccountId === providerAccountId && section.entries !== undefined
        ? { ...section, entries: [...section.entries, ...added] }
        : section,
    ),
    defaultEntry: input.defaultEntry ?? added[0] ?? null,
  };
};

/**
 * Returns the profile in which the account's section does (`included`) or
 * does not hold `model` in the section's harness. This is the picker's
 * choice, and it says what the user wants, not what to flip, so applying it
 * again to a fresher profile (after a `conflict`) gives the same result: a
 * model that is already held is not added twice or taken out, and one that
 * is already gone is not taken out again.
 *
 * Removing takes out the entry that runs in the section's harness, however
 * that entry names its harness, with the dismissal and the default change of
 * `takeOutModelProfileEntry`. Adding appends an entry that follows the
 * section's harness (`addModelProfileEntries`).
 */
export const setModelProfileEntryIncluded = (
  profile: ModelProfile,
  providerAccountId: string,
  model: string,
  included: boolean,
): ModelProfileUpdateInput => {
  if (included) return addModelProfileEntries(profile, providerAccountId, [model]);
  const section = profile.accounts.find((each) => each.providerAccountId === providerAccountId);
  const held = section?.entries.find(
    (entry) => entry.model === model && entry.resolvedHarnessId === section.resolvedHarnessId,
  );
  return held === undefined ? toUpdateInput(profile) : takeOutModelProfileEntry(profile, held);
};

/**
 * Returns the profile with the account added as its last section, sent
 * without entries so the controller applies the account's Default Selection.
 * An account the profile already holds is not added twice.
 */
export const addModelProfileAccount = (
  profile: ModelProfile,
  providerAccountId: string,
): ModelProfileUpdateInput => {
  const input = toUpdateInput(profile);
  return input.accounts.some((section) => section.providerAccountId === providerAccountId)
    ? input
    : { ...input, accounts: [...input.accounts, { providerAccountId, harnessId: null }] };
};

/**
 * Returns the profile renamed to `name`, as typed. The name is not trimmed
 * or checked: a blank name, or one another profile has, is refused by the
 * controller, and its message is what the user reads.
 */
export const renameModelProfile = (
  profile: ModelProfile,
  name: string,
): ModelProfileUpdateInput => ({
  ...toUpdateInput(profile),
  name,
});
