import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { updateModelProfile, type HerculeClient } from "@hercule/client-core";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import { modelProfilesQuery } from "./queries";

/**
 * Returns the cached list of Model Profiles, the newest the page holds, or an
 * empty list when it holds none yet.
 */
export const readCachedModelProfiles = (
  queryClient: QueryClient,
  client: HerculeClient,
): readonly ModelProfile[] => queryClient.getQueryData(modelProfilesQuery(client).queryKey) ?? [];

/**
 * Returns the cached copy of the profile with the id `profileId`, which is the
 * newest copy the page holds: the `provider` live topic and the answers of
 * earlier saves keep it current. A save is built from it and not from the
 * profile the user acted on, because a save that ran before has changed the
 * revision. Fails with "The profile is gone." when the list has no such
 * profile, such as after another client deleted it.
 */
export const readCachedModelProfile = (
  queryClient: QueryClient,
  client: HerculeClient,
  profileId: string,
): ModelProfile => {
  const cached = readCachedModelProfiles(queryClient, client).find(({ id }) => id === profileId);
  if (cached === undefined) throw new Error("The profile is gone.");
  return cached;
};

/**
 * Puts `saved`, a profile the controller just answered with, in the cached
 * list in place of the profile with its id. The `provider` live topic keeps
 * the list current too; this makes the answer visible at once.
 */
export const replaceCachedModelProfile = (
  queryClient: QueryClient,
  client: HerculeClient,
  saved: ModelProfile,
): void => {
  queryClient.setQueryData(modelProfilesQuery(client).queryKey, (list) =>
    list?.map((each) => (each.id === saved.id ? saved : each)),
  );
};

/** Adds `created` at the end of the cached list, which is in creation order, unless it is there already. */
export const addCachedModelProfile = (
  queryClient: QueryClient,
  client: HerculeClient,
  created: ModelProfile,
): void => {
  queryClient.setQueryData(modelProfilesQuery(client).queryKey, (list) =>
    list === undefined || list.some(({ id }) => id === created.id) ? list : [...list, created],
  );
};

/** Takes the profile with the id `id` out of the cached list. */
export const removeCachedModelProfile = (
  queryClient: QueryClient,
  client: HerculeClient,
  id: string,
): void => {
  queryClient.setQueryData(modelProfilesQuery(client).queryKey, (list) =>
    list?.filter((each) => each.id !== id),
  );
};

/**
 * Returns the mutation that saves one change to a Model Profile. Call it with
 * the id of the profile and `buildChange`, which builds the change from the
 * profile it is given (`updateModelProfile`).
 *
 * Every save of every caller shares the "model-profile" mutation scope, so
 * saves run one after the other. The profile is read from the cache when a
 * save's turn comes, not when the user acted, so a save never writes over one
 * that ran before it. The controller's answer replaces the profile in the
 * cache. The mutation fails with the reason `readCachedModelProfile` gives
 * when the profile is gone, or with the controller's refusal.
 */
export function useModelProfileUpdate(client: HerculeClient) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: "model-profile" },
    mutationFn: ({
      profileId,
      buildChange,
    }: {
      readonly profileId: string;
      readonly buildChange: (profile: ModelProfile) => ModelProfileUpdateInput;
    }) =>
      updateModelProfile(
        client,
        readCachedModelProfile(queryClient, client, profileId),
        buildChange,
      ),
    onSuccess: (saved) => {
      replaceCachedModelProfile(queryClient, client, saved);
    },
  });
}
