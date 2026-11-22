/**
 * The models behind the MCP server screens, in the web app and the desktop
 * app: pure functions over the records of the contract. Reached as
 * `@hercule/client-core/mcp-servers`, and left out of the package index on
 * purpose: only lazily loaded screens use them, and the app's first paint has
 * no room for them.
 */
export {
  describeAgentToolsNote,
  describeUnavailableAgentToolsNote,
  type AgentToolsNote,
} from "./agent-tools-note";
export {
  buildMcpWarningLine,
  decideStatusBand,
  type McpServerWarningEntry,
  type McpWarningLine,
  type StatusBand,
  type StatusBandAction,
  type WarningFix,
} from "./fix";
export { hasMcpServerBlock, hasMcpServerLine } from "./mcp-line-presence";
export { MCP_SERVER_STATUS_FACTS, type McpServerDisplayStatus } from "./status";
export {
  buildMcpListQuery,
  createMcpListEdits,
  decideMcpListChoice,
  describeMcpListProblem,
  findOrCreateMcpListEdits,
  type McpListCache,
  type McpListChoice,
  type McpListDecision,
  type McpListQuery,
  type McpListEdits,
  type McpListTarget,
} from "./list-edits";
export { type McpListEditState, type McpListRefusal, type McpListUnread } from "./edit-guard";
export {
  buildOfferSwitchTarget,
  buildServerSwitchTarget,
  createMcpServerSwitches,
  decideServerPageSwitch,
  findOrCreateMcpServerSwitches,
  type ServerPageSwitch,
  type McpServerSwitchCache,
  type McpServerSwitches,
  type McpServerSwitchTarget,
} from "./server-switch";
export { chooseNamedServer, findOtherOccupant, type NamedServer } from "./named-lists";
export {
  describeOfferAddress,
  joinOfferedServers,
  readMcpServerOffers,
  type OfferedServer,
} from "./offers";
export {
  buildProjectBoxes,
  decideProjectBoxWrite,
  describeProjectRefusal,
  type ProjectBox,
  type ProjectBoxAction,
  type TextPart,
} from "./project-boxes";
export {
  buildMcpServerSettingsRows,
  describeNamingProjects,
  type McpServerSettingsRow,
  type NamingProjects,
} from "./settings-list";
export { resolveDraftMcpServerIds } from "./draft-pick";
export { decideDraftServersPick } from "./draft-servers-pick";
export {
  canResetToStart,
  decideThreadStart,
  decideThreadStartSource,
  describeThreadStartFoot,
  listKnownServerIds,
  type StartProjectRecord,
  type StartRecord,
  type ThreadStartDecision,
  type ThreadStartList,
} from "./start-list";
export {
  buildServerPicker,
  buildThreadServerMenu,
  orderMenuNames,
  type RememberedAccounts,
  type ServerMenuRow,
  type ServerPickerRow,
  type ThreadServerMenu,
} from "./thread-menu";
export {
  decideThreadServersDemand,
  describeThreadServers,
  type ThreadServersDemand,
  type ThreadServersDescription,
  type ThreadServersRecords,
  type ThreadServersSubject,
} from "./thread-servers";
export { describeThreadServersRow, type ThreadServersRow } from "./thread-servers-row";
export {
  buildMcpServerViews,
  describeConnectionRowProblem,
  isCheckDisabled,
  type McpServerView,
} from "./views";
