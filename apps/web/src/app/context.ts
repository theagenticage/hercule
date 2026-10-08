/**
 * The router context: what every route receives.
 *
 * The client and the query cache are built once, at the top of the app, and
 * reach routes through the router's context rather than a module-level
 * singleton. That way a test can build its own pair without the app knowing.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient, Live, UploadQueue } from "@hercule/client-core";
import type { Runner } from "@hercule/contract";

export interface RouterContext {
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  /**
   * The live connection, built once beside the client. A screen subscribes to
   * the topics it reads and invalidates the query keys in each push. Nothing
   * else about the socket reaches this app.
   */
  readonly live: Live;
  /**
   * The uploads of the images on every composer's shelf, `UPLOAD_CONCURRENCY`
   * at a time across the whole app. It lives here, built once beside the
   * client, so an upload keeps running when the user leaves the thread it was
   * attached in, and the limit holds however many composers are open.
   */
  readonly uploads: UploadQueue;
  /**
   * Returns the id of the listed runner that runs on the same machine as this
   * browser, or `null` when no local runner responds. Only a process outside
   * the app can tell, so the app receives this function instead of making the
   * loopback requests itself, and a test can pass one that needs no network.
   */
  readonly detectLocalRunner: (runners: ReadonlyArray<Runner>) => Promise<string | null>;
}
