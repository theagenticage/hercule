/**
 * Connections: what the connections domain needs from other domains and
 * cannot import itself: the resources, workflow triggers and MCP Servers that name a
 * Connection, which block its delete, and the Task facts that losing what the
 * Connection read makes. Also the listener for its created and deleted
 * Connections: a delete validates the stored workflows again, and a create adds
 * the MCP servers its plugin asks to be added with the Connection.
 */
export {
  ConnectionObserverLayer,
  McpServerServiceReference,
  McpServerServiceReferenceFill,
  McpServerServiceReferenceLayer,
} from "./observer";
export { ConnectionServiceWithReferencesLayer } from "./references";
