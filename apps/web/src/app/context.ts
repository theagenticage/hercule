/**
 * What every route is handed.
 *
 * The client and the query cache are built once, at the top of the app, and
 * reach routes through the router's context rather than a module-level
 * singleton: a test builds its own pair and the app never notices.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient, Live } from "@hercule/client-core";
import type { Runner } from "@hercule/contract";

export interface RouterContext {
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  /**
   * The live connection, built once beside the client. A screen subscribes to
   * the topics it reads and invalidates the keys a push names; nothing else
   * about the socket reaches this app.
   */
  readonly live: Live;
  /**
   * Which listed runner is the one on the machine this browser is running on,
   * or `null` when nothing on it answers for one. It reaches routes through the
   * context because only a process outside the app can answer it: the app is
   * handed the answer rather than the loopback fetches behind it, and a test
   * hands it one without a network.
   */
  readonly detectLocalRunner: (runners: ReadonlyArray<Runner>) => Promise<string | null>;
}
