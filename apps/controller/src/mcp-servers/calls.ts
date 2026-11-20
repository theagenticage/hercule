/**
 * What the MCP Gateway asks of the catalogue: which servers it may serve, and
 * a call to a server's tool (spec 21 sections 3.5 and 3.10). The gateway
 * programs against this service only.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { McpSchema } from "effect/ai";
import { McpServerWarningReason } from "@hercule/protocol";
import { mcpServerRepository, type StoredMcpServer } from "./repository";

/** Why a call through the gateway did not reach, or did not get an answer from, the server. */
export class McpCallRefused extends Schema.TaggedError<McpCallRefused>()("McpCallRefused", {
  reason: McpServerWarningReason,
  /** One fixed line the agent can act on. It never holds the server's or the provider's words. */
  message: Schema.String,
}) {}

/** A server as the gateway serves it: its record, its full tool definitions, and whether it may be served now. */
export interface ServedMcpServer {
  /** Includes `tools` (the full definitions), `status`, `enabled`, `checkedAt` and `name`. */
  readonly server: StoredMcpServer;
  /** Enabled, with a stored tool list, its plugin active and its Connection not switched off. */
  readonly servable: boolean;
}

/** The catalogue's side of the gateway. */
export class McpServerCalls extends Context.Service<
  McpServerCalls,
  {
    /**
     * Reads the servers with these ids that exist, in the given order. Checks
     * no grant: the gateway applies `mcp.use`.
     */
    readonly readServedServers: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<ServedMcpServer>, SqlError>;

    /**
     * Calls one tool of one server and returns the server's answer as it
     * came: an answer with `isError: true` is an answer, not a refusal.
     *
     * - `upstreamScope` is the hash of the caller's Session Token: one
     *   upstream MCP session per scope and server.
     * - `tool` is the tool's original name, as the server lists it.
     * - `authorize` runs immediately before every request is sent upstream, the
     *   first and any retry. When it fails, nothing more is sent and that
     *   refusal is returned.
     *
     * The whole call is bounded by 60 seconds (`timed-out`). Fails with
     * `McpCallRefused` when the server is not `ready`, is switched off, has an
     * unusable plugin or Connection, the sign-in failed, the answer is over
     * 4 MiB, or the call timed out. Interrupting the effect cancels the
     * upstream request.
     */
    readonly callTool: (input: {
      readonly upstreamScope: string;
      readonly serverId: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>> | undefined;
      readonly authorize: Effect.Effect<void, McpCallRefused>;
    }) => Effect.Effect<McpSchema.CallToolResult, McpCallRefused>;

    /** Ends every upstream MCP session of this scope, because the Session Token ended. Idempotent. */
    readonly closeUpstreamScope: (upstreamScope: string) => Effect.Effect<void>;
  }
>()("hercule/controller/mcp-servers/McpServerCalls") {}

/**
 * INTERIM, replaced by the call path of part C1 of #1208 when the branches
 * merge: it reads the served servers (a server is servable when it is on and
 * has a stored tool list) and dies on `callTool`, so nothing is sent upstream
 * and a build without the call path fails loudly instead of refusing quietly.
 */
export const McpServerCallsLayer: Layer.Layer<McpServerCalls, never, SqlClient.SqlClient> =
  Layer.effect(McpServerCalls)(
    Effect.gen(function* () {
      const servers = yield* mcpServerRepository;
      return McpServerCalls.of({
        readServedServers: (ids) =>
          Effect.map(
            Effect.forEach(ids, (id) => servers.readById(id)),
            (found) =>
              found.flatMap((one) =>
                Option.isSome(one)
                  ? [
                      {
                        server: one.value,
                        servable: one.value.enabled && one.value.checkedAt !== null,
                      },
                    ]
                  : [],
              ),
          ),
        callTool: () => Effect.die("the MCP call path (part C1 of #1208) is not merged yet"),
        closeUpstreamScope: () => Effect.void,
      });
    }),
  );
