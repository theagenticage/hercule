/**
 * What every route is handed.
 *
 * The client and the query cache are built once, at the top of the app, and
 * reach routes through the router's context rather than a module-level
 * singleton: a test builds its own pair and the app never notices.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HydraClient } from "@hydra/client-core";

export interface RouterContext {
  readonly client: HydraClient;
  readonly queryClient: QueryClient;
}
