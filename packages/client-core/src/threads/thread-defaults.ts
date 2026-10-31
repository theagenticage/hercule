/**
 * Computes what a new thread starts with: the `thread.*` settings the user
 * has set, and built-in defaults for the rest (spec 02 §Thread). The rule is
 * written once here because two screens use it: the composer prefills a new
 * thread from it, and Settings > Threads shows it as the form's state. Two
 * copies of a rule drift apart.
 *
 * "Nothing picked" is always `null`, never an empty string. That happens when:
 *
 * - no account exists;
 * - no runner is signed in to the picked account;
 * - no profile has been created.
 *
 * The caller decides what to do (dim the field, disable Send); it never gets
 * an empty id that the API would reject.
 */
import type {
  AccessMode,
  Profile,
  ProviderAccount,
  Runner,
  SettingsState,
} from "@hercule/contract";
import type { ThreadConfig } from "./config";
import { resolveThreadHarnessId } from "../provider-accounts";
import { findDefaultProviderAccountId } from "./default-provider-account";
import { buildThreadModelField, type ThreadModelField } from "./model-field";
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

/**
 * Returns the slug of the model a new thread starts with, from `field`: the
 * model marked as default, else the first one, else `null` when there are none.
 */
const chooseDefaultModel = (field: ThreadModelField): string | null =>
  field.options.find((option) => option.isDefault)?.slug ?? field.options[0]?.slug ?? null;

/**
 * Returns the slug of the model a new thread on `account` starts with when it
 * runs in `harnessId` on `runnerId`: the default model of the account's
 * snapshot on that runner, else its first model, else `null`. Returns `null`
 * too when the account has no snapshot on that runner or is not signed in
 * there. It never reads another runner's snapshot, because a catalog belongs
 * to one account in one harness on one runner (spec 06 §3.1), and a model of
 * another runner would show `not offered on <runner>` before the user has
 * touched anything.
 */
export const findDefaultModel = (
  account: ProviderAccount,
  harnessId: string,
  runnerId: string | null,
): string | null => {
  const snapshot = account.snapshots.find(
    (each) => each.harnessId === harnessId && each.runnerId === runnerId,
  );
  return chooseDefaultModel(
    buildThreadModelField(
      { snapshots: snapshot === undefined ? [] : [snapshot] },
      harnessId,
      runnerId,
      undefined,
    ),
  );
};

/**
 * Returns the runner a new thread on this account would be placed on, and
 * the default model on that runner. The runner is resolved first, and the
 * model is read from that runner's snapshot. When no runner is usable, the
 * model comes from the account's first snapshot in the harness, so Settings
 * still lists the models of an account whose runners are all offline.
 */
export const computeProviderAccountDefaults = (
  account: ProviderAccount,
  harnessId: string,
  runners: readonly Runner[],
  thisMacRunnerId: string | null,
): { readonly runnerId: string | null; readonly model: string | null } => {
  const runnerId = buildRunnerMenu(runners, thisMacRunnerId, account, harnessId).defaultRunnerId;
  return {
    runnerId,
    model: chooseDefaultModel(buildThreadModelField(account, harnessId, runnerId, undefined)),
  };
};

/** Returns the defaults for a new thread, from the user's settings and the available catalogs. */
export const computeThreadDefaults = (
  settingsUser: SettingsState["user"],
  accounts: readonly ProviderAccount[],
  runners: readonly Runner[],
  profiles: readonly Profile[],
  thisMacRunnerId: string | null,
): ThreadDefaults => {
  // A stored account id that no longer exists (dangling) falls back the same
  // way an unset one does. So there is always an account to read a catalog
  // from, rather than an empty field with no explanation.
  const storedProviderAccountId = settingsUser["thread.providerAccountId"];
  const storedAccount = accounts.find((each) => each.id === storedProviderAccountId);
  const isDangling = storedProviderAccountId !== undefined && storedAccount === undefined;
  const account =
    storedAccount ?? accounts.find((each) => each.id === findDefaultProviderAccountId(accounts));
  // A stored harness belongs to the stored account. When the stored account
  // is gone, the fallback account runs in its own default harness.
  const harnessId = storedAccount === undefined ? null : (settingsUser["thread.harnessId"] ?? null);
  const forProviderAccount =
    account === undefined
      ? { runnerId: null, model: null }
      : computeProviderAccountDefaults(
          account,
          resolveThreadHarnessId(account, harnessId),
          runners,
          thisMacRunnerId,
        );

  return {
    providerAccountId: account?.id ?? null,
    harnessId,
    // A stored model that the resolved runner does not offer is still the
    // user's choice. It stays picked and the model menu shows that it is not
    // offered there, rather than silently replacing it with another model.
    // The exception is a dangling account: its model belonged to the deleted
    // account, so the fallback account's default model is used instead, as
    // the controller does.
    model: isDangling
      ? forProviderAccount.model
      : (settingsUser["thread.model"] ?? forProviderAccount.model),
    accessMode: settingsUser["thread.accessMode"] ?? DEFAULT_ACCESS_MODE,
    runnerId: forProviderAccount.runnerId,
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
  projectId,
  workspaceId,
}: {
  readonly settingsUser: SettingsState["user"];
  readonly accounts: readonly ProviderAccount[];
  readonly runners: readonly Runner[];
  readonly profiles: readonly Profile[];
  readonly thisMacRunnerId: string | null;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}): ThreadConfig => ({
  ...computeThreadDefaults(settingsUser, accounts, runners, profiles, thisMacRunnerId),
  options: {},
  projectId,
  workspace: workspaceId === null ? null : { kind: "existing", workspaceId },
  preferredWorkspace: settingsUser["thread.workspace"] ?? null,
});
