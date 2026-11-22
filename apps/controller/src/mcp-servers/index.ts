/**
 * MCP Servers: the catalogue of remote servers that offer tools to sessions,
 * reached through the MCP Gateway (spec 21 section 2). This domain owns the
 * server records and the `mcpServer` operations. It knows nothing about
 * Projects or Sessions.
 */
export { McpCallRefused, McpServerCalls, McpServerCallsLayer, type McpToolCall } from "./calls";
export {
  decideCallRefusal,
  isServable,
  mcpServerCatalogue,
  type CallRefusal,
  type McpServerAvailabilityView,
  type McpServerView,
} from "./catalogue";
export { McpServerCheckDeadline, McpServerChecks, McpServerChecksLayer } from "./checks";
export { runConnectionFollower } from "./follower";
export {
  buildLeftOutWarning,
  decideLeftOutReason,
  decideNoGatewayReason,
  type LeftOutServer,
  type NoGatewayReason,
  type StartDelivery,
} from "./left-out";
export { McpServerListHolders } from "./list-holders";
export { mcpServerListRule, requireMcpManage } from "./list-rule";
export { mcpServerRepository, type StoredMcpServer, type StoredMcpTool } from "./repository";
export {
  McpServerService,
  McpServerServiceLayer,
  type FinishSignInInput,
  type SetTokenInput,
  type StartSignInInput,
  type UpdateInput,
} from "./service";
export { buildErrorResult } from "./upstream";
