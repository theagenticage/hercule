/**
 * Connections: what the connections domain needs from other domains and
 * cannot import itself: the resources, workflow triggers and MCP Servers that name a
 * Connection, which block its delete, and the Task facts that losing what the
 * Connection read makes.
 */
export { ConnectionServiceWithReferencesLayer } from "./references";
