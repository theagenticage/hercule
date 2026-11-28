/**
 * Runs one save of a Model Profile (see `buildModelProfileUpdateOptions`). The
 * save options import this file when the first save runs, so the app's first
 * screen does not carry the code that only a save needs.
 */
import type { QueryClient } from "@tanstack/query-core";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { addNewModel, dismissNewModel } from "./profile-edits";
import type { ModelProfileSave, ModelProfilesQueryKey } from "./profile-save";
import { updateModelProfile } from "./update-profile";

/**
 * Returns the cached copy of the profile with the id `profileId`, which is the
 * newest copy the app holds: the `provider` live topic and the answers of
 * earlier saves keep it current. Fails with "This profile was deleted. Pick
 * another profile." when the cached list has no such profile, such as after
 * another client deleted it.
 */
export const readCachedModelProfile = (
  queryClient: QueryClient,
  profilesKey: ModelProfilesQueryKey,
  profileId: string,
): ModelProfile => {
  const cached = queryClient.getQueryData(profilesKey)?.find(({ id }) => id === profileId);
  if (cached === undefined) throw new Error("This profile was deleted. Pick another profile.");
  return cached;
};

/** Returns the function that builds the change of `save` from a profile. */
const selectChangeBuilder = (
  save: ModelProfileSave,
): ((profile: ModelProfile) => ModelProfileUpdateInput) => {
  if ("buildChange" in save) return save.buildChange;
  const { providerAccountId, model, action } = save.newModelEdit;
  const edit = action === "add" ? addNewModel : dismissNewModel;
  return (profile) => edit(profile, providerAccountId, model);
};

/**
 * Sends `save` for the profile as the cache holds it now, and returns the
 * profile as the controller answers. Fails with the reason
 * `readCachedModelProfile` gives, or with the controller's refusal.
 */
export const runModelProfileSave = (
  client: HerculeClient,
  queryClient: QueryClient,
  profilesKey: ModelProfilesQueryKey,
  save: ModelProfileSave,
): Promise<ModelProfile> =>
  updateModelProfile(
    client,
    readCachedModelProfile(queryClient, profilesKey, save.profileId),
    selectChangeBuilder(save),
  );
