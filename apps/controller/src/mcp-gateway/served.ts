/**
 * What one session is served (spec 21 section 3.3): the tools of the servers
 * in its list that may be served, under the gateway's names, with the one-line
 * instructions. `tools/list`, the instructions and `list_changed` all derive
 * from the same selection of servers, so they can never disagree.
 */
import { createHash } from "node:crypto";
import type { SessionActor } from "../actor";
import type { ServedMcpServer, StoredMcpTool } from "../mcp-servers";
import { buildInstructions } from "./instructions";
import type { NameLedger, ToolKey } from "./tool-names";

/** One tool the session is served, under the name the gateway gives it. */
export interface ServedTool {
  /** The name the gateway sends: `<server name>__<tool>`, shortened if needed. */
  readonly name: string;
  readonly serverId: string;
  readonly serverName: string;
  /** The tool's name as the server lists it. */
  readonly tool: string;
  readonly definition: StoredMcpTool;
}

/** Returns whether the session's profile holds `mcp.use`. Without it nothing is served. */
export const holdsMcpUse = (actor: SessionActor): boolean =>
  actor.profileGrants.includes("mcp.use");

/**
 * Returns whether the server is served: it is in the list the caller read, it
 * may be served now, and its tool list is stored. A server that is not `ready`
 * is still served, and a call to it is refused with the reason.
 */
export const isServed = ({ server, servable }: ServedMcpServer): boolean =>
  servable && server.enabled && server.checkedAt !== null;

/** Returns the servers of the session's list that it is served now: none without `mcp.use`. */
export const selectServed = (
  records: ReadonlyArray<ServedMcpServer>,
  actor: SessionActor,
): ReadonlyArray<ServedMcpServer> => (holdsMcpUse(actor) ? records.filter(isServed) : []);

/**
 * Builds the one-line instructions for the served servers. They name the
 * servers, or say why there are none. Needs no tool names.
 */
export const buildServedInstructions = (
  served: ReadonlyArray<ServedMcpServer>,
  actor: SessionActor,
): string =>
  buildInstructions(
    served.map(({ server }) => server.name).toSorted(),
    holdsMcpUse(actor) ? undefined : "missing-grant",
  );

/**
 * Names the tools of the served servers with `ledger`, and returns them in
 * the order the names were given, with the tools that got no unique name.
 * Pure: the caller records the names in the ledger once it has sent them.
 */
export const projectTools = (
  served: ReadonlyArray<ServedMcpServer>,
  ledger: NameLedger,
): { readonly tools: ReadonlyArray<ServedTool>; readonly leftOut: ReadonlyArray<ToolKey> } => {
  const { named, leftOut } = ledger.allocate(
    served.map(({ server }) => ({
      serverName: server.name,
      tools: server.tools.map((tool) => tool.name),
    })),
  );
  const servers = new Map(served.map(({ server }) => [server.name, server]));
  const tools = named.map(({ name, serverName, tool }): ServedTool => {
    const server = servers.get(serverName)!;
    return {
      name,
      serverId: server.id,
      serverName,
      tool,
      definition: server.tools.find((one) => one.name === tool)!,
    };
  });
  return { tools, leftOut };
};

/**
 * Returns a fingerprint that changes whenever a served tool, a tool's
 * definition, a tool's name or the instructions change. A stream is told
 * `list_changed` when its last fingerprint differs from the current one.
 */
export const fingerprintServed = (
  served: ReadonlyArray<ServedMcpServer>,
  actor: SessionActor,
  ledger: NameLedger,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        instructions: buildServedInstructions(served, actor),
        tools: projectTools(served, ledger).tools.map((one) => [one.name, one.definition]),
      }),
    )
    .digest("hex");

/**
 * Returns a tool as `tools/list` sends it: the stored definition under the
 * gateway's name.
 */
export const buildToolDefinition = ({ name, definition }: ServedTool): Record<string, unknown> => ({
  name,
  ...(definition.title === undefined ? {} : { title: definition.title }),
  description: definition.description,
  inputSchema: definition.inputSchema,
  ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
  ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
});
