/**
 * Connections: what the connections domain needs from other domains and
 * cannot import itself: the resources and workflow triggers that name a
 * Connection, which block its delete.
 */
export { ConnectionReferencesLayer } from "./references";
