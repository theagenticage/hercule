/**
 * Deleting a Connection, which must check what other domains still use it.
 *
 * Two kinds of records name a Connection and would break without it:
 *
 * - a resource acts through it, with its credentials;
 * - a workflow's trigger starts runs only on events from it. Without the
 *   Connection no event could match that trigger again, and nothing would
 *   tell the user why their workflow went quiet.
 *
 * So the delete is refused while either exists. Resources and workflows both
 * import the connections domain, so the connections domain cannot read them,
 * and this operation lives in the controller daemon.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createInvalidStateError,
  type Forbidden,
  type Id,
  type InvalidState,
  type NotFound,
  type Unauthenticated,
} from "@hercule/contract";
import { requireGrant } from "../../actor";
import { ConnectionService } from "../../connections";
import { withTransaction } from "../../db";
import { resourceRepository } from "../../resources";
import { workflowRepository, type TriggerNamingConnection } from "../../workflows";

const NAMED_BY_RESOURCE =
  "a resource still acts through this connection; point the resource at another connection before deleting this one";

/**
 * Builds the refusal for a Connection that triggers name. It lists every
 * trigger, so the user can change them all before trying again.
 */
const buildNamedByTriggersMessage = (triggers: ReadonlyArray<TriggerNamingConnection>): string => {
  const named = triggers
    .map((trigger) => `${trigger.triggerId} in the workflow ${trigger.workflowName}`)
    .join(", ");
  return (
    `workflow triggers start runs on events from this connection: ${named}; ` +
    "point those triggers at another connection, or delete them, before deleting this one"
  );
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* ConnectionService;
  // The repositories, not the services: the services check `resource.query`
  // and `trigger.query` on the caller, and deleting a Connection is not a
  // read of anyone's resources or triggers.
  const resources = yield* resourceRepository;
  const workflows = yield* workflowRepository;

  return {
    /**
     * `connection.delete`: deletes a Connection and every secret it owns.
     * Fails with `NotFound` when no Connection has the id, and with
     * `InvalidState` while a resource acts through it or a trigger names it.
     *
     * The checks run in one transaction with the delete. Otherwise a resource
     * or a workflow saved between a check and the delete would name a
     * Connection that no longer exists.
     */
    deleteConnection: (
      id: Id,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.delete");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            if (yield* resources.usesConnection(id)) {
              return yield* Effect.fail(createInvalidStateError(NAMED_BY_RESOURCE));
            }
            const triggers = yield* workflows.listTriggersNamingConnection(id);
            if (triggers.length > 0) {
              return yield* Effect.fail(
                createInvalidStateError(buildNamedByTriggersMessage(triggers)),
              );
            }
            return yield* connections.deleteUnchecked(id);
          }),
        );
      }),
  };
});

export class ConnectionRemoval extends Context.Service<
  ConnectionRemoval,
  Effect.Success<typeof make>
>()("hercule/controller/daemon/ConnectionRemoval") {}

export const ConnectionRemovalLayer: Layer.Layer<
  ConnectionRemoval,
  never,
  SqlClient.SqlClient | ConnectionService
> = Layer.effect(ConnectionRemoval)(make);
