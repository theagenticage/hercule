/**
 * What the desktop app's first screen needs of the MCP server models: whether
 * a thread's transcript holds a line about servers, what a thread must read
 * about them, and the words and red dot of the composer's `+`. Reached as
 * `@hercule/client-core/mcp-servers/first-screen`.
 *
 * Everything here, and everything it imports, stays free of the code that
 * joins servers with their Connections (`views.ts`), builds a line's buttons
 * (`fix.ts`), reads offers (`offers.ts`) or edits a list (`list-edits.ts`).
 * The package index of the models, `@hercule/client-core/mcp-servers`, pulls
 * all of that in, so the first screen never imports it. `first-screen.test.ts`
 * checks the imports.
 */
export { hasMcpServerBlock, hasMcpServerLine } from "./mcp-line-presence";
export type { StartProjectRecord, StartRecord, ThreadStartDecision } from "./start-list";
export {
  decideThreadServersDemand,
  describeThreadServers,
  type ThreadServersDemand,
  type ThreadServersDescription,
  type ThreadServersRecords,
  type ThreadServersSubject,
} from "./thread-servers";
export { describeThreadServersRow, type ThreadServersRow } from "./thread-servers-row";
