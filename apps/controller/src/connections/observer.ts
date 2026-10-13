import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The port through which `ConnectionService` reports that a Connection was
 * deleted. The workflows domain listens, because a stored workflow can name
 * the Connection where `ConnectionReferences` does not look, so the delete
 * went ahead: as the default of a Connection input, or as a value a
 * `run.start` step gives. Such a workflow no longer validates. It is
 * declared here and implemented in the controller daemon, because the
 * workflows domain depends on this one.
 *
 * It is called after the delete has committed, so it never fails: the
 * implementation logs its own failure.
 */
export class ConnectionObserver extends Context.Service<
  ConnectionObserver,
  {
    /** Reports that a Connection was deleted. */
    readonly connectionDeleted: () => Effect.Effect<void>;
  }
>()("hercule/controller/connections/ConnectionObserver") {}
