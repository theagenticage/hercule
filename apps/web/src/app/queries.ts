/**
 * The reads the shell itself depends on.
 *
 * Both are answered once per page load and then held: first run happens once,
 * and the settings store changes only through a write this app made, which puts
 * the answer it got back into the cache. Neither retries - a failure here is
 * something the user has to see, not something to sit through.
 */
import { queryOptions } from "@tanstack/react-query";
import type { HydraClient } from "@hydra/client-core";

/** Whether first run has been completed. Reachable without a token. */
export const setupQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: ["setup"],
    queryFn: () => client.setup.read(),
    staleTime: Infinity,
    retry: false,
  });

/** The settings store, both scopes. The user scope carries onboarding progress. */
export const settingsQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: ["settings"],
    queryFn: () => client.settings.read(),
    staleTime: Infinity,
    retry: false,
  });
