/**
 * Exports `buildMcpServerViews` alone, for the dynamic import in
 * `loadMcpServerViewsBuilder`. A dynamic import keeps every export of the
 * module it names, so importing the package's whole `mcp-servers` index would
 * bring all of its code into the first screen.
 */
export { buildMcpServerViews } from "@hercule/client-core/mcp-servers";
