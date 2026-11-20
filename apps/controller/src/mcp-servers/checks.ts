import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Asks for a new list of an MCP Server's tools from the outside server. The
 * MCP Server service calls it after the commit of a create, a switch on, or a
 * "check now".
 */
export class McpServerChecks extends Context.Service<
  McpServerChecks,
  {
    /**
     * Requests a new list of this server's tools, soon, and returns at once.
     * The result is written to the server later and announced on the
     * `mcpServer` live topic. Never fails: a check that cannot run sets the
     * server's status instead.
     */
    readonly request: (id: string) => Effect.Effect<void>;
  }
>()("hercule/controller/mcp-servers/McpServerChecks") {}

/**
 * A `McpServerChecks` that requests nothing, so a server stays in status
 * `checking`. The next step of #1208 replaces it with the check that lists the
 * tools upstream.
 */
export const McpServerChecksNoopLayer = Layer.succeed(McpServerChecks)({
  request: () => Effect.void,
});
