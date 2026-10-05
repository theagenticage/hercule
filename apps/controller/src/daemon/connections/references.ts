import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ConnectionReferences,
  ConnectionServiceLayer,
  type ConnectionReference,
} from "../../connections";
import { resourceRepository } from "../../resources";
import { workflowRepository } from "../../workflows";

/**
 * Provides the connections domain's `ConnectionReferences` from the resources
 * and workflows domains' rows. It lives in the controller daemon because both
 * of those domains depend on the connections domain, so none of the three can
 * connect them without a cycle.
 *
 * It reads the repositories, not the services: the services check
 * `resource.query` and `trigger.query` on the caller, and deleting a
 * Connection is not a read of anyone's resources or triggers.
 */
const ConnectionReferencesLayer: Layer.Layer<ConnectionReferences, never, SqlClient.SqlClient> =
  Layer.effect(ConnectionReferences)(
    Effect.gen(function* () {
      const resources = yield* resourceRepository;
      const workflows = yield* workflowRepository;
      return {
        list: (connectionId) =>
          Effect.gen(function* () {
            const actingResources = yield* resources.listActingThroughConnection(connectionId);
            const namingTriggers = yield* workflows.listTriggersNamingConnection(connectionId);
            const namingSteps = yield* workflows.listStepsNamingConnection(connectionId);
            return [
              ...actingResources.map((resource): ConnectionReference => ({
                kind: "resource",
                resourceId: resource.id,
                resourceName: resource.name,
              })),
              ...namingTriggers.map((trigger): ConnectionReference => ({
                kind: "trigger",
                ...trigger,
              })),
              ...namingSteps.map((step): ConnectionReference => ({ kind: "step", ...step })),
            ];
          }),
      };
    }),
  );

/**
 * The connection service with the `ConnectionReferences` it asks before it
 * deletes a Connection. The controller's boot and the test controller both
 * use this one layer, so the two cannot be wired differently.
 */
export const ConnectionServiceWithReferencesLayer = ConnectionServiceLayer.pipe(
  Layer.provide(ConnectionReferencesLayer),
);
