/**
 * MCP Servers: the catalogue of remote servers that offer tools to sessions,
 * reached through the MCP Gateway (spec 21 section 2). This domain owns the
 * server records and the `mcpServer` operations. It knows nothing about
 * Projects or Sessions.
 */
export { McpServerChecks, McpServerChecksLayer, McpUpstreamHttpClient } from "./checks";
export { runConnectionFollower } from "./follower";
export { McpServerListHolders } from "./list-holders";
export { mcpServerListRule, requireMcpManage, type ListedMcpServer } from "./list-rule";
export { mcpServerRepository, type StoredMcpServer, type StoredMcpTool } from "./repository";
export { McpServerService, McpServerServiceLayer, type UpdateInput } from "./service";
