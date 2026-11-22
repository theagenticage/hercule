/**
 * Loads `buildMcpServerViews`, which joins the MCP servers with their
 * Connections, when a thread first needs it, so the first screen holds none of
 * that code (spec 17 §What MCP servers cost). It is a file of its own because
 * the React Compiler does not compile a function that holds a dynamic import.
 */
export const loadMcpServerViewsBuilder = () =>
  import("./build-mcp-server-views").then((module) => module.buildMcpServerViews);
