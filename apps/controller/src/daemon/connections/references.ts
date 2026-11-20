import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  ConnectionReferences,
  ConnectionServiceLayer,
  type ConnectionReference,
} from "../../connections";
import { mcpServerRepository } from "../../mcp-servers";
import { resourceRepository } from "../../resources";
import { workflowRepository } from "../../workflows";
import { ConnectionEntityFactsLayer } from "./entity-facts";

/**
 * Provides the connections domain's `ConnectionReferences` from the resources,
 * workflows and mcp-servers domains' rows. It lives in the controller daemon
 * because all of those domains depend on the connections domain, so none of
 * the four can connect them without a cycle.
 *
 * It reads the repositories, not the services: the services check
 * `resource.query`, `trigger.query` and `mcpServer.query` on the caller, and
 * deleting a Connection is not a read of anyone's resources, triggers or MCP
 * Servers.
 */
const ConnectionReferencesLayer: Layer.Layer<ConnectionReferences, never, SqlClient.SqlClient> =
  Layer.effect(ConnectionReferences)(
    Effect.gen(function* () {
      const resources = yield* resourceRepository;
      const workflows = yield* workflowRepository;
      const mcpServers = yield* mcpServerRepository;
      return {
        list: (connectionId) =>
          Effect.gen(function* () {
            const actingResources = yield* resources.listActingThroughConnection(connectionId);
            const namingTriggers = yield* workflows.listTriggersNamingConnection(connectionId);
            const namingSteps = yield* workflows.listStepsNamingConnection(connectionId);
            const usingServers = yield* mcpServers.listByConnection(connectionId);
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
              ...usingServers.map((server): ConnectionReference => ({
                kind: "mcpServer",
                mcpServerId: server.id,
                mcpServerName: server.name,
              })),
            ];
          }),
      };
    }),
  );

/**
 * The connection service with the `ConnectionReferences` it asks before it
 * deletes a Connection, and the `ConnectionEntityFacts` it records the facts
 * of the delete with. The controller's boot and the test controller both use
 * this one layer, so the two cannot be wired differently.
 */
export const ConnectionServiceWithReferencesLayer = ConnectionServiceLayer.pipe(
  Layer.provide(Layer.mergeAll(ConnectionReferencesLayer, ConnectionEntityFactsLayer)),
);
