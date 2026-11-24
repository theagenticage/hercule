import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Actor } from "../actor";

/** What `ConnectionObserver.connectionCreated` is told about a new Connection. Nothing in it is secret. */
export interface CreatedConnection {
  readonly connectionId: string;
  /** The qualified Connection type, such as `slack/slack`. */
  readonly type: string;
  /**
   * Who created the Connection. A change made on its behalf must pass the
   * same grant checks this actor would. It is the `none` actor when the
   * controller no longer knows who started the sign-in, which holds no grant.
   */
  readonly actor: Actor;
}

/**
 * The port through which `ConnectionService` reports that a Connection was
 * created or deleted. It is declared here and implemented in the controller
 * daemon, because both listeners depend on this domain:
 *
 * - The workflows domain listens for a delete, because a stored workflow can
 *   name the Connection where `ConnectionReferences` does not look, so the
 *   delete went ahead: as the default of a Connection input, or as a value a
 *   `run.start` step gives. Such a workflow no longer validates.
 * - The mcp-servers domain listens for a create, because a plugin's MCP
 *   server can ask to be added for each new Connection of its type.
 *
 * Each method is called after the change has committed, so it never fails:
 * the implementation logs its own failure. A reconnect creates no
 * Connection, so it is not reported.
 */
export class ConnectionObserver extends Context.Service<
  ConnectionObserver,
  {
    /** Reports that a Connection was created, by any of the flows that create one. */
    readonly connectionCreated: (created: CreatedConnection) => Effect.Effect<void>;
    /** Reports that a Connection was deleted. */
    readonly connectionDeleted: () => Effect.Effect<void>;
  }
>()("hercule/controller/connections/ConnectionObserver") {}
