/**
 * Plugins: the compiled-in registry, what each boot makes of it, and the
 * contribution catalog the rest of the system reads instead of the live plugin.
 */
export { PluginHost, PluginHostLayer, type RegisteredConnectionType } from "./host";
export { registry } from "./registry";
export { Plugins, PluginsLayer } from "./service";
