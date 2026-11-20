/**
 * The MCP Gateway: the controller's one MCP endpoint, which serves each
 * session the tools of the MCP Servers in its list (spec 21 section 3). Only
 * the `/mcp` route and the controller daemon import this domain.
 */
import * as Effect from "effect/Effect";
import { McpGateway } from "./service";

export { buildUnauthorizedResponse, McpGateway, McpGatewayLayer, type McpCaller } from "./service";

/** Follows what each session is served and tells its open streams; runs for the life of the fiber. */
export const runMcpGatewayFollower: Effect.Effect<never, never, McpGateway> = Effect.flatMap(
  McpGateway,
  (gateway) => gateway.follow,
);
