/**
 * MCP Servers: the catalogue of remote servers that offer tools to sessions,
 * reached through the MCP Gateway (spec 21 section 2). This domain owns the
 * server records and the `mcpServer` operations. It knows nothing about
 * Projects or Sessions.
 */
export {
  McpCallDeadline,
  McpCallRefused,
  McpServerCalls,
  McpServerCallsLayer,
  type McpToolCall,
  type ServedMcpServer,
} from "./calls";
export {
  decideCallRefusal,
  isServable,
  mcpServerCatalogue,
  type CallRefusal,
  type McpServerView,
} from "./catalogue";
export { McpServerChecks, McpServerChecksLayer } from "./checks";
export { runConnectionFollower } from "./follower";
export {
  buildLeftOutWarning,
  decideLeftOutReason,
  type LeftOutServer,
  type StartDelivery,
} from "./left-out";
export { McpServerListHolders } from "./list-holders";
export { mcpServerListRule, requireMcpManage } from "./list-rule";
export { mcpServerRepository, type StoredMcpServer, type StoredMcpTool } from "./repository";
export { McpServerService, McpServerServiceLayer, type UpdateInput } from "./service";
