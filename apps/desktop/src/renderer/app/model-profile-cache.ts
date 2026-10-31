import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { buildModelProfileUpdateOptions, type HerculeClient } from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import { modelProfilesQuery } from "./queries";

/**
 * Returns the cached list of Model Profiles, the newest the page holds, or an
 * empty list when it holds none yet.
 */
export const readCachedModelProfiles = (
  queryClient: QueryClient,
  client: HerculeClient,
): readonly ModelProfile[] => queryClient.getQueryData(modelProfilesQuery(client).queryKey) ?? [];

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
 * profile it is given (`buildModelProfileUpdateOptions` has the rules).
 */
export function useModelProfileUpdate(client: HerculeClient) {
  const queryClient = useQueryClient();
  return useMutation(
    buildModelProfileUpdateOptions(client, queryClient, modelProfilesQuery(client).queryKey),
  );
}
