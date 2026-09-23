/**
 * Plugins: the compiled-in registry, the host that loads it at each boot, and
 * the contribution catalog the rest of the system reads instead of the live
 * plugin.
 */
export { EventKindCatalogLayer } from "./event-kinds";
export { PluginConfigsLayer, PluginHost, PluginHostLayer } from "./host";
export { registry } from "./registry";
export { Plugins, PluginsLayer } from "./service";
export { type RegisteredWorkflowAction } from "./workflow-actions";
