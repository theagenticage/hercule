/**
 * The models behind the MCP server screens, in the web app and the desktop
 * app: pure functions over the records of the contract. Reached as
 * `@hercule/client-core/mcp-servers`, and left out of the package index on
 * purpose: only lazily loaded screens use them, and the app's first paint has
 * no room for them.
 */
export {
  ADDRESS_FIELD_HINT,
  describeToolNamePreview,
  readAddForm,
  type AddFormReading,
  type SignInEntry,
} from "./add-by-url";
export { type RefusalAction, type RefusalDescription } from "./add-refusal";
export { type BrowserSignInPort } from "./browser-sign-in";
export { type McpServerQueries } from "./reconcile";
export {
  createAttemptSlot,
  openUrlServerAttempt,
  type AddFields,
  type AttemptTarget,
  type UrlServerAttempt,
  type UrlServerAttemptState,
} from "./url-server-attempt";
export {
  describeUrlServerDialogTitle,
  describeUrlServerStep,
  type OpenServerAction,
  type UrlServerDialog,
  type UrlServerLaterStep,
  type UrlServerStep,
} from "./url-server-step";
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
export { type McpServerDisplayStatus } from "./status";
export {
  buildMcpListQuery,
  describeMcpListProblem,
  findOrCreateMcpListEdits,
  type McpListCache,
  type McpListChoice,
  type McpListEdits,
  type McpListTarget,
} from "./list-edits";
export { type McpListEditState, type McpListRefusal } from "./edit-guard";
export {
  buildOfferSwitchTarget,
  buildServerSwitchTarget,
  decideServerPageSwitch,
  findOrCreateMcpServerSwitches,
  type McpServerSwitchPress,
  type McpServerSwitches,
  type McpServerSwitchTarget,
} from "./server-switch";
export { type ReplaceDialogView } from "./replace";
export { joinOfferedServers, readMcpServerOffers, type OfferedServer } from "./offers";
export {
  buildProjectBoxes,
  describeProjectRefusal,
  describeServerRemoval,
  describeTickedBoxes,
  type ProjectBox,
  type ProjectBoxAction,
  type TextPart,
} from "./project-boxes";
export {
  buildMcpServerSettingsRows,
  buildUrlServerSettingsRows,
  describeNamingProjects,
  type McpServerSettingsRow,
  type NamingProjects,
  type UrlServerSettingsRow,
} from "./settings-list";
export { resolveDraftMcpServerIds } from "./draft-pick";
export { decideDraftServersPick } from "./draft-servers-pick";
export { buildStartRecord } from "./start-record";
export {
  decideThreadStart,
  describeThreadStartFoot,
  listKnownServerIds,
  type StartProjectRecord,
  type StartRecord,
  type ThreadStartDecision,
} from "./start-list";
export {
  buildServerPicker,
  buildThreadServerMenu,
  orderMenuNames,
  type RememberedAccounts,
  type ServerMenuRow,
  type ServerPickerRow,
} from "./thread-menu";
export {
  decideThreadServersDemand,
  describeThreadServers,
  type ThreadServersDescription,
  type ThreadServersRecords,
} from "./thread-servers";
export { type ThreadServersRow } from "./thread-servers-row";
export {
  buildMcpServerViews,
  describeConnectionRowProblem,
  describeRemoveEffect,
  describeServerPageFields,
  describeSignInAction,
  describeSignInRow,
  describeSourceChip,
  isCheckDisabled,
  type McpServerView,
  type ServerPageFields,
  type SignInAction,
} from "./views";
