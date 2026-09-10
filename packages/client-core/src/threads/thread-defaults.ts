/**
 * What a new thread starts with: the `thread.*` settings where the user has
 * set them, else the shipped fallbacks (spec 02 §Thread). Written once here
 * because two screens read it - the composer prefills a new thread from it and
 * Settings > Threads presents it as the form's own state - and a rule written
 * twice is a rule that drifts.
 *
 * "Nothing picked" is `null` throughout, never an empty string: no instance
 * exists, no runner is logged in to the picked one, no profile has been
 * created. The caller decides what to do with that (dim the field, disable
 * Send); it never gets an id-shaped value the API would refuse.
 */
import type { AccessMode, Profile, ProviderInstance, Runner, SettingsState } from "@hydra/contract";
import { defaultInstanceId } from "./default-instance";
import { threadModelField } from "./model-field";
import { runnerMenu } from "./runner-menu";

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
 * The runner a new thread on this instance would be placed on, and the model
 * that runner offers by default. Resolved in that order and never separately:
 * a catalog is scoped instance x runner (spec 06 §3.1), so a model read from
 * one machine's snapshot beside a runner that is another machine is a pill
 * reading `not offered on <runner>` before the user has touched anything.
 */
export const instanceDefaults = (
  instance: ProviderInstance,
  runners: readonly Runner[],
  localRunnerId: string | null,
): { readonly runnerId: string | null; readonly model: string | null } => {
  const runnerId = runnerMenu(runners, localRunnerId, instance).defaultRunnerId;
  const field = threadModelField(instance, runnerId, undefined);
  const model =
    field.options.find((option) => option.isDefault)?.slug ?? field.options[0]?.slug ?? null;
  return { runnerId, model };
};

export const threadDefaults = (
  settingsUser: SettingsState["user"],
  instances: readonly ProviderInstance[],
  runners: readonly Runner[],
  profiles: readonly Profile[],
  localRunnerId: string | null,
): ThreadDefaults => {
  // A stored id naming an instance that no longer exists falls back the same
  // way an unset one does, so there is always a picked instance to read a
  // catalog from - never the empty, unexplained field a stale id would leave.
  const instance =
    instances.find((each) => each.id === settingsUser["thread.instanceId"]) ??
    instances.find((each) => each.id === defaultInstanceId(instances));
  const forInstance =
    instance === undefined
      ? { runnerId: null, model: null }
      : instanceDefaults(instance, runners, localRunnerId);

  return {
    instanceId: instance?.id ?? null,
    // A stored model the resolved runner does not offer is still the user's
    // own choice: it stays picked and the model menu says it is not offered
    // there, rather than being swapped for another model behind their back.
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
