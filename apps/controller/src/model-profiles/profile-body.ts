/**
 * What a Model Profile stores in its `body` column, and the pure changes made
 * to it. The profile's id, name and revision live in their own columns.
 *
 * A section whose `entries` is `null` is waiting for its account's first
 * Model Catalog read, which fills it with the Default Selection. A client
 * reads that as `selectionPending: true` with no entries.
 */
import * as Schema from "effect/Schema";
import { DismissedNewModel, Id, ModelProfileEntry } from "@hercule/contract";
import type { DefaultSelection } from "../provider-accounts";

/** One account's section as it is stored. */
export const StoredSection = Schema.Struct({
  providerAccountId: Id,
  harnessId: Schema.NullOr(Schema.String),
  entries: Schema.NullOr(Schema.Array(ModelProfileEntry)),
});

export type StoredSection = Schema.Schema.Type<typeof StoredSection>;

export const StoredProfileBody = Schema.Struct({
  accounts: Schema.Array(StoredSection),
  defaultEntry: Schema.NullOr(ModelProfileEntry),
  dismissedNewModels: Schema.Array(DismissedNewModel),
});

export type StoredProfileBody = Schema.Schema.Type<typeof StoredProfileBody>;

/** Returns the entries a Default Selection gives a section of the account: its models, in its order, in the section's harness. */
export const buildSelectionEntries = (
  providerAccountId: string,
  selection: DefaultSelection,
): ReadonlyArray<ModelProfileEntry> =>
  selection.models.map((model) => ({ providerAccountId, model, harnessId: null }));

/**
 * Returns the entry a profile takes as its default when a Default Selection
 * fills it and it had none: the selection's default model when the selection
 * holds it, else the first of the entries. `null` when there are no entries.
 */
export const pickSelectionDefault = (
  entries: ReadonlyArray<ModelProfileEntry>,
  selection: DefaultSelection,
): ModelProfileEntry | null =>
  entries.find((entry) => entry.model === selection.defaultModel) ?? entries[0] ?? null;

/** Returns whether two entries are the same row of the menu: same account, model and stored harness. */
export const isSameEntry = (left: ModelProfileEntry, right: ModelProfileEntry): boolean =>
  left.providerAccountId === right.providerAccountId &&
  left.model === right.model &&
  left.harnessId === right.harnessId;

/**
 * Returns the harness an entry runs in when it or its section names one: the
 * entry's own, else the section's. Returns `null` when neither does, which
 * means the entry follows the account's default harness.
 */
export const findNamedHarnessId = (
  entry: ModelProfileEntry,
  section: Pick<StoredSection, "harnessId">,
): string | null => entry.harnessId ?? section.harnessId;

/** Returns the entries of every section that has them, in menu order. */
export const listEntries = (body: StoredProfileBody): ReadonlyArray<ModelProfileEntry> =>
  body.accounts.flatMap((section) => section.entries ?? []);

/**
 * Returns the body without the account: its section and the models of it the
 * profile had dismissed. A default entry of the account moves to the first
 * remaining entry, or `null` when none remains. Returns `null` when the body
 * does not hold the account, so a caller can tell nothing changed.
 */
export const removeAccountFromBody = (
  body: StoredProfileBody,
  providerAccountId: string,
): StoredProfileBody | null => {
  if (!body.accounts.some((section) => section.providerAccountId === providerAccountId)) {
    return null;
  }
  const remaining: StoredProfileBody = {
    accounts: body.accounts.filter((section) => section.providerAccountId !== providerAccountId),
    defaultEntry: body.defaultEntry,
    dismissedNewModels: body.dismissedNewModels.filter(
      (dismissed) => dismissed.providerAccountId !== providerAccountId,
    ),
  };
  return body.defaultEntry?.providerAccountId === providerAccountId
    ? { ...remaining, defaultEntry: listEntries(remaining)[0] ?? null }
    : remaining;
};

/**
 * Returns the body with every pending section of the account filled with the
 * selection. When the body had no default entry, the first filled section's
 * entries give it one (`pickSelectionDefault`). Returns `null` when the
 * account has no pending section, so a caller can tell nothing changed.
 */
export const fillPendingSections = (
  body: StoredProfileBody,
  providerAccountId: string,
  selection: DefaultSelection,
): StoredProfileBody | null => {
  const isPending = (section: StoredSection): boolean =>
    section.providerAccountId === providerAccountId && section.entries === null;
  if (!body.accounts.some(isPending)) return null;
  const entries = buildSelectionEntries(providerAccountId, selection);
  return {
    ...body,
    accounts: body.accounts.map((section) =>
      isPending(section) ? { ...section, entries } : section,
    ),
    defaultEntry: body.defaultEntry ?? pickSelectionDefault(entries, selection),
  };
};

/**
 * Returns the models of the section that would appear twice if the account's
 * default harness became `defaultHarnessId`. An entry follows the account's
 * default harness only when neither it nor its section names a harness, and
 * such an entry then lands on an entry that names `defaultHarnessId` itself
 * for the same model. A section that names a harness is not moved by the
 * account's default.
 */
export const findModelsClashingOnDefaultHarness = (
  section: StoredSection,
  defaultHarnessId: string,
): ReadonlyArray<string> => {
  if (section.harnessId !== null || section.entries === null) return [];
  const namedHere = new Set(
    section.entries
      .filter((entry) => entry.harnessId === defaultHarnessId)
      .map((entry) => entry.model),
  );
  return section.entries
    .filter((entry) => entry.harnessId === null && namedHere.has(entry.model))
    .map((entry) => entry.model);
};
