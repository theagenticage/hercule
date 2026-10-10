/**
 * Plugins: the compiled-in registry, the host that loads it at each boot, and
 * the contribution catalog the rest of the system reads instead of the live
 * plugin.
 */
export { EventKindCatalogLayer } from "./event-kinds";
export { PluginConfigsLayer, PluginHost, PluginHostLayer } from "./host";
export {
  computeIngestFingerprint,
  IngestLoops,
  IngestLoopsLayer,
  type RunningIngest,
} from "./ingest";
export { IngestExecutor } from "./ingest-executor";
export type { RegisteredEventSource } from "./event-sources";
export { registry } from "./registry";
export { Plugins, PluginsLayer } from "./service";
export {
  CONNECTION_PARAM,
  executePluginAction,
  isBuiltInControllerActionId,
  isUsableAsAnswer,
  separateConnectionParam,
  runsInWorkspace,
  WORKSPACE_ACTION_IDS,
  type BuiltInControllerActionId,
  type RegisteredWorkflowAction,
  type WorkspaceActionId,
} from "./workflow-actions";
