import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServerListHolders } from "../../mcp-servers";

/**
 * Provides the mcp-servers domain's `McpServerListHolders`. It lives in the
 * controller daemon because Projects and Sessions both depend on the
 * mcp-servers domain, so it cannot reach them without a cycle.
 *
 * It removes nothing yet, because no Project or Session holds a list of
 * servers until the lists step of #1208 adds them. That step fills this
 * adapter in.
 */
export const McpServerListHoldersLayer = Layer.succeed(McpServerListHolders)({
  removeServer: () => Effect.void,
});
