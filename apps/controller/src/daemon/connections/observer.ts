import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Forbidden } from "@hercule/contract";
import { CurrentActor } from "../../actor";
import { absorbFailures } from "../../absorbing";
import { ConnectionObserver, type CreatedConnection } from "../../connections";
import { McpServerService } from "../../mcp-servers";
import { PluginHost, type RegisteredMcpServer } from "../../plugins";
import { WorkflowValidity } from "../../workflows";
import { makeLateReference, type LateReference } from "../late-reference";
import { revalidateAfterChange } from "../workflows";

/**
 * The MCP Server service, for the connections domain's observer, set once the
 * MCP Server service is built.
 *
 * The observer adds a server when a Connection is created, so it needs the
 * MCP Server service. The MCP Server service is built with the operation
 * layers, after the Connection service, and the Connection service is built
 * with this observer. So boot builds the observer with this empty reference,
 * and `McpServerServiceReferenceFill` sets it once the MCP Server service is
 * built. Boot builds every layer before it serves any request, so no
 * Connection is created before the reference is set.
 */
export class McpServerServiceReference extends Context.Service<
  McpServerServiceReference,
  LateReference<McpServerService["Service"]>
>()("hercule/controller/daemon/McpServerServiceReference") {}

export const McpServerServiceReferenceLayer: Layer.Layer<McpServerServiceReference> = Layer.sync(
  McpServerServiceReference,
)(() =>
  makeLateReference(
    "The connections observer was called before the MCP Server service was built. Boot must build the MCP Server service, and McpServerServiceReferenceFill with it, before any Connection can be created.",
  ),
);

/** Sets `McpServerServiceReference` to the MCP Server service, once both are built. */
export const McpServerServiceReferenceFill: Layer.Layer<
  never,
  never,
  McpServerServiceReference | McpServerService
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const reference = yield* McpServerServiceReference;
    reference.set(yield* McpServerService);
  }),
);

/**
 * Adds one plugin MCP server for a new Connection, with `mcpServer.create`
 * and the input a user's "add this server" sends, as the actor that created
 * the Connection. The service's own checks decide, so an actor without
 * `mcp.manage` gets no server, and the actor's grants are never widened.
 *
 * A server's name is not unique, so a second Connection of the same plugin
 * (another workspace) gets a server of the same default name. What the
 * service refuses is a second server for one external account.
 *
 * Never fails: each refusal or failure is logged in plain words, and the
 * Connection stays created. The log holds no credential.
 */
const addServer = (
  servers: McpServerService["Service"],
  contribution: RegisteredMcpServer,
  created: CreatedConnection,
): Effect.Effect<void> =>
  servers
    .create({
      source: {
        kind: "plugin",
        contributionId: contribution.id,
        connectionId: created.connectionId,
      },
    })
    .pipe(
      Effect.provideService(CurrentActor, created.actor),
      Effect.asVoid,
      Effect.catch((error) =>
        error instanceof Forbidden
          ? Effect.logWarning(
              `The ${contribution.displayName} MCP server was not added for the new Connection ${created.connectionId}, because whoever created the Connection may not manage MCP servers (${error.message}). The Connection is created. Add the server in Settings > MCP servers.`,
            )
          : Effect.logError(
              `The ${contribution.displayName} MCP server could not be added for the new Connection ${created.connectionId}: ${error.message}. The Connection is created. Add the server in Settings > MCP servers.`,
            ),
      ),
    );

/**
 * Provides the connections domain's `ConnectionObserver`:
 *
 * - A deleted Connection validates the stored workflows again, through the
 *   workflows domain's `WorkflowValidity`, because a workflow can still name
 *   it.
 * - A created Connection adds each MCP server whose contribution sets
 *   `addWhenConnected` for the Connection's type, through the MCP Server
 *   service.
 *
 * It lives in the controller daemon because the workflows and mcp-servers
 * domains both depend on the connections domain, so it cannot reach them
 * without a cycle.
 */
export const ConnectionObserverLayer: Layer.Layer<
  ConnectionObserver,
  never,
  WorkflowValidity | PluginHost | McpServerServiceReference
> = Layer.effect(ConnectionObserver)(
  Effect.gen(function* () {
    const validity = yield* WorkflowValidity;
    const plugins = yield* PluginHost;
    const reference = yield* McpServerServiceReference;

    return {
      connectionCreated: (created) =>
        absorbFailures(
          `The MCP servers of the new Connection ${created.connectionId} could not be added`,
          Effect.gen(function* () {
            const servers = yield* reference.get;
            const contributions = (yield* plugins.listMcpServers()).filter(
              (contribution) =>
                contribution.addWhenConnected && contribution.connectionType === created.type,
            );
            yield* Effect.forEach(
              contributions,
              (contribution) => addServer(servers, contribution, created),
              { discard: true },
            );
          }),
        ),
      connectionDeleted: () => revalidateAfterChange(validity),
    };
  }),
);
