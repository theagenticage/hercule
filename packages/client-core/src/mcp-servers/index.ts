/**
 * The models behind the MCP server screens, in the web app and the desktop
 * app: pure functions over the records of the contract. Reached as
 * `@hercule/client-core/mcp-servers`, and left out of the package index on
 * purpose: only lazily loaded screens use them, and the app's first paint has
 * no room for them.
 */
export {
  ADDRESS_FIELD_HINT,
  describeSignInHeading,
  describeTokenForm,
  describeToolNamePreview,
  readAddForm,
  readFieldIssues,
  readTokenField,
  suggestServerName,
  type AddFormReading,
  type FieldIssues,
  type SignInEntry,
  type TokenFieldReading,
  type TokenFormWords,
} from "./add-by-url";
export {
  describeExistsRefusal,
  describePluginOriginRefusal,
  type ExistingServer,
  type PluginOriginRefusal,
  type RefusalAction,
  type RefusalDescription,
} from "./add-refusal";
export {
  CHECK_ANSWER_WAIT_MILLIS,
  IDLE_CHECK_NOW,
  NEW_SERVER_NOTE,
  createMcpUrlServerFlows,
  decideFollowing,
  describeClosing,
  describeFailedCheck,
  describeOffOutcome,
  describeOpenServerAction,
  describeReadyTools,
  findOrCreateMcpUrlServerFlows,
  type BrowserSignInPort,
  type CheckNowState,
  type EndReason,
  type FailedCheckWords,
  type FlowProblem,
  type FollowOrigin,
  type McpUrlServerFlowCache,
  type McpUrlServerFlows,
  type OpenServerAction,
  type RecordReading,
  type ServerOutcome,
  type SignInStep,
  type UrlServerFlowState,
} from "./url-server-flows";
export {
  BROWSER_SIGN_IN_LABEL,
  BROWSER_SIGN_IN_UNSUPPORTED,
  describePasteRefusal,
  describeSignInRefusal,
  describeSignInWaiting,
  offersBrowserSignIn,
  type SignInRefusalReason,
  type SignInWaitingWords,
} from "./sign-in-words";
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
  decideReplaceLock,
  decideServerPageSwitch,
  findOrCreateMcpServerSwitches,
  type ServerPageSwitch,
  type McpServerSwitchCache,
  type McpServerSwitchPress,
  type McpServerSwitches,
  type McpServerSwitchTarget,
  type ReplaceProgress,
} from "./server-switch";
export {
  decideReplaceChoice,
  describeReplaceDialog,
  describeReplaceRefusal,
  describeReplaceTitle,
  findReplaceCandidates,
  type ReplaceChoice,
  type ReplaceDialog,
  type ReplaceLine,
  type ReplaceRefusal,
} from "./replace";
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
  describeServerRemoval,
  describeTickedBoxes,
  type ProjectBox,
  type ProjectBoxAction,
  type ServerRemovalWording,
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
  describeRemoveEffect,
  describeServerPageFields,
  describeSignInAction,
  describeSignInRow,
  describeSourceChip,
  isCheckDisabled,
  type McpServerView,
  type ServerPageFields,
  type SignInAction,
  type SignInRow,
} from "./views";
