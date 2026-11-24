/**
 * Registers the MCP servers a plugin offers. Each contribution writes two
 * things: a catalog row, which the API returns and which stays while the
 * plugin is disabled, and a live entry that also holds `buildUpstreamRequest`,
 * the function that no catalog column or API response may carry.
 *
 * This module sits beside the host, like the other extension points: the host
 * calls it and it calls nothing in the host.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  McpServerDeclaration,
  PluginError,
  type McpServerContribution,
  type PluginManifest,
} from "@hercule/plugin-host";
import { describeFieldIssues } from "./errors";
import { mintQualifiedId } from "./qualified-id";
import type { NewContribution } from "./repository";

/** The name of the extension point this module registers into. */
const MCP_SERVER = "mcp-server";

/**
 * An MCP server a plugin registered at boot. `id` and `connectionType` are
 * qualified (`sentry/sentry`), as the catalog holds them.
 */
export interface RegisteredMcpServer {
  readonly id: string;
  readonly pluginId: string;
  readonly displayName: string;
  readonly description: string;
  /** The qualified type of the Connection the server is reached with. */
  readonly connectionType: string;
  /** Scheme, host and optional port of the vendor's server. */
  readonly origin: string;
  /** True when a new Connection of `connectionType` adds this server for itself. */
  readonly addWhenConnected: boolean;
  /** Builds the URL and headers of a call to the vendor's server. Pure: no I/O. */
  readonly buildUpstreamRequest: McpServerContribution["buildUpstreamRequest"];
}

const decodeMcpServerDeclaration = Schema.decodeUnknownEffect(McpServerDeclaration, {
  errors: "all",
});

/**
 * Validates one MCP server contribution and adds it to the catalog rows in
 * `declared` and to the `live` list of the current registration pass. The
 * qualified id is `<pluginId>/<id>`.
 *
 * Fails with a `PluginError` when a field is invalid, the id is already
 * registered, `connectionType` belongs to another plugin, or the id is too
 * long once qualified. Whether `connectionType` is registered at all is
 * checked once the plugin's `register` has finished
 * (`checkMcpServerConnectionTypes`), so a plugin may register the server
 * before or after its Connection type.
 */
export const registerMcpServerContribution = (
  manifest: PluginManifest,
  contribution: McpServerContribution,
  declared: Array<NewContribution>,
  live: Array<RegisteredMcpServer>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    const { buildUpstreamRequest, ...declaration } = contribution;
    const decoded = yield* Effect.mapError(
      decodeMcpServerDeclaration(declaration),
      (error) =>
        new PluginError({
          message: `the ${MCP_SERVER} contribution ${manifest.id}/${String(declaration.id)} is invalid: ${describeFieldIssues(error)}`,
        }),
    );
    const id = yield* mintQualifiedId(manifest.id, "MCP server", decoded.id);
    if (live.some((server) => server.id === id)) {
      return yield* Effect.fail(
        new PluginError({ message: `the ${MCP_SERVER} contribution ${id} is registered twice` }),
      );
    }
    if (!decoded.connectionType.startsWith(`${manifest.id}/`)) {
      return yield* Effect.fail(
        new PluginError({
          message: `the ${MCP_SERVER} contribution ${id} is reached with the Connection type ${decoded.connectionType}, which another plugin owns. A server can only be reached with a Connection type of its own plugin, "${manifest.id}/<type>", because a plugin can read the credentials of its own Connections only.`,
        }),
      );
    }
    declared.push({
      owner: manifest.id,
      extensionPoint: MCP_SERVER,
      id,
      definition: { ...decoded, id },
    });
    live.push({
      id,
      pluginId: manifest.id,
      displayName: decoded.displayName,
      description: decoded.description,
      connectionType: decoded.connectionType,
      origin: decoded.origin,
      addWhenConnected: decoded.addWhenConnected === true,
      buildUpstreamRequest,
    });
  });

/**
 * Checks that every server a plugin registered names a Connection type the
 * same plugin registered. Fails with a `PluginError` naming the first server
 * whose type is missing. `registeredTypes` holds the qualified Connection
 * types of the plugin's registration pass.
 *
 * It runs after the plugin's `register` has finished, so the order of the
 * plugin's `register...` calls does not matter. A server whose Connection type
 * does not exist could never be switched on, so the plugin is refused instead.
 */
export const checkMcpServerConnectionTypes = (
  servers: ReadonlyArray<RegisteredMcpServer>,
  registeredTypes: ReadonlyArray<string>,
): Effect.Effect<void, PluginError> => {
  const orphan = servers.find((server) => !registeredTypes.includes(server.connectionType));
  return orphan === undefined
    ? Effect.void
    : Effect.fail(
        new PluginError({
          message: `the ${MCP_SERVER} contribution ${orphan.id} is reached with the Connection type ${orphan.connectionType}, which the plugin ${orphan.pluginId} does not register. Register the Connection type, or name one the plugin registers.`,
        }),
      );
};
