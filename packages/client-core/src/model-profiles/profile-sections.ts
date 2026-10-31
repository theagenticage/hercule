/**
 * Turns a Model Profile into what Settings > Providers > Models draws: one
 * section per account, with a row per entry. The page draws these as they come
 * and holds no rule of its own about which entry is the default, which runs in
 * another harness than its section, or which has a problem worth showing.
 */
import type {
  Harness,
  ModelProfile,
  Provider,
  ProviderAccount,
  ResolvedModelProfileEntry,
  Runner,
} from "@hercule/contract";
import { buildProviderAccountName, findProviderPluginId } from "../provider-accounts";
import { isMachineProblemReason } from "./entry-problem";
import {
  buildSectionHarnessChoices,
  type HarnessOption,
  type HarnessTarget,
  type SectionHarness,
} from "./profile-harnesses";
import {
  buildProfileEntryKey,
  findOtherHarnessName,
  formatProfileEntryKey,
  isSameStoredEntry,
} from "./profile-entries";

/** One entry as its row draws it. */
export interface ModelSectionRow {
  /** Names the entry among the profile's, such as for a drag; it holds the entry's account, harness and model. */
  readonly key: string;
  readonly entry: ResolvedModelProfileEntry;
  /** The model's name. */
  readonly name: string;
  /** Whether this is the profile's default entry. */
  readonly isDefault: boolean;
  /** The name of the harness the entry runs in when that is not its section's harness, such as "pi"; else `null`. */
  readonly otherHarnessName: string | null;
  /**
   * Why the entry cannot be offered, in the controller's words, when its
   * account's Model Catalog no longer lists the model, its harness does not
   * know it, or its harness may not run the account; else `null`. Problems
   * with the machine, such as a missing sign-in, are not here: the account's
   * card shows those.
   */
  readonly problem: string | null;
  /** The harnesses the entry can run in, struck through where it cannot; empty when there are fewer than two. */
  readonly runsIn: readonly HarnessOption[];
  /** The harnesses the model can be offered in as another entry. */
  readonly alsoOfferIn: readonly HarnessTarget[];
}

/** One account's section of the profile. */
export interface ModelSection {
  readonly providerAccountId: string;
  /** The account's name, such as "Anthropic · Work". */
  readonly name: string;
  /** The id of the plugin whose mark the provider wears; `null` when no provider is registered for it any more. */
  readonly pluginId: string | null;
  /** Whether the section waits for the account's first Model Catalog read, which will fill it. */
  readonly selectionPending: boolean;
  /** The harness pill in the section's head. */
  readonly harness: SectionHarness;
  readonly rows: readonly ModelSectionRow[];
  /**
   * The slugs of the entries that run in the section's harness, whether they
   * follow it (a stored `harnessId` of `null`) or name it outright. The
   * picker checks these, because picking a model adds an entry that runs in
   * the section's harness, and the controller refuses two entries of one model
   * in one harness.
   */
  readonly sectionHarnessModels: readonly string[];
}

/**
 * Returns the sections of `profile` in its order. A section whose account is
 * not in `accounts` is left out: the controller removes an account from every
 * profile when it deletes it, so such a section only shows between the two
 * reads that follow a delete.
 */
export const buildModelProfileSections = (
  profile: ModelProfile,
  catalogs: {
    readonly accounts: readonly ProviderAccount[];
    readonly providers: readonly Provider[];
    readonly harnesses: readonly Harness[];
    readonly runners: readonly Runner[];
  },
): readonly ModelSection[] => {
  const { defaultEntry } = profile;
  return profile.accounts.flatMap((section) => {
    const account = catalogs.accounts.find(({ id }) => id === section.providerAccountId);
    if (account === undefined) return [];
    const { harness, buildRowChoices } = buildSectionHarnessChoices(section, account, catalogs);
    return [
      {
        providerAccountId: account.id,
        name: buildProviderAccountName(catalogs.providers, account),
        pluginId: findProviderPluginId(catalogs.providers, account),
        selectionPending: section.selectionPending,
        harness,
        sectionHarnessModels: section.entries
          .filter((entry) => entry.resolvedHarnessId === section.resolvedHarnessId)
          .map((entry) => entry.model),
        rows: section.entries.map((entry) => ({
          key: formatProfileEntryKey(buildProfileEntryKey(entry)),
          entry,
          name: entry.name,
          isDefault: defaultEntry !== null && isSameStoredEntry(defaultEntry, entry),
          otherHarnessName: findOtherHarnessName(catalogs.harnesses, section, entry),
          problem:
            entry.problem !== null && !isMachineProblemReason(entry.problem.reason)
              ? entry.problem.message
              : null,
          ...buildRowChoices(entry),
        })),
      },
    ];
  });
};
