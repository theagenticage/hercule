/**
 * What every route is handed.
 *
 * The client and the query cache are built once, at the top of the app, and
 * reach routes through the router's context rather than a module-level
 * singleton: a test builds its own pair and the app never notices.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HydraClient, Live } from "@hydra/client-core";

export interface RouterContext {
  readonly client: HydraClient;
  readonly queryClient: QueryClient;
  /**
   * The live connection, built once beside the client. A screen subscribes to
   * the topics it reads and invalidates the keys a push names; nothing else
   * about the socket reaches this app.
   */
  readonly live: Live;
}
