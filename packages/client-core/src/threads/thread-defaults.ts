/**
 * Computes what a new thread starts with: the `thread.*` settings the user
 * has set, and built-in defaults for the rest (spec 02 §Thread). The rule is
 * written once here because two screens use it: the composer prefills a new
 * thread from it, and Settings > Threads shows it as the form's state. Two
 * copies of a rule drift apart.
 *
 * "Nothing picked" is always `null`, never an empty string. That happens when:
 *
 * - no instance exists;
 * - no runner is logged in to the picked instance;
 * - no profile has been created.
 *
 * The caller decides what to do (dim the field, disable Send); it never gets
 * an empty id that the API would reject.
 */
import type {
  AccessMode,
  Profile,
  ProviderInstance,
  Runner,
  SettingsState,
} from "@hercule/contract";
import type { ThreadConfig } from "./config";
import { findDefaultInstanceId } from "./default-instance";
import { buildThreadModelField } from "./model-field";
import { buildRunnerMenu } from "./runner-menu";

const DEFAULT_PROFILE_NAME = "unrestricted";
const DEFAULT_ACCESS_MODE: AccessMode = "approval-required";

export interface ThreadDefaults {
  readonly instanceId: string | null;
  readonly model: string | null;
  readonly accessMode: AccessMode;
  readonly runnerId: string | null;
  readonly profileId: string | null;
}

/**
 * Returns the runner a new thread on this instance would be placed on, and
 * the default model on that runner. The runner is resolved first, and the
 * model is read from that runner's snapshot: a catalog belongs to one instance
 * on one runner (spec 06 §3.1). A model read from another runner's snapshot
 * could show `not offered on <runner>` before the user has touched anything.
 */
export const computeInstanceDefaults = (
  instance: ProviderInstance,
  runners: readonly Runner[],
  localRunnerId: string | null,
): { readonly runnerId: string | null; readonly model: string | null } => {
  const runnerId = buildRunnerMenu(runners, localRunnerId, instance).defaultRunnerId;
  const field = buildThreadModelField(instance, runnerId, undefined);
  const model =
    field.options.find((option) => option.isDefault)?.slug ?? field.options[0]?.slug ?? null;
  return { runnerId, model };
};

/** Returns the defaults for a new thread, from the user's settings and the available catalogs. */
export const computeThreadDefaults = (
  settingsUser: SettingsState["user"],
  instances: readonly ProviderInstance[],
  runners: readonly Runner[],
  profiles: readonly Profile[],
  localRunnerId: string | null,
): ThreadDefaults => {
  // A stored instance id that no longer exists falls back the same way an
  // unset one does. So there is always an instance to read a catalog from,
  // rather than an empty field with no explanation.
  const instance =
    instances.find((each) => each.id === settingsUser["thread.instanceId"]) ??
    instances.find((each) => each.id === findDefaultInstanceId(instances));
  const forInstance =
    instance === undefined
      ? { runnerId: null, model: null }
      : computeInstanceDefaults(instance, runners, localRunnerId);

  return {
    instanceId: instance?.id ?? null,
    // A stored model that the resolved runner does not offer is still the
    // user's choice. It stays picked and the model menu shows that it is not
    // offered there, rather than silently replacing it with another model.
    model: settingsUser["thread.model"] ?? forInstance.model,
    accessMode: settingsUser["thread.accessMode"] ?? DEFAULT_ACCESS_MODE,
    runnerId: forInstance.runnerId,
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
 * changes while the draft is open, such as after a provider login, fills in
 * whatever the user has not picked.
 */
export const buildDraftConfig = ({
  settingsUser,
  instances,
  runners,
  profiles,
  localRunnerId,
  projectId,
  workspaceId,
}: {
  readonly settingsUser: SettingsState["user"];
  readonly instances: readonly ProviderInstance[];
  readonly runners: readonly Runner[];
  readonly profiles: readonly Profile[];
  readonly localRunnerId: string | null;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}): ThreadConfig => ({
  ...computeThreadDefaults(settingsUser, instances, runners, profiles, localRunnerId),
  options: {},
  projectId,
  workspace: workspaceId === null ? null : { kind: "existing", workspaceId },
  preferredWorkspace: settingsUser["thread.workspace"] ?? null,
});
