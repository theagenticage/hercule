/**
 * The models behind the MCP server screens, in the web app and the desktop
 * app: pure functions over the records of the contract. Reached as
 * `@hercule/client-core/mcp-servers`, and left out of the package index on
 * purpose: only lazily loaded screens use them, and the app's first paint has
 * no room for them.
 */
export { describeAgentToolsNote, type AgentToolsNote } from "./agent-tools-note";
export {
  buildMcpWarningLine,
  decideStatusBand,
  decideWarningFix,
  type McpServerWarningEntry,
  type McpWarningLine,
  type StatusBand,
  type StatusBandAction,
  type WarningFix,
} from "./fix";
export { type McpServerDisplayStatus } from "./display-status";
export { chooseNamedServer, groupServersByName, type ServerNameGroup } from "./named-lists";
export { describeOfferAddress, readMcpServerOffers, type McpServerOffer } from "./offers";
export {
  buildProjectBoxes,
  decideProjectBoxWrite,
  describeProjectRefusal,
  type ProjectBox,
  type ProjectBoxAction,
  type ProjectBoxWrite,
  type ProjectBoxTarget,
  type ProjectRefusal,
  type TextPart,
} from "./project-boxes";
export {
  buildMcpServerSettingsRows,
  describeNamingProjects,
  type McpServerSettingsRow,
  type NamingProjects,
} from "./settings-list";
export {
  decideThreadStartList,
  describeStartLine,
  resolveDraftMcpServerIds,
  type ThreadStartList,
  type ThreadStartSource,
} from "./start-list";
export {
  buildServerPicker,
  buildThreadServerMenu,
  orderMenuNames,
  type RememberedAccounts,
  type ServerMenuRow,
  type ServerPicker,
  type ServerPickerRow,
  type ThreadServerMenu,
} from "./thread-menu";
export {
  countServersNeedingSignIn,
  describeThreadServersRow,
  type ThreadServersRow,
} from "./thread-servers-row";
export {
  buildMcpServerViews,
  describeReconnect,
  type McpServerView,
  type ReconnectTarget,
} from "./views";
