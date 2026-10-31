/**
 * Computes what a new thread starts with: the `thread.*` settings the user
 * has set, then the open Model Profile's default entry, and built-in defaults
 * for the rest (spec 02 §Thread, spec 06 §17.9). The rule is written once here
 * because two screens use it: the composer prefills a new thread from it, and
 * Settings > Threads shows it as the form's state. Two copies of a rule drift
 * apart.
 *
 * "Nothing picked" is always `null`, never an empty string. That happens when:
 *
 * - no account exists;
 * - no runner is ready for the picked account;
 * - the Model Profile has no entry and no model is stored;
 * - no profile has been created.
 *
 * The caller decides what to do (dim the field, disable Send); it never gets
 * an empty id that the API would reject.
 */
import type {
  AccessMode,
  ModelProfile,
  Profile,
  ProviderAccount,
  ResolvedModelProfileEntry,
  Runner,
  SettingsState,
} from "@hercule/contract";
import {
  findAccountDefaultEntry,
  findProfileDefaultEntry,
} from "../model-profiles/profile-entries";
import type { ThreadConfig } from "./config";
import { resolveThreadHarnessId } from "../provider-accounts";
import { findDefaultProviderAccountId } from "./default-provider-account";
import { buildRunnerMenu } from "./runner-menu";

const DEFAULT_PROFILE_NAME = "unrestricted";
const DEFAULT_ACCESS_MODE: AccessMode = "approval-required";

export interface ThreadDefaults {
  readonly providerAccountId: string | null;
  /** The qualified harness id the thread runs in; `null` runs it in the account's default harness. */
  readonly harnessId: string | null;
  readonly model: string | null;
  readonly accessMode: AccessMode;
  readonly runnerId: string | null;
  readonly profileId: string | null;
}

/** The account, harness and model a new thread starts on, before a runner is chosen for it. */
interface StartingEntry {
  readonly account: ProviderAccount | undefined;
  /** The qualified harness id, or `null` for the account's default harness. */
  readonly harnessId: string | null;
  readonly model: string | null;
}

/**
 * Returns the starting entry that runs the profile `entry` on `account`, in
 * the harness the entry resolved to, so the thread runs where the menu showed.
 */
const buildStartingEntry = (
  account: ProviderAccount,
  entry: ResolvedModelProfileEntry,
): StartingEntry => ({ account, harnessId: entry.resolvedHarnessId, model: entry.model });

/**
 * Returns the account, harness and model a new thread starts on:
 *
 * - the stored `thread.*` settings, when the stored account still exists. A
 *   stored harness and model belong to the stored account. With no stored
 *   model, the open profile's entry for that account applies;
 * - otherwise (nothing stored, or the stored account is gone) the open
 *   profile's default entry. A model stored without an account is ignored,
 *   because it belonged to no account that exists;
 * - otherwise the first account that is ready, with no model.
 *
 * A stored model that no profile holds is still the user's choice. It stays
 * picked and the menu shows it is not offered, rather than silently replacing
 * it with another model.
 */
const chooseStartingEntry = (
  settingsUser: SettingsState["user"],
  accounts: readonly ProviderAccount[],
  openProfile: ModelProfile | undefined,
): StartingEntry => {
  const storedAccount = accounts.find(
    (each) => each.id === settingsUser["thread.providerAccountId"],
  );
  if (storedAccount !== undefined) {
    const storedModel = settingsUser["thread.model"];
    if (storedModel !== undefined) {
      return {
        account: storedAccount,
        harnessId: settingsUser["thread.harnessId"] ?? null,
        model: storedModel,
      };
    }
    const entry =
      openProfile === undefined
        ? undefined
        : findAccountDefaultEntry(openProfile, storedAccount.id);
    return entry === undefined
      ? { account: storedAccount, harnessId: settingsUser["thread.harnessId"] ?? null, model: null }
      : buildStartingEntry(storedAccount, entry);
  }
  const entry = openProfile === undefined ? undefined : findProfileDefaultEntry(openProfile);
  const entryAccount = accounts.find((each) => each.id === entry?.providerAccountId);
  if (entry !== undefined && entryAccount !== undefined)
    return buildStartingEntry(entryAccount, entry);
  return {
    account: accounts.find((each) => each.id === findDefaultProviderAccountId(accounts)),
    harnessId: null,
    model: null,
  };
};

/**
 * Returns the defaults for a new thread, from the user's settings, the open
 * Model Profile (the first one) and the available runners.
 */
export const computeThreadDefaults = (
  settingsUser: SettingsState["user"],
  accounts: readonly ProviderAccount[],
  runners: readonly Runner[],
  profiles: readonly Profile[],
  thisMacRunnerId: string | null,
  modelProfiles: readonly ModelProfile[],
): ThreadDefaults => {
  const { account, harnessId, model } = chooseStartingEntry(
    settingsUser,
    accounts,
    modelProfiles[0],
  );
  const runnerId =
    account === undefined
      ? null
      : buildRunnerMenu(
          runners,
          thisMacRunnerId,
          account,
          resolveThreadHarnessId(account, harnessId),
        ).defaultRunnerId;

  return {
    providerAccountId: account?.id ?? null,
    harnessId,
    model,
    accessMode: settingsUser["thread.accessMode"] ?? DEFAULT_ACCESS_MODE,
    runnerId,
    profileId:
      settingsUser["thread.profileId"] ??
      profiles.find((profile) => profile.name === DEFAULT_PROFILE_NAME)?.id ??
      profiles[0]?.id ??
      null,
  };
};

/**
 * Returns what a Draft Thread runs with before the user picks anything: the
 * defaults of `computeThreadDefaults`, no model options, the draft's project,
 * and the workspace it joins. `workspaceId` is `null` for a draft that joins
 * no workspace; the composer then opens it where the stored `thread.workspace`
 * setting says, which the config carries along.
 *
 * Call it on every render rather than keeping the result, so a catalog that
 * changes while the draft is open, such as after a sign-in, fills in
 * whatever the user has not picked.
 */
export const buildDraftConfig = ({
  settingsUser,
  accounts,
  runners,
  profiles,
  thisMacRunnerId,
  modelProfiles,
  projectId,
  workspaceId,
}: {
  readonly settingsUser: SettingsState["user"];
  readonly accounts: readonly ProviderAccount[];
  readonly runners: readonly Runner[];
  readonly profiles: readonly Profile[];
  readonly thisMacRunnerId: string | null;
  readonly modelProfiles: readonly ModelProfile[];
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}): ThreadConfig => ({
  ...computeThreadDefaults(
    settingsUser,
    accounts,
    runners,
    profiles,
    thisMacRunnerId,
    modelProfiles,
  ),
  options: {},
  projectId,
  workspace: workspaceId === null ? null : { kind: "existing", workspaceId },
  preferredWorkspace: settingsUser["thread.workspace"] ?? null,
});
