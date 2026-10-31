import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import { modelProfilesQuery } from "../../../../app/queries";

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
