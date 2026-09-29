/**
 * Every read the app makes, as query options.
 *
 * The query keys come from `client-core`, so the desktop app and the web app
 * key the same reads the same way.
 */
import { queryOptions } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";

/**
 * Reads whether the controller's first run has been completed. Works without
 * a token. It is read once and then kept, because setup happens only once.
 * It never retries: an unreachable controller must lead to the connect screen
 * at once, not after several seconds of retries.
 */
export const setupQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.setup(),
    queryFn: () => client.setup.read(),
    staleTime: Infinity,
    retry: false,
  });
