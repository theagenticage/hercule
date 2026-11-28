import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

/**
 * What the MCP Server service needs from the records that hold a list of
 * servers: every Project's list and every Session's list.
 *
 * Those domains import this one, so this one cannot import them back without
 * making the domain graph a cycle. It declares what it needs as this service,
 * and the controller daemon provides it from them. This is the second step of
 * the cycle ladder in ADR 0033: invert the control.
 */
export class McpServerListHolders extends Context.Service<
  McpServerListHolders,
  {
    /**
     * Removes the server from every Project's list and every Session's list,
     * and announces each record it changed. Runs in the caller's transaction,
     * so a delete that fails leaves every list as it was.
     */
    readonly removeServer: (id: string) => Effect.Effect<void, SqlError>;
  }
>()("hercule/controller/mcp-servers/McpServerListHolders") {}
