/**
 * Builds the model field of Settings > Threads. The thread default is an entry
 * of a Model Profile: an account, the harness it runs in and a model. The field
 * lists the entries of every profile, built from the same rows the composer's
 * model menu builds (`buildModelMenu`), so the two never offer different
 * choices. With two or more profiles the entries are grouped by profile name.
 *
 * A stored entry that the profile no longer holds stays in the list, marked as
 * missing. A choice made before the user took the model out of the profile
 * then does not silently disappear from the field.
 */
import type { ProviderAccount } from "@hercule/contract";
import { formatProfileEntryKey, type ProfileEntryKey } from "../model-profiles/profile-entries";
import { buildProviderAccountName, resolveThreadHarnessId } from "../provider-accounts";
import type { ThreadCatalogs } from "./config";
import { buildProfileLanes } from "./model-menu";
import type { ThreadDefaults } from "./thread-defaults";

/** One entry the field offers. */
export interface ThreadModelFieldOption {
  /** A unique string for the form control to hold; not a setting value. */
  readonly key: string;
  /** What the option reads, such as `Anthropic · Opus 5.5` or `Z.ai · GLM-5 · in pi`. */
  readonly label: string;
  readonly providerAccountId: string;
  /** The qualified id of the harness the entry runs in. */
  readonly harnessId: string;
  readonly model: string;
  /** The stored entry, kept on the list even though no profile holds it. */
  readonly missing: boolean;
  /** Why the entry cannot run now, or `null` when it can. */
  readonly problem: string | null;
}

/** The entries of one Model Profile, or the entries that no profile holds. */
export interface ThreadModelFieldGroup {
  /** The profile's name, or `null` when the field is not grouped or the entries belong to no profile. */
  readonly label: string | null;
  readonly options: readonly ThreadModelFieldOption[];
}

export interface ThreadModelField {
  /** Why there is nothing to choose. When this is set, `options` is empty. */
  readonly dimmed: string | null;
  /** Every option of `groups`, in order. */
  readonly options: readonly ThreadModelFieldOption[];
  /**
   * The options in the order the field draws them. With two or more profiles
   * there is one labelled group per profile that holds an entry; with one
   * profile there is a single group without a label. A stored entry that no
   * profile holds is a last group without a label.
   */
  readonly groups: readonly ThreadModelFieldGroup[];
  /** The key of the option the stored default selects, or `null` when no model is set. */
  readonly selectedKey: string | null;
}

type StoredEntry = Pick<ThreadDefaults, "providerAccountId" | "harnessId" | "model">;

/**
 * Returns the model field for the thread default `current`, from the entries
 * of every profile. An entry that several profiles hold is listed once, under
 * the first of them, because the stored default does not name a profile. A
 * default whose entry no profile holds is added as the last, missing option.
 */
export const buildThreadModelField = (
  catalogs: ThreadCatalogs,
  current: StoredEntry,
): ThreadModelField => {
  const grouped = catalogs.modelProfiles.length >= 2;
  const seenKeys = new Set<string>();
  const groups: ThreadModelFieldGroup[] = [];
  for (const modelProfile of catalogs.modelProfiles) {
    const options = buildProfileLanes(catalogs, modelProfile).flatMap((lane) =>
      lane.rows.flatMap((row): readonly ThreadModelFieldOption[] => {
        const key = formatProfileEntryKey({
          providerAccountId: row.providerAccountId,
          harnessId: row.harnessId,
          model: row.model,
        });
        if (seenKeys.has(key)) return [];
        seenKeys.add(key);
        return [
          {
            key,
            label: [lane.name, row.name, row.inHarness === null ? null : `in ${row.inHarness}`]
              .filter((part) => part !== null)
              .join(" · "),
            providerAccountId: row.providerAccountId,
            harnessId: row.harnessId,
            model: row.model,
            missing: false,
            problem: row.problem?.message ?? null,
          },
        ];
      }),
    );
    if (options.length > 0) groups.push({ label: grouped ? modelProfile.name : null, options });
  }

  const stored = readStoredKey(catalogs.accounts, current);
  const selectedKey = stored === null ? null : formatProfileEntryKey(stored);
  if (stored !== null && !seenKeys.has(selectedKey!)) {
    const account = catalogs.accounts.find((each) => each.id === stored.providerAccountId);
    groups.push({
      label: null,
      options: [
        {
          key: formatProfileEntryKey(stored),
          label:
            account === undefined
              ? stored.model
              : `${buildProviderAccountName(catalogs.providers, account)} · ${stored.model}`,
          ...stored,
          missing: true,
          problem: null,
        },
      ],
    });
  }

  const options = groups.flatMap((group) => group.options);
  return {
    dimmed: options.length === 0 ? "no models in your profile yet" : null,
    options,
    groups,
    selectedKey,
  };
};

/** Returns the key of the stored entry, or `null` while no account or model is stored or the account is gone. */
const readStoredKey = (
  accounts: readonly ProviderAccount[],
  current: StoredEntry,
): ProfileEntryKey | null => {
  const account = accounts.find((each) => each.id === current.providerAccountId);
  return account === undefined || current.model === null
    ? null
    : {
        providerAccountId: account.id,
        harnessId: resolveThreadHarnessId(account, current.harnessId),
        model: current.model,
      };
};
