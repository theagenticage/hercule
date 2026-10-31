/**
 * Builds the model field of Settings > Threads. The thread default is an entry
 * of the open Model Profile: an account, the harness it runs in and a model.
 * The field lists the same rows the composer's model menu builds
 * (`buildModelMenu`), so the two never offer different choices.
 *
 * A stored entry that the profile no longer holds stays in the list, marked as
 * missing. A choice made before the user took the model out of the profile
 * then does not silently disappear from the field.
 */
import type { ProviderAccount } from "@hercule/contract";
import { formatProfileEntryKey, type ProfileEntryKey } from "../model-profiles/profile-entries";
import { buildProviderAccountName, resolveThreadHarnessId } from "../provider-accounts";
import type { ThreadCatalogs } from "./config";
import { buildModelMenu } from "./model-menu";
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

export interface ThreadModelField {
  /** Why there is nothing to choose. When this is set, `options` is empty. */
  readonly dimmed: string | null;
  readonly options: readonly ThreadModelFieldOption[];
  /** The key of the option the stored default selects, or `null` when no model is set. */
  readonly selectedKey: string | null;
}

type StoredEntry = Pick<ThreadDefaults, "providerAccountId" | "harnessId" | "model">;

/**
 * Returns the model field for the thread default `current`, from the open
 * profile's entries. A default whose entry no profile holds is added as the
 * last, missing option.
 */
export const buildThreadModelField = (
  catalogs: ThreadCatalogs,
  current: StoredEntry,
): ThreadModelField => {
  // The field always offers the first profile, as the menu's opened one.
  const menu = buildModelMenu(
    catalogs,
    { ...current, runnerId: null },
    {
      kind: "draft",
      filter: "",
      recent: [],
      runnerId: null,
      openedProfileId: catalogs.modelProfiles[0]?.id ?? null,
      lastOpenProfileId: null,
    },
  );
  const profile = menu.kind === "draft" ? menu.profiles.find((each) => each.unfolded) : undefined;
  const options: ThreadModelFieldOption[] =
    profile !== undefined
      ? profile.lanes.flatMap((lane) =>
          lane.rows.map((row) => ({
            key: formatProfileEntryKey({
              providerAccountId: row.providerAccountId,
              harnessId: row.harnessId,
              model: row.model,
            }),
            label: [lane.name, row.name, row.inHarness === null ? null : `in ${row.inHarness}`]
              .filter((part) => part !== null)
              .join(" · "),
            providerAccountId: row.providerAccountId,
            harnessId: row.harnessId,
            model: row.model,
            missing: false,
            problem: row.problem?.message ?? null,
          })),
        )
      : [];

  const stored = readStoredKey(catalogs.accounts, current);
  const selectedKey = stored === null ? null : formatProfileEntryKey(stored);
  if (stored !== null && !options.some((option) => option.key === selectedKey)) {
    const account = catalogs.accounts.find((each) => each.id === stored.providerAccountId);
    options.push({
      key: formatProfileEntryKey(stored),
      label:
        account === undefined
          ? stored.model
          : `${buildProviderAccountName(catalogs.providers, account)} · ${stored.model}`,
      ...stored,
      missing: true,
      problem: null,
    });
  }

  return {
    dimmed: options.length === 0 ? "no models in your profile yet" : null,
    options,
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
